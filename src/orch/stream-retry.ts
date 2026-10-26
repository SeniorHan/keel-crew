import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * Per-request retry delays. A provider that dropped the connection before producing any
 * output is usually back within one of these windows; the total cap mirrors the approved
 * "3 retries with 10/30/90 s back off" policy.
 */
export const DEFAULT_STREAM_RETRY_BACKOFF_MS = [10_000, 30_000, 90_000] as const;

export interface StreamRetryNotice {
  /** 1-based retry index (the first retry is 1). */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: "aborted" | "error";
  errorMessage?: string;
}

export interface StreamRetryOptions {
  /** Delay before each retry; the array length is also the retry budget. */
  backoffMs?: readonly number[];
  /** Driver lifetime signal; aborting it cancels a pending retry. */
  signal?: AbortSignal;
  /** Extra veto (stop/pause/dispose). A false result ends retrying immediately. */
  shouldRetry?(): boolean;
  onRetry?(notice: StreamRetryNotice): void;
  /** Injectable for tests. */
  sleep?(delayMs: number, signal?: AbortSignal): Promise<void>;
}

interface StreamFailure {
  reason: "aborted" | "error";
  message: AssistantMessage;
}

/**
 * Wrap a stream function with request-level, lossless retries.
 *
 * The wrapper holds the upstream `start` event until real content arrives, so a stream that
 * dies before producing anything can be retried without the agent loop ever seeing a partial
 * message. Once any content has been forwarded the failure is passed through unchanged: the
 * turn-level recovery in the driver is responsible for that case.
 */
export function withStreamRetry(inner: StreamFn, options: StreamRetryOptions = {}): StreamFn {
  const backoff = options.backoffMs ?? DEFAULT_STREAM_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? sleepUnlessAborted;
  return (model, context, streamOptions) => {
    const out = createAssistantMessageEventStream();
    void pump(inner, out, model, context, streamOptions, backoff, sleep, options);
    return out;
  };
}

async function pump(
  inner: StreamFn,
  out: AssistantMessageEventStream,
  model: Model<Api>,
  context: TranscriptContext,
  streamOptions: SimpleStreamOptions | undefined,
  backoff: readonly number[],
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
  options: StreamRetryOptions,
): Promise<void> {
  const signal = streamOptions?.signal;
  for (let attempt = 0; ; attempt += 1) {
    let forwarded = false;
    let start: AssistantMessageEvent | undefined;
    let failure: StreamFailure | undefined;
    try {
      const stream = await inner(model, context, streamOptions);
      for await (const event of stream) {
        if (event.type === "start") {
          // Hold it: pushing `start` makes the agent loop own a partial message, which
          // would make this attempt unrecoverable.
          start = event;
          continue;
        }
        if (event.type === "done") {
          flush(out, start, forwarded);
          forwarded = true;
          out.push(event);
          return;
        }
        if (event.type === "error") {
          failure = { reason: event.reason, message: event.error };
          break;
        }
        if (!forwarded) {
          start ??= { type: "start", partial: event.partial };
          flush(out, start, forwarded);
          forwarded = true;
        }
        out.push(event);
      }
      // No terminal event at all: the connection dropped mid-stream, same as an abort.
      failure ??= {
        reason: "aborted",
        message: failureMessage(model, "Subagent stream ended without a final message", "aborted"),
      };
    } catch (error) {
      failure = {
        reason: "error",
        message: failureMessage(model, errorMessage(error), "error"),
      };
    }
    const retriesLeft = attempt < backoff.length;
    const canRetry =
      !forwarded &&
      retriesLeft &&
      !signal?.aborted &&
      !options.signal?.aborted &&
      options.shouldRetry?.() !== false &&
      isTransientFailure(failure);
    if (!canRetry) {
      const note =
        attempt > 0
          ? `${failure.message.errorMessage ?? ""} (after ${attempt} stream retries)`
          : undefined;
      out.push({
        type: "error",
        reason: failure.reason,
        error: note ? { ...failure.message, errorMessage: note } : failure.message,
      });
      return;
    }
    const delayMs = backoff[attempt]!;
    options.onRetry?.({
      attempt: attempt + 1,
      maxAttempts: backoff.length,
      delayMs,
      reason: failure.reason,
      ...(failure.message.errorMessage ? { errorMessage: failure.message.errorMessage } : {}),
    });
    try {
      await sleep(delayMs, signal);
    } catch {
      out.push({
        type: "error",
        reason: "aborted",
        error: failureMessage(model, "Subagent stream retry cancelled", "aborted"),
      });
      return;
    }
  }
}

function flush(
  out: AssistantMessageEventStream,
  start: AssistantMessageEvent | undefined,
  forwarded: boolean,
): void {
  if (forwarded || !start) return;
  out.push(start);
}

/**
 * A dropped connection surfaces as `aborted` here, which the SDK's own classifier treats as
 * terminal. We treat aborts as transient (our own stop/pause is guarded separately) and defer
 * to the SDK for errors, so permanent quota/billing failures still fail fast.
 */
function isTransientFailure(failure: StreamFailure): boolean {
  if (failure.reason === "aborted") return true;
  if (isContextOverflowText(failure.message.errorMessage)) return false;
  return isRetryableAssistantError(failure.message);
}

function isContextOverflowText(text: string | undefined): boolean {
  if (!text) return false;
  return /context (length|window)|maximum context|too many tokens|prompt is too long|exceeds the context/i.test(
    text,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureMessage(
  model: Model<Api>,
  text: string,
  reason: "aborted" | "error",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason,
    errorMessage: text,
    timestamp: Date.now(),
  };
}

/** Resolve after `delayMs`, or reject as soon as the signal aborts. */
export function sleepUnlessAborted(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("aborted"));
    // Not unref'd: a pending retry is live work, and letting the event loop drain here would
    // abandon the run (and any caller awaiting it) in the middle of the backoff window.
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
