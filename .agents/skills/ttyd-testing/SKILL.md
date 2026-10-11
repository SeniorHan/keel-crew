---
name: ttyd-testing
description: Operate real terminal and TUI apps in persistent headless browser sessions through ttyd and Playwright. Use for interactive keyboard testing, terminal resizing, visual regression investigation, and repeated PNG screenshots that an AI agent can inspect.
compatibility: macOS or Linux with Node.js, ttyd, Playwright, and Chromium. Default font is JetBrainsMono Nerd Font Propo.
---

# ttyd testing

Use `scripts/terminal.mjs` to keep a real PTY, ttyd, and an isolated headless Chromium session alive across tool calls. Use `scripts/smoke-test.mjs` to check the complete workflow. All CLI results are JSON.

This is the terminal-specific Playwright harness, not the user's live Chrome session. Never attach it to the user's browser profile, tabs, or logged-in state.

## Safety and preparation

- These commands run with the local user's privileges. **A PTY is not a sandbox.** Do not run untrusted commands.
- Use a disposable working directory and application configuration for tests that save settings, delete files, or otherwise mutate state. Do not test destructive confirmations against the user's real settings.
- Keep the writable ttyd endpoint on localhost. Do not expose its port, open a second browser client, or navigate the persistent page away from the terminal. The ttyd URL requires Basic authentication supplied by the harness; its control endpoint requires a bearer token. Public CLI output omits those secrets; private `session.json` holds them. Do not share that file.
- Screenshots, terminal text, logs, and command arguments can contain secrets. Keep artifacts private; redact before sharing.
- State lives in `ttyd-testing` under the OS temporary directory by default. Set `TTYD_TESTING_HOME` to use another location. The returned `artifacts` path is authoritative. The artifact root and session directories must be owned, non-symlink directories with mode `0700`; insecure existing roots are rejected. Use a dedicated private directory for `TTYD_TESTING_HOME`.

Resolve the skill directory from this `SKILL.md` location; from this repository's root:

```bash
SKILL="$PWD/.agents/skills/ttyd-testing"
node "$SKILL/scripts/terminal.mjs" doctor
```

`doctor` checks dependencies, Chromium, and the font through a headless probe. It does not install anything. If setup is missing, explain the failure and obtain approval before installing:

```bash
brew install ttyd
npm install -g playwright
playwright install chromium
```

Playwright is resolved from a local module or the global npm installation. `PLAYWRIGHT_MODULE` can point to an explicit module path. Do not add dependencies to the app repository merely to use this skill.

## Act → wait → screenshot → inspect

Start a fresh named session, or omit `--session` to generate one. Existing session directories are not overwritten, including stopped sessions.

```bash
SESSION="terminal-$(date +%s)"
WORK="$(mktemp -d)"
node "$SKILL/scripts/terminal.mjs" start \
  --session "$SESSION" --cwd "$WORK" --cols 80 --rows 24 \
  -- /bin/bash --noprofile --norc -i
```

The result includes `session`, `url`, `artifacts`, an initial `screenshot`, and terminal `cols`/`rows`. **Read that PNG with an image-capable tool** before deciding what to do next.

Send text and keys separately. `type` does not implicitly press Enter:

```bash
node "$SKILL/scripts/terminal.mjs" type --session "$SESSION" \
  --text "printf 'RE''ADY\n'"
node "$SKILL/scripts/terminal.mjs" press --session "$SESSION" --key Enter
node "$SKILL/scripts/terminal.mjs" wait --session "$SESSION" \
  --text READY --timeout 15000
node "$SKILL/scripts/terminal.mjs" screenshot --session "$SESSION" --name ready
```

Then read the returned screenshot path. Repeat after each meaningful interaction: opening a dialog, moving selection, confirming/cancelling, changing a setting, or resizing. `type` and `press` return status/text; request screenshots explicitly after actions.

**Do not infer visual correctness from terminal text or an accessibility snapshot.** xterm.js is canvas-rendered. Text can establish readiness or content, but only the PNG shows colors, clipping, glyphs, borders, cursor placement, and layout.

Choose a readiness substring that cannot be satisfied merely by echoed input or an earlier screen. For animated/live output, capture and inspect a deliberate sample rather than claiming the entire UI is stable.

## Controls

All commands use `node "$SKILL/scripts/terminal.mjs"`:

| Command | Arguments / purpose |
|---|---|
| `doctor` | Check ttyd, Playwright, Chromium, and font availability; optional `--font FAMILY`. |
| `start` | `--session NAME` optional; `--cwd DIR`; `--cols 80 --rows 24`; `--font FAMILY --font-size 14`; repeatable `--env KEY=VALUE`; `--timeout 15000`; `--idle-timeout 1800000`; then `-- COMMAND ARG…`. |
| `type` | `--session NAME --text STRING` **or** `--file FILE`; text input without implicit Enter. |
| `press` | `--session NAME --key KEY`; Playwright syntax such as `Enter`, `Escape`, `ArrowDown`, `Tab`, `Control+c`, or `Control+s`. |
| `wait` | `--session NAME --text SUBSTRING --timeout 15000`; wait for terminal content. |
| `screenshot` | `--session NAME`; optional `--name descriptive-label`; write a PNG to the session artifacts. |
| `text` | `--session NAME`; optional `--history`; inspect the terminal buffer, not pixels. |
| `resize` | `--session NAME --cols 60 --rows 12`; change terminal dimensions. |
| `status` | `--session NAME`; inspect a session. |
| `list` | List sessions. |
| `stop` | `--session NAME`; stop the session while keeping artifacts. |

Arguments after `start … --` are an executable and its argv, **not a shell command string**. For shell syntax, explicitly launch a shell and pass its arguments. Avoid introducing shell evaluation when argv is enough.

Timeouts are milliseconds. The default idle timeout is 30 minutes; unattended sessions stop while retaining artifacts. An idle timeout is a safety net, not a substitute for cleanup. After an app exits, the browser and final frame remain available until `stop` or the idle timeout; inspect `status` rather than assuming the app is still accepting input.

`stop` can cancel startup or interrupt a long wait. Disconnected clients' queued input is cancelled rather than delivered late. Actions otherwise run serially; do not issue competing input from several agents in one session.

## Font and dimensions

The default is the user's installed **JetBrainsMono Nerd Font Propo**, at 14px. Preserve this preference unless the user requests another font. Propo glyphs can be wider than a terminal cell: inspect Nerd Font icons in actual screenshots and do not promise identical glyph behavior to the Mono variant.

`--cols` and `--rows` refer to character cells, not browser pixel dimensions. Test normal and constrained layouts, taking a screenshot at each size:

```bash
node "$SKILL/scripts/terminal.mjs" resize --session "$SESSION" --cols 60 --rows 12
node "$SKILL/scripts/terminal.mjs" screenshot --session "$SESSION" --name short-terminal
node "$SKILL/scripts/terminal.mjs" resize --session "$SESSION" --cols 20 --rows 24
node "$SKILL/scripts/terminal.mjs" screenshot --session "$SESSION" --name narrow-terminal
```

Inspect text truncation, selection visibility, wrapping, borders, dangerous-action warnings, colors, and font fallback. A screenshot is evidence from one viewport and moment, not proof of every state.

## Testing Pi without changing real settings

Pi's `PI_CODING_AGENT_DIR` environment variable overrides its user configuration directory. Use it together with a disposable project directory for settings-mutation tests:

```bash
WORK="$(mktemp -d)"
mkdir -p "$WORK/project" "$WORK/agent"
SESSION="pi-ui-$(date +%s)"
node "$SKILL/scripts/terminal.mjs" start \
  --session "$SESSION" --cwd "$WORK/project" --cols 80 --rows 24 \
  --env "PI_CODING_AGENT_DIR=$WORK/agent" -- pi
```

An empty agent directory does not include the user's configured extensions, models, or credentials. Explicitly configure the extension/app under test; do not silently copy credentials or assume this launches the same configuration as the user's current Pi session. Project settings still depend on Pi's project-trust decision.

## Cleanup, failures, and evidence

Always stop sessions you started, including after an assertion or action fails:

```bash
node "$SKILL/scripts/terminal.mjs" status --session "$SESSION"
node "$SKILL/scripts/terminal.mjs" stop --session "$SESSION"
```

For failures, preserve the session's `daemon.log`, `ttyd.log`, and useful screenshots. Report the exact command, terminal dimensions, expected behavior, observed behavior, and screenshot path. Do not claim success from an exit code alone when the task is visual.

Run the reusable end-to-end check after changing the harness:

```bash
node "$SKILL/scripts/smoke-test.mjs"
node "$SKILL/scripts/lifecycle-test.mjs"
```

It exercises real terminal keyboard input, colored output, Nerd Font icons, alternate-screen behavior, PTY resizing, and repeated PNG captures, with teardown in `finally`. Read its screenshots to assess appearance; automated assertions alone do not certify font fidelity.

The lifecycle regression check covers private-root validation, split-chunk Unicode, client timeouts, startup cancellation, interrupting waits, idle cleanup, and termination of PTY programs that ignore SIGHUP/SIGTERM. Process cleanup uses Unix `ps`; this harness is tested on macOS and intended for macOS/Linux, not Windows.

## Keep reusable scripts here

- Reuse the existing CLI; do not rebuild a one-off inline ttyd/Playwright harness for each test.
- Add reusable scenario scripts or small helpers under `scripts/`, and fixtures under `assets/` when needed.
- Each scenario must use a fresh session, explicit readiness checks, named screenshots, and cleanup in `finally`.
- Keep application-specific setup separate from session/control infrastructure. Do not embed machine secrets or hard-code the user's project path.
- Update this command reference when adding or changing controls. Add a smoke/regression check for new behavior.

Run `/reload` after adding or editing the skill. Load it explicitly with `/skill:ttyd-testing` when needed.
