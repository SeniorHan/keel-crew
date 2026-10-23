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
    "选型前先调 agent_types。路径用 kebab-case 任务名,非类型名。子代理只见自身 task 与类型 prompt;上下文写简报进 task 或指文件。",
    waitingPolicy,
    "后台代理完成/失败/被停自动唤醒,勿轮询,结束回合;监督/预算语义见工具描述;终态(完成/失败/停止/暂停)session 保留,可经 agent_steer 恢复。",
    "Use agent_steer to send input or resume retained sessions. Paused agents have no final answer; completed agents hand back results. Both retain their session.",
    `Maximum depth: ${settings.maxLevels} levels including L1. Shared concurrency: ${settings.maxConcurrent} active threads; waiting parents count.`,
    ...(settings.checklistIntegration && checklistEligible ? [checklistGuidance(settings.subagentMode)] : []),
  ].join("\n");
}
