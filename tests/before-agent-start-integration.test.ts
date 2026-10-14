import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { IMPORT_REQUEST_PREFIX, importWasOffered } from "../src/prefs/agent-import.ts";
import { subagentPrompt } from "../src/orch/prompt.ts";
import { DEFAULT_MANAGER_SETTINGS } from "../src/prefs/settings.ts";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

const answer = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

test("custom-message turns retain subagent guidance without acknowledging an import", async () => {
  await withOfflineHarness(
    {
      agentFiles: {},
      managerSettings: { subagentMode: "opportunistic" },
      onRequest: answer,
    },
    async ({ directory, cwd, open, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      await session.prompt("Ordinary user request");
      assert.equal(importWasOffered(directory), false);

      const guidance = subagentPrompt(DEFAULT_MANAGER_SETTINGS)!;
      const message = {
        customType: "test:custom-turn",
        content: IMPORT_REQUEST_PREFIX,
        display: false,
      };
      // Exercise Pi 1.2's event shape even when running against the pinned older SDK.
      const extension = session.resourceLoader
        .getExtensions()
        .extensions.find((extension) => extension.tools.has("agent_spawn"))!;
      const handler = extension.handlers.get("before_agent_start")![0]!;
      const result = await handler(
        { type: "before_agent_start", messageType: "custom", message, systemPrompt: "Base" },
        session.extensionRunner.createCommandContext(),
      );
      assert.deepEqual(result, { systemPrompt: `Base\n\n${guidance}` });
      assert.equal(importWasOffered(directory), false);

      await session.sendCustomMessage(message, { triggerTurn: true });
      assert.deepEqual(errors, []);
      assert.equal(requests.length, 2);
      assert.ok(JSON.parse(requests[0]!.system).endsWith(`\n\n${guidance}`));
      assert.equal(
        importWasOffered(directory),
        false,
        "custom content is not a user import request",
      );

      await session.prompt(IMPORT_REQUEST_PREFIX);
      assert.equal(
        importWasOffered(directory),
        true,
        "user import requests still record onboarding",
      );
      assert.deepEqual(errors, []);
    },
  );
});
