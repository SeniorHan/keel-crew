import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDriverFactory } from "../src/orch/runtime.ts";
import { formatRecoveryReport, isRunInterrupted } from "../src/orch/interrupted.ts";
import type { AgentDriver, DriverEvent, DriverOptions } from "../src/types.ts";

const PROVIDER = "recovery-test";

const message = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "answer" }],
  provider: PROVIDER,
  model: "only",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 5,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 7,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  ...overrides,
});

type Script = (stream: AssistantMessageEventStream) => void;

/** Answers with `text` and closes the turn normally. */
const answers =
  (text: string): Script =>
  (stream) => {
    const reply = message({ content: [{ type: "text", text }] });
    stream.push({ type: "start", partial: { ...reply, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...reply, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: reply });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: reply });
    stream.push({ type: "done", reason: "stop", message: reply });
    stream.end(reply);
  };

/** Streams partial output, then dies the way a dropped upstream connection looks. */
const interruptedAfterOutput =
  (partialText: string): Script =>
  (stream) => {
    const partial = message({ content: [{ type: "text", text: partialText }] });
    stream.push({ type: "start", partial: { ...partial, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: partialText, partial });
    const failure = message({ content: [], stopReason: "aborted" });
    stream.push({ type: "error", reason: "aborted", error: failure });
    stream.end(failure);
  };

/** Fails before any output, like a rate-limited first token. */
const interruptedBeforeOutput = (): Script => (stream) => {
  const failure = message({ content: [], stopReason: "aborted" });
  stream.push({ type: "start", partial: { ...failure, content: [] } });
  stream.push({ type: "error", reason: "aborted", error: failure });
  stream.end(failure);
};

const modelError =
  (errorMessage: string): Script =>
  (stream) => {
    const failure = message({ content: [], stopReason: "error", errorMessage });
    stream.push({ type: "start", partial: { ...failure, content: [] } });
    stream.push({ type: "error", reason: "error", error: failure });
    stream.end(failure);
  };

interface Harness {
  factory: ReturnType<typeof createDriverFactory>;
  events: DriverEvent[];
  requests: number;
  script(scripts: Script[]): void;
  options(overrides?: Partial<DriverOptions>): DriverOptions;
  create(overrides?: Partial<DriverOptions>): Promise<AgentDriver>;
  root: SessionManager;
  cleanup(): Promise<void>;
}

const harness = async (): Promise<Harness> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-recovery-"));
  const cwd = path.join(directory, "workspace");
  await mkdir(cwd, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: path.join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  let queue: Script[] = [];
  const events: DriverEvent[] = [];
  const state = { requests: 0 };
  registry.registerProvider(PROVIDER, {
    api: "openai-completions",
    baseUrl: "http://invalid.local",
    models: [
      {
        id: "only",
        name: "recovery/only",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
    streamSimple(_model: Model<any>, _context, _options) {
      state.requests += 1;
      const run = queue.shift();
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await Promise.resolve();
        if (!run) {
          answers("unscripted")(stream);
          return;
        }
        run(stream);
      })();
      return stream;
    },
  });
  await runtime.setRuntimeApiKey(PROVIDER, "recovery-test-key");
  await registry.refresh({ allowNetwork: false });
  const root = SessionManager.create(cwd, path.join(directory, "root"));
  const ctx = {
    cwd,
    sessionManager: root,
    modelRegistry: registry,
    model: registry.find(PROVIDER, "only"),
    scopedModels: [{ model: registry.find(PROVIDER, "only") }],
    thinkingLevel: "low",
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;
  const factory = createDriverFactory(() => ctx);
  const drivers: AgentDriver[] = [];
  const options = (overrides: Partial<DriverOptions> = {}): DriverOptions => ({
    path: "/root/worker",
    parentPath: "/root",
    type: {
      name: "worker",
      description: "Recovery test",
      systemPrompt: "ONLY CHILD PROMPT",
      tools: { allow: [] },
    },
    inherited: [],
    tools: [],
    onEvent: (event) => events.push(event),
    shouldPause: () => false,
    signal: new AbortController().signal,
    // Keep the suite fast and deterministic: the request wrapper is exercised in its own
    // suite, so here every drop reaches the turn-level recovery.
    streamRetryBackoffMs: [],
    recoveryBackoffMs: [0, 0, 0],
    ...overrides,
  });
  return {
    factory,
    events,
    get requests() {
      return state.requests;
    },
    script: (scripts) => {
      queue = [...scripts];
    },
    options,
    create: async (overrides = {}) => {
      const driver = await factory(options(overrides));
      drivers.push(driver);
      return driver;
    },
    root,
    cleanup: async () => {
      for (const driver of drivers) {
        driver.dispose();
        await driver.abort();
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("an interrupted turn is replayed losslessly from the same session", async () => {
  const h = await harness();
  try {
    h.script([interruptedAfterOutput("half-written report"), answers("recovered answer")]);
    const driver = await h.create();
    await driver.prompt("do the work");
    assert.equal(driver.output(), "recovered answer");
    // Two requests: the interrupted turn, then the resumed one.
    assert.equal(h.requests, 2);
    // The abandoned attempt never becomes part of the model context...
    assert.ok(
      !driver
        .snapshot()
        .some((entry) => (entry as { stopReason?: string }).stopReason === "aborted"),
    );
    // ...but the session file still records it, plus the edit that hid it.
    const checkpoint = h.events.find((event) => event.kind === "checkpoint");
    assert.ok(checkpoint?.kind === "checkpoint" && checkpoint.sessionFile);
    const entries = SessionManager.open(checkpoint.sessionFile!).getEntries();
    assert.ok(
      entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "aborted",
      ),
      "the interrupted turn must stay in the transcript",
    );
    assert.ok(
      entries.some((entry) => entry.type === "context_edit" && entry.replacement === null),
      "the interrupted turn is hidden with a context edit",
    );
    const recovery = h.events.filter((event) => event.kind === "recovery");
    assert.deepEqual(
      recovery.map((event) => (event.kind === "recovery" ? event.phase : "")),
      ["retry", "recovered"],
    );
    const retry = recovery[0]!;
    assert.equal(retry.kind === "recovery" ? retry.reasons[0] : undefined, "upstream-interrupted");
    assert.equal(retry.kind === "recovery" ? retry.maxAttempts : undefined, 3);
  } finally {
    await h.cleanup();
  }
});

test("recovery stops at three attempts and the failure says why", async () => {
  const h = await harness();
  try {
    h.script([
      interruptedAfterOutput("attempt one"),
      interruptedBeforeOutput(),
      interruptedBeforeOutput(),
      interruptedBeforeOutput(),
    ]);
    const driver = await h.create();
    const error = await driver.prompt("doomed").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(isRunInterrupted(error), "the driver must report a faithful interruption");
    assert.equal(error.reason, "upstream-interrupted");
    assert.equal(error.recovery.attempts, 3);
    assert.match(error.message, /3 lossless recovery attempts \(4 runs total\)/);
    const report = formatRecoveryReport(error);
    assert.equal(report.split("\n")[0], "failed after 3 lossless recovery attempts; 4 runs total.");
    // Spend figures never reach the parent model: they nudge it toward frugality.
    assert.doesNotMatch(report, /tokens?|budget|\$/i);
    // One original run plus three recoveries.
    assert.equal(h.requests, 4);
    assert.ok(!h.events.some((event) => event.kind === "recovery" && event.phase === "recovered"));
  } finally {
    await h.cleanup();
  }
});

test("an interruption that never produced output is retried at the request level", async () => {
  const h = await harness();
  try {
    h.script([interruptedBeforeOutput(), answers("first-token retry")]);
    const driver = await h.create({ streamRetryBackoffMs: [0] });
    await driver.prompt("work");
    assert.equal(driver.output(), "first-token retry");
    // A single turn-level run: the request wrapper absorbed the drop.
    assert.ok(!h.events.some((event) => event.kind === "recovery"));
  } finally {
    await h.cleanup();
  }
});

test("a quota failure is reported as a model error and not retried", async () => {
  const h = await harness();
  try {
    h.script([modelError("insufficient_quota: out of budget")]);
    const driver = await h.create();
    const error = await driver.prompt("work").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(isRunInterrupted(error));
    assert.equal(error.reason, "model-error");
    assert.equal(error.recovery.attempts, 0);
    assert.match(error.providerMessage ?? "", /insufficient_quota/);
    assert.equal(h.requests, 1);
  } finally {
    await h.cleanup();
  }
});

test("a local stop is never recovered", async () => {
  const h = await harness();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.script([
      (stream) => {
        const reply = message({ content: [{ type: "text", text: "late" }] });
        stream.push({ type: "start", partial: { ...reply, content: [] } });
        void gate.then(() => {
          stream.push({ type: "text_delta", contentIndex: 0, delta: "late", partial: reply });
          stream.push({ type: "done", reason: "stop", message: reply });
          stream.end(reply);
        });
      },
      answers("must not run"),
    ]);
    const driver = await h.create();
    const run = driver.prompt("work");
    await driver.abort();
    release();
    await assert.rejects(run, /aborted/);
    assert.equal(h.requests, 1);
    assert.ok(!h.events.some((event) => event.kind === "recovery"));
  } finally {
    await h.cleanup();
  }
});

test("a paused run is not recovered and keeps its session for the next task", async () => {
  const h = await harness();
  try {
    let paused = false;
    h.script([answers("paused answer"), answers("resumed answer")]);
    const driver = await h.create({ shouldPause: () => paused });
    paused = true;
    await driver.prompt("work");
    assert.equal(driver.output(), "");
    assert.ok(!h.events.some((event) => event.kind === "recovery"));
    paused = false;
    await driver.prompt("more work");
    assert.equal(driver.output(), "resumed answer");
  } finally {
    await h.cleanup();
  }
});
