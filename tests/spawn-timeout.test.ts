import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadManager } from "../src/orch/manager.ts";
import type { ThreadEvent } from "../src/types.ts";
import { agentTools } from "../src/orch/tools.ts";

function setup() {
  const events: ThreadEvent[] = [];
  const gates: Array<(error?: Error) => void> = [];
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "t", systemPrompt: "t" }),
    toolsFor: () => [],
    onEvent: (event) => events.push(event),
    createDriver: async () => {
      let release: (error?: Error) => void = () => {};
      return {
        prompt: () =>
          new Promise<void>((resolve, reject) => {
            release = (e) => (e ? reject(e) : resolve());
            gates.push(release);
          }),
        steer: async () => {},
        snapshot: () => [
          {
            role: "assistant",
            content: [{ type: "text", text: "partial work" }],
            timestamp: 0,
          } as any,
        ],
        output: () => "done",
        abort: async () => release(),
        dispose: () => {},
        sendUpdate: () => {},
      };
    },
  });
  const spawn = (path: string, timeout?: number) =>
    manager.spawn("/root", {
      path,
      type: "w",
      task: "task",
      wait: false,
      timeout,
    });
  const timeouts = () => events.filter((e) => e.kind === "timeout");
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return { manager, events, gates, spawn, timeouts, flush };
}

test("timeout reports state to the parent without stopping the child", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  await spawn("a", 30);
  await flush();
  t.mock.timers.tick(29_999);
  assert.equal(timeouts().length, 0);
  t.mock.timers.tick(1);
  const [event] = timeouts() as Extract<ThreadEvent, { kind: "timeout" }>[];
  assert.equal(event!.thread.state, "running");
  assert.equal(event!.recipient, "/root");
  assert.equal(event!.timeout, 30);
  assert.match(event!.recentOutput, /partial work/);
  assert.equal(manager.get("a").state, "running", "child keeps running");
  gates[0]!();
  await manager.wait("/root", "a");
  await manager.shutdown();
});

test("timer is cleared on completion, failure, stop and shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  for (const name of ["done", "failed", "stopped", "alive"])
    await spawn(name, 60);
  await flush();
  gates[0]!();
  gates[1]!(new Error("boom"));
  await manager.wait("/root", "done");
  await manager.wait("/root", "failed").catch(() => {});
  await manager.stop("/root", "stopped");
  t.mock.timers.tick(60_000);
  assert.deepEqual(
    timeouts().map((e) => e.thread.path),
    ["/root/alive"],
    "only the live child reports",
  );
  await spawn("late", 60);
  await manager.shutdown();
  t.mock.timers.tick(120_000);
  assert.equal(timeouts().length, 1, "shutdown clears pending timers");
});

test("steer timeout-only re-arms from now; invalid ranges are rejected; 0 re-arms at the default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  for (const bad of [-1, 301, 1.5, Number.NaN])
    await assert.rejects(
      spawn(`bad${bad}`, bad),
      /timeout must be an integer between 0/,
    );
  await spawn("plain");
  await spawn("a", 30);
  await flush();
  t.mock.timers.tick(20_000);
  for (const bad of [-1, 301])
    await assert.rejects(
      manager.steer("/root", "a", undefined, bad),
      /between 0/,
    );
  await manager.steer("/root", "a", undefined, 60);
  t.mock.timers.tick(59_999);
  assert.equal(
    timeouts().filter((e) => e.thread.path === "/root/a").length,
    0,
    "old deadline replaced",
  );
  t.mock.timers.tick(1);
  assert.deepEqual(
    timeouts()
      .filter((e) => e.thread.path === "/root/a")
      .map((e) => e.timeout),
    [60],
  );
  assert.deepEqual(
    timeouts()
      .filter((e) => e.thread.path === "/root/plain")
      .map((e) => e.timeout),
    [60],
    "plain child fires at the 60s default",
  );
  gates.forEach((g) => g());
  await manager.wait("/root", "a");
  await assert.rejects(
    manager.steer("/root", "a", undefined, 30),
    /working agent/,
  );
  await assert.rejects(
    manager.steer("/root", "a"),
    /message, timeout, or both/,
  );
  await manager.shutdown();
});

test("settled events flag detached spawns; outstandingAsync tracks them", async () => {
  const { manager, events, gates, spawn, flush } = setup();
  await spawn("bg");
  await flush();
  assert.equal(manager.outstandingAsync(), 1);
  gates[0]!();
  await manager.wait("/root", "bg");
  await flush();
  assert.equal(manager.outstandingAsync(), 0);
  const settled = events.find((e) => e.kind === "settled") as any;
  assert.equal(settled.async, true);
  await manager.shutdown();
});

test("tool schemas expose timeout/budgetTokens and steer timeout with report-only bounds", () => {
  const tools = agentTools(
    () => ({}) as any,
    "/root",
    () => [],
    () => ({}) as any,
  );
  const spawn = tools.find((t) => t.name === "agent_spawn")!;
  const timeout = (spawn.parameters as any).properties.timeout;
  assert.equal(timeout.minimum, 0);
  assert.equal(timeout.maximum, 300);
  assert.deepEqual((spawn.parameters as any).required, [
    "path",
    "type",
    "task",
    "timeout",
    "budgetTokens",
  ]);
  const budget = (spawn.parameters as any).properties.budgetTokens;
  assert.equal(budget.minimum, 0);
  assert.equal(
    tools.find((t) => t.name === "agent_extend_timeout"),
    undefined,
  );
  const steer = tools.find((t) => t.name === "agent_steer")!;
  assert.equal((steer.parameters as any).properties.timeout.minimum, 0);
  assert.equal((steer.parameters as any).properties.timeout.maximum, 300);
  assert.deepEqual((steer.parameters as any).required, ["path"]);
});

test("legacy timeoutMs param is still accepted at the execute layer and normalized to seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, timeouts, flush } = setup();
  const tools = agentTools(
    () => manager,
    "/root",
    () => [],
    () => ({}) as any,
  );
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.find((tool) => tool.name === name)!.execute as any)(
      "t0",
      params,
      undefined,
    );
  try {
    await call("agent_spawn", {
      path: "legacy",
      type: "w",
      task: "task",
      wait: false,
      timeoutMs: 30_000,
      budgetTokens: 0,
    });
    await flush();
    t.mock.timers.tick(29_999);
    assert.equal(
      timeouts().length,
      0,
      "30000ms normalized to 30s, not read as 30000s",
    );
    t.mock.timers.tick(1);
    assert.deepEqual(
      timeouts().map((e) => (e as any).timeout),
      [30],
    );
    const snapshotPending = call("agent_wait", {
      path: "legacy",
      timeoutMs: 0,
    });
    t.mock.timers.tick(0);
    const snapshot = await snapshotPending;
    assert.ok(
      snapshot,
      "legacy agent_wait timeoutMs=0 returns the current snapshot immediately",
    );
    await call("agent_steer", { path: "legacy", timeoutMs: 45_000 });
    t.mock.timers.tick(44_999);
    assert.equal(timeouts().length, 1, "legacy steer timeoutMs re-arms at 45s");
    gates.forEach((g) => g());
    await manager.wait("/root", "legacy");
  } finally {
    await manager.shutdown();
  }
});

test("steer with message and timeout steers and re-arms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, gates, spawn, timeouts, flush } = setup();
  await spawn("a", 30);
  await flush();
  t.mock.timers.tick(20_000);
  await manager.steer("/root", "a", "keep going", 60);
  t.mock.timers.tick(59_999);
  assert.equal(timeouts().length, 0);
  t.mock.timers.tick(1);
  assert.equal(timeouts().length, 1);
  gates.forEach((g) => g());
  await manager.shutdown();
});

test("steering and timer-only rearming leave a running foreground spawn foreground", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, events, gates, timeouts, flush } = setup();
  try {
    const completion = manager.spawn("/root", {
      path: "fg",
      type: "w",
      task: "task",
    });
    await flush();
    assert.equal(manager.outstandingAsync(), 0);
    await manager.steer("/root", "fg", "queued steering");
    await manager.steer("/root", "fg", undefined, 30);
    assert.equal(
      manager.outstandingAsync(),
      0,
      "neither operation detaches the current run",
    );
    t.mock.timers.tick(30_000);
    assert.equal(timeouts().length, 1, "report-only timer still reports");
    assert.equal(manager.get("fg").state, "running");
    gates[0]!();
    await completion;
    const settled = events.filter(
      (event): event is Extract<ThreadEvent, { kind: "settled" }> =>
        event.kind === "settled",
    );
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.async, false);
  } finally {
    await manager.shutdown();
  }
});

for (const state of ["completed", "paused", "failed", "stopped"] as const) {
  test(`resuming a restored ${state} thread marks the new run detached`, async () => {
    const { manager, events, gates, flush } = setup();
    try {
      manager.restore([
        {
          view: {
            path: "/root/retained",
            parent: "/root",
            owner: "/root",
            type: "w",
            state,
            task: "task",
            status: "Retained",
            createdAt: 0,
          },
          definition: { name: "w", description: "test", systemPrompt: "test" },
          inherited: [],
        },
      ]);
      await manager.steer("/root", "retained", "resume");
      assert.equal(
        manager.outstandingAsync(),
        1,
        "new run immediately blocks premature recap",
      );
      await flush();
      gates[0]!();
      await manager.wait("/root", "retained");
      assert.equal(manager.outstandingAsync(), 0);
      const settled = events.filter(
        (event): event is Extract<ThreadEvent, { kind: "settled" }> =>
          event.kind === "settled",
      );
      assert.equal(settled.length, 1);
      assert.equal(settled[0]!.async, true);
    } finally {
      await manager.shutdown();
    }
  });
}
