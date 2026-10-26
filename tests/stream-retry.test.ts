import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Model, Api } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_STREAM_RETRY_BACKOFF_MS,
  sleepUnlessAborted,
  withStreamRetry,
  type StreamRetryNotice,
} from "../src/orch/stream-retry.ts";

const model = {
  id: "retry-test",
  name: "Retry Test",
  api: "openai-completions",
  provider: "retry-test",
  baseUrl: "http://invalid.local",
} as unknown as Model<Api>;

const message = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "answer" }],
  provider: "retry-test",
  model: "retry-test",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  ...overrides,
});

/** A stream that reports `event` in order, then ends. */
const streamOf = (
  build: (stream: ReturnType<typeof createAssistantMessageEventStream>) => AssistantMessageEvent[],
) => {
  const stream = createAssistantMessageEventStream();
  for (const event of build(stream)) stream.push(event);
  // Real providers always close the response; a fake without a terminal event must too.
  stream.end();
  return stream;
};

const failedBeforeOutput = (
  text = "socket hang up",
): ReturnType<typeof createAssistantMessageEventStream> =>
  streamOf(() => [
    { type: "start", partial: message({ content: [] }) },
    {
      type: "error",
      reason: "aborted",
      error: message({ content: [], stopReason: "aborted", errorMessage: text }),
    },
  ]);

const succeeded = (text = "recovered"): ReturnType<typeof createAssistantMessageEventStream> =>
  streamOf(() => {
    const partial = message({ content: [{ type: "text", text }] });
    return [
      { type: "start", partial: { ...partial, content: [] } },
      { type: "text_start", contentIndex: 0, partial: { ...partial, content: [] } },
      { type: "text_delta", contentIndex: 0, delta: text, partial },
      { type: "text_end", contentIndex: 0, content: text, partial },
      { type: "done", reason: "stop", message: partial },
    ];
  });

const collect = async (fn: StreamFn) => {
  const stream = await fn(model, { messages: [] } as never, undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
};

test("a stream that dies before emitting content is retried invisibly", async () => {
  const notices: StreamRetryNotice[] = [];
  const delays: number[] = [];
  let calls = 0;
  const fn = withStreamRetry(
    async () => {
      calls += 1;
      return calls === 1 ? failedBeforeOutput() : succeeded();
    },
    {
      onRetry: (notice) => notices.push(notice),
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  );
  const { events, result } = await collect(fn);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [DEFAULT_STREAM_RETRY_BACKOFF_MS[0]]);
  assert.deepEqual(notices, [
    {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10_000,
      reason: "aborted",
      errorMessage: "socket hang up",
    },
  ]);
  // The consumer sees one clean, complete stream: exactly one start and one done.
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.filter((event) => event.type === "text_delta").length, 1);
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(result.stopReason, "stop");
});

test("the upstream start event is withheld until real content arrives", async () => {
  const seen: string[] = [];
  let calls = 0;
  const fn = withStreamRetry(
    async () => {
      calls += 1;
      if (calls === 1) return failedBeforeOutput();
      // Emits a start and nothing else: no content, so nothing may leak.
      return streamOf(() => [{ type: "start", partial: message({ content: [] }) }]);
    },
    {
      sleep: async () => {},
      shouldRetry: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return true;
          }
          return false;
        };
      })(),
    },
  );
  const stream = await fn(model, { messages: [] } as never, undefined);
  for await (const event of stream) seen.push(event.type);
  assert.deepEqual(seen, ["error"]);
  assert.equal(calls, 2);
});

test("a failure after content was forwarded is not retried", async () => {
  let calls = 0;
  const fn = withStreamRetry(
    async () => {
      calls += 1;
      return streamOf(() => {
        const partial = message({ content: [{ type: "text", text: "half an ans" }] });
        return [
          { type: "start", partial: { ...partial, content: [] } },
          { type: "text_delta", contentIndex: 0, delta: "half an ans", partial },
          {
            type: "error",
            reason: "error",
            error: message({ content: [], stopReason: "error", errorMessage: "stream broke" }),
          },
        ];
      });
    },
    { sleep: async () => {} },
  );
  const { events } = await collect(fn);
  assert.equal(calls, 1, "partial output must be handed to the turn-level recovery instead");
  assert.ok(events.some((event) => event.type === "text_delta"));
  const last = events.at(-1)!;
  assert.equal(last.type, "error");
  assert.equal(last.type === "error" && last.error.errorMessage, "stream broke");
});

test("retries stop at the backoff budget and report how many were spent", async () => {
  let calls = 0;
  const fn = withStreamRetry(
    async () => {
      calls += 1;
      return failedBeforeOutput("connection refused");
    },
    { sleep: async () => {} },
  );
  const { events } = await collect(fn);
  assert.equal(calls, DEFAULT_STREAM_RETRY_BACKOFF_MS.length + 1);
  const last = events.at(-1)!;
  assert.equal(last.type, "error");
  assert.match(
    last.type === "error" ? (last.error.errorMessage ?? "") : "",
    /after 3 stream retries/,
  );
});

test("quota and context-overflow failures are never retried", async () => {
  for (const errorMessage of [
    "insufficient_quota: out of budget",
    "prompt is too long: exceeds the context window",
  ]) {
    let calls = 0;
    const fn = withStreamRetry(
      async () => {
        calls += 1;
        return streamOf(() => [
          { type: "start", partial: message({ content: [] }) },
          {
            type: "error",
            reason: "error",
            error: message({ content: [], stopReason: "error", errorMessage }),
          },
        ]);
      },
      { sleep: async () => {} },
    );
    const { events } = await collect(fn);
    assert.equal(calls, 1, `${errorMessage} must fail fast`);
    assert.equal(events.at(-1)?.type, "error");
  }
});

test("local stop and pause veto retries", async () => {
  let calls = 0;
  let allowed = true;
  const fn = withStreamRetry(
    async () => {
      calls += 1;
      return failedBeforeOutput();
    },
    { sleep: async () => {}, shouldRetry: () => allowed },
  );
  allowed = false;
  const { events } = await collect(fn);
  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.type, "error");
});

test("aborting the driver signal cancels a pending retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fn = withStreamRetry(
    async () => {
      calls += 1;
      return failedBeforeOutput();
    },
    {
      signal: controller.signal,
      sleep: () => {
        controller.abort();
        return Promise.reject(new Error("aborted"));
      },
    },
  );
  const stream = await fn(model, { messages: [] } as never, undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  assert.equal(calls, 1);
  const last = events.at(-1)!;
  assert.equal(last.type, "error");
  assert.match(last.type === "error" ? (last.error.errorMessage ?? "") : "", /retry cancelled/);
});

test("sleepUnlessAborted rejects immediately on an aborted signal and keeps the loop alive", async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(sleepUnlessAborted(10, aborted.signal), /aborted/);
  const controller = new AbortController();
  const pending = sleepUnlessAborted(50, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  await sleepUnlessAborted(1);
});
