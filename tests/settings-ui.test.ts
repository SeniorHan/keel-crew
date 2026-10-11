import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/prefs/config.ts";
import { dialogHeight, type DialogRow } from "../src/ui/dialog.ts";
import { AGENT_LOADERS } from "../src/ui/agent-loader.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { configureAgents } from "../src/ui/settings-ui.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  LOADER_STYLES,
  type ManagerSettings,
} from "../src/prefs/settings.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
type Menu = { title: string; rows: DialogRow[]; selectedId: string | undefined };

/** Runs configureAgents with scripted menu/input choices and reports what reached disk. */
async function run(
  t: TestContext,
  actions: (string | undefined)[],
  { settings, trusted = false, width = 80, rows = 24, root: existingRoot, agentDir: existingAgentDir, global, project, onMenu } = {} as {
    settings?: ManagerSettings;
    trusted?: boolean;
    width?: number;
    rows?: number;
    root?: string;
    agentDir?: string;
    global?: Partial<ManagerSettings> | string;
    project?: Partial<ManagerSettings> | string;
    onMenu?: (menu: Menu, index: number, files: { userFile: string; projectFile: string }) => void;
  },
) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "pi-settings-ui-"));
  if (!existingRoot) t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = existingAgentDir ?? root;
  const userFile = join(agentDir, "subagent-manager", "settings.json");
  const projectFile = join(root, ".pi", "agent", "subagent-manager", "settings.json");
  for (const [file, contents] of [[userFile, global ?? settings], [projectFile, project]] as const) {
    if (contents === undefined) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  const initialSettings = settings ?? loadManagerSettings({ cwd: root, agentDir, includeProject: trusted }).settings;
  const notifications: string[] = [];
  const notificationTypes: string[] = [];
  const menus: Menu[] = [];
  const driver = createDialogDriver({
    theme,
    width,
    rows,
    choices: actions,
    unified: true,
    assertBorder: true,
    onOpen: (options) => assert.equal((options as { overlay?: boolean }).overlay, true),
    onMenu: (menu) => {
      const snapshot = {
        title: menu.title,
        selectedId: menu.getSelectedId(),
        rows: menu.rows.map((row) => ({ ...row })),
      };
      menus.push(snapshot);
      onMenu?.(snapshot, menus.length - 1, { userFile, projectFile });
    },
  });
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui: {
      notify: (message: string, type: string) => {
        notifications.push(message);
        notificationTypes.push(type);
      },
      custom: driver.custom,
    },
  } as unknown as ExtensionCommandContext;
  let applied = 0;
  const appliedSettings: ManagerSettings[] = [];
  await configureAgents(ctx, {
    store: new ConfigStore({ cwd: root, agentDir, includeProject: false }),
    agentDir,
    settings: { ...initialSettings },
    apply: () => {
      applied++;
      appliedSettings.push(loadManagerSettings({ cwd: root, agentDir, includeProject: trusted }).settings);
    },
  });
  // Every settings flow stays inside one outer overlay with a fixed frame height.
  assert.equal(driver.stats.outerOpens, 1);
  assert.equal(driver.stats.outerCompletions, 1);
  assert.equal(driver.stats.forcedRenders, 0);
  const height = dialogHeight({ requestRender() {}, terminal: { rows } });
  assert.ok(driver.stats.frameHeights.every((frame) => frame === height));
  const value = (menu: number, id: string) => menus[menu]?.rows.find((row) => row.id === id)?.value;
  return {
    root,
    applied,
    appliedSettings,
    notifications,
    notificationTypes,
    menus,
    renders: driver.renders,
    value,
    loaded: loadManagerSettings({ cwd: root, agentDir, includeProject: trusted }),
    userFile,
    projectFile,
  };
}

test("[labs] Loader style previews all families and states together, and saves every selection", async (t) => {
  for (const loaderStyle of LOADER_STYLES) {
    const result = await run(t, ["loaderStyle", loaderStyle, "save"], {
      settings: { ...DEFAULT_MANAGER_SETTINGS, nerdFontIcons: true },
    });
    const chooser = result.menus[1]!;
    assert.equal(result.menus[0]!.rows.find((row) => row.id === "loaderStyle")!.label, "[labs] Loader style");
    assert.equal(result.value(0, "loaderStyle"), "Circle");
    assert.equal(chooser.title, "[labs] Loader style");
    assert.deepEqual(chooser.rows.map((row) => row.id), [...LOADER_STYLES]);
    const preview = result.renders.find((lines) => lines[0]?.includes("[labs] Loader style"))!;
    assert.ok(preview, "loader picker rendered");
    const text = stripTerminalSequences(preview.join("\n"));
    for (const row of chooser.rows) {
      const loader = AGENT_LOADERS[row.id as typeof loaderStyle];
      assert.ok(text.includes(loader.label), `${loader.label} visible alongside other options`);
      for (const glyph of [...loader.frames, ...Object.values(loader.states)]) {
        assert.ok(row.value!.includes(glyph));
        assert.ok(text.includes(glyph), `${row.id} preview ${glyph} visible`);
      }
      for (const state of ["Starting/running", "Completed", "Paused", "Failed", "Stopped"]) {
        assert.ok(row.help!.includes(state));
      }
    }
    assert.ok(text.includes("completed, paused, failed, stopped"), "visible preview legend");
    assert.equal(result.loaded.settings.loaderStyle, loaderStyle);
    assert.equal(result.applied, 1);
    assert.equal(result.value(2, "loaderStyle"), AGENT_LOADERS[loaderStyle].label);
  }
});

test("[labs] Loader style cancel, restore-defaults and narrow layouts preserve draft semantics", async (t) => {
  const cancelled = await run(t, ["loaderStyle", "braille", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
  const chooserCancelled = await run(t, ["loaderStyle", undefined, "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, loaderStyle: "hourglass" },
  });
  assert.equal(chooserCancelled.loaded.settings.loaderStyle, "hourglass");
  const restored = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, loaderStyle: "braille" },
  });
  assert.equal(restored.loaded.settings.loaderStyle, "circle");
  for (const width of [20, 40, 60]) {
    const result = await run(t, ["loaderStyle", "hourglass", "save"], {
      width,
      trusted: true,
      settings: { ...DEFAULT_MANAGER_SETTINGS, nerdFontIcons: true },
    });
    assert.equal(result.loaded.settings.loaderStyle, "hourglass");
    assert.ok(result.renders.every((lines) => lines.every((line) => visibleWidth(line) <= width)));
  }
});

test("[labs] Nerd Font setting toggles, persists, and cancels without saving", async (t) => {
  const enabled = await run(t, ["nerdFontIcons", "save"]);
  const field = enabled.menus[0]!.rows.find((row) => row.id === "nerdFontIcons")!;
  assert.equal(field.label, "[labs] Nerd Font icons");
  assert.equal(field.value, "Off");
  assert.equal(enabled.loaded.settings.nerdFontIcons, true);
  assert.equal(enabled.applied, 1);
  const disabled = await run(t, ["nerdFontIcons", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, nerdFontIcons: true },
  });
  assert.equal(disabled.loaded.settings.nerdFontIcons, false);
  const cancelled = await run(t, ["nerdFontIcons", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
});

test("invalid numbers are rejected in place and valid edits save once to the user scope", async (t) => {
  const result = await run(t, ["maxLevels", "33", "maxLevels", "0", "maxLevels", "5", "save"]);
  assert.equal(result.applied, 1);
  assert.equal(result.loaded.settings.maxLevels, 5);
  assert.equal(result.notifications.filter((message) => message.includes("at most 32")).length, 2);
  assert.ok(result.notifications.some((message) => message.includes(result.userFile)));
  assert.equal(existsSync(result.projectFile), false);
});

test("selecting each subagent mode saves it", async (t) => {
  for (const [mode, label] of [
    ["off", "Off"],
    ["opportunistic", "Opportunistic"],
    ["orchestration", "Orchestration"],
  ]) {
    const result = await run(t, ["subagentMode", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "subagentMode")!;
    assert.equal(field.label, "Subagent Mode");
    assert.equal(field.value, "Opportunistic");
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Subagent Mode");
    assert.deepEqual(chooser.rows.map((row) => row.id), ["off", "opportunistic", "orchestration"]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "subagentMode"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.subagentMode, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).subagentMode,
      mode === DEFAULT_MANAGER_SETTINGS.subagentMode ? undefined : mode);
  }
});

test("mode selection and chooser cancellation remain draft-only", async (t) => {
  const canceled = await run(t, ["subagentMode", "off", "cancel"]);
  assert.equal(canceled.value(2, "subagentMode"), "Off");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["subagentMode", undefined, "save"]);
  assert.equal(escaped.value(2, "subagentMode"), "Opportunistic");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.subagentMode, "opportunistic");
});

for (const width of [32, 80]) {
  test(`mode screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["subagentMode", "orchestration", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Subagent Mode") || lines[0]!.includes("Agents settings"),
    ));
    // The shared two-column menu clips labels at narrow widths; the selected
    // mode's full name remains visible in its help and in the settings value.
    assert.ok(result.renders[1]!.join("\n").includes(width === 32 ? "Orchestra" : "Orchestration"));
    assert.ok(result.renders[2]!.join("\n").includes("Orchestration"));
  });
}

test("Model Picking saves all three modes", async (t) => {
  for (const [mode, label] of [
    ["pick-first-available", "Pick First (available)"],
    ["pick-first-scoped", "Pick First (scoped)"],
    ["use-current", "Use Current"],
  ]) {
    const result = await run(t, ["modelSelection", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "modelSelection")!;
    assert.equal(field.label, "Model Picking");
    assert.equal(field.value, "Pick First (scoped)");
    assert.equal(result.menus[0]!.rows.some((row) => row.id === "scopedModelFiltering"), false);
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Model Picking");
    assert.deepEqual(chooser.rows.map((row) => row.id), [
      "pick-first-available", "pick-first-scoped", "use-current",
    ]);
    assert.deepEqual(chooser.rows.map((row) => row.label), [
      "Pick First (available)", "Pick First (scoped)", "Use Current",
    ]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "modelSelection"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.modelSelection, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    const stored = JSON.parse(readFileSync(result.userFile, "utf8"));
    assert.equal(stored.modelSelection,
      mode === DEFAULT_MANAGER_SETTINGS.modelSelection ? undefined : mode);
    assert.equal(Object.hasOwn(stored, "scopedModelFiltering"), false);
  }
});

test("Model Picking and other edits stay draft-only until save; chooser cancellation keeps the value", async (t) => {
  const canceled = await run(t, ["modelSelection", "pick-first-available", "maxLevels", "4", "cancel"]);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.equal(canceled.value(0, "modelSelection"), "Pick First (scoped)");
  assert.equal(canceled.value(2, "modelSelection"), "Pick First (available)");
  assert.match(canceled.menus[2]?.title ?? "", /unsaved/);
  assert.equal(canceled.value(3, "maxLevels"), "4");

  const escaped = await run(t, ["modelSelection", undefined, "save"]);
  assert.equal(escaped.value(2, "modelSelection"), "Pick First (scoped)");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.modelSelection, "pick-first-scoped");
});

test("Model Picking saves to a trusted project", async (t) => {
  const saved = await run(t, ["scope", "confirm", "modelSelection", "use-current", "save"], { trusted: true });
  assert.equal(saved.applied, 1);
  assert.equal(saved.loaded.settings.modelSelection, "use-current");
  assert.equal(JSON.parse(readFileSync(saved.projectFile, "utf8")).modelSelection, "use-current");
  assert.equal(existsSync(saved.userFile), false);
});

test("save shows a warning-colored changes value only while the draft is dirty", async (t) => {
  const result = await run(t, [
    "modelSelection", "pick-first-available", "modelSelection", "pick-first-scoped",
    "maxLevels", "5", "defaults", "cancel",
  ]);
  const settingsMenus = result.menus.filter((menu) => menu.title.startsWith("Agents settings"));
  const save = (index: number) => settingsMenus[index]!.rows.find((row) => row.id === "save")!;
  for (const index of [0, 2, 4]) {
    assert.equal(save(index).value, undefined, "unchanged or reverted drafts clear the indicator");
    assert.equal(save(index).valueColor, undefined);
  }
  for (const index of [1, 3]) {
    assert.equal(save(index).label, "Save and apply");
    assert.equal(save(index).value, "(changes)");
    assert.equal(save(index).valueColor, "warning");
  }
});

for (const width of [32, 80]) {
  test(`Model Picking screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["modelSelection", "use-current", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Model Picking") || lines[0]!.includes("Agents settings"),
    ));
    assert.equal(result.value(2, "modelSelection"), "Use Current");
    assert.ok(result.renders[2]!.join("\n").includes("Use Current"));
  });
}

test("Global to Project confirmation Cancel and Esc preserve files, scope and unsaved draft", async (t) => {
  for (const choice of ["cancel", undefined]) {
    const result = await run(t, ["maxLevels", "5", "scope", choice, "cancel"], { trusted: true });
    assert.equal(result.value(0, "scope"), "Global");
    assert.equal(result.value(1, "maxLevels"), "5");
    assert.equal(result.menus[2]!.title, "Enable project settings?");
    assert.equal(result.menus[2]!.selectedId, "cancel");
    assert.match(result.menus[2]!.rows[0]!.help!, /create this project's settings\.json/);
    assert.equal(result.value(3, "maxLevels"), "5");
    assert.equal(result.value(3, "scope"), "Global");
    assert.match(result.menus[3]!.title, /unsaved/);
    assert.equal(result.applied, 0);
    assert.equal(existsSync(result.userFile), false);
    assert.equal(existsSync(result.projectFile), false);
  }
});

test("confirming Project creates an empty layer immediately and preserves edits until save", async (t) => {
  const result = await run(t, ["maxLevels", "5", "scope", "confirm", "cancel"], {
    trusted: true, global: { maxThreads: 20 },
  });
  assert.equal(result.value(3, "scope"), "Current Project");
  assert.equal(result.value(3, "maxLevels"), "5");
  assert.match(result.menus[3]!.title, /unsaved/);
  assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), {});
  assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")), { maxThreads: 20 });
  assert.equal(result.applied, 0);
  assert.equal(result.loaded.settings.maxLevels, DEFAULT_MANAGER_SETTINGS.maxLevels);
  assert.equal(result.loaded.settings.maxThreads, 20);
  const reopened = await run(t, ["maxLevels", "5", "save"], { trusted: true, root: result.root });
  assert.equal(reopened.value(0, "scope"), "Current Project");
  assert.deepEqual(JSON.parse(readFileSync(reopened.projectFile, "utf8")), { maxLevels: 5 });
  assert.deepEqual(JSON.parse(readFileSync(reopened.userFile, "utf8")), { maxThreads: 20 });
  assert.equal(reopened.applied, 1);
});

test("edits made before confirming Project are saved there rather than copied into Global", async (t) => {
  const result = await run(t, ["maxLevels", "8", "scope", "confirm", "save"], {
    trusted: true, global: { maxLevels: 5, maxThreads: 20 },
  });
  assert.equal(result.value(3, "maxLevels"), "8");
  assert.equal(result.value(3, "scope"), "Current Project");
  assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), { maxLevels: 8 });
  assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")), { maxLevels: 5, maxThreads: 20 });
  assert.equal(result.applied, 1);
  assert.equal(result.appliedSettings[0]!.maxLevels, 8);
  assert.equal(result.appliedSettings[0]!.maxThreads, 20);
});

test("restore defaults resets the whole draft before save", async (t) => {
  const result = await run(t, ["defaults", "save"], {
    settings: {
      ...DEFAULT_MANAGER_SETTINGS,
      subagentMode: "orchestration",
      toolFiltering: "all",
      modelSelection: "use-current",
      maxLevels: 9,
    },
  });
  assert.equal(result.applied, 1);
  assert.equal(result.value(1, "modelSelection"), "Pick First (scoped)");
  assert.equal(result.value(1, "subagentMode"), "Opportunistic");
  assert.equal(result.value(1, "toolFiltering"), "Allowed (except blocked)");
  assert.deepEqual(result.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")), {});
});

test("trusted projects without a project file start Global; confirmed Project saves sparse overrides", async (t) => {
  const global = await run(t, ["maxLevels", "7", "save"], { trusted: true });
  assert.equal(global.value(0, "scope"), "Global");
  assert.deepEqual(JSON.parse(readFileSync(global.userFile, "utf8")), { maxLevels: 7 });
  assert.equal(existsSync(global.projectFile), false);

  const project = await run(t, ["scope", "confirm", "subagentMode", "off", "maxThreads", "9", "save"], {
    trusted: true, root: global.root,
  });
  assert.equal(project.applied, 1);
  assert.equal(project.loaded.settings.maxLevels, 7);
  assert.deepEqual(JSON.parse(readFileSync(project.projectFile, "utf8")), { maxThreads: 9, subagentMode: "off" });
  assert.deepEqual(JSON.parse(readFileSync(project.userFile, "utf8")), { maxLevels: 7 });
});

test("Project to Global Cancel and Esc leave overrides and draft unchanged", async (t) => {
  for (const choice of ["cancel", undefined]) {
    const result = await run(t, ["maxLevels", "9", "scope", choice, "cancel"], {
      trusted: true, global: { maxLevels: 5 }, project: { maxLevels: 7 },
    });
    assert.equal(result.value(0, "scope"), "Current Project");
    assert.equal(result.menus[2]!.selectedId, "cancel");
    assert.match(result.menus[2]!.title, /Clear project settings/);
    assert.match(result.menus[2]!.rows[0]!.help!, /Unsaved edits will be discarded/);
    assert.equal(result.value(3, "scope"), "Current Project");
    assert.equal(result.value(3, "maxLevels"), "9");
    assert.match(result.menus[3]!.title, /unsaved/);
    assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), { maxLevels: 7 });
    assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")), { maxLevels: 5 });
    assert.equal(result.loaded.settings.maxLevels, 7);
    assert.equal(result.applied, 0);
  }
});

test("Project to Global Confirm clears project immediately, discards draft, reloads and routes future saves", async (t) => {
  const result = await run(t, ["maxLevels", "9", "scope", "confirm", "cancel"], {
    trusted: true, global: { maxLevels: 5 }, project: { maxLevels: 7, widgetMode: "minimal" },
  });
  assert.equal(result.value(3, "scope"), "Global");
  assert.equal(result.value(3, "maxLevels"), "5");
  assert.equal(result.value(3, "widgetMode"), "Full");
  assert.doesNotMatch(result.menus[3]!.title, /unsaved/);
  assert.equal(existsSync(result.projectFile), false);
  assert.equal(existsSync(dirname(result.projectFile)), true, "only the settings file is deleted");
  assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")), { maxLevels: 5 });
  assert.equal(result.applied, 1, "reload happens even without Save and apply");
  assert.equal(result.appliedSettings[0]!.maxLevels, 5);
  assert.equal(result.appliedSettings[0]!.widgetMode, "full");
  const reopened = await run(t, ["maxLevels", "6", "save"], { trusted: true, root: result.root });
  assert.equal(reopened.value(0, "scope"), "Global");
  assert.equal(existsSync(reopened.projectFile), false);
  assert.deepEqual(JSON.parse(readFileSync(reopened.userFile, "utf8")), { maxLevels: 6 });
});

test("save scope is project-local and ignores the legacy remembered preference", async (t) => {
  const project = await run(t, ["scope", "confirm", "cancel"], { trusted: true, global: { maxLevels: 5 } });
  writeFileSync(join(dirname(project.userFile), "ui-state.json"), JSON.stringify({ saveScope: "user" }));
  const reopened = await run(t, ["cancel"], { trusted: true, root: project.root });
  assert.equal(reopened.value(0, "scope"), "Current Project");
  const otherProject = await run(t, ["cancel"], { trusted: true, agentDir: project.root });
  assert.equal(otherProject.value(0, "scope"), "Global");
  assert.equal(otherProject.value(0, "maxLevels"), "5");
  assert.equal(existsSync(otherProject.projectFile), false);
});

test("untrusted projects ignore project values and cannot switch scope or alter the project file", async (t) => {
  const result = await run(t, ["scope", "maxLevels", "6", "save"], {
    global: { maxLevels: 5 }, project: { maxLevels: 7 },
  });
  assert.equal(result.value(0, "scope"), "Global");
  assert.equal(result.value(0, "maxLevels"), "5");
  assert.ok(result.notifications.some((message) => message.includes("trusted project")));
  assert.equal(result.menus.some((menu) => menu.title.includes("project settings?")), false);
  assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), { maxLevels: 7 });
  assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")), { maxLevels: 6 });
  assert.equal(result.loaded.settings.maxLevels, 6);
  const row = result.menus[0]!.rows.find((row) => row.id === "maxLevels")!;
  assert.equal(row.renderLabel!(row.label, theme), "● Maximum levels");
});

test("Save rejects concurrent Global or Project changes instead of persisting stale draft overrides", async (t) => {
  for (const scope of ["global", "project"] as const) {
    for (const changedLayer of scope === "global" ? ["global"] as const : ["global", "project"] as const) {
      const result = await run(t, ["maxThreads", "9", "save", "cancel"], {
        trusted: true,
        global: { maxLevels: 5 },
        ...(scope === "project" ? { project: { maxLevels: 7 } } : {}),
        onMenu: (_menu, index, files) => {
          if (index !== 1) return;
          writeFileSync(changedLayer === "global" ? files.userFile : files.projectFile,
            JSON.stringify({ maxLevels: 8 }));
        },
      });
      assert.equal(result.applied, 0, `${scope} save rejected after ${changedLayer} changed`);
      assert.ok(result.notifications.some((message) => /Settings changed on disk.*Reopen settings/.test(message)));
      assert.equal(result.notificationTypes.at(-1), "error");
      assert.equal(result.value(2, "maxThreads"), "9", "failed save preserves unsaved draft");
      assert.match(result.menus[2]!.title, /unsaved/);
      assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")),
        { maxLevels: changedLayer === "global" ? 8 : 5 });
      if (scope === "project") {
        assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")),
          { maxLevels: changedLayer === "project" ? 8 : 7 });
      } else assert.equal(existsSync(result.projectFile), false);
    }
  }
});

test("confirming Project rejects concurrent changes without creating or overwriting its file", async (t) => {
  for (const changedLayer of ["global", "project"] as const) {
    const result = await run(t, ["scope", "confirm", "cancel"], {
      trusted: true, global: { maxLevels: 5 },
      onMenu: (menu, _index, files) => {
        if (menu.title !== "Enable project settings?") return;
        const file = changedLayer === "global" ? files.userFile : files.projectFile;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ maxLevels: 8 }));
      },
    });
    assert.equal(result.applied, 0);
    assert.equal(result.value(2, "scope"), "Global");
    assert.ok(result.notifications.some((message) => /Settings changed on disk.*Reopen settings/.test(message)));
    assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")),
      { maxLevels: changedLayer === "global" ? 8 : 5 });
    if (changedLayer === "project")
      assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), { maxLevels: 8 });
    else assert.equal(existsSync(result.projectFile), false);
  }
});

test("confirming Global rejects concurrent changes without deleting the project file or dropping edits", async (t) => {
  for (const changedLayer of ["global", "project"] as const) {
    const result = await run(t, ["maxLevels", "9", "scope", "confirm", "cancel"], {
      trusted: true, global: { maxLevels: 5 }, project: { maxLevels: 7 },
      onMenu: (menu, _index, files) => {
        if (!menu.title.startsWith("Clear project settings")) return;
        writeFileSync(changedLayer === "global" ? files.userFile : files.projectFile,
          JSON.stringify({ maxLevels: 8 }));
      },
    });
    assert.equal(result.applied, 0);
    assert.equal(result.value(3, "scope"), "Current Project");
    assert.equal(result.value(3, "maxLevels"), "9");
    assert.match(result.menus[3]!.title, /unsaved/);
    assert.ok(result.notifications.some((message) => /Settings changed on disk.*Reopen settings/.test(message)));
    assert.deepEqual(JSON.parse(readFileSync(result.userFile, "utf8")),
      { maxLevels: changedLayer === "global" ? 8 : 5 });
    assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")),
      { maxLevels: changedLayer === "project" ? 8 : 7 });
  }
});

test("invalid files warn on opening and reloading and contribute no values or dots", async (t) => {
  const result = await run(t, ["scope", "confirm", "cancel"], {
    trusted: true,
    global: JSON.stringify({ maxLevels: 5, unknownSetting: true }),
    project: "{",
  });
  const globalWarnings = result.notifications.filter((message) => message.startsWith(result.userFile + ":"));
  const projectWarnings = result.notifications.filter((message) => message.startsWith(result.projectFile + ":"));
  assert.equal(globalWarnings.length, 2, "initial and post-switch reload both report invalid global settings");
  assert.match(globalWarnings[0]!, /Unknown settings key: unknownSetting/);
  assert.equal(projectWarnings.length, 1);
  assert.match(projectWarnings[0]!, /Invalid JSON/);
  assert.ok(result.notificationTypes.every((type) => type === "warning"));
  assert.equal(result.value(0, "maxLevels"), String(DEFAULT_MANAGER_SETTINGS.maxLevels));
  assert.equal(coloredLabel(result.menus[0]!, "maxLevels"), "Maximum levels");
  assert.equal(result.value(0, "scope"), "Current Project", "invalid project file can still be explicitly cleared");
  assert.equal(result.value(2, "scope"), "Global");
  assert.equal(existsSync(result.projectFile), false);
  assert.deepEqual(result.appliedSettings[0], DEFAULT_MANAGER_SETTINGS);
});

test("destructive scope warning renders delete, discard and no-undo consequences at 60x12", async (t) => {
  const result = await run(t, ["scope", "cancel", "cancel"], {
    trusted: true, width: 60, rows: 12, global: { maxLevels: 5 }, project: { maxLevels: 7 },
  });
  const confirmation = result.renders[1]!;
  const text = stripTerminalSequences(confirmation.join("\n"));
  assert.match(text, /Delete project file now\./);
  assert.match(text, /Discard edits\./);
  assert.match(text, /No undo\./);
  assert.equal(result.menus[1]!.selectedId, "cancel");
  assert.equal(result.applied, 0);
  assert.ok(result.renders.every((lines) => lines.every((line) => visibleWidth(line) <= 60)));
  assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), { maxLevels: 7 });
});

test("settings values are read from layers rather than stale runtime settings", async (t) => {
  const result = await run(t, ["cancel"], {
    trusted: true,
    settings: { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 9, widgetMode: "minimal" },
    global: { maxLevels: 5 },
    project: { maxThreads: 20 },
  });
  assert.equal(result.value(0, "maxLevels"), "5");
  assert.equal(result.value(0, "maxThreads"), "20");
  assert.equal(result.value(0, "widgetMode"), "Full");
  assert.doesNotMatch(result.menus[0]!.title, /unsaved/);
  assert.equal(result.applied, 0);
});

const provenanceTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;
const coloredLabel = (menu: Menu, id: string) => {
  const row = menu.rows.find((row) => row.id === id)!;
  return row.renderLabel?.(row.label, provenanceTheme) ?? row.label;
};

test("saved provenance distinguishes both layers, equal values, and projects reverting a default", async (t) => {
  for (const width of [20, 40, 80]) {
    const result = await run(t, ["maxLevels", "8", "cancel"], {
      trusted: true, width,
      global: { maxLevels: 5, widgetMode: "minimal", maxConcurrent: DEFAULT_MANAGER_SETTINGS.maxConcurrent },
      project: { maxLevels: DEFAULT_MANAGER_SETTINGS.maxLevels, widgetMode: "minimal", maxConcurrent: 8 },
    });
    assert.equal(result.value(0, "maxLevels"), String(DEFAULT_MANAGER_SETTINGS.maxLevels));
    assert.equal(coloredLabel(result.menus[0]!, "maxLevels"),
      "<accent>●</accent> <warning>●</warning> Maximum levels");
    assert.equal(coloredLabel(result.menus[0]!, "widgetMode"), "<accent>●</accent> Status Widget",
      "project value equal to global does not count as changed");
    assert.equal(coloredLabel(result.menus[0]!, "maxConcurrent"), "<warning>●</warning> Concurrent agents",
      "explicit global value equal to default does not count as changed");
    assert.equal(coloredLabel(result.menus[0]!, "modelSelection"), "Model Picking");
    assert.equal(coloredLabel(result.menus[1]!, "maxLevels"), coloredLabel(result.menus[0]!, "maxLevels"),
      "unsaved edits do not change saved provenance");
    assert.match(result.menus[0]!.rows.find((row) => row.id === "maxLevels")!.help!, /Dots.*Global.*Current Project/);
    assert.ok(result.renders.every((lines) => lines.every((line) => visibleWidth(line) <= width)));
    assert.equal(result.menus[1]!.selectedId, "maxLevels", "the captured final frame focuses the changed setting");
    assert.ok(stripTerminalSequences(result.renders.at(-1)!.join("\n")).includes("● ●"),
      "both saved-layer dots render when Maximum levels is selected, including narrow viewports");
  }
});

test("Footer aggregate provenance covers all three settings while the submenu marks each independently", async (t) => {
  const result = await run(t, ["costDisplay", "icon", "money", "back", "cancel"], {
    trusted: true,
    global: { costDisplay: "pi-status", costValue: "total" },
    project: { costDisplay: "pi-status", costIcon: "wallet" },
  });
  assert.equal(coloredLabel(result.menus[0]!, "costDisplay"),
    "<accent>●</accent> <warning>●</warning> Footer display");
  assert.equal(coloredLabel(result.menus[1]!, "location"), "<accent>●</accent> Location");
  assert.equal(coloredLabel(result.menus[1]!, "value"), "<accent>●</accent> Display value");
  assert.equal(coloredLabel(result.menus[1]!, "icon"), "<warning>●</warning> Icon");
  assert.equal(coloredLabel(result.menus[1]!, "back"), "Back");
  assert.equal(coloredLabel(result.menus[3]!, "icon"), "<warning>●</warning> Icon",
    "changing the draft icon keeps the persisted dot");
  assert.equal(result.applied, 0);
  assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), { costDisplay: "pi-status", costIcon: "wallet" });
});

test("sparse Project saves inherit future global changes and defaults can override global", async (t) => {
  const saved = await run(t, ["maxThreads", "9", "save"], {
    trusted: true, global: { maxLevels: 5, widgetMode: "minimal" }, project: {},
  });
  assert.deepEqual(JSON.parse(readFileSync(saved.projectFile, "utf8")), { maxThreads: 9 });
  writeFileSync(saved.userFile, JSON.stringify({ maxLevels: 6, widgetMode: "full" }));
  const reopened = await run(t, ["cancel"], { trusted: true, root: saved.root });
  assert.equal(reopened.value(0, "maxLevels"), "6");
  assert.equal(reopened.value(0, "widgetMode"), "Full");
  assert.equal(reopened.value(0, "maxThreads"), "9");
  const restored = await run(t, ["defaults", "save"], { trusted: true, root: saved.root });
  assert.deepEqual(restored.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.deepEqual(JSON.parse(readFileSync(restored.projectFile, "utf8")), { maxLevels: DEFAULT_MANAGER_SETTINGS.maxLevels });
  assert.deepEqual(JSON.parse(readFileSync(restored.userFile, "utf8")), { maxLevels: 6, widgetMode: "full" });
});

for (const width of [20, 40, 80]) {
  test(`scope confirmation and two-layer settings fit bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["scope", "confirm", "scope", "cancel", "cancel"], {
      trusted: true, width, global: { maxLevels: 5 },
    });
    assert.equal(result.menus[1]!.selectedId, "cancel");
    assert.equal(result.menus[3]!.selectedId, "cancel");
    assert.deepEqual(JSON.parse(readFileSync(result.projectFile, "utf8")), {});
    assert.equal(result.applied, 0);
    assert.ok(result.renders.every((lines) => lines.every((line) => visibleWidth(line) <= width)));
  });
}

test("Tool Filtering saves every mode", async (t) => {
  for (const [mode, label] of [
    ["allowed", "Allowed (except blocked)"],
    ["all-except-blocked", "All except blocked"],
    ["all", "All"],
  ]) {
    const result = await run(t, ["toolFiltering", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "toolFiltering")!;
    assert.equal(field.label, "Tool Filtering");
    assert.equal(field.value, "Allowed (except blocked)");
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Tool Filtering");
    assert.deepEqual(
      chooser.rows.map((row) => row.id),
      ["allowed", "all-except-blocked", "all"],
    );
    assert.deepEqual(
      chooser.rows.map((row) => row.label),
      ["Allowed (except blocked)", "All except blocked", "All"],
    );
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "toolFiltering"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.toolFiltering, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).toolFiltering,
      mode === DEFAULT_MANAGER_SETTINGS.toolFiltering ? undefined : mode);
  }
});

test("Tool Filtering selection and chooser cancellation remain draft-only", async (t) => {
  const canceled = await run(t, ["toolFiltering", "all", "cancel"]);
  assert.equal(canceled.value(2, "toolFiltering"), "All");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["toolFiltering", undefined, "save"]);
  assert.equal(escaped.value(2, "toolFiltering"), "Allowed (except blocked)");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.toolFiltering, "allowed");
});

test("Tool Filtering saves to a trusted project and restores defaults without saving on cancel", async (t) => {
  const saved = await run(t, ["scope", "confirm", "toolFiltering", "all-except-blocked", "save"], { trusted: true });
  assert.equal(saved.applied, 1);
  assert.equal(saved.loaded.settings.toolFiltering, "all-except-blocked");
  assert.equal(
    JSON.parse(readFileSync(saved.projectFile, "utf8")).toolFiltering,
    "all-except-blocked",
  );
  assert.equal(existsSync(saved.userFile), false);

  const restored = await run(t, ["toolFiltering", "all", "defaults", "cancel"]);
  assert.equal(restored.value(2, "toolFiltering"), "All");
  assert.equal(restored.value(3, "toolFiltering"), "Allowed (except blocked)");
  assert.doesNotMatch(restored.menus[3]!.title, /unsaved/);
  assert.equal(restored.applied, 0);
  assert.equal(existsSync(restored.userFile), false);
});

for (const width of [32, 80]) {
  test(`Tool Filtering screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["toolFiltering", "all", "cancel"], { width });
    assert.ok(
      result.renders.every(
        (lines) => lines[0]!.includes("Tool Filtering") || lines[0]!.includes("Agents settings"),
      ),
    );
    assert.ok(result.renders[1]!.join("\n").includes("All"));
    assert.equal(result.value(2, "toolFiltering"), "All");
  });
}

test("Status Widget saves each mode", async (t) => {
  for (const [mode, label] of [["full", "Full"], ["minimal", "Minimal"]]) {
    const result = await run(t, ["widgetMode", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "widgetMode")!;
    assert.equal(field.label, "Status Widget");
    assert.equal(field.value, "Full");
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Status Widget");
    assert.deepEqual(chooser.rows.map((row) => row.id), ["full", "minimal"]);
    assert.deepEqual(chooser.rows.map((row) => row.label), ["Full", "Minimal"]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "widgetMode"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.widgetMode, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).widgetMode,
      mode === DEFAULT_MANAGER_SETTINGS.widgetMode ? undefined : mode);
  }
});

test("Status Widget cancellation leaves settings unchanged and defaults restore Full", async (t) => {
  const canceled = await run(t, ["widgetMode", "minimal", "cancel"]);
  assert.equal(canceled.value(2, "widgetMode"), "Minimal");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["widgetMode", undefined, "save"]);
  assert.equal(escaped.value(2, "widgetMode"), "Full");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.widgetMode, "full");

  const restored = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, widgetMode: "minimal" },
  });
  assert.equal(restored.value(1, "widgetMode"), "Full");
  assert.equal(restored.loaded.settings.widgetMode, "full");
});

test("Status Widget saves to a trusted project", async (t) => {
  const result = await run(t, ["scope", "confirm", "widgetMode", "minimal", "save"], { trusted: true });
  assert.equal(result.applied, 1);
  assert.equal(JSON.parse(readFileSync(result.projectFile, "utf8")).widgetMode, "minimal");
  assert.equal(existsSync(result.userFile), false);
});

for (const width of [32, 80]) {
  test(`Status Widget screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["widgetMode", "minimal", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Status Widget") || lines[0]!.includes("Agents settings"),
    ));
    assert.ok(result.renders[1]!.join("\n").includes("Full"));
    assert.ok(result.renders[1]!.join("\n").includes("Minimal"));
    assert.equal(result.value(2, "widgetMode"), "Minimal");
  });
}

test("[labs] Final Recap toggles and saves to both scopes", async (t) => {
  const enabled = await run(t, ["finalRecap", "save"]);
  const field = enabled.menus[0]!.rows.find((row) => row.id === "finalRecap")!;
  assert.equal(field.label, "[labs] Final Recap");
  assert.equal(field.value, "Off");
  assert.equal(enabled.value(1, "finalRecap"), "On");
  assert.match(enabled.menus[1]!.title, /unsaved/);
  assert.equal(enabled.applied, 1);
  assert.equal(enabled.loaded.settings.finalRecap, true);
  assert.equal(JSON.parse(readFileSync(enabled.userFile, "utf8")).finalRecap, true);

  const disabled = await run(t, ["finalRecap", "save"], {
    global: { finalRecap: true }, project: {}, trusted: true,
  });
  assert.equal(disabled.value(1, "finalRecap"), "Off");
  assert.equal(disabled.loaded.settings.finalRecap, false);
  assert.equal(disabled.applied, 1);
  assert.equal(JSON.parse(readFileSync(disabled.projectFile, "utf8")).finalRecap, false);
  assert.deepEqual(JSON.parse(readFileSync(disabled.userFile, "utf8")), { finalRecap: true });
});

test("[labs] Final Recap cancellation, toggle reversal and restore-defaults keep it opt-in", async (t) => {
  const cancelled = await run(t, ["finalRecap", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
  assert.equal(cancelled.loaded.settings.finalRecap, false);
  const reverted = await run(t, ["finalRecap", "finalRecap", "save"]);
  assert.doesNotMatch(reverted.menus[2]!.title, /unsaved/);
  assert.equal(reverted.loaded.settings.finalRecap, false);
  const restored = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, finalRecap: true },
  });
  assert.equal(restored.value(1, "finalRecap"), "Off");
  assert.equal(restored.loaded.settings.finalRecap, false);
});

for (const width of [32, 80]) {
  test(`[labs] Final Recap renders a bordered settings frame at width ${width}`, async (t) => {
    const result = await run(t, ["finalRecap", "cancel"], { width });
    assert.ok(result.renders.every((lines) => lines[0]!.includes("Agents settings")));
    assert.equal(result.value(1, "finalRecap"), "On");
  });
}


test("Footer display opens a submenu and saves all three locations with integration IDs", async (t) => {
  for (const mode of ["pi-footer-event", "pi-footer-status", "pi-status"] as const) {
    const result = await run(t, ["costDisplay", "location", mode, "back", "save"]);
    assert.equal(result.menus[0]!.rows.find((row) => row.id === "costDisplay")!.label, "[labs] Footer display");
    assert.equal(result.menus[1]!.title, "[labs] Footer display");
    assert.deepEqual(result.menus[1]!.rows.map((row) => row.id), ["location", "value", "icon", "back"]);
    const locations = result.menus[2]!.rows;
    assert.deepEqual(locations.map((row) => row.id), ["pi-status", "pi-footer-status", "pi-footer-event"]);
    assert.equal(locations[1]!.value, "subagent_cost");
    assert.equal(locations[2]!.value, "subagent_cost");
    assert.match(locations[2]!.help!, /pi-footer:update-widget/);
    assert.equal(result.loaded.settings.costDisplay, mode);
    assert.equal(result.applied, 1);
  }
});

test("Footer display saves both cost values independently of location", async (t) => {
  for (const value of ["subagents", "total"] as const) {
    const result = await run(t, ["costDisplay", "value", value, "back", "save"]);
    assert.deepEqual(result.menus[2]!.rows.map((row) => row.id), ["subagents", "total"]);
    assert.equal(result.loaded.settings.costValue, value);
    assert.equal(result.loaded.settings.costDisplay, DEFAULT_MANAGER_SETTINGS.costDisplay);
  }
});

test("Footer icon offers three previews from the draft Nerd Font setting", async (t) => {
  for (const nerd of [false, true]) {
    for (const icon of ["money", "coins", "wallet"] as const) {
      const result = await run(t, [
        ...(nerd ? ["nerdFontIcons"] : []),
        "costDisplay", "icon", icon, "back", "save",
      ]);
      const picker = result.menus.find((menu) => menu.title.startsWith("Footer icon"))!;
      assert.equal(picker.title, `Footer icon · ${nerd ? "Nerd Font" : "Emoji"}`);
      assert.deepEqual(picker.rows.map((row) => row.id), ["money", "coins", "wallet"]);
      assert.deepEqual(picker.rows.map((row) => row.value), nerd ? ["\uf0d6", "\u{f0512}", "\u{f055d}"] : ["💵", "🪙", "👛"]);
      assert.equal(result.loaded.settings.costIcon, icon);
      assert.equal(result.loaded.settings.nerdFontIcons, nerd);
    }
  }
});

test("Footer edits remain draft-only, picker Esc preserves values, and defaults reset choices", async (t) => {
  const cancelled = await run(t, ["costDisplay", "location", "pi-status", "value", "total", "icon", "wallet", "back", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
  const settings = { ...DEFAULT_MANAGER_SETTINGS, costDisplay: "pi-status", costValue: "total", costIcon: "wallet" } as const;
  const escaped = await run(t, ["costDisplay", "location", undefined, "value", undefined, "icon", undefined, undefined, "save"], { settings });
  assert.equal(escaped.loaded.settings.costDisplay, "pi-status");
  assert.equal(escaped.loaded.settings.costValue, "total");
  assert.equal(escaped.loaded.settings.costIcon, "wallet");
  const restored = await run(t, ["defaults", "save"], { settings });
  assert.deepEqual(restored.loaded.settings, DEFAULT_MANAGER_SETTINGS);
});

test("Footer submenu and pickers fit narrow terminals and save to project scope", async (t) => {
  for (const width of [20, 40, 60]) {
    const result = await run(t, ["scope", "confirm", "costDisplay", "location", "pi-footer-event", "value", "total", "icon", "coins", "back", "save"], { width, trusted: true });
    assert.ok(result.renders.every((lines) => lines.every((line) => visibleWidth(line) <= width)));
    assert.equal(result.loaded.settings.costValue, "total");
    assert.equal(result.loaded.settings.costIcon, "coins");
    assert.equal(existsSync(result.projectFile), true);
  }
});

test("[labs] Enable subagent extensions warns, toggles, saves and restores default off", async (t) => {
  const enabled = await run(t, ["subagentExtensions", "save"]);
  const row = enabled.menus[0]!.rows.find((row) => row.id === "subagentExtensions")!;
  assert.equal(row.label, "[labs] Enable subagent extensions");
  assert.equal(row.value, "Off");
  assert.match(row.help!, /Experimental/);
  assert.match(row.help!, /Bugs and unintended consequences/);
  assert.match(row.help!, /separate subagent sessions/);
  assert.match(row.help!, /configured user\/trusted-project extension hooks/);
  assert.match(row.help!, /not CLI-only or inline extensions/);
  const limitationsUrl =
    "https://github.com/championswimmer/pi-subagent-manager/blob/main/docs/subagent-extension-limitations.md";
  assert.ok(row.help!.includes(`Read limitations: ${limitationsUrl}`));
  assert.ok(existsSync(new URL("../docs/subagent-extension-limitations.md", import.meta.url)));
  assert.equal(enabled.loaded.settings.subagentExtensions, true);
  assert.equal(enabled.applied, 1);
  const disabled = await run(t, ["subagentExtensions", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, subagentExtensions: true },
  });
  assert.equal(disabled.loaded.settings.subagentExtensions, false);
  const cancelled = await run(t, ["subagentExtensions", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
  const defaults = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, subagentExtensions: true },
  });
  assert.equal(defaults.loaded.settings.subagentExtensions, false);
  for (const width of [20, 40, 80]) {
    const narrow = await run(t, ["subagentExtensions", "save"], { width, trusted: true });
    assert.equal(narrow.loaded.settings.subagentExtensions, true);
    assert.ok(narrow.renders.every((lines) => lines.every((line) => visibleWidth(line) <= width)));
  }
});
test("Nerd Fonts off filters loader previews, uses ASCII fallback, and saves non-Nerd selections", async (t) => {
  const styles = ["braille", "ascii", "ascii-star", "ascii-pulse"] as const;
  for (const loaderStyle of styles) {
    const result = await run(t, ["loaderStyle", loaderStyle, "save"]);
    assert.equal(result.value(0, "loaderStyle"), AGENT_LOADERS.ascii.label);
    assert.deepEqual(
      result.menus[1]!.rows.map((row) => row.id),
      [...styles],
    );
    assert.equal(result.menus[1]!.selectedId, "ascii");
    for (const row of result.menus[1]!.rows) {
      assert.doesNotMatch(row.value!, /\p{Co}/u);
      assert.doesNotMatch(row.help!, /Requires \[labs\] Nerd Font icons On/);
    }
    assert.equal(result.loaded.settings.loaderStyle, loaderStyle);
    assert.equal(result.loaded.settings.nerdFontIcons, false);
    assert.equal(result.value(2, "loaderStyle"), AGENT_LOADERS[loaderStyle].label);
  }
});

test("turning Nerd Fonts off preserves the saved family and turning them back on restores it", async (t) => {
  const settings = {
    ...DEFAULT_MANAGER_SETTINGS,
    nerdFontIcons: true,
    loaderStyle: "hourglass",
  } as const;
  const off = await run(t, ["nerdFontIcons", "loaderStyle", undefined, "save"], { settings });
  assert.equal(off.value(0, "loaderStyle"), AGENT_LOADERS.hourglass.label);
  assert.equal(off.value(1, "loaderStyle"), AGENT_LOADERS.ascii.label);
  assert.equal(off.menus[2]!.selectedId, "ascii");
  assert.equal(off.loaded.settings.loaderStyle, "hourglass");
  assert.equal(off.loaded.settings.nerdFontIcons, false);
  const restored = await run(
    t,
    ["nerdFontIcons", "nerdFontIcons", "loaderStyle", undefined, "save"],
    { settings },
  );
  assert.equal(restored.value(2, "loaderStyle"), AGENT_LOADERS.hourglass.label);
  assert.equal(restored.menus[3]!.selectedId, "hourglass");
  assert.deepEqual(
    restored.menus[3]!.rows.map((row) => row.id),
    [...LOADER_STYLES],
  );
  assert.equal(restored.loaded.settings.loaderStyle, "hourglass");
});
