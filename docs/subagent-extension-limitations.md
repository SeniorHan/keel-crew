# Subagent extension limitations

**[lab] Subagent extensions** (`subagentExtensions`) is experimental and **none selected by default**. It reloads selected auto-discovered/configured extension files into separate subagent sessions. Bugs and unintended consequences are possible; enable it only when your extensions are safe to run in multiple sessions.

See [the setting and how to enable it](settings.md#labs-subagent-extensions-subagentextensions).

## Not an exact copy of the main agent's extensions

- The public Pi extension API does not expose the main session's loaded-extension inventory. Subagents discover enabled extension files through Pi’s resource resolver: standalone `.ts`/`.js` files and subdirectory entry points in `<agentDir>/extensions` (honoring `PI_CODING_AGENT_DIR`), plus configured/package paths. The same discovery under `<cwd>/.pi/extensions` and project configuration is included only when the main project is trusted.
- **CLI-only, inline, and built-in extensions are not reloaded.** Auto-discovered and configured file extensions are supported; this manager is excluded to avoid starting another keel-crew inside each child.
- Configuration changed since the main session loaded can produce a different extension set in a newly opened subagent session. Disabled-extension settings and package resource filters are respected. Missing packages are skipped, never installed.
- Saving the selection affects newly opened sessions, including retained sessions reopened after reload. Already-open agents keep their extension runtime until disposed; the main agent's runtime is unchanged.

## Some messages bypass `input` hooks

Initial prompts run `input` hooks. **Durable steering and replayed queued mailbox messages bypass `input` hooks** to preserve mailbox delivery semantics. Request-time context hooks still run, but an extension cannot rely on its `input` handler seeing or transforming every subagent message.

## Separate sessions do not isolate every side effect

Each reloaded factory receives a child-local runtime, and its hooks operate on that child's session rather than the main session. Hooks that assume main-session state may behave incorrectly. Sessions can run concurrently, so writes to shared files, external services, or other shared state can conflict or produce repeated side effects.

Subagents use **non-interactive print mode**, not the main agent's interactive terminal UI. Extensions that require dialogs, confirmations, or other interactive UI may not work as expected. Session shutdown hooks are awaited before child contexts are invalidated, but extensions must still handle their own session-scoped resources safely.

## Some tools still execute through the main session

Reloaded extension tools take precedence over inherited main-session bridges, including tools registered on `session_start`; agent tool filtering still applies. Tools that are not reloaded, including built-in MCP tools, retain the existing main-session bridge.

**Bridged calls run through both child hooks and the main session's hooks.** They reuse main-session resources and context, so session-mutating tools are not necessarily isolated to the child, and hook side effects can occur in both sessions. Built-in codemode and tool search remain child-local rather than reusing the main agent's implementations.

Leave all extensions unselected if your extensions require exact main-session inheritance, interactive UI, or an `input` hook for every delivered message.
