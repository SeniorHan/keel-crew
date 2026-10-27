import type { RecoveryRecord, SettleReason } from "../types.ts";

/**
 * Why a run ended. This is deliberately richer than `ThreadState`: a thread that lost its
 * upstream connection and one whose model call failed both end up `failed`, but the recipient
 * must be able to tell them apart from the run's own evidence, never from token counts.
 */
export type InterruptReason = Extract<SettleReason, "upstream-interrupted" | "model-error">;

export interface RunInterruptedOptions {
  reason: InterruptReason;
  /**
   * Cumulative own-assistant input tokens spent by this driver instance. Kept for diagnostics
   * and never rendered into anything the parent model reads: a token figure in the parent's
   * context nudges it toward frugality instead of finishing the task.
   */
  spentInput: number;
  /** Raw provider text, when the SDK reported one. */
  providerMessage?: string;
  /** Lossless recovery attempts that already ran before this failure surfaced. */
  recovery: RecoveryRecord;
}

/**
 * Thrown by the driver when the run died from an upstream/provider failure rather than from
 * our own stop or pause. The manager turns this into a faithful settle reason.
 */
export class RunInterruptedError extends Error {
  /** Marker used instead of `instanceof` so callers survive module duplication. */
  readonly runInterrupted = true;
  readonly reason: InterruptReason;
  readonly spentInput: number;
  readonly providerMessage?: string;
  readonly recovery: RecoveryRecord;

  constructor(options: RunInterruptedOptions) {
    super(describeInterruption(options));
    this.name = "RunInterruptedError";
    this.reason = options.reason;
    this.spentInput = options.spentInput;
    this.providerMessage = options.providerMessage;
    this.recovery = options.recovery;
  }
}

export function isRunInterrupted(error: unknown): error is RunInterruptedError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { runInterrupted?: unknown }).runInterrupted === true &&
    typeof (error as { reason?: unknown }).reason === "string"
  );
}

function describeInterruption(options: RunInterruptedOptions): string {
  const cause =
    options.reason === "upstream-interrupted"
      ? "upstream interrupted the run (provider aborted or dropped the stream)"
      : `model call failed${options.providerMessage ? `: ${options.providerMessage}` : ""}`;
  const attempts =
    options.recovery.attempts > 0
      ? ` after ${options.recovery.attempts} lossless recovery attempt${
          options.recovery.attempts === 1 ? "" : "s"
        } (${options.recovery.attempts + 1} runs total)`
      : "";
  return `Subagent run failed${attempts}: ${cause}`;
}

/** One line per attempt, for the failure report handed back to the recipient. */
export function formatRecoveryReport(
  failure: Pick<RunInterruptedError, "reason" | "recovery" | "providerMessage">,
): string {
  const { recovery } = failure;
  const cause =
    failure.reason === "upstream-interrupted"
      ? "upstream interrupted the run (provider aborted or dropped the stream)"
      : `model call failed${failure.providerMessage ? `: ${failure.providerMessage}` : ""}`;
  const lines =
    recovery.attempts > 0
      ? [
          `failed after ${recovery.attempts} lossless recovery attempt${recovery.attempts === 1 ? "" : "s"}; ${
            recovery.attempts + 1
          } runs total.`,
          ...recovery.reasons.map((reason, index) => `  interruption ${index + 1}: ${reason}`),
        ]
      : [`failed: ${cause}.`];
  // Keep the provider's own words: they are the only evidence the recipient can act on.
  if (failure.providerMessage) lines.push(`  provider said: ${failure.providerMessage}`);
  return lines.join("\n");
}
