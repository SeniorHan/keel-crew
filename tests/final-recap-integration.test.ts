import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

const UPDATE = "pi-subagent:update";
const SUMMARY = "pi-subagent:final-recap";
const MAILBOX = "pi-subagent:root-mailbox:v1";
const WAKE = "pi-subagent:wake";
const worker = "---\nname: worker\ndescription: Execute work\ntools:\n  allow: [agent_update]\n---\nExecute your assigned task.\n";
const answer = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }],
  provider: "integration-test", model: "offline", api: "openai-completions",
  stopReason: "stop", timestamp: Date.now(),
  usage: {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const toolUse = (id: string, name: string, args: JsonObject): AssistantMessage => ({
  ...answer(""), stopReason: "toolUse",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const spawn = (count = 1, wait = false): AssistantMessage => ({
  ...answer(""), stopReason: "toolUse",
  content: Array.from({ length: count }, (_, i) => ({
    type: "toolCall", id: `spawn-${i}`, name: "agent_spawn",
    arguments: { path: `worker-${i}`, type: "worker", task: `Task ${i}`, wait, timeout: 0, budgetTokens: 0 },
  })),
});
const timedSpawn = (count = 1): AssistantMessage => ({
  ...answer(""), stopReason: "toolUse",
  content: Array.from({ length: count }, (_, i) => ({
    type: "toolCall", id: `timed-spawn-${i}`, name: "agent_spawn",
    arguments: { path: `worker-${i}`, type: "worker", task: `Task ${i}`, wait: false, timeout: 300, budgetTokens: 0 },
  })),
});
const summaryIds = (manager: SessionManager) => messages(manager, SUMMARY).map(
  (entry) => (entry.details as { mailboxIds: string[] }).mailboxIds,
);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const flushTimers = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const messages = (manager: SessionManager, customType: string) => manager.getBranch().filter(
  (entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
    entry.type === "custom_message" && entry.customType === customType,
);
const mailbox = (manager: SessionManager) => manager.getBranch().filter(
  (entry) => entry.type === "custom" && entry.customType === MAILBOX,
);
function assertLastVisible(manager: SessionManager, text: string) {
  const last = manager.getBranch().filter((entry) =>
    entry.type === "message" || (entry.type === "custom_message" && entry.display)).at(-1);
  assert.ok(last?.type === "message" && last.message.role === "assistant",
    "the main assistant must own the last visible message");
  assert.deepEqual(last.message.content, [{ type: "text", text }]);
}
async function reload(session: AgentSession) {
  await session.extensionRunner.getCommand("agents")!.handler(
    "reload", session.extensionRunner.createCommandContext(),
  );
}

test("Final Recap batches idle detached completions, not progress, and persists consumption across reload/reopen", { timeout: 15000 }, async () => {
  const children = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
  let rootCalls = 0;
  await withOfflineHarness({
    agentFiles: { worker }, managerSettings: { finalRecap: true },
    onRequest(request) {
      if (request.path) {
        const i = Number(request.path.at(-1));
        return request.pathCall === 1
          ? toolUse(`progress-${i}`, "agent_update", { message: `Progress ${i}` })
          : children[i]!.promise;
      }
      rootCalls++;
      if (rootCalls === 1) return spawn(2);
      if (rootCalls === 2) return answer("Initial root answer");
      assert.equal(rootCalls, 3, "exactly one automatic summary request");
      assert.match(request.messagesText, /Worker 0 result/);
      assert.match(request.messagesText, /Worker 1 result/);
      return answer("Root combined summary");
    },
  }, async ({ cwd, open, close, requests, errors }) => {
    const session = await open(SessionManager.create(cwd));
    try {
      await session.prompt("Delegate parallel work");
      await waitFor(() => requests.filter((r) => r.path && r.pathCall === 2).length === 2, "both children waiting");
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 2, "progress alone does not wake root");
      assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
      children.forEach((child, i) => child.resolve(answer(`Worker ${i} result`)));
      await waitFor(() => messages(session.sessionManager, SUMMARY).length === 1 && session.isIdle, "combined summary settled");
      assert.equal(requests.filter((r) => !r.path).length, 3);
      assertLastVisible(session.sessionManager, "Root combined summary");
      assert.ok(messages(session.sessionManager, UPDATE).every((entry) => !entry.display));
      const summary = messages(session.sessionManager, SUMMARY)[0]!;
      assert.equal(summary.display, false);
      const ids = (summary.details as { mailboxIds: string[] }).mailboxIds;
      assert.equal(new Set(ids).size, 2, "one batch consumes both completion IDs, not progress");
      const completions = messages(session.sessionManager, UPDATE).filter((entry) =>
        (entry.details as { state: string }).state === "completed");
      assert.deepEqual(new Set(ids), new Set(completions.map((entry) =>
        (entry.details as { mailboxId: string }).mailboxId)));
      await reload(session);
      await reload(session);
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 3, "reload does not repeat a consumed batch");
      const file = session.sessionManager.getSessionFile()!;
      await close(session);
      const restored = await open(SessionManager.open(file));
      await reload(restored);
      await flushTimers();
      assert.equal(messages(restored.sessionManager, SUMMARY).length, 1);
      assert.equal(requests.filter((r) => !r.path).length, 3, "reopen does not repeat a consumed batch");
      assertLastVisible(restored.sessionManager, "Root combined summary");
      assert.deepEqual(errors, []);
    } finally {
      children.forEach((child, i) => child.resolve(answer(`Worker ${i} result`)));
    }
  });
});

test("recap waits until all outstanding async agents have reported, then runs once", { timeout: 15000 }, async () => {
  const children = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
  let rootCalls = 0;
  await withOfflineHarness({
    agentFiles: { worker }, managerSettings: { finalRecap: true },
    onRequest(request) {
      if (request.path) return children[Number(request.path.at(-1))]!.promise;
      rootCalls++;
      if (rootCalls === 1) return spawn(2);
      if (rootCalls === 2) return answer("Initial root answer");
      assert.equal(rootCalls, 3, "a single recap after the last completion");
      assert.match(request.messagesText, /First child result/);
      assert.match(request.messagesText, /Second child result/);
      return answer("Final root summary");
    },
  }, async ({ cwd, open, requests, errors }) => {
    const session = await open(SessionManager.create(cwd));
    try {
      await session.prompt("Delegate parallel work");
      children[0]!.resolve(answer("First child result"));
      await waitFor(() => mailbox(session.sessionManager).length === 1, "first completion retained");
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 2, "no recap while a sibling is outstanding");
      assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
      children[1]!.resolve(answer("Second child result"));
      await waitFor(() => requests.filter((r) => !r.path).length === 3 && session.isIdle, "recap settled");
      const summaries = messages(session.sessionManager, SUMMARY);
      assert.equal(summaries.length, 1);
      assert.equal((summaries[0]!.details as { mailboxIds: string[] }).mailboxIds.length, 2);
      assertLastVisible(session.sessionManager, "Final root summary");
      await flushTimers();
      assert.equal(requests.filter((r) => !r.path).length, 3, "no summary loop");
      assert.deepEqual(errors, []);
    } finally {
      children.forEach((child, i) => child.resolve(answer(`Cleanup ${i}`)));
    }
  });
});

for (const foreground of [true, false]) {
  test(`Final Recap ${foreground ? "does not add a turn for foreground" : "recaps once after the root settles for detached root-busy"} completion`, { timeout: 15000 }, async () => {
    const child = deferred<AssistantMessage>();
    const root = deferred<AssistantMessage>();
    let rootCalls = 0;
    await withOfflineHarness({
      agentFiles: { worker }, managerSettings: { finalRecap: true },
      onRequest(request) {
        if (request.path) return child.promise;
        rootCalls++;
        if (rootCalls === 1) return spawn(1, foreground);
        if (rootCalls === 2) return root.promise;
        return answer("Recap after busy root");
      },
    }, async ({ cwd, open, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      const prompt = session.prompt("Delegate work before answering");
      try {
        await waitFor(() => requests.some((r) => r.path), "child starts");
        if (!foreground) await waitFor(() => requests.some((r) => !r.path && r.pathCall === 2), "root streaming");
        child.resolve(answer("Completed while root busy"));
        await waitFor(() => mailbox(session.sessionManager).length === 1, "completion retained");
        root.resolve(answer("Normal root final answer"));
        await prompt;
        await flushTimers();
        if (foreground) {
          assert.equal(requests.filter((r) => !r.path).length, 2);
          assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
          assertLastVisible(session.sessionManager, "Normal root final answer");
        } else {
          await waitFor(() => messages(session.sessionManager, SUMMARY).length === 1 && session.isIdle, "recap after root settles");
          assert.equal(requests.filter((r) => !r.path).length, 3);
          assertLastVisible(session.sessionManager, "Recap after busy root");
        }
        assert.deepEqual(errors, []);
      } finally {
        child.resolve(answer("Cleanup"));
        root.resolve(answer("Normal root final answer"));
        await prompt;
      }
    });
  });
}

test("shutdown cancels a queued summary before opening a new session", { timeout: 15000 }, async () => {
  await withOfflineHarness({
    agentFiles: { worker }, managerSettings: { finalRecap: true },
    onRequest() { assert.fail("a summary must not run across a session switch"); },
  }, async ({ cwd, open, close, requests, errors }) => {
    const session = await open(SessionManager.create(cwd));
    const oldId = session.sessionManager.getSessionId();
    session.sessionManager.appendCustomEntry(MAILBOX, {
      rootSessionId: oldId,
      content: "Retained asynchronous result",
      finalRecap: true,
      details: { mailboxId: "queued-completion", path: "/root/worker", state: "completed" },
    });
    await reload(session);
    assert.equal(messages(session.sessionManager, UPDATE).length, 1);
    assert.equal(messages(session.sessionManager, SUMMARY).length, 0, "summary is deferred");
    await close(session);
    const next = await open(SessionManager.create(cwd));
    await flushTimers();
    assert.notEqual(next.sessionManager.getSessionId(), oldId);
    assert.equal(requests.length, 0);
    assert.equal(messages(next.sessionManager, SUMMARY).length, 0);
    assert.deepEqual(errors, []);
  });
});

for (const suppression of ["finalRecap", "off"] as const) {
  test(`Final Recap is suppressed by ${suppression} and off-mode results replay only once`, { timeout: 15000 }, async () => {
    const child = deferred<AssistantMessage>();
    let rootCalls = 0;
    await withOfflineHarness({
      agentFiles: { worker }, managerSettings: { finalRecap: true },
      onRequest(request) {
        if (request.path) return child.promise;
        rootCalls++;
        if (rootCalls === 1) return spawn();
        if (rootCalls === 2) return answer("Initial root answer");
        assert.equal(rootCalls, 3, "at most one summary after enabling");
        assert.match(request.messagesText, /Retained child result/);
        return answer("Replayed root summary");
      },
    }, async ({ directory, cwd, open, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      try {
        await session.prompt("Delegate background work");
        const settingsFile = join(directory, "keel-crew", "settings.json");
        await writeFile(settingsFile, JSON.stringify(suppression === "off"
          ? { finalRecap: true, subagentMode: "off" } : { finalRecap: false }));
        await reload(session);
        child.resolve(answer("Retained child result"));
        await waitFor(() => mailbox(session.sessionManager).length === 1, "completion retained under suppression");
        await flushTimers();
        // With recap disabled the async completion simply wakes the root (3rd request);
        // in off mode nothing is delivered.
        if (suppression === "finalRecap") await waitFor(() => requests.filter((r) => !r.path).length === 3, "completion wakes root");
        assert.equal(requests.filter((r) => !r.path).length, suppression === "off" ? 2 : 3);
        assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
        assert.equal(messages(session.sessionManager, UPDATE).length, suppression === "off" ? 0 : 1);
        await writeFile(settingsFile, JSON.stringify({ finalRecap: true }));
        await reload(session);
        if (suppression === "off") {
          await waitFor(() => requests.filter((r) => !r.path).length === 3 && session.isIdle, "off-mode retained summary replayed");
          assertLastVisible(session.sessionManager, "Replayed root summary");
        }
        await reload(session);
        await flushTimers();
        assert.equal(requests.filter((r) => !r.path).length, 3,
          "completion woke the root once; off-mode replay is consumed once");
        assert.deepEqual(errors, []);
      } finally {
        child.resolve(answer("Retained child result"));
      }
    });
  });
}

for (const order of [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]) {
  test(
    `timed detached siblings finishing in order ${order.join(" → ")} trigger one continuation before reporting timers expire`,
    { timeout: 15000 },
    async () => {
      const children = Array.from({ length: 3 }, () => deferred<AssistantMessage>());
      let rootCalls = 0;
      await withOfflineHarness(
        {
          agentFiles: { worker },
          managerSettings: { finalRecap: true },
          onRequest(request) {
            if (request.path) return children[Number(request.path.at(-1))]!.promise;
            rootCalls++;
            if (rootCalls === 1) return timedSpawn(3);
            if (rootCalls === 2) return answer("Waiting for timed parallel work");
            assert.equal(rootCalls, 3, "the final completion triggers exactly one request");
            assert.match(request.messagesText, /continue any unfinished work/);
            assert.match(request.messagesText, /If the overall task is complete/);
            for (let i = 0; i < 3; i++)
              assert.match(request.messagesText, new RegExp(`Timed result ${i}`));
            return answer("All timed work is complete");
          },
        },
        async ({ cwd, open, requests, errors }) => {
          const session = await open(SessionManager.create(cwd));
          try {
            await session.prompt("Delegate three tasks, then finish the overall task");
            await waitFor(
              () => requests.filter((r) => r.path).length === 3,
              "all timed children running",
            );
            for (const [position, childIndex] of order.entries()) {
              children[childIndex]!.resolve(answer(`Timed result ${childIndex}`));
              await waitFor(
                () => mailbox(session.sessionManager).length === position + 1,
                `completion ${childIndex} retained`,
              );
              if (position < 2) {
                await flushTimers();
                assert.equal(
                  requests.filter((r) => !r.path).length,
                  2,
                  "no early recap with a sibling outstanding",
                );
                assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
              }
            }
            await waitFor(
              () => requests.filter((r) => !r.path).length === 3 && session.isIdle,
              "single final completion turn",
            );
            assert.equal(summaryIds(session.sessionManager).length, 1);
            assert.equal(new Set(summaryIds(session.sessionManager)[0]).size, 3);
            assert.equal(
              messages(session.sessionManager, WAKE).length,
              0,
              "unexpired report timers do not create wakes",
            );
            assertLastVisible(session.sessionManager, "All timed work is complete");
            await flushTimers();
            assert.equal(requests.filter((r) => !r.path).length, 3, "no completion loop");
            assert.deepEqual(errors, []);
          } finally {
            children.forEach((child, i) => child.resolve(answer(`Cleanup ${i}`)));
          }
        },
      );
    },
  );
}

test(
  "last timed nested descendant unblocks a recap after both detached root parents have settled",
  { timeout: 15000 },
  async () => {
    const parent = deferred<AssistantMessage>();
    const sibling = deferred<AssistantMessage>();
    const leaf = deferred<AssistantMessage>();
    let rootCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: {
          worker: worker.replace("allow: [agent_update]", "allow: [agent_update, agent_spawn]"),
        },
        managerSettings: { finalRecap: true },
        onRequest(request) {
          if (request.path === "/root/worker-0/leaf") return leaf.promise;
          if (request.path === "/root/worker-0")
            return request.pathCall === 1
              ? toolUse("spawn-leaf", "agent_spawn", {
                  path: "leaf",
                  type: "worker",
                  task: "Nested task",
                  wait: false,
                  timeout: 300,
                  budgetTokens: 0,
                })
              : parent.promise;
          if (request.path === "/root/worker-1") return sibling.promise;
          rootCalls++;
          if (rootCalls === 1) return timedSpawn(2);
          if (rootCalls === 2) return answer("Waiting for nested work");
          assert.equal(rootCalls, 3, "only the last descendant unblocks the batch");
          assert.match(request.messagesText, /continue any unfinished work/);
          assert.match(request.messagesText, /Parent handed back/);
          assert.match(request.messagesText, /Sibling handed back/);
          return answer("Nested batch recap");
        },
      },
      async ({ cwd, open, requests, errors }) => {
        const session = await open(SessionManager.create(cwd));
        try {
          await session.prompt("Delegate parallel and nested work");
          await waitFor(
            () => requests.some((r) => r.path === "/root/worker-0/leaf"),
            "nested leaf running",
          );
          parent.resolve(answer("Parent handed back"));
          sibling.resolve(answer("Sibling handed back"));
          await waitFor(() => mailbox(session.sessionManager).length === 2, "root parents settled");
          await flushTimers();
          assert.equal(
            requests.filter((r) => !r.path).length,
            2,
            "a nested descendant still blocks recap",
          );
          assert.equal(messages(session.sessionManager, SUMMARY).length, 0);
          leaf.resolve(answer("Nested leaf finished last"));
          await waitFor(
            () => requests.filter((r) => !r.path).length === 3 && session.isIdle,
            "root woken by nested settlement",
          );
          assert.equal(summaryIds(session.sessionManager).length, 1);
          assert.equal(
            new Set(summaryIds(session.sessionManager)[0]).size,
            2,
            "root completion IDs consumed once",
          );
          assert.equal(messages(session.sessionManager, WAKE).length, 0);
          assertLastVisible(session.sessionManager, "Nested batch recap");
          await flushTimers();
          assert.equal(requests.filter((r) => !r.path).length, 3);
          assert.deepEqual(errors, []);
        } finally {
          parent.resolve(answer("Cleanup parent"));
          sibling.resolve(answer("Cleanup sibling"));
          leaf.resolve(answer("Cleanup leaf"));
        }
      },
    );
  },
);

test(
  "timed completion during manual-compaction busy state retries after idle without agent_settled",
  { timeout: 15000 },
  async () => {
    const child = deferred<AssistantMessage>();
    let rootCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { finalRecap: true },
        onRequest(request) {
          if (request.path) return child.promise;
          rootCalls++;
          if (rootCalls === 1) return timedSpawn();
          if (rootCalls === 2) return answer("Initial answer before compaction");
          assert.equal(rootCalls, 3, "one retry wakes the root after compaction");
          assert.match(request.messagesText, /Result retained during compaction/);
          return answer("Recap after compaction");
        },
      },
      async ({ cwd, open, requests, errors }) => {
        const session = await open(SessionManager.create(cwd));
        // Model only the SDK's manual-compaction busy flag, not compaction's content
        // rewrite. Clearing it intentionally emits no agent_settled event.
        const sdk = session as unknown as { _compactionAbortController?: AbortController };
        let settled = 0;
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "agent_settled") settled++;
        });
        try {
          await session.prompt("Delegate timed work");
          assert.equal(session.isIdle, true);
          const settledBeforeCompaction = settled;
          sdk._compactionAbortController = new AbortController();
          assert.equal(session.isIdle, false);
          child.resolve(answer("Result retained during compaction"));
          await waitFor(
            () => mailbox(session.sessionManager).length === 1,
            "compaction-busy completion retained",
          );
          // Allow at least one 100ms busy retry before clearing the SDK flag.
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          assert.equal(requests.filter((r) => !r.path).length, 2);
          assert.equal(
            messages(session.sessionManager, UPDATE).length,
            0,
            "busy root mailbox is not drained",
          );
          assert.equal(settled, settledBeforeCompaction, "child settlement is not root settlement");
          sdk._compactionAbortController = undefined;
          assert.equal(session.isIdle, true);
          assert.equal(settled, settledBeforeCompaction, "idle transition emitted no settlement");
          await waitFor(
            () => requests.filter((r) => !r.path).length === 3 && session.isIdle,
            "retry delivers after compaction",
          );
          assert.equal(summaryIds(session.sessionManager).length, 1);
          assert.equal(messages(session.sessionManager, UPDATE).length, 1);
          assertLastVisible(session.sessionManager, "Recap after compaction");
          await flushTimers();
          assert.equal(requests.filter((r) => !r.path).length, 3);
          assert.deepEqual(errors, []);
        } finally {
          sdk._compactionAbortController = undefined;
          unsubscribe();
          child.resolve(answer("Cleanup"));
        }
      },
    );
  },
);

test(
  "pending timeout wake and final timed completion coalesce into one recap turn",
  { timeout: 15000 },
  async () => {
    const children = [deferred<AssistantMessage>(), deferred<AssistantMessage>()];
    let rootCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { finalRecap: true },
        onRequest(request) {
          if (request.path) return children[Number(request.path.at(-1))]!.promise;
          rootCalls++;
          if (rootCalls === 1) return timedSpawn(2);
          if (rootCalls === 2) return answer("Initial timeout-race answer");
          assert.equal(rootCalls, 3, "no separate timeout wake plus recap");
          assert.match(request.messagesText, /Retained report-only timeout/);
          assert.match(request.messagesText, /First timed result/);
          assert.match(request.messagesText, /Last timed result/);
          return answer("Coalesced root recap");
        },
      },
      async ({ cwd, open, requests, errors }) => {
        const session = await open(SessionManager.create(cwd));
        const sdk = session as unknown as { _compactionAbortController?: AbortController };
        try {
          await session.prompt("Delegate timed work with a pending report");
          children[0]!.resolve(answer("First timed result"));
          await waitFor(
            () => mailbox(session.sessionManager).length === 1,
            "first completion retained",
          );
          await flushTimers();
          // Hold the common scheduler's deferred boundary deterministically. This
          // mailbox entry models a timeout already emitted by the report-only timer.
          sdk._compactionAbortController = new AbortController();
          session.sessionManager.appendCustomEntry(MAILBOX, {
            rootSessionId: session.sessionManager.getSessionId(),
            content: "Retained report-only timeout",
            trigger: true,
            finalRecap: false,
            details: { mailboxId: "timeout-race", path: "/root/worker-1", state: "running" },
          });
          await reload(session);
          children[1]!.resolve(answer("Last timed result"));
          await waitFor(
            () => mailbox(session.sessionManager).length === 3,
            "last completion retained alongside timeout",
          );
          assert.equal(requests.filter((r) => !r.path).length, 2);
          sdk._compactionAbortController = undefined;
          await waitFor(
            () => requests.filter((r) => !r.path).length === 3 && session.isIdle,
            "one coalesced recap",
          );
          assert.equal(messages(session.sessionManager, WAKE).length, 0);
          assert.equal(summaryIds(session.sessionManager).length, 1);
          assert.equal(new Set(summaryIds(session.sessionManager)[0]).size, 2);
          assert.ok(
            !summaryIds(session.sessionManager)[0]!.includes("timeout-race"),
            "recap consumes completion IDs only",
          );
          assert.equal(messages(session.sessionManager, UPDATE).length, 3);
          assertLastVisible(session.sessionManager, "Coalesced root recap");
          await reload(session);
          await flushTimers();
          assert.equal(
            requests.filter((r) => !r.path).length,
            3,
            "timeout intent was consumed by the recap",
          );
          assert.deepEqual(errors, []);
        } finally {
          sdk._compactionAbortController = undefined;
          children.forEach((child) => child.resolve(answer("Cleanup")));
        }
      },
    );
  },
);

test(
  "automatic completion turn may continue work and receives one follow-up for completion while still busy",
  { timeout: 15000 },
  async () => {
    const first = deferred<AssistantMessage>();
    const next = deferred<AssistantMessage>();
    const continuation = deferred<AssistantMessage>();
    let rootCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: { worker },
        managerSettings: { finalRecap: true },
        onRequest(request) {
          if (request.path === "/root/worker-0") return first.promise;
          if (request.path === "/root/next") return next.promise;
          rootCalls++;
          if (rootCalls === 1) return timedSpawn();
          if (rootCalls === 2) return answer("Initial work is delegated");
          if (rootCalls === 3) {
            assert.match(request.messagesText, /continue any unfinished work/);
            return toolUse("continue-next-batch", "agent_spawn", {
              path: "next",
              type: "worker",
              task: "Dependent unfinished work",
              wait: false,
              timeout: 300,
              budgetTokens: 0,
            });
          }
          if (rootCalls === 4) return continuation.promise;
          assert.equal(rootCalls, 5, "exactly one follow-up after the automatic turn settles");
          assert.match(request.messagesText, /Dependent work completed/);
          return answer("Overall task is finally complete");
        },
      },
      async ({ cwd, open, requests, errors }) => {
        const session = await open(SessionManager.create(cwd));
        try {
          await session.prompt("Complete initial work and then dependent work");
          first.resolve(answer("Initial work completed"));
          await waitFor(
            () => rootCalls === 4 && requests.some((r) => r.path === "/root/next"),
            "automatic continuation busy with dependent work",
          );
          assert.equal(session.isIdle, false);
          assert.equal(summaryIds(session.sessionManager).length, 1);
          next.resolve(answer("Dependent work completed"));
          await waitFor(
            () => mailbox(session.sessionManager).length === 2,
            "completion during automatic turn retained",
          );
          await flushTimers();
          assert.equal(
            requests.filter((r) => !r.path).length,
            4,
            "busy automatic turn is not interrupted",
          );
          assert.equal(summaryIds(session.sessionManager).length, 1);
          continuation.resolve(answer("Dependent work was launched"));
          await waitFor(
            () => requests.filter((r) => !r.path).length === 5 && session.isIdle,
            "follow-up after automatic continuation settles",
          );
          const ids = summaryIds(session.sessionManager);
          assert.equal(ids.length, 2);
          assert.deepEqual(
            ids.map((batch) => batch.length),
            [1, 1],
          );
          assert.equal(
            new Set(ids.flat()).size,
            2,
            "each completion ID consumed by only one batch",
          );
          assert.equal(messages(session.sessionManager, WAKE).length, 0);
          assertLastVisible(session.sessionManager, "Overall task is finally complete");
          await reload(session);
          await flushTimers();
          assert.equal(
            requests.filter((r) => !r.path).length,
            5,
            "no replay of either consumed batch",
          );
          assert.deepEqual(errors, []);
        } finally {
          first.resolve(answer("Cleanup first"));
          next.resolve(answer("Cleanup next"));
          continuation.resolve(answer("Cleanup continuation"));
        }
      },
    );
  },
);

for (const foreground of [true, false]) {
  for (const reopen of [false, true]) {
    for (const finalRecap of [false, true]) {
      test(
        `inactive steer wakes root: ${foreground ? "foreground" : "detached"} spawn, ${reopen ? "reopened" : "retained"} session, recap ${finalRecap}`,
        { timeout: 15000 },
        async () => {
          const resumed = deferred<AssistantMessage>();
          let rootCalls = 0;
          await withOfflineHarness(
            {
              agentFiles: { worker },
              managerSettings: { finalRecap },
              onRequest(request) {
                if (request.path)
                  return request.pathCall === 1 ? answer("Initial child result") : resumed.promise;
                rootCalls++;
                if (rootCalls === 1) return spawn(1, foreground);
                return answer(
                  request.messagesText.includes("Resumed child result")
                    ? "Root handled resumed result"
                    : "Initial root answer",
                );
              },
            },
            async ({ cwd, open, close, tool, requests, errors }) => {
              let session = await open(SessionManager.create(cwd));
              try {
                await session.prompt("Delegate initial work");
                await tool(session, "agent_wait", { path: "/root/worker-0" });
                const initialCalls = foreground ? 2 : 3;
                await waitFor(
                  () => rootCalls === initialCalls && session.isIdle,
                  "initial completion handled",
                );
                if (reopen) {
                  const file = session.sessionManager.getSessionFile()!;
                  await close(session);
                  session = await open(SessionManager.open(file));
                }
                const initialSummaries = messages(session.sessionManager, SUMMARY).length;
                const initialCompletions = mailbox(session.sessionManager).length;
                await tool(session, "agent_steer", {
                  path: "/root/worker-0",
                  message: "Resume retained work",
                });
                await waitFor(
                  () => requests.filter((request) => request.path).length === 2,
                  "same child resumes",
                );
                await flushTimers();
                assert.equal(rootCalls, initialCalls, "resuming alone does not wake root");
                resumed.resolve(answer("Resumed child result"));
                await waitFor(
                  () => mailbox(session.sessionManager).length === initialCompletions + 1,
                  "resumed completion retained",
                );
                await waitFor(
                  () => rootCalls === initialCalls + 1 && session.isIdle,
                  "resumed completion automatically wakes idle root",
                );
                assertLastVisible(session.sessionManager, "Root handled resumed result");
                assert.equal(
                  messages(session.sessionManager, SUMMARY).length,
                  initialSummaries + (finalRecap ? 1 : 0),
                );
                await reload(session);
                await flushTimers();
                assert.equal(rootCalls, initialCalls + 1, "completion is delivered only once");
                assert.deepEqual(errors, []);
              } finally {
                resumed.resolve(answer("Cleanup resumed child"));
              }
            },
          );
        },
      );
    }
  }
}
