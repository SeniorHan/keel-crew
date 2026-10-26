# Asynchronous completion and main-agent wakes

A detached spawn (`wait: false`) returns while its agent is still working. Completion and reporting timeouts are separate signals: finishing cancels the agent's reporting timer, then reevaluates whether the main agent should run. It never waits for that timer to expire.

With [Final Recap](settings.md#labs-final-recap-finalrecap) enabled, completed, failed, and stopped detached agents contribute to a pending completion batch. The batch becomes ready when **no detached agent is starting or running**, including nested descendants. Without Final Recap, detached settlements request ordinary wakes instead of waiting for a batch. Progress alone does not request a turn; foreground results do not request an extra completion turn. A detached pause requests an ordinary wake, not a final-result recap.

The scheduler knows whether a batch is ready—not whether the user's task is finished. Both kinds of trigger tell the main agent to collect results and continue unfinished work, or give a final recap if the overall task is complete.

## Delivery and scheduling flow

Root-directed events are persisted before delivery. When main is idle, their notifications enter model context without triggering a turn or appearing as the final visible chat message. A single scheduler then chooses a completion/continuation trigger or an ordinary wake.

```mermaid
flowchart TD
    Event["Progress, timeout, or settlement"] --> Recipient{"Recipient is /root?"}
    Recipient -->|Yes| Mailbox["Persist root mailbox notification"]
    Recipient -->|No| Parent["Deliver notification to lexical parent"]
    Parent --> Nested{"Settlement?"}
    Nested -->|Yes| Reconcile["Reevaluate root mailbox and scheduler"]
    Nested -->|No| Stop["No root scheduling change"]
    Mailbox --> Reconcile
    Reconcile --> Enabled{"Enabled and not cancelling?"}
    Enabled -->|No| Hold["Do not deliver or start a turn"]
    Enabled -->|Yes| Drain["Deliver pending notifications if main is idle"]
    Drain --> Reserved{"Timer queued or automatic turn reserved?"}
    Reserved -->|Yes| Retain["Leave pending work for reevaluation"]
    Reserved -->|No| Pending{"Ready completion batch or wake intent?"}
    Pending -->|No| Retain
    Pending -->|Yes| Timer["Defer: 0 ms if idle, 100 ms if busy"]
    Timer --> Valid{"Same session and generation, still enabled?"}
    Valid -->|No| Hold
    Valid -->|Yes| Idle{"Main idle?"}
    Idle -->|No| Reconcile
    Idle -->|Yes| Flush["Drain mailbox and recheck live state"]
    Flush --> Batch{"Final Recap on, no outstanding async agents, pending results?"}
    Batch -->|Yes| Recap["Reserve one completion/continuation turn"]
    Batch -->|No| Wake{"Wake intent remains?"}
    Wake -->|Yes| Normal["Reserve one ordinary wake turn"]
    Wake -->|No| Retain
    Recap --> Main["Main collects results and decides what remains"]
    Normal --> Main
    Main --> Settled["Main agent_settled releases reservation"]
    Settled --> Reconcile
```

A report-only timeout requests a wake while the child is **still running**; it does not stop the child. If a ready completion batch and timeout wake are pending at the same scheduling boundary, the completion trigger takes priority and clears the pending wake intent. Their notifications are available in that one turn. A timeout turn that already started is not retroactively merged with a later completion.

The 0 ms deferral leaves the current settlement boundary and coalesces events already arriving together. The 100 ms busy retry also covers compaction, so delivery does not depend solely on a later main-agent `agent_settled` event. These are scheduling delays, not guaranteed response deadlines.

## Timing: siblings finish before their reporting timers

This example has Final Recap on. Time runs downward; all three agents finish before their report deadlines.

```mermaid
sequenceDiagram
    participant Main as Main agent
    participant A as Agent A
    participant B as Agent B
    participant C as Agent C
    participant S as Root scheduler
    Main->>A: Spawn detached with reporting timer
    Main->>B: Spawn detached with reporting timer
    Main->>C: Spawn detached with reporting timer
    Note over Main: Main settles and becomes idle
    A-->>S: Completed, cancel A's timer
    Note over S: Retain result, two async agents remain
    B-->>S: Completed, cancel B's timer
    Note over S: Retain result, one async agent remains
    C-->>S: Completed, cancel C's timer
    Note over S: Zero outstanding, defer and recheck
    S->>Main: One completion/continuation trigger
    Note over Main,C: No reporting timer had to expire
    alt More work remains
        Main->>Main: Collect results and continue the task
        opt Another detached batch is needed
            Main->>C: Spawn new work or resume retained work
        end
    else Overall task is complete
        Main->>Main: Give final recap
    end
    Main-->>S: agent_settled, release turn reservation
```

“Batch” is a scheduling group, not a separate job object. Readiness is checked against the manager's current detached-agent count. New detached work can make the next completion batch wait again.

## Timing: a nested descendant finishes last

A nested result still belongs to its lexical parent. Its settlement must also reevaluate the root scheduler because the global outstanding count includes that descendant.

```mermaid
sequenceDiagram
    participant Main as Main agent
    participant A as Parent A
    participant B as Sibling B
    participant C as Child C
    participant S as Root scheduler
    Main->>A: Spawn detached
    Main->>B: Spawn detached
    A->>C: Spawn detached child
    A-->>S: A completes, retain root result
    B-->>S: B completes, retain root result
    Note over S: C is still active, so no completion turn
    C-->>A: C completes, deliver result to retained parent
    C-->>S: Settlement reevaluates global readiness
    Note over S: Zero outstanding, root batch is ready
    S->>Main: Completion/continuation trigger for pending root results
```

C's result is not copied into the root mailbox by this path. The main agent can inspect descendant output when needed. Delivery to a retained parent does not itself restart that parent.

## Timing: busy main, coalesced signals, and follow-up work

Final Recap is on here. A timeout and the last completion arrive during compaction. Later, the automatic turn launches dependent work that finishes before main settles.

```mermaid
sequenceDiagram
    participant Main as Main agent
    participant Child as Detached agent
    participant S as Root scheduler
    Note over Main: Busy with compaction
    Child-->>S: Report timeout, child keeps running
    S->>S: Persist notification, retain wake intent
    Child-->>S: Last completion, clear reporting timer
    S->>S: Persist result, completion batch ready
    loop While main remains busy
        S->>S: Retry after 100 ms, recheck session and idle state
    end
    Note over Main: Compaction ends, no agent_settled required
    S->>Main: Deliver notifications and one completion trigger
    Note over S: Clear wake intent, reserve automatic turn
    Main->>Child: Launch dependent detached work
    Child-->>S: Dependent work completes while main is busy
    S->>S: Retain new result, do not interrupt main
    Main-->>S: agent_settled, release reservation
    S->>S: Reevaluate pending results and defer
    S->>Main: One follow-up completion/continuation trigger
    Main->>Main: Continue remaining work or give final recap
```

## Lossless recovery from upstream interruptions

A dropped provider stream is an accident, not a verdict. Two layers rebuild the turn without editing the task or the conversation:

| Layer | Catches | Mechanism |
| --- | --- | --- |
| Request (`src/orch/stream-retry.ts`) | The stream died **before any content** arrived | The `start` event is withheld until real content shows up, so a dead request leaves nothing behind. The request is retried in place; the agent loop never sees the failure. |
| Turn (`src/orch/runtime.ts`) | The stream died **after partial output** | The failed assistant message and that turn's tool results are hidden with `sessionManager.appendContextEdit(id, null)`, `session.refreshContext()` reprojects agent state, and `agent.continue()` reruns the turn from the context it had before it started. The transcript keeps both the abandoned turn and the edit that hid it. |

- Both layers back off 10 s / 30 s / 90 s (three attempts) and stop immediately on a user stop, a pause, a shutdown, or a budget kill.
- Only transient failures are retried: `aborted` streams, rate limits, 5xx, network errors. Quota/billing errors and context overflows are terminal on the first try.
- Recovery is **progress, not an outcome**: it emits a `recovery` driver event that updates the thread status (`Upstream interruption; lossless recovery 1/3 in 30s`, then `Recovered after 1 upstream interruption`) and never wakes the parent.
- The parent is woken once, at the end. A failure report names what actually happened: `upstream-interrupted` or `model-error`, the provider's own words, every interruption attempt, and the tokens actually spent — with an explicit note when the budget was never the cause. A budget kill keeps its own `budget` attribution instead of looking like a caller stop.
- Reverting a turn discards that turn's partial output. Agents that must not lose work stream it to a file as they go.

## Settings, cancellation, and persistence

- **Subagent Mode Off:** suppresses notification delivery and automatic turns. Matching-session mailbox entries remain available for reconciliation when enabled. **Final Recap off** changes detached completion behavior to ordinary wakes; it is not a master switch for all automatic turns.
- **One automatic turn at a time:** `rootTurnRunning` reserves a requested turn until main's `agent_settled`. Results arriving during it remain pending for a follow-up. The reservation covers both ordinary wakes and completion/continuation turns.
- **Session changes:** tree navigation, switching, and forking cancel scheduled work and suppress cancellation-generated turns while stopping old threads. Attaching a session changes the generation; shutdown cancels the timer and changes the generation too. Deferred callbacks recheck session identity and generation before acting.
- **Branch-local recovery:** root mailbox entries carry `rootSessionId` and a unique `details.mailboxId`. Delivered `pi-subagent:update` messages identify notifications already placed in context. Completion-trigger messages (`pi-subagent:final-recap`) record the completion `mailboxIds` consumed by that batch, so reconciliation does not recap those same IDs again. Ordinary wake intent is an in-memory flag, not a separate durable acknowledgment log.

These records track notification delivery and trigger consumption, not successful completion of the user's task. The scheduler calls `pi.sendMessage` with `triggerTurn: true`; it does not receive an acknowledgment that the resulting model turn succeeded.

## Implementation and regression coverage

- [`src/index.ts`](../src/index.ts): `delivery`, `pendingRootNotifications`, `pendingSummaries`, `scheduleRootTurn`, and session lifecycle hooks.
- [`src/orch/manager.ts`](../src/orch/manager.ts): `outstandingAsync`, reporting timers, and terminal-state settlement.
- [`src/orch/stream-retry.ts`](../src/orch/stream-retry.ts), [`src/orch/interrupted.ts`](../src/orch/interrupted.ts): request-level retry and the faithful interruption report.
- [`tests/stream-retry.test.ts`](../tests/stream-retry.test.ts), [`tests/recovery.test.ts`](../tests/recovery.test.ts): withheld `start`, retry exhaustion, non-retryable providers, local stop/pause never recovering, replay from the same session, and the retained transcript.
- [`tests/final-recap-integration.test.ts`](../tests/final-recap-integration.test.ts): all six completion orders for three timed siblings, nested-last completion, busy-state retry, timeout/completion coalescing, and completion during an automatic continuation. The compaction case simulates the SDK's busy state; it does not run a content-compaction pass.
