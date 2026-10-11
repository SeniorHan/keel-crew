import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// Exercises the committing-push-merge publish script against real git in temp repositories
// (a local bare "origin", no network) with PATH shims for gh and npm. Nothing is published.
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(
  root,
  ".agents/skills/committing-push-merge/scripts/publish.mjs",
);

const ghShim = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.log", JSON.stringify(["gh", ...args]) + "\n");
const statePath = dir + "/state.json";
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { prs: [] };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const bare = (...a) => spawnSync("git", ["--git-dir", process.env.FAKE_BARE, ...a], { encoding: "utf8" }).stdout.trim();
const flag = (name) => args[args.indexOf(name) + 1];
const url = (n) => "https://github.com/o/r/pull/" + n;
const view = (pr) => ({
  number: pr.number, url: url(pr.number), state: pr.state, baseRefName: "main",
  headRefOid: process.env.FAKE_HEAD_OVERRIDE || bare("rev-parse", "refs/heads/" + pr.head),
  mergedAt: pr.state === "MERGED" ? "2026-01-01T00:00:00Z" : null,
  mergeCommit: pr.state === "MERGED" ? { oid: pr.mergeOid } : null,
});
if (args[0] === "repo") console.log("main");
else if (args[0] === "pr" && args[1] === "list") {
  const open = state.prs.filter((p) => p.state === "OPEN" && p.head === flag("--head"));
  console.log(JSON.stringify(open.map(view)));
} else if (args[0] === "pr" && args[1] === "create") {
  const body = fs.readFileSync(flag("--body-file"), "utf8");
  const pr = { number: state.prs.length + 1, head: flag("--head"), title: flag("--title"), body, state: "OPEN" };
  state.prs.push(pr); save();
  console.log(url(pr.number));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify(view(state.prs[Number(args[2]) - 1])));
} else if (args[0] === "pr" && args[1] === "merge") {
  const mode = process.env.FAKE_MERGE || "ok";
  if (mode === "block") { console.error("base branch policy prohibits the merge"); process.exit(1); }
  if (mode === "ok") {
    const pr = state.prs[Number(args[2]) - 1];
    pr.state = "MERGED"; pr.mergeOid = bare("rev-parse", "refs/heads/" + pr.head);
    bare("update-ref", "refs/heads/main", pr.mergeOid); save();
  }
} else { console.error("unexpected gh " + args.join(" ")); process.exit(1); }
`;

const npmShim = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.log", JSON.stringify(["npm", ...args]) + "\n");
const script = args[0] === "run" ? args[1] : args[0];
if (process.env.FAKE_NPM_FAIL === script) { console.log("boom from " + script); process.exit(1); }
if (process.env.FAKE_NPM_MUTATE && script === "test") fs.appendFileSync(process.env.FAKE_NPM_MUTATE, "x\n");
`;

interface Fixture {
  work: string;
  bare: string;
  dir: string;
  git: (...args: string[]) => string;
  run: (
    args: string[],
    extra?: Record<string, string>,
  ) => { status: number; out: string };
  calls: () => string[][];
}

function fixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "publish-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  const bare = join(dir, "origin.git");
  mkdirSync(bin);
  mkdirSync(work);
  for (const [name, source] of [
    ["gh", ghShim],
    ["npm", npmShim],
  ]) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const baseEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
    FAKE_DIR: dir,
    FAKE_BARE: bare,
    PUBLISH_PR_POLL_MS: "0",
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: work,
      env: baseEnv,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  spawnSync("git", ["init", "--bare", "-b", "main", bare], { env: baseEnv });
  git("init", "-b", "main");
  git("remote", "add", "origin", bare);
  for (const file of ["a.txt", "b.txt", "c.txt"])
    writeFileSync(join(work, file), `${file}\n`);
  git("add", ".");
  git("commit", "-m", "chore: initial");
  git("push", "-u", "origin", "main");
  writeFileSync(join(dir, "body.md"), "## Summary\nDoes a thing.\n");
  return {
    work,
    bare,
    dir,
    git,
    run: (args, extra = {}) => {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: work,
        env: { ...baseEnv, ...extra },
        encoding: "utf8",
      });
      return {
        status: result.status ?? -1,
        out: `${result.stdout}${result.stderr}`,
      };
    },
    calls: () => {
      const log = join(dir, "calls.log");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
  };
}

const msg = ["--message", "feat: add thing"];
const bareRev = (f: Fixture, ref: string) =>
  spawnSync(
    "git",
    ["--git-dir", f.bare, "rev-parse", "--verify", "--quiet", ref],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
const ghCalls = (f: Fixture, sub: string) =>
  f.calls().filter((c) => c[0] === "gh" && c[1] === "pr" && c[2] === sub);

test("default: tests, new branch, commit ALL changes, PR, pinned gh merge, then main updated", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work, "a.txt"), "changed a\n");
  writeFileSync(join(f.work, "new.txt"), "new file\n");

  const result = f.run(msg);
  assert.equal(result.status, 0, result.out);
  assert.match(
    result.out,
    /RESULT: merged https:\/\/github\.com\/o\/r\/pull\/1/,
  );

  const branchSha = bareRev(f, "refs/heads/feat/add-thing");
  assert.ok(branchSha, "topic branch was pushed (generated name)");
  assert.deepEqual(
    f.git("show", "--name-only", "--format=", branchSha).split("\n").sort(),
    ["a.txt", "new.txt"],
  );
  assert.equal(f.git("log", "-1", "--format=%s", branchSha), "feat: add thing");
  const create = ghCalls(f, "create")[0];
  assert.equal(create[create.indexOf("--title") + 1], "feat: add thing");
  assert.deepEqual(ghCalls(f, "merge")[0].slice(3), [
    "1",
    "--squash",
    "--match-head-commit",
    branchSha,
  ]);
  // Local tests run before any branch exists.
  assert.deepEqual(
    f.calls().filter((c) => c[0] === "npm"),
    [
      ["npm", "run", "check"],
      ["npm", "test"],
    ],
  );
  for (const call of f.calls()) {
    for (const banned of ["--admin", "--auto", "--force", "-f", "--watch"]) {
      assert.ok(
        !call.includes(banned),
        `${call.join(" ")} must not include ${banned}`,
      );
    }
  }
  // Left on main, up to date with the merge result, clean.
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("rev-parse", "main"), branchSha);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("listed paths: only those are committed, unrelated staged/unstaged/untracked work survives", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work, "a.txt"), "changed a\n");
  writeFileSync(join(f.work, "new.txt"), "new file\n");
  writeFileSync(join(f.work, "b.txt"), "unrelated staged\n");
  f.git("add", "b.txt");
  writeFileSync(join(f.work, "c.txt"), "unrelated unstaged\n");
  writeFileSync(join(f.work, "scratch.txt"), "untracked scratch\n");

  const result = f.run([
    ...msg,
    "--branch",
    "feat/thing",
    "--body-file",
    join(f.dir, "body.md"),
    "--",
    "a.txt",
    "new.txt",
  ]);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(
    f.git("show", "--name-only", "--format=", "feat/thing").split("\n").sort(),
    ["a.txt", "new.txt"],
  );
  assert.equal(f.git("diff", "--cached", "--name-only"), "b.txt");
  assert.match(f.git("status", "--porcelain"), /^ M c\.txt$/m);
  assert.match(f.git("status", "--porcelain"), /^\?\? scratch\.txt$/m);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("rev-parse", "main"), f.git("rev-parse", "feat/thing"));
  assert.equal(ghCalls(f, "create").length, 1);
});

test("a new branch starts from origin/main so commits on another topic branch are not included", (t) => {
  const f = fixture(t);
  f.git("switch", "-c", "feat/other");
  writeFileSync(join(f.work, "c.txt"), "other work\n");
  f.git("commit", "-am", "feat: other work");
  writeFileSync(join(f.work, "a.txt"), "changed a\n");

  const result = f.run(msg);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /feat\/other has 1 commit\(s\) not on origin\/main/);
  assert.deepEqual(
    f.git("show", "--name-only", "--format=", "feat/add-thing").split("\n"),
    ["a.txt"],
  );
  assert.equal(f.git("rev-list", "--count", "origin/main..feat/other"), "1");
  assert.equal(f.git("branch", "--show-current"), "main");
});

test("rejects unsafe paths, bad messages and existing branches before changing anything", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work, "a.txt"), "changed a\n");
  for (const path of [".", "..", "/etc/hosts", ".git/config"]) {
    const result = f.run([...msg, "--", path]);
    assert.equal(result.status, 2, `${path}: ${result.out}`);
  }
  const bad = f.run(["--message", "added stuff"]);
  assert.equal(bad.status, 2);
  assert.match(bad.out, /conventional prefix/);
  f.git("branch", "feat/add-thing");
  const exists = f.run(msg);
  assert.equal(exists.status, 2);
  assert.match(exists.out, /already exists/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.deepEqual(
    f.calls().filter((c) => c[0] === "npm"),
    [],
  );
});

test("no changes to commit fails before tests or branch", (t) => {
  const f = fixture(t);
  const result = f.run(msg);
  assert.equal(result.status, 1);
  assert.match(result.out, /No changes to commit/);
  assert.deepEqual(
    f.calls().filter((c) => c[0] === "npm"),
    [],
  );
});

test("test failure stops before any branch, commit, push or PR", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work, "a.txt"), "changed a\n");
  const result = f.run(msg, { FAKE_NPM_FAIL: "test" });
  assert.equal(result.status, 1);
  assert.match(result.out, /Validation failed: npm test/);
  assert.match(result.out, /boom from test/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("branch", "--list", "feat/add-thing"), "");
  assert.equal(bareRev(f, "refs/heads/feat/add-thing"), "");
  assert.deepEqual(ghCalls(f, "create"), []);
});

test("fails when validation rewrites files being committed, or the patch has whitespace errors", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work, "a.txt"), "changed a\n");
  const mutated = f.run(msg, { FAKE_NPM_MUTATE: join(f.work, "a.txt") });
  assert.equal(mutated.status, 1);
  assert.match(mutated.out, /Validation modified files/);
  assert.equal(f.git("branch", "--list", "feat/add-thing"), "");

  const f2 = fixture(t);
  writeFileSync(join(f2.work, "a.txt"), "trailing space \n");
  const ws = f2.run(msg);
  assert.equal(ws.status, 1);
  assert.match(ws.out, /git diff --check/);
  assert.equal(f2.git("branch", "--list", "feat/add-thing"), "");
});

test("refuses when local main has unpushed commits", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work, "c.txt"), "local only\n");
  f.git("commit", "-am", "chore: unpushed");
  writeFileSync(join(f.work, "a.txt"), "changed a\n");
  const result = f.run(msg);
  assert.equal(result.status, 1);
  assert.match(result.out, /not on origin\/main/);
  assert.equal(f.git("branch", "--list", "feat/add-thing"), "");
});

test("merge blocker or queued merge exits 3 with the PR URL and is never reported as merged", (t) => {
  for (const mode of ["block", "queued"]) {
    const f = fixture(t);
    writeFileSync(join(f.work, "a.txt"), "changed a\n");
    const result = f.run(msg, { FAKE_MERGE: mode });
    assert.equal(result.status, 3, result.out);
    assert.match(result.out, /https:\/\/github\.com\/o\/r\/pull\/1/);
    assert.doesNotMatch(result.out, /RESULT: merged/);
    assert.equal(ghCalls(f, "merge").length, 1);
    assert.ok(!ghCalls(f, "merge")[0].includes("--admin"));
    assert.ok(!ghCalls(f, "merge")[0].includes("--auto"));
  }
});

test("PR body defaults to message plus validation, and --body-file overrides it", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work, "a.txt"), "changed a\n");
  assert.equal(f.run(msg).status, 0);
  const state = JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8"));
  assert.match(state.prs[0].body, /^feat: add thing/);
  assert.match(state.prs[0].body, /npm test`: passed/);

  const f2 = fixture(t);
  writeFileSync(join(f2.work, "a.txt"), "changed a\n");
  assert.equal(
    f2.run([...msg, "--body-file", join(f2.dir, "body.md")]).status,
    0,
  );
  const state2 = JSON.parse(readFileSync(join(f2.dir, "state.json"), "utf8"));
  assert.equal(state2.prs[0].body, "## Summary\nDoes a thing.\n");
});
