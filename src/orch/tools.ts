import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThreadManager } from "./manager.ts";
import { ModelPreferenceError } from "../prefs/models.ts";
import type { AgentType, ResolvedAgentSettings, ThreadView } from "../types.ts";

const path = Type.String({ description: "Absolute agent path, or name relative to the caller" });
const text = Type.String({ minLength: 1 });
function compact(thread: ThreadView): ThreadView & { outputTruncated?: boolean } {
  if (thread.output && thread.output.length > 16000)
    return { ...thread, output: thread.output.slice(0, 16000), outputTruncated: true };
  return thread;
}
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/** All threads see the same verbs, with caller identity bound by closure, never model input. */
export function agentTools(
  getManager: () => ThreadManager,
  caller: string,
  getTypes: () => AgentType[],
  resolveSettings: (type: AgentType) => ResolvedAgentSettings,
): ToolDefinition[] {
  const threads = () => getManager().scope(caller);
  const make = (
    name: string,
    description: string,
    parameters: any,
    execute: (params: any, signal?: AbortSignal) => Promise<any> | any,
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, params, signal) => execute(params, signal),
  });
  return [
    make(
      "agent_types",
      "List agent names, descriptions, resolved models and thinking levels for new children of this caller. Reflects current configuration; call before choosing a type. Other parent paths may inherit different settings.",
      Type.Object({}),
      () => {
        const entries = getTypes().map((type) => {
          const { name, description } = type;
          try {
            return { name, description, ...resolveSettings(type) };
          } catch (error) {
            return {
              name,
              description,
              error:
                error instanceof ModelPreferenceError
                  ? error.summary
                  : error instanceof Error
                    ? error.message
                    : String(error),
            };
          }
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                entries
                  .map((entry) =>
                    "error" in entry
                      ? `${entry.name} (unavailable): ${entry.description}\n  ${entry.error}`
                      : `${entry.name} (${entry.model}, thinking: ${entry.thinkingLevel}): ${entry.description}`,
                  )
                  .join("\n") || "No agent types available.",
            },
          ],
          details: entries,
        };
      },
    ),
    make(
      "agent_spawn",
      "Spawn a named child agent. The child receives only its own task prompt and the agent type's prompt. To hand over context, write a self-contained brief (decisions, paths, file locations) into the task, or point the child at files. Foreground waits by default; wait:false runs detached: when it completes, fails or is stopped, you receive a message event that wakes you, so do not poll. Required timeoutMs (ms; 0 = 60s default): report-only supervision — when it fires you get an event with the child's state, elapsed time, tokens and recent output; the child is NOT stopped; re-arm with agent_steer({path, timeoutMs}). Required budgetTokens (0 = 2,000,000 input-token default): when the child's cumulative input tokens exceed this budget it is stopped and you get an event with its recent output; its session stays readable via agent_output. For parallel work, spawn every independent sibling with wait:false before calling agent_wait; child agents with delegation tools should do the same. Existing paths are retained and can be resumed with agent_steer. Use agent_types to discover current types.",
      Type.Object({
        path: Type.String({
          description:
            "Task-based kebab-case path, not the agent type (e.g. /root/controller-security-research), or a task name relative to the caller",
        }),
        type: text,
        task: text,
        wait: Type.Optional(Type.Boolean()),
        timeoutMs: Type.Integer({
          minimum: 0,
          maximum: 300000,
          description:
            "Required: report-only supervision timer in ms; 0 = 60s default. If the child is still running after this many ms you receive a status event (state, elapsed time, tokens, recent output); the child keeps running.",
        }),
        budgetTokens: Type.Integer({
          minimum: 0,
          description:
            "Required: cumulative input-token budget for this thread; 0 = 2,000,000-token default. Exceeding it stops the child and reports an event with its recent output.",
        }),
      }),
      async (params, signal) => result(compact(await threads().spawn(params, signal))),
    ),
    make(
      "agent_wait",
      "Wait for a descendant to complete, fail, stop or pause. Paused means no final answer handback. Cancellation/timeouts do not stop the child; poll status or wait again.",
      Type.Object({
        path,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600000 })),
      }),
      async (params, signal) =>
        result(compact(await threads().wait(params.path, params.timeoutMs, signal))),
    ),
    make(
      "agent_steer",
      'Send input to a descendant and/or re-arm its report-only timeout. With message: working threads receive queued steering; completed, stopped and paused threads resume the SAME session with its previous context. With timeoutMs (0 = 60s default, or 30000–300000): the timeout fires that many ms from now, replacing any pending timer. To extend a running background agent\'s reporting timer without sending input, call agent_steer({path: "/root/task", timeoutMs: 120000}) and omit message entirely. This resets the timer to 120000 ms from now, not an addition to the old deadline. timeoutMs WITHOUT message only re-arms the timeout of a running child (error if not running) and does not steer, interrupt or resume it; with both, steer and re-arm. At least one is required. Returns immediately; use agent_wait for the result.',
      Type.Object({
        path,
        message: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Input to send or resume with. Omit entirely for a timer-only re-arm.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 300000,
            description:
              "Reset the report-only timer to this many ms from now, replacing any pending timer; 0 = 60s default. With no message, only re-arms a running agent; does not send input, interrupt or resume it.",
          }),
        ),
      }),
      async (params) =>
        result(compact(await threads().steer(params.path, params.message, params.timeoutMs))),
    ),
    make(
      "agent_status",
      "Read a thread's status or list visible descendants. Root can inspect all trees. Completion retains the session; pause retains it without final answer handback.",
      Type.Object({ path: Type.Optional(path) }),
      (params) =>
        result(params.path ? compact(threads().get(params.path)) : threads().list().map(compact)),
    ),
    make(
      "agent_update",
      "Child-only: send progress to the parent without ending this task. Delivery is recorded and displayed but does not interrupt or automatically restart the parent model.",
      Type.Object({ message: Type.String({ minLength: 1, maxLength: 8000 }) }),
      (params) => result(compact(threads().update(params.message))),
    ),
    make(
      "agent_pause",
      "Child-only: stop at this turn boundary WITHOUT returning a final answer. Keep the SAME session for user/parent input via agent_steer. To finish and hand back an answer instead, simply return your final assistant answer. Both states can be resumed.",
      Type.Object({ reason: text }),
      (params) => ({
        ...result({
          path: caller,
          pauseRequested: true,
          status: threads().pause(params.reason).status,
        }),
        terminate: true,
      }),
    ),
    make(
      "agent_stop",
      "Stop a descendant and every still-working descendant below it (the whole subtree, any depth). Session history is retained; resume with agent_steer. This is cooperative cancellation, not sandbox process termination.",
      Type.Object({ path }),
      async (params) => result(compact(await threads().stop(params.path))),
    ),
    make(
      "agent_output",
      "Read completed thread output in character pages. Paused threads deliberately have no final answer handback. All sessions can be viewed by the user with /agents tree; select a thread and press Enter to inspect it.",
      Type.Object({
        path,
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
      }),
      (params) => {
        const output = threads().output(params.path),
          offset = params.offset ?? 0,
          limit = params.limit ?? 8000;
        return result({
          path: threads().get(params.path).path,
          text: output.slice(offset, offset + limit),
          totalCharacters: output.length,
          nextOffset: offset + limit < output.length ? offset + limit : null,
        });
      },
    ),
  ];
}
