# Settings

Open with `/agents` (or `/agents settings`). Save with **Ctrl+S**. Changes apply immediately and never cancel running work.

## Files

| Scope   | Path                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------- |
| Global  | `<pi-agent-dir>/subagent-manager/settings.json` (normally `~/.pi/agent/subagent-manager/settings.json`) |
| Project | `<cwd>/.pi/agent/subagent-manager/settings.json` — trusted projects only; overrides global              |

All keys are optional. Defaults:

```json
{
  "subagentMode": "opportunistic",
  "widgetMode": "full",
  "nerdFontIcons": false,
  "loaderStyle": "circle",
  "costDisplay": "pi-footer-status",
  "costValue": "subagents",
  "costIcon": "money",
  "finalRecap": false,
  "subagentExtensions": false,
  "modelSelection": "pick-first-scoped",
  "toolFiltering": "allowed",
  "maxLevels": 3,
  "maxConcurrent": 16,
  "maxThreads": 64
}
```

Unknown keys, bad values and symlinked paths produce warnings. An invalid file is ignored as a whole; the previous layer (or defaults) stays in effect.

Other packages' settings (e.g. `.pi/subagents.json`) are never read here.

---

## Subagent Mode (`subagentMode`)

How much the main model is encouraged to delegate.

| Option                    | What it does                                                                                                         | Use when                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `off`                     | Hides subagent tools; injects no guidance. Widget, notifications and import offer are hidden. `/agents` still works. | You want plain pi for a while, without uninstalling.             |
| `opportunistic` (default) | Tools on. Main model delegates only parallelizable or very large tasks; otherwise works directly.                    | Everyday use.                                                    |
| `orchestration`           | Tools on. `/root` delegates **all** execution and only coordinates and synthesizes.                                  | Big multi-part tasks where you want the main context kept clean. |

- Orchestration is a prompt policy, not a tool restriction. Workers don't inherit the root-only rule.
- Agent import needs `opportunistic` (it uses the main thread's file tools).

## Status Widget (`widgetMode`)

Controls the subagent status display above the input box. Choose **Status Widget** in `/agents` settings and save with **Ctrl+S**.

| Option             | Display |
| ------------------ | ------- |
| `full` (default)   | A compact tree with one row per agent, task/state, metrics and navigation hints. |
| `minimal`          | One line of theme-colored status counts plus cumulative input `↑` / output `↓` tokens for agents currently starting or running. |

Minimal mode groups starting agents with running agents and excludes the main conversation. Token totals exclude completed, stopped, failed and paused agents. The fullscreen tree remains available via `/agents tree` in either mode. In full mode, press **Right (→)** at the end of the main draft (or in an empty input) to collapse to one line for this session only, without saving preferences. Session startup/switch/reload restores the configured mode. **Left (←)** at the start of the draft still opens the full dialog while agents are active.

## [labs] Nerd Font icons (`nerdFontIcons`)

Experimental features are tagged **[labs]** in the selected setting's help. Row labels omit that prefix to leave room for provenance dots. **[labs] Nerd Font icons** is an on/off toggle, **off by default**. Enable it in `/agents` and save with **Ctrl+S**, or set `"nerdFontIcons": true` in your settings file. Configure a [Nerd Font](https://www.nerdfonts.com/) in your terminal first; unsupported fonts may show boxes or incorrect glyphs. The extension does not install or detect fonts.

When enabled, an agent type’s optional `icon` appears before its readable name in the full widget, thread browsers, live watcher header, and type picker. Starting/running agents show the selected loader **before the original role icon**, never replacing it. Completed, paused, failed, and stopped agents show that loader family's corresponding static state icon before the role icon. Agents without a configured role icon still show their loader/state indicator. The one-line minimal widget uses the same family's indicators for aggregate status counts. Turning the setting off hides role icons without removing configured icons; portable loaders remain visible; RPC output keeps state indicators static. Saved settings apply immediately to newly rendered widgets and dialogs.

All six bundled agents have [role-specific icons](default-agents.md#nerd-font-icons). Add or change an icon with **[labs] Icon** in `/agents types`, or the optional `icon` frontmatter field in [your own agent](custom-agents.md#icons-labs). Retained threads keep the icon from their saved agent definition.

## [labs] Loader style (`loaderStyle`)

Choose a loader in `/agents` settings and save with **Ctrl+S**, or set `loaderStyle` in your settings file:

| Style | Setting | Running frames | Requires Nerd Font |
| --- | --- | --- | --- |
| Circle | `circle` (saved default) | Circle slices | Yes |
| Braille | `braille` | ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ | No (standard Unicode, not ASCII) |
| Hourglass | `hourglass` | Hourglass stages | Yes |
| ASCII | `ascii` | `\| / - \\` | No |
| ASCII Star | `ascii-star` | `+ x *` | No |
| ASCII Pulse | `ascii-pulse` | `= * -` | No |

With **[labs] Nerd Font icons** off, the picker shows only Braille and ASCII palettes. With it on, all palettes are available. Saved Circle/Hourglass preferences render as ASCII while Nerd Fonts are off, without changing the saved preference. ASCII palettes use `+`, `=`, `!`, and `#` for completed, paused, failed, and stopped states. The compact ASCII animations are inspired by [cli-spinners](https://github.com/sindresorhus/cli-spinners/blob/main/spinners.json) (`line`, `star2`, and `toggle13`).

The Labs preview shows every family's running animation frames and completed, paused, failed, and stopped icons, so you can compare all states before choosing. Starting uses the running animation. State indicators precede the role icon when role icons are enabled; the selected family also applies to the minimal widget's counts. In non-animated output, active agents use the family's first frame.

## [labs] Cost display (`costDisplay`)

Open **[labs] Footer display** in `/agents settings` to choose the location, display value, and icon, then return and save. The stable ID/key is **`subagent_cost`**.

| Value | Output |
| --- | --- |
| `pi-footer-status` (default) | Publishes `💵 $0.0000` via Pi’s `setStatus` API. In `/footer`, add **Extension Status** and pick **`subagent_cost`** from the status-key selector. |
| `pi-footer-event` | Emits `pi-footer:update-widget` with `widgetId: "subagent_cost"`. Add **Pi Event Value**, enter **Widget ID** manually, and enable **Raw value only**. Event IDs do not appear in the status selector. Without an extension providing `/footer`, preserves the fallback footer, using the selected value/icon. |
| `pi-status` | **Replace Pi status**: sets the manager’s Pi status to `Subagents: 💵 $0.0000` or `Total: 💵 $0.0000`; no pi-footer events or custom footer. |

Both status modes use the same public Pi status API: third-party footers may also display Pi status-only output. These modes never replace your footer. **Display value** (`costValue`) is independent of location: `subagents` (default) shows settled subagent-only USD; `total` adds the main session’s cost. In all modes, running subagent costs settle on completion, pause, stop, or failure. Values publish on session start/reload, immediately when a subagent starts (even at zero), after settlement/settings changes, and when main-session turns end. Switching locations clears the previous output; shutdown clears the published value.

**Icon** (`costIcon`) offers `money` (default), `coins`, or `wallet`. With **[labs] Nerd Font icons** off, these appear as 💵, 🪙, or 👛. With it on, the picker and output use corresponding Nerd Font glyphs instead. The semantic choice survives toggling font mode.

See [Subagent dollar totals in pi-footer](pi-footer.md) for step-by-step setup and copy-paste widget configuration, status-key, and event snippets.

## [labs] Enable subagent extensions (`subagentExtensions`)

Experimental on/off toggle, **off by default**. Enable **[labs] Enable subagent extensions** in `/agents settings` and save, or set `"subagentExtensions": true`.

When a subagent session opens, it reloads enabled extension files from user configuration and, only when the main project is trusted, project configuration. Pi package resource filters and disabled-extension settings are respected; missing packages are skipped, never installed. This manager is excluded to avoid starting a second subagent manager inside each child. Each factory receives a child-local runtime and its hooks run against that child's session. Reloaded extension tools take precedence over inherited main-session bridges, including tools registered on `session_start`; tool filtering still applies. Other inherited tools keep their existing bridges.

**This is configured-file discovery, not exact main-session inheritance. Bugs and unintended consequences are possible.** Read [subagent extension limitations](subagent-extension-limitations.md) before enabling it: the guide covers excluded extensions, configuration drift, `input` hook bypasses, shared side effects, non-interactive UI, and main-session tool bridges.

Save and apply affects newly opened sessions, including retained sessions reopened after reload. Already-open agents keep their extension runtime until disposed. The main agent's extensions and tool set are not changed. Leave this off unless your extensions are safe to run across separate sessions.

## [labs] Final Recap (`finalRecap`)

**[labs] Final Recap** is an experimental on/off toggle, **off by default**. Enable it in `/agents` and save with **Ctrl+S**, or set `"finalRecap": true` in your settings file.

When detached agents finish or fail and the main agent is idle, their results are sent back to the main agent for an automatic summary. The summary is a main-thread response, so child notifications do not become the final visible message. Progress updates do not trigger summaries, and active main-agent work is not interrupted. **Subagent Mode Off** suppresses automatic summaries even if this setting is enabled.

With Final Recap on, async completion events no longer wake the main agent one by one; the recap turn starts once every outstanding async agent has reported (spawn-timeout events still wake it).

**Enabling Final Recap may cause extra model turns and uses more tokens and context.** Leave it off if you prefer to inspect results manually in `/agents tree` or request a summary yourself.

## Model Picking (`modelSelection`)

Which model an agent gets when its session starts.

| Option                                                  | What it does                                                             | Use when                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `pick-first-available` — **Pick First (available)**     | First entry in the type's `models` with configured credentials.          | You trust your per-agent lists and want them honored regardless of `/scoped-models`.       |
| `pick-first-scoped` — **Pick First (scoped)** (default) | Same, but the model must also be in the main session's `/scoped-models`. | You use `/scoped-models` as an allowlist (cost, compliance) and want agents to respect it. |
| `use-current` — **Use Current**                         | Ignores `models`; uses the main session's current model.                 | One model for everything, or quick testing.                                                |

- Types with no `models` inherit the parent's model in both Pick First modes.
- Your list's order decides, not the scoped list's order.
- No match → spawn fails clearly. An empty `/scoped-models` matches nothing.
- `use-current` always uses the **main** session's model, even for nested or reopened agents. Thinking levels stay per-agent.
- `modelSuggestions` never affects this.
- Switching modes doesn't change already-open sessions.
- Legacy `scopedModelFiltering: true` → `pick-first-scoped`; `false` → `pick-first-available`.

## Tool Filtering (`toolFiltering`)

How the type's `tools.allow` / `tools.block` lists are applied.

| Option                                             | What it does                                                         | Use when                                   |
| -------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `allowed` — **Allowed (except blocked)** (default) | Only `allow` tools, minus `block`. Empty/missing `allow` = no tools. | Least privilege. Recommended.              |
| `all-except-blocked` — **All except blocked**      | Ignores `allow`; everything except `block`.                          | Your definitions only list what to forbid. |
| `all` — **All**                                    | Ignores both lists.                                                  | Trusted local experiments.                 |

- "All" includes child-local built-in and manager tools plus the main session's registered non-hidden tools. Exact-name allow/block lists apply to this inventory.
- Inherited tools retain exposure and active status. Deferred/codemode tools are discoverable through child-local codemode when permitted; direct tools remain model-facing when active.
- By default, built-in tools, manager controls, codemode and tool search remain child-local. External calls reuse main-session resources/context rather than loading fresh extensions or MCP connections. With [Enable subagent extensions](#labs-enable-subagent-extensions-subagentextensions), reloaded extension tools execute in the child instead. Bridged callable tools remain subject to the main session's tool policy; session-mutating external tools are not necessarily isolated to the child. Skills and project context files are not automatically loaded.
- Other custom **model-only** tools fail closed: the SDK cannot bridge them while preserving root permission/result hooks. Run those in the main session.
- UI/command-driven resumes after reopening the main session need a main-session `agent_*` tool call to establish the execution bridge; use `agent_steer` rather than the thread dialog.
- Applies to newly started sessions (including retained ones reopened after reload). Already-open sessions keep their selected tools, and the main session's tool set is unchanged.
- Non-default modes can expose `agent_spawn` to types that weren't meant to delegate.

## Max Levels (`maxLevels`)

Maximum tree depth, counting the main conversation as level 1. Integer 1–32. Default `3` = children and grandchildren.

| Value         | Effect                   | Use when                                             |
| ------------- | ------------------------ | ---------------------------------------------------- |
| `1`           | No new subagents         | Block spawning while still resuming existing threads |
| `2`           | Children only            | Flat fan-out; simplest to follow                     |
| `3` (default) | Children + grandchildren | An `architect` coordinating workers                  |
| `4+`          | Deeper trees             | Large hierarchical teams                             |

Independent roots like `/k` count as level 2, so they can't bypass the limit. Lowering it still lets you resume existing deeper threads.

## Max Concurrent (`maxConcurrent`)

Threads starting or running at once, across the whole tree. Parents waiting on children count. Default `16`.

Lower it for rate limits or cost. Raise it for wide fan-out. When full, spawns **fail** — they don't queue.

## Max Threads (`maxThreads`)

Total retained threads (any state) per main session. Default `64`.

Lower it to keep the tree tidy. Raise it for long sessions with many agents. When full, spawns fail.

## Scope

Settings are read in order: **built-in defaults → Global → trusted Current Project**.
All keys are optional. The dialog saves only values different from the lower layer,
so unchanged settings continue inheriting future global changes. Restoring defaults
is a draft edit; in Project scope it can explicitly override non-default global values.

Colored dots before each setting describe saved changes: an **accent dot** means
changed in Global relative to defaults; a **warning dot** means changed in Current
Project relative to effective global settings. Both dots appear when both layers
change that setting, even when the project restores the built-in default. Equal
values are not changes. Unsaved edits do not change the dots. Footer display groups
the provenance of its three settings; its submenu shows each separately.

The save scope is **Global** when no project settings file exists and **Current
Project** when one exists. It is determined independently for each project; the old
cross-project `ui-state.json` preference is no longer used by this dialog.
Untrusted projects always read and save Global only.

Changing scope opens a confirmation screen with **Cancel selected by default**:

- **Global → Current Project:** Confirm creates the project settings file as an
  empty object (inheriting global). Unsaved edits are kept; Save and apply writes
  them to Project. Future edits in this project use Project scope.
- **Current Project → Global:** Confirm deletes only this manager's project
  settings file, discards unsaved edits, reloads global/default values immediately,
  and routes future saves to Global. Project values are not copied into Global.
- **Cancel / Esc:** no files, values, or scope are changed.

Confirmed scope changes happen **immediately** and survive cancelling the outer
settings screen. Ordinary value edits still require **Save and apply**. Running
agents and retained threads are kept.

The dialog warns about invalid settings layers. Project saves are blocked until an
invalid Global layer is fixed, rather than persisting a default-based snapshot.
If settings layers change while the dialog is open, Save and scope transitions
refuse the stale draft: reopen settings to load the new values before editing.
