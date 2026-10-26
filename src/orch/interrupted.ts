import type { RecoveryRecord, SettleReason } from "../types.ts";

/**
 * Why a run ended. This is deliberately richer than `ThreadState`: a thread that lost its
 * upstream connection and one that ran out of input-token budget both end up `failed`, but
 * the recipient must be able to tell them apart instead of "spent too much".
 */
export type InterruptReason = Extract<SettleReason, "upstream-interrupted" | "model-error">;

export interface RunInterruptedOptions {
  reason: InterruptReason;
  /** Cumulative own-assistant input tokens spent by this driver instance. */
  spentInput: number;
  /** Budget that was configured for the thread, if any. */
  budgetTokens?: number;
  /** Raw provider text, when the SDK reported one. */
  providerMessage?: string;
  /** Lossless recovery attempts that already ran before this failure surfaced. */
  recovery: RecoveryRecord;
}

/**
 * Thrown by the driver when the run died from an upstream/provider failure rather than from
 * our own stop, pause, or budget. The manager turns this into a faithful settle reason.
 */
export class RunInterruptedError extends Error {
  /** Marker used instead of `instanceof` so callers survive module duplication. */
  readonly runInterrupted = true;
  readonly reason: InterruptReason;
  readonly spentInput: number;
  readonly budgetTokens?: number;
  readonly providerMessage?: string;
  readonly recovery: RecoveryRecord;

  constructor(options: RunInterruptedOptions) {
    super(describeInterruption(options));
    this.name = "RunInterruptedError";
    this.reason = options.reason;
    this.spentInput = options.spentInput;
    this.budgetTokens = options.budgetTokens;
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
  const budget = options.budgetTokens;
  const share =
    budget && budget > 0 ? ` (${Math.round((options.spentInput / budget) * 100)}% of budget)` : "";
  const spend = `spent ${options.spentInput.toLocaleString("en-US")} input tokens${
    budget ? ` of ${budget.toLocaleString("en-US")}` : ""
  }${share}`;
  const budgetVerdict =
    budget && budget > 0 && options.spentInput < budget * 0.5
      ? " — this was NOT a budget stop"
      : "";
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
  return `Subagent run failed${attempts}: ${cause}; ${spend}${budgetVerdict}`;
}

/** One line per attempt, for the failure report handed back to the recipient. */
export function formatRecoveryReport(
  failure: Pick<RunInterruptedError, "reason" | "recovery" | "providerMessage">,
  detail: { spentInput: number; budgetTokens?: number },
): string {
  const { recovery } = failure;
  const budget = detail.budgetTokens;
  const spent =
    budget && budget > 0
      ? `spent ${detail.spentInput.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} input tokens`
      : `spent ${detail.spentInput.toLocaleString("en-US")} input tokens`;
  // A failure that burned well under its budget must never read as an exhaustion report.
  const budgetVerdict =
    budget && budget > 0 && detail.spentInput < budget * 0.5
      ? " — the budget was never the cause"
      : "";
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
  lines.push(`  ${spent}${budgetVerdict}.`);
  return lines.join("\n");
}
