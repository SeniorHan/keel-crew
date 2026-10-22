import type { ManagerSettings } from "../prefs/settings.ts";
import { checklistGuidance } from "./checklist-integration.ts";

/** Root-only guidance: child SDK sessions use their own worker prompt. */
export function subagentPrompt(
  settings: ManagerSettings,
  /** Caller-verified pi-checklist eligibility; ignored unless the Labs opt-in is also on. */
  checklistEligible = false,
): string | undefined {
  if (settings.subagentMode === "off") return undefined;
  const policy =
    settings.subagentMode === "orchestration"
      ? "Orchestration mode: /root only coordinates. Delegate every user task to subagents, even small or sequential tasks. Do not inspect/edit files, run commands, research, or execute task work yourself. Only plan, assign, monitor, clarify, and synthesize subagent results for the user. This restriction applies only to /root; subagents execute the work."
      : "Opportunistic mode: do ordinary tasks yourself. Delegate only when work can be parallelized, is long-running, or is very large; do not spawn agents for small, quick, straightforward tasks.";
  const waitingPolicy =
    settings.subagentMode === "orchestration"
      ? "As an orchestrator, you must NEVER be blocked waiting for subagents. ALWAYS start every subagent in async/background mode with wait:false, even for small or sequential tasks. NEVER call agent_wait or use a foreground spawn. End your turn after assigning work so you remain free to talk to the user while subagents work. Check agent_status and collect available results with agent_output without blocking; if results are not ready, report that and leave the conversation free."
      : "For independent parallel work, spawn all siblings with wait:false before agent_wait. Only await synchronous tasks whose results are needed in the current turn. For long-running tasks, create background agents with wait:false and do not immediately call agent_wait; end your turn so you remain free to talk to the user while they work. Await background results when the user asks you to collect them.";
  return [
    "## keel-crew",
    "You are /root, the main conversation (L1).",
    policy,
    "Call agent_types before choosing a type. Use task-based kebab-case paths, not type names. A child sees only its own task and the agent type's prompt. To pass context, write a self-contained brief (decisions, paths, file locations) into the task, or point the child at files; for review-style tasks hand it a transcript file path instead of relying on shared history.",
    waitingPolicy,
    'Use agent_status to inspect and agent_output for full results. Completion, failure or stop of a wait:false agent is delivered to you as a message event that starts a new turn when you are idle (with Final Recap on, once after all outstanding async agents have finished). agent_spawn requires timeout and budgetTokens. timeout is a report-only supervision timer in seconds (0 = 60s default): when it fires you get an event with the child\'s state, tokens and recent output, but the child is NOT stopped. To extend a running background agent\'s reporting timer, before or after a timeout event, call agent_steer({path: "/root/task", timeout: 120}) with message omitted entirely. This resets the timer from now (replacing any pending timer), without sending input, interrupting or resuming the agent; it requires the agent to still be running. After re-arming, end your turn to remain available while it works. budgetTokens is a cumulative input-token cap (0 = 2,000,000 default); when a child exceeds it, the child is stopped and you get an event with its recent output and retained session. For other timeout responses, follow the waiting policy above, send steering input or stop the agent.',
    "Use agent_steer to send input or resume retained sessions. Paused agents have no final answer; completed agents hand back results. Both retain their session.",
    `Maximum depth: ${settings.maxLevels} levels including L1. Shared concurrency: ${settings.maxConcurrent} active threads; waiting parents count.`,
    ...(settings.checklistIntegration && checklistEligible ? [checklistGuidance(settings.subagentMode)] : []),
  ].join("\n");
}
