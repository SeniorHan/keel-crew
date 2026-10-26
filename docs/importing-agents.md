# Importing agents

Already have agents for another pi subagent package? Import them.

## How

- **First run:** in an interactive TUI session, you're offered an import once. (Not in `off` or `orchestration` mode.)
- **Any time:** `/agents import`.

The checkbox picker starts with nothing selected.

| Key    | Action                |
| ------ | --------------------- |
| ↑↓     | Navigate              |
| Space  | Toggle row            |
| Ctrl+A | Toggle all            |
| Enter  | Submit (empty = skip) |
| Esc    | Cancel                |

## What happens

Your **current main model** does the conversion, in your current conversation. There's no converter code and no separate agent.

- It receives only the selected file paths, relevant source settings paths, the target schema, your scoped models and tools, and migration instructions.
- It must explain and get your approval for anything lossy: unsupported features, dropped security restrictions, unavailable models, name collisions.
- Originals are never modified.
- New definitions load after the turn, or with `/agents reload`.

Requires `opportunistic` mode (it uses the main thread's file tools). TUI only — RPC/print/JSON sessions never prompt.

## Where it looks

Supported sources: [`@tintinweb/pi-subagents` 0.19.0](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/custom-agents.ts) and [npm `pi-subagents` 0.74.0](https://github.com/nicobailon/pi-subagents/blob/b6bda32f03b7f549623bc404c9be14dca298ddc4/src/agents/agents.ts).

- **User:** `<pi-agent-dir>/agents`; recursive `~/.agents` (npm).
- **Project (trusted only):** `.pi/agents`, `.agents/agents` (tintinweb), recursive `.agents` (npm), including npm's nearest configured ancestor.
- **Extra:** npm's `PI_SUBAGENT_EXTRA_AGENT_DIRS` and `settings.json` → `subagents.agentScanDirs` / `agentExcludeDirs`.

Skipped: `skills`/`.skills` trees, any `SKILL.md`, symlinks, `.chain.md` workflows, installed-package builtins. npm's git-root anchoring isn't reproduced.

The offer is remembered in `<pi-agent-dir>/keel-crew/.import-offered`.
