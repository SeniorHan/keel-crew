import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  initTheme,
  type ExtensionCommandContext,
  type ScopedModel,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AGENT_COLORS } from "../src/prefs/config.ts";
import { ConfigStore } from "../src/prefs/config.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  type ManagerSettings,
} from "../src/prefs/settings.ts";
import { configureAgents } from "../src/ui/settings-ui.ts";
import { HousekeepingModelPickerComponent } from "../src/ui/model-picker.ts";
import { StatusDialog } from "../src/ui/status-ui.ts";
import { renderAgentTree, renderThreads, updateWidget } from "../src/ui/ui.ts";
import { threadActivity } from "../src/ui/thread-tree.ts";
import type { DialogMenu, DialogRow } from "../src/ui/dialog.ts";
import type { ThreadService, ThreadView } from "../src/types.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

initTheme();

const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const renderTheme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  colors: Object.fromEntries(AGENT_COLORS.map((color) => [color, rgbColor(238, 238, 238)])),
  style: (text: string) => text,
} as unknown as Theme;

function thread(path: string, patch: Partial<ThreadView> = {}): ThreadView {
  const slash = path.lastIndexOf("/");
  return {
    parent: slash > 0 ? path.slice(0, slash) : null,
    owner: "/root",
    type: "worker",
    state: "running",
    task: "Investigate flaky test",
    status: "Tool: bash",
    createdAt: 1,
    updatedAt: 2,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...patch,
    path,
  };
}

const text = (lines: string[]) => lines.map((line) => stripTerminalSequences(line)).join("\n");

// --- rendering ------------------------------------------------------------------------------

test("a summary replaces raw tool status only while the agent is active", () => {
  assert.equal(threadActivity(thread("/root/a")), "Tool: bash", "no summary: original behavior");
  assert.equal(
    threadActivity(thread("/root/a", { summary: "Running the test suite" })),
    "Running the test suite",
  );
  assert.equal(
    threadActivity(thread("/root/a", { state: "starting", summary: "Warming up" })),
    "Warming up",
  );
  for (const state of ["completed", "failed", "paused", "stopped"] as const)
    assert.equal(
      threadActivity(
        thread("/root/a", { state, status: `real ${state} status`, summary: "stale label" }),
      ),
      `real ${state} status`,
      state,
    );
  assert.equal(threadActivity(thread("/root/a", { summary: "   " })), "Tool: bash");
  assert.equal(
    threadActivity(thread("/root/a", { summary: undefined, status: "" })),
    "Investigate flaky test",
    "task fallback",
  );
});

test("the tree viewer and status widget both show the one-line summary", () => {
  const threads = [
    thread("/root/a", { summary: "Running the test suite" }),
    thread("/root/b", {
      summary: "Hidden after completion",
      state: "completed",
      status: "Completed; session retained",
    }),
    thread("/root/c"),
  ];
  const service = {
    list: () => threads,
    get: (path: string) => threads.find((item) => item.path === path)!,
  } as ThreadService;
  const dialog = new StatusDialog(
    { requestRender() {}, terminal: { rows: 30 } },
    renderTheme,
    service,
    () => {},
  );
  const tree = text(dialog.render(110));
  assert.match(tree, /Running the test suite/);
  assert.doesNotMatch(tree, /Hidden after completion/);
  assert.match(tree, /Completed; session retained/);
  assert.match(tree, /Tool: bash/, "agents without a summary keep their tool-call status");
  assert.equal(
    tree.split("\n").filter((line) => line.includes("Tool: bash")).length,
    1,
    "only /root/c shows raw status",
  );

  const widget = text(renderAgentTree(threads, 110, renderTheme));
  assert.match(widget, /Running the test suite/);
  assert.doesNotMatch(widget, /Hidden after completion|Tool: bash|Completed; session retained/);
  assert.equal(
    widget.split("\n").filter((line) => line.includes("Investigate flaky test")).length,
    2,
    "completed agents and agents without a summary keep their task label",
  );
});

test("summary selection keeps each view's fallback for missing, blank, or inactive summaries", () => {
  const cases: Partial<ThreadView>[] = [
    { state: "running", summary: "  Running the test suite  " },
    { state: "starting", summary: "  Warming up  " },
    { summary: undefined },
    { summary: "" },
    { summary: " \t\n " },
    { summary: undefined, status: "" },
    ...(["completed", "failed", "paused", "stopped"] as const).map((state) => ({
      state,
      summary: "stale label",
    })),
  ];
  for (const patch of cases) {
    const view = thread("/root/a", patch);
    const active = view.state === "starting" || view.state === "running";
    const summary = active ? view.summary?.trim() : undefined;
    const activity = summary || view.status || view.task;
    const title = summary || view.task;
    const dialog = new StatusDialog(
      { requestRender() {}, terminal: { rows: 24 } },
      renderTheme,
      { list: () => [view], get: () => view } as unknown as ThreadService,
      () => {},
    );
    assert.ok(text(dialog.render(110)).includes(activity), JSON.stringify(patch));
    assert.ok(text(renderThreads([view], 110, renderTheme)).includes(activity));
    const widget = text(renderAgentTree([view], 110, renderTheme));
    assert.ok(widget.includes(title), JSON.stringify(patch));
    assert.doesNotMatch(widget, /Tool: bash|stale label/);
  }
});

test("summary text stays sanitized and width-bounded in the tree and status renderers", () => {
  const threads = [
    thread("/root/a", {
      summary: "Edit\x1b[31m red \x07file " + "界".repeat(80),
      inputTokens: 120,
      outputTokens: 45,
    }),
  ];
  const dialog = new StatusDialog(
    { requestRender() {}, terminal: { rows: 24 } },
    renderTheme,
    { list: () => threads, get: () => threads[0]! } as unknown as ThreadService,
    () => {},
  );
  for (const width of [1, 20, 40, 100]) {
    for (const lines of [
      dialog.render(width),
      renderAgentTree(threads, width, renderTheme),
      renderThreads(threads, width, renderTheme),
    ]) {
      assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(text(lines).replaceAll("\n", "")));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (width === 100) {
        assert.match(text(lines), /Edit red/);
        assert.match(text(lines), /↑120 ↓45/);
      }
    }
  }
});

test("full TUI and RPC widgets show fresh summaries and return to the task when cleared", () => {
  for (const mode of ["tui", "rpc"] as const) {
    let rendered: string[] = [];
    const ctx = {
      hasUI: true,
      mode,
      ui: {
        theme: renderTheme,
        setWidget(_key: string, value: unknown) {
          if (typeof value === "function") {
            const component = value({ requestRender() {} });
            try {
              rendered = component.render(110);
            } finally {
              component.dispose();
            }
          } else rendered = value as string[];
        },
      },
    } as unknown as ExtensionCommandContext;
    const view = thread("/root/a", { summary: "Running the test suite" });
    updateWidget(ctx, [view]);
    assert.match(text(rendered), /Running the test suite/);
    assert.doesNotMatch(text(rendered), /Investigate flaky test|Tool: bash/);
    updateWidget(ctx, [{ ...view, summary: undefined }]);
    assert.match(text(rendered), /Investigate flaky test/);
    assert.doesNotMatch(text(rendered), /Running the test suite|Tool: bash/);
  }
});

// --- model picker ---------------------------------------------------------------------------

const AVAILABLE = [
  { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
  { provider: "google", id: "gemini-flash", name: "Gemini Flash" },
];

function picker(options: { scoped?: string[]; current?: string; rows?: number } = {}) {
  const done: string[] = [];
  let cancelled = 0;
  const component = new HousekeepingModelPickerComponent({
    tui: { requestRender() {}, terminal: { rows: options.rows ?? 24 } },
    theme: plainTheme,
    availableModels: AVAILABLE,
    scopedModels: (options.scoped ?? []).map(
      (identity) =>
        ({
          model: AVAILABLE.find((model) => `${model.provider}/${model.id}` === identity)!,
        }) as unknown as ScopedModel,
    ),
    current: options.current,
    onDone: (identity) => done.push(identity),
    onCancel: () => cancelled++,
  });
  component.focused = true;
  return { component, done, cancelled: () => cancelled };
}
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

test("housekeeping picker lists scoped models first, then all other available models", () => {
  const { component } = picker({ scoped: ["openai/gpt-5-mini"] });
  const rows = component.getRows();
  assert.deepEqual(
    rows.map((row) => [row.group, row.value]),
    [
      ["Selection", ""],
      ["Scoped models", "openai/gpt-5-mini"],
      ["Other available models", "anthropic/claude-haiku-5-5"],
      ["Other available models", "anthropic/claude-opus-5-5"],
      ["Other available models", "google/gemini-flash"],
    ],
  );
  const rendered = text(component.render(100));
  assert.match(rendered, /Scoped models/);
  assert.match(rendered, /Other available models/);
  assert.match(rendered, /Housekeeping model/);
});

test("housekeeping picker chooses scoped or unscoped models, clears, cancels, and previews the current one", () => {
  let p = picker({ scoped: ["openai/gpt-5-mini"] });
  p.component.handleInput(DOWN);
  p.component.handleInput(ENTER);
  assert.deepEqual(p.done, ["openai/gpt-5-mini"]);

  p = picker({ scoped: ["openai/gpt-5-mini"] });
  for (let i = 0; i < 3; i++) p.component.handleInput(DOWN);
  p.component.handleInput(ENTER);
  assert.deepEqual(
    p.done,
    ["anthropic/claude-opus-5-5"],
    "available-but-unscoped models are selectable",
  );

  p = picker({ current: "openai/gpt-5-mini" });
  assert.equal(
    p.component.getSelectedValue(),
    "openai/gpt-5-mini",
    "current model starts selected",
  );
  assert.match(text(p.component.render(100)), /GPT-5 mini · current/);
  p.component.handleInput(UP);
  p.component.handleInput(UP);
  p.component.handleInput(UP);
  p.component.handleInput(UP);
  p.component.handleInput(ENTER);
  assert.deepEqual(p.done, [""], "No model clears the selection");

  p = picker();
  p.component.handleInput(ESC);
  assert.equal(p.cancelled(), 1);
  assert.deepEqual(p.done, []);
});

test("housekeeping picker search filters models and selects the best match", () => {
  const p = picker({ scoped: ["openai/gpt-5-mini"] });
  for (const char of "haiku") p.component.handleInput(char);
  assert.deepEqual(
    p.component.getRows().map((row) => row.value),
    ["", "anthropic/claude-haiku-5-5"],
  );
  assert.equal(p.component.getSelectedValue(), "anthropic/claude-haiku-5-5");
  p.component.handleInput(ENTER);
  assert.deepEqual(p.done, ["anthropic/claude-haiku-5-5"]);
  const none = picker();
  for (const char of "zzzzqq") none.component.handleInput(char);
  assert.deepEqual(
    none.component.getRows().map((row) => row.value),
    [""],
  );
});

test("housekeeping picker keeps an unavailable current model visible and fits narrow terminals", () => {
  const { component } = picker({ current: "gone/model", rows: 10 });
  assert.equal(component.getRows()[1]!.value, "gone/model");
  assert.match(component.getRows()[1]!.description, /unavailable/);
  for (const width of [30, 60, 120]) {
    const lines = component.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
    assert.equal(lines.length, 8);
  }
  assert.match(text(picker().component.render(100)), /No scoped models in this session/);
});

// --- settings dialog ------------------------------------------------------------------------

type Menu = { title: string; rows: DialogRow[] };

async function runSettings(
  t: TestContext,
  actions: (string | undefined)[],
  options: {
    settings?: Partial<ManagerSettings>;
    global?: Partial<ManagerSettings>;
    project?: Partial<ManagerSettings>;
    trusted?: boolean;
    picks?: (string | typeof CANCEL | typeof CLEAR)[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-housekeeping-ui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userFile = join(root, "subagent-manager", "settings.json");
  const projectFile = join(root, ".pi", "agent", "subagent-manager", "settings.json");
  for (const [file, contents] of [
    [userFile, options.global],
    [projectFile, options.project],
  ] as const) {
    if (!contents) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(contents));
  }
  const trusted = options.trusted ?? false;
  const picks = [...(options.picks ?? [])];
  const pickerStarts: (string | undefined)[] = [];
  const menus: Menu[] = [];
  const notifications: string[] = [];
  const driver = createDialogDriver({
    theme: plainTheme,
    rows: 24,
    width: 100,
    choices: actions,
    unified: true,
    onMenu: (menu: DialogMenu) =>
      menus.push({ title: menu.title, rows: menu.rows.map((row) => ({ ...row })) }),
  });
  driver.onChild = (component) => {
    if (!(component instanceof HousekeepingModelPickerComponent)) return false;
    pickerStarts.push(component.getSelectedValue());
    const pick = picks.shift();
    if (pick === undefined || pick === CANCEL) component.handleInput(ESC);
    else if (pick === CLEAR) {
      for (let i = 0; i < 10; i++) component.handleInput(UP);
      component.handleInput(ENTER);
    } else {
      for (const char of pick) component.handleInput(char);
      component.handleInput(ENTER);
    }
    return true;
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    modelRegistry: { getAvailable: () => AVAILABLE },
    scopedModels: [{ model: AVAILABLE[2] }],
    ui: { notify: (message: string) => notifications.push(message), custom: driver.custom },
  } as unknown as ExtensionCommandContext;
  let applied = 0;
  const initial = {
    ...loadManagerSettings({ cwd: root, agentDir: root, includeProject: trusted }).settings,
    ...options.settings,
  };
  await configureAgents(ctx, {
    store: new ConfigStore({ cwd: root, agentDir: root, includeProject: false }),
    agentDir: root,
    settings: initial,
    apply: () => applied++,
  });
  return {
    menus,
    notifications,
    applied,
    pickerStarts,
    loaded: loadManagerSettings({ cwd: root, agentDir: root, includeProject: trusted }),
    userFile,
    projectFile,
    row: (menu: number, id: string) => menus[menu]!.rows.find((row) => row.id === id)!,
  };
}
const CANCEL = Symbol("cancel");
const CLEAR = Symbol("clear");

test("settings show a [lab] Housekeeping model row that is Off by default", async (t) => {
  const result = await runSettings(t, ["cancel"]);
  const row = result.row(0, "housekeeping");
  assert.equal(row.label, "[lab] Housekeeping model");
  assert.equal(row.value, "Off");
  assert.match(row.help!, /Experimental/);
  assert.match(row.help!, /available and scoped models/);
  assert.match(row.help!, /original status/);
  assert.equal(DEFAULT_MANAGER_SETTINGS.housekeepingEnabled, false);
  assert.equal(result.loaded.settings.housekeepingModel, "");
});

test("enabling and picking a scoped or unscoped model saves both keys and reflects them", async (t) => {
  const result = await runSettings(t, ["housekeeping", "enabled", "model", "back", "save"], {
    picks: ["haiku"],
  });
  assert.equal(result.menus[1]!.title, "[lab] Housekeeping model");
  assert.equal(result.row(1, "enabled").value, "Off");
  assert.equal(result.row(1, "model").value, "Not selected");
  assert.equal(result.row(2, "enabled").value, "On", "toggle applies to the shared draft");
  assert.equal(result.row(3, "model").value, "anthropic/claude-haiku-5-5");
  assert.equal(result.row(4, "housekeeping").value, "On · anthropic/claude-haiku-5-5");
  assert.equal(result.loaded.settings.housekeepingEnabled, true);
  assert.equal(result.loaded.settings.housekeepingModel, "anthropic/claude-haiku-5-5");
  assert.equal(result.applied, 1);
  assert.deepEqual(result.pickerStarts, [""]);
});

test("enabled without a model is shown as inactive; cancelling the picker keeps the previous model", async (t) => {
  const none = await runSettings(t, ["housekeeping", "enabled", "back", "cancel"]);
  assert.equal(none.row(3, "housekeeping").value, "On · no model selected");
  assert.equal(none.row(3, "housekeeping").valueColor, "warning");
  assert.equal(none.loaded.settings.housekeepingEnabled, false, "cancel does not save");

  const kept = await runSettings(t, ["housekeeping", "model", "back", "cancel"], {
    global: { housekeepingEnabled: true, housekeepingModel: "openai/gpt-5-mini" },
    picks: [CANCEL],
  });
  assert.equal(kept.row(3, "housekeeping").value, "On · openai/gpt-5-mini");
  assert.deepEqual(kept.pickerStarts, ["openai/gpt-5-mini"], "picker opens on the current model");
});

test("choosing No model clears the saved model; turning summaries Off keeps it", async (t) => {
  const cleared = await runSettings(t, ["housekeeping", "model", "back", "save"], {
    global: { housekeepingEnabled: true, housekeepingModel: "openai/gpt-5-mini" },
    picks: [CLEAR],
  });
  assert.equal(cleared.loaded.settings.housekeepingModel, "");
  assert.equal(cleared.loaded.settings.housekeepingEnabled, true);

  const off = await runSettings(t, ["housekeeping", "enabled", "back", "save"], {
    global: { housekeepingEnabled: true, housekeepingModel: "openai/gpt-5-mini" },
  });
  assert.equal(off.loaded.settings.housekeepingEnabled, false);
  assert.equal(
    off.loaded.settings.housekeepingModel,
    "openai/gpt-5-mini",
    "choice is retained while Off",
  );
});

test("housekeeping persists as overrides in the selected scope with provenance dots", async (t) => {
  const result = await runSettings(t, ["housekeeping", "enabled", "back", "save"], {
    trusted: true,
    global: { housekeepingModel: "openai/gpt-5-mini" },
    project: {},
  });
  assert.equal(result.loaded.settings.housekeepingEnabled, true);
  const projectOnly = JSON.parse(readFileSync(result.projectFile, "utf8"));
  assert.deepEqual(
    projectOnly,
    { housekeepingEnabled: true },
    "only the changed key is saved to Project",
  );
  const dots = (menu: number) =>
    result.menus[menu]!.rows.find((row) => row.id === "housekeeping")!.renderIndicators!({
      fg: (color: string, glyph: string) => `<${color}>${glyph}</${color}>`,
    } as Theme);
  assert.equal(
    dots(0),
    "<accent>●</accent>  ",
    "saved global change is flagged; unsaved edits are not",
  );
});

test("search selects the first matching available model, not the unavailable saved one", () => {
  const p = picker({ current: "gone/model", scoped: ["openai/gpt-5-mini"] });
  assert.equal(p.component.getRows()[1]!.value, "gone/model");
  for (const char of "haiku") p.component.handleInput(char);
  assert.deepEqual(
    p.component.getRows().map((row) => row.value),
    ["", "gone/model", "anthropic/claude-haiku-5-5"],
  );
  assert.equal(p.component.getSelectedValue(), "anthropic/claude-haiku-5-5");
  p.component.handleInput(ENTER);
  assert.deepEqual(p.done, ["anthropic/claude-haiku-5-5"]);
  // No matches: falls back to the clear row rather than an out-of-range selection.
  const none = picker({ current: "gone/model" });
  for (const char of "zzzzqq") none.component.handleInput(char);
  assert.equal(none.component.getSelectedValue(), "");
});
