import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThreadManager } from "./manager.ts";
import { ModelPreferenceError } from "../prefs/models.ts";
import type { AgentType, ResolvedAgentSettings, ThreadView } from "../types.ts";

const path = Type.String({
  description: "Absolute agent path, or name relative to the caller",
});
const text = Type.String({ minLength: 1 });
function compact(
  thread: ThreadView,
): ThreadView & { outputTruncated?: boolean } {
  if (thread.output && thread.output.length > 16000)
    return {
      ...thread,
      output: thread.output.slice(0, 16000),
      outputTruncated: true,
    };
  return thread;
}
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/**
 * Legacy (pre-rename) `timeoutMs` param is still accepted at the execute layer
 * and normalized to the new seconds-based field (ms / 1000). The new field
 * always wins when both are present.
 */
function legacyTimeoutMsToSeconds(
  params: Record<string, unknown>,
  target: "timeout" | "maxWait",
): number | undefined {
  if (params[target] !== undefined) return params[target] as number;
  const legacy = params.timeoutMs;
  return typeof legacy === "number" ? legacy / 1000 : undefined;
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
      "列出本调用方新增子代理可用的类型:名称、描述、解析模型与思考级别。反映当前配置,选型前先调用。其他父路径可能继承不同设置。",
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
      "生成命名子代理,子代理只收自己的 task 与类型 prompt。传上下文:把自含简报(决策/路径/文件位置)写进 task,或指向文件。默认前台等待;wait:false 转后台,完成/失败/被停时收到唤醒消息,勿轮询。timeout 到点仅发状态事件(状态/耗时/tokens/最近输出),绝不停止子代理,续期用 agent_steer。上游断流会被自动无损重试(最多 3 次、退避 10/30/90s,不改任务、不丢上下文),过程不唤醒你,只有终态才回报,所以一次失败报告就是真的没救了;失败原因会写明是 upstream interruption 还是 model error,并附已耗 token。budgetTokens 超限即停子代理并发事件,session 仍可经 agent_output 读取。并行时先以 wait:false 生成全部独立兄弟,再 agent_wait;有委派工具的子代理照做。可用类型用 agent_types 查询。",
      Type.Object({
        path: Type.String({
          description:
            "任务式 kebab-case 路径,非代理类型(如 /root/controller-security-research),或相对调用方的任务名",
        }),
        type: text,
        task: text,
        wait: Type.Optional(Type.Boolean()),
        timeout: Type.Integer({
          minimum: 0,
          maximum: 300,
          description:
            "报告型监督计时器:到点只发事件,绝不停止子代理。必填,整数秒 0–300,0=落 60s 默认。",
        }),
        budgetTokens: Type.Integer({
          minimum: 0,
          description: "必填,本线程累计输入 token 上限,0=2,000,000 默认。",
        }),
      }),
      async (params, signal) => {
        const view = await threads().spawn(
          {
            ...params,
            timeout: legacyTimeoutMsToSeconds(params, "timeout"),
          },
          signal,
        );
        // Detached mid-flight by queued user input: end the blocking call with the notice;
        // settlement/budget/timeout events still arrive via the detached path.
        if (view.detachedToBackground)
          return {
            content: [
              {
                type: "text" as const,
                text: `Child ${view.path} detached to the background because you sent a message: reply to the user first; its settlement is reported automatically (check with agent_wait/agent_output).`,
              },
            ],
            details: view,
          };
        return result(compact(view));
      },
    ),
    make(
      "agent_wait",
      "等待后代代理完成/失败/停止/暂停。取消与到点均不影响子代理;到点返回当前快照,可再等待或经 agent_status 轮询。暂停态无 final answer 回传,可经 agent_steer 恢复。",
      Type.Object({
        path,
        maxWait: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 3600,
            description:
              "调用方等待上界,不影响子代理。整数秒 0–3600,0=立即返回当前快照,省略=无限等待。",
          }),
        ),
      }),
      async (params, signal) =>
        result(
          compact(
            await threads().wait(
              params.path,
              legacyTimeoutMsToSeconds(params, "maxWait"),
              signal,
            ),
          ),
        ),
    ),
    make(
      "agent_steer",
      "向后代代理发送输入和/或重置其监督计时器。带 message:运行中线程排队接收转舵;完成/停止/暂停线程以原 session 连同先前上下文恢复。带 timeout:计时器自现在起重新计时,替换原计时,非累加。仅 timeout:只重置运行中子代理的计时器,未运行则报错,不发送输入、不中断、不恢复。两者同给则转舵并重置。至少给一个。立即返回,结果用 agent_wait。",
      Type.Object({
        path,
        message: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Input to send or resume with.",
          }),
        ),
        timeout: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 300,
            description:
              "报告型监督计时器,绝不停止子代理。整数秒 0–300,0=落 60s 默认。",
          }),
        ),
      }),
      async (params) =>
        result(
          compact(
            await threads().steer(
              params.path,
              params.message,
              legacyTimeoutMsToSeconds(params, "timeout"),
            ),
          ),
        ),
    ),
    make(
      "agent_status",
      "读取线程状态;省略 path 则列出可见后代。/root 可查所有树。",
      Type.Object({
        path: Type.Optional(
          Type.String({
            description: "Omit to list visible descendants.",
          }),
        ),
      }),
      (params) =>
        result(
          params.path
            ? compact(threads().get(params.path))
            : threads().list().map(compact),
        ),
    ),
    make(
      "agent_update",
      "子代理专用:向父级发送进度,不结束本任务。消息被记录并展示,但不中断、不自动重启父模型。",
      Type.Object({
        message: Type.String({
          minLength: 1,
          maxLength: 8000,
          description: "Progress text, 1–8000 characters.",
        }),
      }),
      (params) => result(compact(threads().update(params.message))),
    ),
    make(
      "agent_pause",
      "子代理专用:本回合边界停止,不回传 final answer。要交付答案则直接返回最终回答,该完成态同样可恢复。",
      Type.Object({
        reason: Type.String({
          minLength: 1,
          description:
            "写入线程状态;留空则落 'Awaiting further input'。",
        }),
      }),
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
      "停止后代代理及其下所有仍在运行的子孙(整棵子树,任意深度)。协作式取消,非沙箱进程终止。",
      Type.Object({ path }),
      async (params) => result(compact(await threads().stop(params.path))),
    ),
    make(
      "agent_output",
      "按字符分页读取线程输出;nextOffset 非空即还有后续页。",
      Type.Object({
        path,
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "0-based character offset; default 0.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 16000,
            description: "Characters per page; default 8000, max 16000.",
          }),
        ),
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
