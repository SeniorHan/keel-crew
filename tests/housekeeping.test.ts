import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  buildHousekeepingRequest,
  cleanSummary,
  createHousekeepingCompleter,
  housekeepingCandidates,
  HousekeepingSummarizer,
  resolveHousekeepingModel,
  SUMMARY_MAX_CHARS,
  type HousekeepingOptions,
} from "../src/orch/housekeeping.ts";
import { toolArgumentSnippet } from "../src/orch/runtime.ts";
import { ThreadManager } from "../src/orch/manager.ts";
import type {
  AgentDriver,
  AgentType,
  DriverOptions,
  ThreadActivity,
  ThreadEvent,
} from "../src/types.ts";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const activity = (path: string, run: number, ...recent: string[]): ThreadActivity => ({
  path,
  type: "worker",
  task: "Fix the flaky test",
  run,
  recent,
});

function harness(
  t: TestContext,
  overrides: Partial<HousekeepingOptions> & { reply?: (n: number) => string } = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls: {
    user: string;
    signal: AbortSignal;
    resolve(text: string): void;
    reject(e: Error): void;
  }[] = [];
  const applied: [string, number, string][] = [];
  const failures: string[] = [];
  const cleared: [string, number][] = [];
  let enabled = true;
  const summarizer = new HousekeepingSummarizer({
    isEnabled: () => enabled,
    complete: (request, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ user: request.user, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
        if (overrides.reply) resolve(overrides.reply(calls.length));
      }),
    apply: (path, run, summary) => {
      applied.push([path, run, summary]);
      return true;
    },
    clear: (path, run) => cleared.push([path, run]),
    onFailure: (message) => failures.push(message),
    ...overrides,
  });
  t.after(() => summarizer.dispose());
  return {
    summarizer,
    calls,
    applied,
    failures,
    cleared,
    setEnabled: (value: boolean) => (enabled = value),
  };
}

test("cleanSummary keeps one short plain line", () => {
  assert.equal(cleanSummary('  "Running unit tests."  \nsecond line'), "Running unit tests");
  assert.equal(
    cleanSummary("- Reading `src/index.ts`\x1b[31m now\x1b[0m"),
    "Reading `src/index.ts` now",
  );
  assert.equal(cleanSummary("\n\n   \n"), "");
  const long = cleanSummary("x".repeat(500));
  assert.equal(long.length, SUMMARY_MAX_CHARS);
  assert.ok(long.endsWith("…"));
});

test("request carries task, bounded recent activity and previous label as untrusted data", () => {
  const request = buildHousekeepingRequest(
    activity("/root/a", 1, "Tool: bash npm test", "Tool bash: finished"),
    "Running tests",
  );
  assert.match(request.system, /untrusted data/);
  assert.match(request.system, /ONLY one line/);
  assert.match(request.user, /Assigned task: Fix the flaky test/);
  assert.match(request.user, /Previous label: Running tests/);
  assert.match(request.user, /- Tool: bash npm test\n- Tool bash: finished/);
  assert.doesNotMatch(buildHousekeepingRequest(activity("/root/a", 1, "x")).user, /Previous label/);
});

test("tool argument snippets are single-line, bounded hints", () => {
  assert.equal(toolArgumentSnippet({ command: "npm test\n--watch" }), "npm test --watch");
  assert.equal(toolArgumentSnippet({ file_path: "/a/b.ts", content: "ignored" }), "/a/b.ts");
  assert.equal(toolArgumentSnippet({ other: 1 }), '{"other":1}');
  assert.equal(toolArgumentSnippet({ command: "x".repeat(400) })!.length, 160);
  assert.equal(toolArgumentSnippet(undefined), undefined);
  assert.equal(toolArgumentSnippet({ command: "  " }), undefined);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(toolArgumentSnippet(cyclic), undefined);
});

test("a burst of activity coalesces into one call using the newest activity", async (t) => {
  const { summarizer, calls, applied } = harness(t);
  for (let i = 1; i <= 5; i++) summarizer.notify(activity("/root/a", 1, `Tool: step-${i}`));
  await flush();
  assert.equal(calls.length, 0, "debounced");
  t.mock.timers.tick(1499);
  await flush();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.user, /step-5/);
  calls[0]!.resolve('"Stepping through the plan."');
  await flush();
  assert.deepEqual(applied, [["/root/a", 1, "Stepping through the plan"]]);
});

test("calls per agent respect the minimum interval, and activity during a call never overlaps it", async (t) => {
  const { summarizer, calls, applied } = harness(t);
  summarizer.notify(activity("/root/a", 1, "one"));
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 1);
  // New activity while the first call is still in flight: marks dirty, no second call.
  summarizer.notify(activity("/root/a", 1, "one", "two"));
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(calls.length, 1, "one in flight per agent");
  assert.equal(summarizer.inFlight, 1);
  calls[0]!.resolve("First label");
  await flush();
  assert.equal(applied.length, 1);
  // Interval measured from the previous call start, long elapsed: next call after the debounce only.
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.user, /Previous label: First label/);
  calls[1]!.resolve("Second label");
  await flush();
  // Rapid follow-up must wait out the 10s spacing from the second call's start.
  summarizer.notify(activity("/root/a", 1, "three"));
  t.mock.timers.tick(9_000);
  await flush();
  assert.equal(calls.length, 2, "throttled");
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(calls.length, 3);
});

test("without new activity nothing is requested again", async (t) => {
  const { summarizer, calls } = harness(t, { reply: () => "Idle label" });
  summarizer.notify(activity("/root/a", 1, "one"));
  t.mock.timers.tick(1500);
  await flush();
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(calls.length, 1);
});

test("a new run aborts the old call and drops its late result", async (t) => {
  const { summarizer, calls, applied } = harness(t);
  summarizer.notify(activity("/root/a", 1, "old run"));
  t.mock.timers.tick(1500);
  await flush();
  const stale = calls[0]!;
  summarizer.notify(activity("/root/a", 2, "new run"));
  assert.equal(stale.signal.aborted, true);
  stale.resolve("Stale label");
  await flush();
  assert.deepEqual(applied, []);
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.user, /new run/);
  assert.doesNotMatch(calls[1]!.user, /Previous label/);
  calls[1]!.resolve("Fresh label");
  await flush();
  assert.deepEqual(applied, [["/root/a", 2, "Fresh label"]]);
});

test("settling cancels pending timers and in-flight calls", async (t) => {
  const { summarizer, calls, applied } = harness(t);
  summarizer.notify(activity("/root/a", 1, "a"));
  summarizer.notify(activity("/root/b", 1, "b"));
  summarizer.settle("/root/b");
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 1, "pending timer for b was cleared");
  summarizer.settle("/root/a");
  assert.equal(calls[0]!.signal.aborted, true);
  calls[0]!.resolve("late");
  await flush();
  assert.deepEqual(applied, []);
  assert.equal(summarizer.inFlight, 0);
});

test("disabled state makes no calls and drops results in flight", async (t) => {
  const { summarizer, calls, applied, setEnabled } = harness(t);
  setEnabled(false);
  summarizer.notify(activity("/root/a", 1, "a"));
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, 0);
  setEnabled(true);
  summarizer.notify(activity("/root/a", 1, "a"));
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 1);
  setEnabled(false);
  calls[0]!.resolve("Late label");
  await flush();
  assert.deepEqual(applied, []);
  // Disabled at the moment the timer fires: no call either.
  setEnabled(true);
  summarizer.notify(activity("/root/c", 1, "c"));
  setEnabled(false);
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 1);
});

test("a throwing isEnabled is treated as disabled", async (t) => {
  const { summarizer, calls } = harness(t, {
    isEnabled: () => {
      throw new Error("registry exploded");
    },
  });
  summarizer.notify(activity("/root/a", 1, "a"));
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, 0);
});

test("failures are reported once, back off exponentially and stop after the limit", async (t) => {
  const { summarizer, calls, applied, failures } = harness(t);
  const fail = async (index: number) => {
    summarizer.notify(activity("/root/a", 1, `n${index}`));
  };
  await fail(0);
  t.mock.timers.tick(1500);
  await flush();
  calls[0]!.reject(new Error("401 unauthorized"));
  await flush();
  assert.deepEqual(failures, ["401 unauthorized"]);
  // Second attempt waits 2 × minInterval (20s) from the first start.
  summarizer.notify(activity("/root/a", 1, "n1"));
  t.mock.timers.tick(19_999);
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2);
  calls[1]!.reject(new Error("again"));
  await flush();
  assert.deepEqual(failures, ["401 unauthorized"], "reported only once");
  summarizer.notify(activity("/root/a", 1, "n2"));
  t.mock.timers.tick(40_000);
  await flush();
  assert.equal(calls.length, 3);
  calls[2]!.reject(new Error("third"));
  await flush();
  // Three consecutive failures: gives up for this run.
  summarizer.notify(activity("/root/a", 1, "n3"));
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(calls.length, 3);
  assert.deepEqual(applied, []);
  // A new run starts clean.
  summarizer.notify(activity("/root/a", 2, "fresh"));
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 4);
});

test("a success resets the failure streak; cancelAll re-arms the one-time failure report", async (t) => {
  const { summarizer, calls, failures } = harness(t);
  summarizer.notify(activity("/root/a", 1, "n0"));
  t.mock.timers.tick(1500);
  await flush();
  calls[0]!.reject(new Error("blip"));
  await flush();
  summarizer.notify(activity("/root/a", 1, "n1"));
  t.mock.timers.tick(20_000);
  await flush();
  calls[1]!.resolve("Recovered");
  await flush();
  summarizer.notify(activity("/root/a", 1, "n2"));
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, 3, "back to the base interval after a success");
  summarizer.cancelAll();
  assert.equal(calls[2]!.signal.aborted, true);
  summarizer.notify(activity("/root/b", 1, "b"));
  t.mock.timers.tick(1500);
  await flush();
  calls[3]!.reject(new Error("blip again"));
  await flush();
  assert.deepEqual(failures, ["blip", "blip again"]);
});

test("a hung model call is aborted by the timeout and counts as a failure", async (t) => {
  const { summarizer, calls, failures } = harness(t, { timeoutMs: 5_000 });
  summarizer.notify(activity("/root/a", 1, "a"));
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls[0]!.signal.aborted, false);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls[0]!.signal.aborted, true);
  assert.equal(summarizer.inFlight, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /timed out/);
});

test("global concurrency is capped and queued agents run as slots free", async (t) => {
  const { summarizer, calls } = harness(t, { maxConcurrent: 2 });
  for (const path of ["/root/a", "/root/b", "/root/c"]) summarizer.notify(activity(path, 1, path));
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(summarizer.inFlight, 2);
  t.mock.timers.tick(1499);
  await flush();
  assert.equal(calls.length, 2, "third waits while both slots are busy");
  calls[0]!.resolve("Done a");
  await flush();
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(summarizer.inFlight, 2);
});

test("empty model output and rejected applies leave state alone without failing", async (t) => {
  const { summarizer, calls, failures } = harness(t, { apply: () => false });
  summarizer.notify(activity("/root/a", 1, "a"));
  t.mock.timers.tick(1500);
  await flush();
  calls[0]!.resolve("   \n  ");
  await flush();
  summarizer.notify(activity("/root/a", 1, "b"));
  t.mock.timers.tick(10_000);
  await flush();
  calls[1]!.resolve("Label that apply rejects");
  await flush();
  summarizer.notify(activity("/root/a", 1, "c"));
  t.mock.timers.tick(10_000);
  await flush();
  assert.doesNotMatch(calls[2]!.user, /Previous label/, "rejected summaries are not remembered");
  assert.deepEqual(failures, []);
});

// --- model resolution and the provider call -------------------------------------------------

const model = (provider: string, id: string, api = "openai-completions") =>
  ({ provider, id, name: id, api }) as never;

function fakeContext(options: {
  available?: ReturnType<typeof model>[];
  scoped?: ReturnType<typeof model>[];
  authed?: (m: { provider: string; id: string }) => boolean;
  stream?: (...args: unknown[]) => { result(): Promise<unknown> };
  sessionManager?: SessionManager;
}) {
  const available = options.available ?? [];
  const calls: unknown[][] = [];
  const sessionManager = options.sessionManager ?? SessionManager.inMemory();
  const ctx = {
    sessionManager,
    scopedModels: (options.scoped ?? []).map((m) => ({ model: m })),
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) =>
        available.find((m: any) => m.provider === provider && m.id === id),
      hasConfiguredAuth: (m: { provider: string; id: string }) => options.authed?.(m) ?? true,
      streamSimple: (...args: unknown[]) => {
        calls.push(args);
        return options.stream!(...args);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls, sessionManager };
}

test("candidates are every available model with scope flagged; resolution fails closed", () => {
  const haiku = model("anthropic", "haiku");
  const mini = model("openai", "mini");
  const { ctx } = fakeContext({
    available: [haiku, mini],
    scoped: [mini],
    authed: (m) => m.provider !== "unauthed",
  });
  assert.deepEqual(
    housekeepingCandidates(ctx).map(({ model, scoped }) => [
      `${model.provider}/${model.id}`,
      scoped,
    ]),
    [
      ["anthropic/haiku", false],
      ["openai/mini", true],
    ],
  );
  assert.equal(
    resolveHousekeepingModel(ctx, "anthropic/haiku"),
    haiku,
    "available but unscoped is allowed",
  );
  assert.equal(resolveHousekeepingModel(ctx, "openai/mini"), mini);
  assert.equal(resolveHousekeepingModel(ctx, ""), undefined);
  assert.equal(resolveHousekeepingModel(ctx, "nope"), undefined);
  assert.equal(resolveHousekeepingModel(ctx, "openai/missing"), undefined);
  const noAuth = fakeContext({ available: [haiku], authed: () => false }).ctx;
  assert.equal(resolveHousekeepingModel(noAuth, "anthropic/haiku"), undefined, "no credentials");
  assert.equal(
    resolveHousekeepingModel({ ...ctx, scopedModels: null } as never, "openai/mini"),
    mini,
  );
});

const assistant = (patch: Record<string, unknown>) => ({
  role: "assistant",
  content: [],
  stopReason: "stop",
  ...patch,
});

test("completer issues one tool-less streamSimple call with the abort signal and returns text", async () => {
  const mini = model("openai", "gpt-5-mini");
  const { ctx, calls } = fakeContext({
    available: [mini],
    stream: () => ({
      result: async () =>
        assistant({
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Reading " },
            { type: "text", text: "files" },
          ],
        }),
    }),
  });
  const complete = createHousekeepingCompleter(
    () => ctx,
    () => "openai/gpt-5-mini",
  );
  const controller = new AbortController();
  assert.equal(await complete({ system: "SYS", user: "USER" }, controller.signal), "Reading files");
  assert.equal(calls.length, 1);
  const [usedModel, context, options] = calls[0] as [unknown, any, any];
  assert.equal(usedModel, mini);
  assert.equal(context.systemPrompt, "SYS");
  assert.equal(context.tools, undefined);
  assert.equal(context.messages.length, 1);
  assert.deepEqual(context.messages[0].content, [{ type: "text", text: "USER" }]);
  assert.equal(options.signal, controller.signal);
  assert.ok(options.maxTokens > 0 && options.maxTokens <= 200);
});

test("completer rejects without a session, unavailable model, or provider error/abort", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    createHousekeepingCompleter(
      () => undefined,
      () => "a/b",
    )({ system: "", user: "" }, signal),
    /No active Pi session/,
  );
  const { ctx } = fakeContext({
    available: [],
    stream: () => assert.fail("must not call the provider"),
  });
  await assert.rejects(
    createHousekeepingCompleter(
      () => ctx,
      () => "a/b",
    )({ system: "", user: "" }, signal),
    /a\/b is unavailable/,
  );
  await assert.rejects(
    createHousekeepingCompleter(
      () => ctx,
      () => "",
    )({ system: "", user: "" }, signal),
    /\(none\) is unavailable/,
  );
  for (const stopReason of ["error", "aborted"]) {
    const failing = fakeContext({
      available: [model("a", "b")],
      stream: () => ({
        result: async () =>
          assistant({
            stopReason,
            errorMessage: stopReason === "error" ? "429 slow down" : undefined,
          }),
      }),
    }).ctx;
    await assert.rejects(
      createHousekeepingCompleter(
        () => failing,
        () => "a/b",
      )({ system: "", user: "" }, signal),
      stopReason === "error" ? /429 slow down/ : /aborted/,
    );
  }
});

// --- usage accounting -----------------------------------------------------------------------

const reportedUsage: Usage = {
  input: 123,
  output: 10,
  cacheRead: 20,
  cacheWrite: 0,
  reasoning: 2,
  totalTokens: 153,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
};
const billableResponse = (patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  api: "openai-completions",
  provider: "response-provider",
  model: "response-model",
  responseModel: "concrete-response-model",
  timestamp: 1,
  content: [{ type: "text", text: "Reading files" }],
  stopReason: "stop",
  usage: reportedUsage,
  ...patch,
});

for (const stopReason of ["stop", "error", "aborted", "empty"] as const) {
  test(`completer records ${stopReason} responses once before output validation`, async () => {
    const { ctx, sessionManager } = fakeContext({
      available: [model("selected", "model")],
      stream: () => ({
        result: async () =>
          billableResponse({
            ...(stopReason === "empty" ? { content: [] } : { stopReason }),
            errorMessage: "provider failed",
          }),
      }),
    });
    let refreshed = 0;
    const complete = createHousekeepingCompleter(
      () => ctx,
      () => "selected/model",
      (current) => {
        assert.equal(current, ctx);
        assert.equal(sessionManager.getEntries().length, 1);
        refreshed++;
      },
    );
    const result = complete(
      { system: "private system prompt", user: "private task and arguments" },
      new AbortController().signal,
    );
    if (stopReason === "error" || stopReason === "aborted")
      await assert.rejects(result, /provider failed/);
    else assert.equal(await result, stopReason === "empty" ? "" : "Reading files");
    const entries = sessionManager.getEntries();
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.type, "usage");
    if (entry.type !== "usage") assert.fail("expected native usage entry");
    assert.deepEqual(entry.usage, reportedUsage);
    assert.equal(entry.model, "concrete-response-model");
    assert.equal(entry.provider, "response-provider");
    assert.equal(entry.kind, "keel-crew");
    assert.doesNotMatch(JSON.stringify(entries), /private|Reading files|provider failed/);
    assert.equal(refreshed, 1);
  });
}

test("provider rejection before a response does not fabricate usage", async () => {
  const { ctx, sessionManager } = fakeContext({
    available: [model("a", "b")],
    stream: () => ({
      result: async () => {
        throw new Error("connection failed");
      },
    }),
  });
  await assert.rejects(
    createHousekeepingCompleter(
      () => ctx,
      () => "a/b",
    )({ system: "", user: "" }, new AbortController().signal),
    /connection failed/,
  );
  assert.deepEqual(sessionManager.getEntries(), []);
});

test("late cancelled responses charge the captured original session, not its replacement or UI", async () => {
  let resolve!: (response: AssistantMessage) => void;
  const { ctx, sessionManager } = fakeContext({
    available: [model("a", "b")],
    stream: () => ({
      result: () =>
        new Promise<AssistantMessage>((r) => {
          resolve = r;
        }),
    }),
  });
  let valid = true;
  const originatingContext = {
    ...ctx,
    get sessionManager() {
      if (!valid) throw new Error("old extension context invalidated");
      return sessionManager;
    },
  } as ExtensionContext;
  let current = originatingContext;
  const replacement = fakeContext({ available: [model("a", "b")] });
  const controller = new AbortController();
  let refreshed = 0;
  const complete = createHousekeepingCompleter(
    () => current,
    () => "a/b",
    () => {
      refreshed++;
    },
  );
  const pending = complete({ system: "", user: "" }, controller.signal);
  current = replacement.ctx;
  valid = false;
  controller.abort();
  resolve(billableResponse({ stopReason: "aborted" }));
  await assert.rejects(pending, /aborted/);
  assert.equal(sessionManager.getEntries().length, 1);
  assert.deepEqual(replacement.sessionManager.getEntries(), []);
  assert.equal(refreshed, 0, "late usage must not refresh the replacement session UI");
});

test("scheduler drops stale display results while the completer retains their usage", async (t) => {
  let resolve!: (response: AssistantMessage) => void;
  const { ctx, sessionManager } = fakeContext({
    available: [model("a", "b")],
    stream: () => ({
      result: () =>
        new Promise<AssistantMessage>((r) => {
          resolve = r;
        }),
    }),
  });
  const { summarizer, applied } = harness(t, {
    complete: createHousekeepingCompleter(
      () => ctx,
      () => "a/b",
    ),
  });
  summarizer.notify(activity("/root/a", 1, "task"));
  t.mock.timers.tick(1500);
  await flush();
  summarizer.settle("/root/a");
  resolve(billableResponse());
  await flush();
  assert.deepEqual(applied, []);
  assert.equal(sessionManager.getEntries().length, 1);
});

test("accounting and cost-refresh failures do not break successful summaries", async (t) => {
  const failedNative = SessionManager.inMemory();
  t.mock.method(failedNative, "appendUsage", () => {
    throw new Error("native write failed");
  });
  const first = fakeContext({
    available: [model("a", "b")],
    sessionManager: failedNative,
    stream: () => ({ result: async () => billableResponse() }),
  });
  assert.equal(
    await createHousekeepingCompleter(
      () => first.ctx,
      () => "a/b",
    )({ system: "", user: "" }, new AbortController().signal),
    "Reading files",
  );
  assert.deepEqual(failedNative.getEntries(), []);
  const second = fakeContext({
    available: [model("a", "b")],
    stream: () => ({ result: async () => billableResponse() }),
  });
  assert.equal(
    await createHousekeepingCompleter(
      () => second.ctx,
      () => "a/b",
      () => {
        throw new Error("UI gone");
      },
    )({ system: "", user: "" }, new AbortController().signal),
    "Reading files",
  );
  assert.equal(second.sessionManager.getEntries().length, 1, "native survives UI failure");
});

// --- manager integration --------------------------------------------------------------------

const workerType: AgentType = { name: "worker", description: "test", systemPrompt: "child prompt" };

function managerHarness(onActivity?: (a: ThreadActivity) => void) {
  const events: ThreadEvent[] = [];
  const drivers: { options: DriverOptions; release(): void }[] = [];
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: () => workerType,
    toolsFor: () => [],
    onEvent: (event) => events.push(event),
    onActivity,
    createDriver: async (options) => {
      let release = () => {};
      drivers.push({ options, release: () => release() });
      const driver: AgentDriver = {
        prompt: () => new Promise<void>((resolve) => (release = resolve)),
        steer: async () => {},
        snapshot: () => [],
        output: () => "answer",
        abort: async () => release(),
        dispose: () => {},
        sendUpdate: () => {},
      };
      return driver;
    },
  });
  const start = async (path = "/root/w") => {
    await manager.spawn("/root", { path, type: "worker", task: "Fix the flaky test", wait: false });
    for (let i = 0; i < 20 && manager.get(path).state !== "running"; i++) await flush();
    return drivers.at(-1)!;
  };
  return { manager, events, drivers, start };
}

test("manager offers bounded recent activity with detail and a per-run id", async () => {
  const seen: ThreadActivity[] = [];
  const { manager, start } = managerHarness((a) => seen.push(a));
  const driver = await start();
  driver.options.onEvent({ kind: "activity", text: "Tool: bash", detail: "npm test" });
  driver.options.onEvent({ kind: "error", text: "Tool bash: failed" });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], {
    path: "/root/w",
    type: "worker",
    task: "Fix the flaky test",
    run: 1,
    recent: ["Tool: bash npm test", "Tool bash: failed"],
  });
  for (let i = 0; i < 20; i++) driver.options.onEvent({ kind: "activity", text: `step ${i}` });
  assert.equal(seen.at(-1)!.recent.length, 12);
  assert.equal(seen.at(-1)!.recent.at(-1), "step 19");
  // The raw status is untouched by the feature.
  assert.equal(manager.get("/root/w").status, "step 19");
  driver.release();
  await manager.wait("/root", "/root/w");
  await manager.shutdown();
});

test("an activity-listener failure never disturbs the run", async () => {
  const { manager, start } = managerHarness(() => {
    throw new Error("listener blew up");
  });
  const driver = await start();
  driver.options.onEvent({ kind: "activity", text: "Tool: ls" });
  assert.equal(manager.get("/root/w").status, "Tool: ls");
  driver.release();
  assert.equal((await manager.wait("/root", "/root/w")).state, "completed");
  await manager.shutdown();
});

test("setSummary is live-only, run-scoped, display-only and never persisted", async () => {
  const { manager, events, start } = managerHarness();
  const driver = await start();
  driver.options.onEvent({ kind: "activity", text: "Tool: bash", detail: "npm test" });
  assert.equal(manager.setSummary("/root/w", 99, "Wrong run"), false, "stale run");
  assert.equal(manager.setSummary("/root/missing", 1, "No thread"), false);
  assert.equal(manager.setSummary("/root/w", 1, "  \n "), false);
  const before = events.length;
  assert.equal(manager.setSummary("/root/w", 1, "Running\nthe   tests"), true);
  assert.equal(manager.get("/root/w").summary, "Running the tests");
  assert.equal(manager.get("/root/w").status, "Tool: bash", "raw status preserved alongside");
  assert.deepEqual(
    events.slice(before).map((event) => event.kind),
    ["metrics"],
    "UI-only refresh; no persistence churn",
  );
  assert.equal(manager.setSummary("/root/w", 1, "Running the tests"), true);
  assert.equal(events.length, before + 1, "unchanged summary is not re-emitted");
  const saved = manager.saved()[0]!;
  assert.equal("summary" in saved.view, false);
  assert.doesNotMatch(JSON.stringify(manager.saved()), /Running the tests/);
  // Explicit progress reports outrank the generated line until fresh activity.
  manager.update("/root/w", "Reporting in");
  assert.equal(manager.get("/root/w").summary, undefined);
  assert.equal(manager.get("/root/w").status, "Reporting in");
  manager.setSummary("/root/w", 1, "Another label");
  manager.clearSummaries();
  assert.equal(manager.get("/root/w").summary, undefined);
  manager.setSummary("/root/w", 1, "Before finishing");
  driver.release();
  const done = await manager.wait("/root", "/root/w");
  assert.equal(done.summary, undefined, "settled agents show their real status");
  assert.equal(done.status, "Completed; session retained");
  assert.equal(manager.setSummary("/root/w", 1, "Too late"), false);
  await manager.shutdown();
});

test("resuming starts a new run: old summaries and run ids no longer apply", async () => {
  const { manager, drivers, start } = managerHarness();
  const first = await start();
  manager.setSummary("/root/w", 1, "First run");
  first.release();
  await manager.wait("/root", "/root/w");
  await manager.steer("/root", "/root/w", "Continue");
  for (let i = 0; i < 20 && manager.get("/root/w").state !== "running"; i++) await flush();
  assert.equal(manager.get("/root/w").summary, undefined);
  assert.equal(manager.setSummary("/root/w", 1, "Old run id"), false);
  assert.equal(manager.setSummary("/root/w", 2, "Second run"), true);
  drivers.at(-1)!.release();
  await manager.shutdown();
});

test("restored registries carry no summaries", async () => {
  const { manager, start } = managerHarness();
  const driver = await start();
  manager.setSummary("/root/w", 1, "Live only");
  const saved = manager.saved();
  driver.release();
  await manager.shutdown();
  const restored = managerHarness().manager;
  restored.restore(saved);
  assert.equal(restored.get("/root/w").summary, undefined);
});

test("an unsuccessful refresh clears the previous summary: failure, empty answer, timeout", async (t) => {
  const { summarizer, calls, applied, cleared } = harness(t, { timeoutMs: 5_000 });
  const next = async (label: string, wait = 30_000) => {
    summarizer.notify(activity("/root/a", 3, label));
    t.mock.timers.tick(wait);
    await flush();
    return calls.at(-1)!;
  };
  (await next("first", 1500)).resolve("Good label");
  await flush();
  assert.deepEqual(applied, [["/root/a", 3, "Good label"]]);
  assert.deepEqual(cleared, []);

  (await next("provider error")).reject(new Error("503"));
  await flush();
  assert.deepEqual(cleared, [["/root/a", 3]], "failure clears");

  (await next("recovered", 60_000)).resolve("Second good label");
  await flush();
  assert.equal(applied.at(-1)![2], "Second good label");
  assert.equal(cleared.length, 1);

  (await next("empty answer")).resolve("   ");
  await flush();
  assert.equal(cleared.length, 2, "empty answer clears");

  const afterEmpty = await next("after empty");
  assert.doesNotMatch(afterEmpty.user, /Previous label/, "cleared labels are not fed back");
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(afterEmpty.signal.aborted, true);
  assert.equal(cleared.length, 3, "timeout clears");
});

test("unavailable detection clears the shown summary at notify time and when the timer fires", async (t) => {
  const { summarizer, calls, cleared, setEnabled } = harness(t, { reply: () => "Label" });
  summarizer.notify(activity("/root/a", 1, "one"));
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(calls.length, 1);
  setEnabled(false);
  summarizer.notify(activity("/root/a", 1, "two"));
  assert.deepEqual(cleared, [["/root/a", 1]], "detected on activity");
  assert.equal(summarizer.inFlight, 0);
  setEnabled(true);
  summarizer.notify(activity("/root/b", 2, "b"));
  setEnabled(false);
  t.mock.timers.tick(1500);
  await flush();
  assert.deepEqual(cleared.at(-1), ["/root/b", 2], "detected when the debounce fires");
  assert.equal(calls.length, 1);
});

test("aborted work (settle, new run) does not clear", async (t) => {
  const { summarizer, calls, cleared } = harness(t);
  summarizer.notify(activity("/root/a", 1, "a"));
  t.mock.timers.tick(1500);
  await flush();
  summarizer.settle("/root/a");
  summarizer.notify(activity("/root/b", 1, "b"));
  t.mock.timers.tick(1500);
  await flush();
  summarizer.notify(activity("/root/b", 2, "b2"));
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(cleared, []);
});

test("a throwing clear callback never breaks scheduling", async (t) => {
  const { summarizer, calls } = harness(t, {
    clear: () => {
      throw new Error("ui gone");
    },
  });
  summarizer.notify(activity("/root/a", 1, "a"));
  t.mock.timers.tick(1500);
  await flush();
  calls[0]!.reject(new Error("boom"));
  await flush();
  assert.equal(summarizer.inFlight, 0);
  summarizer.notify(activity("/root/a", 1, "b"));
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls.length, 2);
});

test("clearSummary removes only the matching run's label and is silent otherwise", async () => {
  const { manager, events, start } = managerHarness();
  const driver = await start();
  assert.equal(manager.clearSummary("/root/w", 1), false, "none shown");
  manager.setSummary("/root/w", 1, "Label");
  const before = events.length;
  assert.equal(manager.clearSummary("/root/w", 2), false, "other run");
  assert.equal(manager.clearSummary("/root/nope", 1), false);
  assert.equal(events.length, before);
  assert.equal(manager.clearSummary("/root/w", 1), true);
  assert.equal(manager.get("/root/w").summary, undefined);
  assert.deepEqual(
    events.slice(before).map((event) => event.kind),
    ["metrics"],
  );
  driver.release();
  await manager.shutdown();
});
