import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSessionContext,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  captureHousekeepingUsageSession,
  HOUSEKEEPING_USAGE_KIND,
  reportHousekeepingUsage,
  type HousekeepingUsageSession,
} from "../src/orch/housekeeping-usage.ts";
import { CostLedger } from "../src/orch/cost-ledger.ts";
import { COST_WIDGET_ID, CostFooterController, footerUsage } from "../src/ui/cost-footer.ts";

const usage: Usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 10,
  reasoning: 5,
  totalTokens: 160,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
};
const response: AssistantMessage = {
  role: "assistant",
  api: "openai-completions",
  provider: "actual-provider",
  model: "requested-model",
  responseModel: "actual-model",
  content: [{ type: "text", text: "Private summary" }],
  stopReason: "stop",
  timestamp: 1,
  usage,
};
const capture = (manager: SessionManager) =>
  captureHousekeepingUsageSession({ sessionManager: manager });

test("native usage preserves full usage, actual model attribution and the pi-stats kind", () => {
  const manager = SessionManager.inMemory();
  const entry = reportHousekeepingUsage(capture(manager), response)!;
  assert.deepEqual(manager.getEntries(), [entry]);
  assert.equal(entry.type, "usage");
  assert.equal(entry.kind, HOUSEKEEPING_USAGE_KIND);
  assert.equal(entry.provider, "actual-provider");
  assert.equal(entry.model, "actual-model");
  assert.equal(entry.note, "housekeeping model call");
  assert.deepEqual(entry.usage, usage, "preserve full native usage and nested costs");
  assert.doesNotMatch(JSON.stringify(entry), /Private summary|content|task|prompt|arguments/);
  assert.deepEqual(buildSessionContext(manager.getEntries()).messages, [], "not model context");
});

test("usage persists as a native session entry that readers can restore", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "housekeeping-session-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "Start work", timestamp: 1 });
  const entry = reportHousekeepingUsage(capture(manager), response)!;
  const path = manager.getSessionFile()!;
  const lines = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines.at(-1), entry);
  const restored = SessionManager.open(path);
  assert.deepEqual(
    restored.getEntries().filter((record) => record.type === "usage"),
    [entry],
  );
  assert.equal(footerUsage(restored.getEntries()).cost, usage.cost.total);
  assert.deepEqual(buildSessionContext(restored.getEntries()).messages, [
    { role: "user", content: "Start work", timestamp: 1 },
  ]);
});

test("responseModel falls back to the response model, never the configured model", () => {
  const manager = SessionManager.inMemory();
  const entry = reportHousekeepingUsage(capture(manager), {
    ...response,
    responseModel: undefined,
  });
  assert.equal(entry!.model, "requested-model");
});

test("native failure, missing appendUsage or missing capture does not throw", () => {
  for (const session of [
    undefined,
    { manager: { getSessionId: () => "original" }, sessionId: "original" },
    {
      manager: {
        getSessionId: () => "original",
        appendUsage() {
          throw new Error("disk full");
        },
      },
      sessionId: "original",
    },
    {
      manager: {
        getSessionId() {
          throw new Error("disposed");
        },
      },
      sessionId: "original",
    },
  ] satisfies (HousekeepingUsageSession | undefined)[]) {
    assert.equal(reportHousekeepingUsage(session, response), undefined);
  }
});

test("capture failure is isolated, and an in-place session replacement is never charged", () => {
  assert.equal(
    captureHousekeepingUsageSession({
      get sessionManager(): ExtensionContext["sessionManager"] {
        throw new Error("stale context");
      },
    }),
    undefined,
  );
  const manager = SessionManager.inMemory();
  const captured = capture(manager)!;
  manager.newSession();
  assert.notEqual(captured.sessionId, manager.getSessionId());
  assert.equal(reportHousekeepingUsage(captured, response), undefined);
  assert.deepEqual(manager.getEntries(), []);
});

test("missing response usage produces no fabricated accounting", () => {
  const manager = SessionManager.inMemory();
  assert.equal(
    reportHousekeepingUsage(capture(manager), { ...response, usage: undefined } as never),
    undefined,
  );
  assert.deepEqual(manager.getEntries(), []);
});

test("housekeeping enters Total exactly once, not the subagent-only ledger or cost display", () => {
  const manager = SessionManager.inMemory();
  reportHousekeepingUsage(capture(manager), response);
  const ledger = new CostLedger();
  ledger.restore(manager.getEntries());
  assert.equal(ledger.totalUsd, 0);
  assert.equal(footerUsage(manager.getEntries()).cost, usage.cost.total);
  let value: "subagents" | "total" = "subagents";
  let status = "";
  const ctx = {
    hasUI: true,
    sessionManager: manager,
    ui: {
      setStatus(key: string, text: string) {
        assert.equal(key, COST_WIDGET_ID);
        status = text;
      },
    },
  } as unknown as ExtensionContext;
  const footer = new CostFooterController(
    { getCommands: () => [], events: { emit() {} } } as never,
    () => ledger.totalUsd,
    () => false,
    () => "pi-status",
    () => value,
  );
  footer.refresh(ctx);
  assert.equal(status, "Subagents: 💵 $0.0000");
  value = "total";
  footer.refresh(ctx);
  assert.equal(status, "Total: 💵 $0.0340");
});
