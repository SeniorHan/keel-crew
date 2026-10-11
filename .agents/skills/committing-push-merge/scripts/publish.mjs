#!/usr/bin/env node
// "Commit and push" = local tests -> NEW topic branch from origin/<default> -> commit -> push -> PR
// -> gh squash-merge -> update the local default branch. PRs are how the changelog gets entries.
// Never force-pushes, never uses --admin/--auto, never waits for CI, never touches version/CHANGELOG.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_BLOCKED = 3; // PR exists but is not merged.

const USAGE = `Usage:
  node .agents/skills/committing-push-merge/scripts/publish.mjs --message "<type>: <summary>" [options] [-- <path>...]

  --message <text>    Conventional commit message; its first line is the PR title.
  --branch <name>     New topic branch (default: <type>/<slug of the summary>). Must not exist yet.
  --body-file <file>  PR body (default: the message plus local validation results).
  -- <paths...>       Commit only these files/directories; other changes stay untouched.
                      Without paths, ALL current changes are committed.
  -h, --help          Show this help.

Exit codes: 0 merged, 1 failed, 2 usage error, 3 PR open but not merged (URL printed).`;

class Fail extends Error {
  constructor(message, code = EXIT_FAIL, extra = '') {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' };
let root = process.cwd();
let stepNo = 0;
let merged = false;
const say = message => console.log(message);
const step = message => say(`\n[${++stepNo}] ${message}`);

function run(cmd, args, { allowFail = false } = {}) {
  const result = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Fail(`'${cmd}' was not found on PATH.`);
    throw new Fail(`Failed to run ${cmd}: ${result.error.message}`);
  }
  const out = { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (out.status !== 0 && !allowFail) {
    const detail = (out.stderr || out.stdout).trim();
    throw new Fail(`\`${cmd} ${args.join(' ')}\` failed (exit ${out.status})${detail ? `:\n${detail}` : ''}`);
  }
  return out;
}
const git = args => run('git', args).stdout;
const gitOk = args => run('git', args, { allowFail: true }).status === 0;
const gh = args => run('gh', args).stdout;

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        message: { type: 'string' },
        branch: { type: 'string' },
        'body-file': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new Fail(`${error.message}\n\n${USAGE}`, EXIT_USAGE);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    say(USAGE);
    process.exit(0);
  }
  const usage = message => new Fail(`${message}\n\n${USAGE}`, EXIT_USAGE);
  if (!values.message?.trim()) throw usage('--message is required.');
  const subject = values.message.split('\n')[0];
  const match = subject.match(/^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([\w./-]+\))?!?: (\S.*)$/);
  if (!match) throw usage(`--message must start with a conventional prefix such as "fix: ..." (got "${subject}").`);
  const slug = match[3].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const branch = values.branch ?? `${match[1]}/${slug || 'change'}`;
  return { message: values.message, subject, branch, bodyFile: values['body-file'], paths: positionals };
}

// Resolve explicit paths to unique repo-relative paths; never allow "everything" via a path.
function resolvePaths(paths) {
  const cwd = fs.realpathSync(process.cwd());
  const result = new Set();
  for (const input of paths) {
    const relative = path.relative(root, path.resolve(cwd, input));
    if (!input.trim() || relative === '') throw new Fail(`Path "${input}" is empty or the repository root; list explicit files or omit paths to commit everything.`, EXIT_USAGE);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Fail(`Path "${input}" is outside the repository.`, EXIT_USAGE);
    }
    const normalized = relative.split(path.sep).join('/');
    if (normalized === '.git' || normalized.startsWith('.git/')) throw new Fail(`Path "${input}" is inside .git.`, EXIT_USAGE);
    result.add(normalized);
  }
  return [...result];
}

function validate(scope) {
  for (const [cmd, args] of [['npm', ['run', 'check']], ['npm', ['test']]]) {
    const label = `${cmd} ${args.join(' ')}`;
    const started = Date.now();
    const result = run(cmd, args, { allowFail: true });
    if (result.status !== 0) {
      const output = (result.stdout + result.stderr).trimEnd().split('\n').slice(-60).join('\n');
      throw new Fail(`Validation failed: ${label} (exit ${result.status}). Nothing was committed.`, EXIT_FAIL, output);
    }
    say(`  ok  ${label} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  const check = run('git', ['diff', '--cached', '--check', ...scope], { allowFail: true });
  if (check.status !== 0) throw new Fail('git diff --check reported whitespace problems:', EXIT_FAIL, check.stdout.trim());
  say('  ok  git diff --check');
  // Tests/checks must not rewrite what we are about to commit (commit would silently include it).
  if (!gitOk(['diff', '--quiet', ...scope])) {
    throw new Fail('Validation modified files being committed; review the changes and re-run.');
  }
}

function main() {
  const opts = parseOptions(process.argv.slice(2));
  root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim());
  const paths = resolvePaths(opts.paths);
  const scope = paths.length ? ['--', ...paths] : [];

  step('Preflight');
  const current = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }).stdout.trim();
  const base = gh(['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
  if (!base) throw new Fail('Could not determine the default branch via gh.');
  git(['fetch', 'origin', base]);
  const remoteBase = `origin/${base}`;
  const localBase = gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
  if (localBase) {
    const ahead = Number(git(['rev-list', '--count', `${remoteBase}..${base}`]).trim());
    if (ahead > 0) throw new Fail(`Local ${base} has ${ahead} commit(s) not on ${remoteBase}; resolve that first so ${base} can be updated afterwards.`);
  }
  if (!gitOk(['check-ref-format', '--branch', opts.branch]) || opts.branch.startsWith('-') || opts.branch === base) {
    throw new Fail(`Invalid topic branch name "${opts.branch}".`, EXIT_USAGE);
  }
  if (gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`]) || run('git', ['ls-remote', '--exit-code', '--heads', 'origin', opts.branch], { allowFail: true }).status === 0) {
    throw new Fail(`Branch ${opts.branch} already exists locally or on origin; pass --branch <new-name>.`, EXIT_USAGE);
  }
  if (current && current !== base) {
    const extra = Number(git(['rev-list', '--count', `${remoteBase}..HEAD`]).trim());
    if (extra > 0) say(`  note: ${current} has ${extra} commit(s) not on ${remoteBase}; they are NOT included (the new branch starts from ${remoteBase}).`);
  }
  let userBody = '';
  if (opts.bodyFile) {
    try {
      userBody = fs.readFileSync(opts.bodyFile, 'utf8');
    } catch (error) {
      throw new Fail(`Cannot read --body-file: ${error.message}`, EXIT_USAGE);
    }
    if (!userBody.trim()) throw new Fail('--body-file is empty.', EXIT_USAGE);
  }

  // Stage the intended changes first so untracked files take part in the checks below.
  if (paths.length) git(['add', '--', ...paths]);
  else git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only', ...scope]).trim().split('\n').filter(Boolean);
  if (staged.length === 0) throw new Fail('No changes to commit' + (paths.length ? ' in the given paths.' : '.'));
  say(`  base:   ${base} (${remoteBase} @ ${git(['rev-parse', '--short', remoteBase]).trim()})`);
  say(`  branch: ${opts.branch} (new, from ${remoteBase})`);
  say(`  commit: ${opts.subject}`);
  say(`  files:  ${staged.join(', ')}`);

  step('Run local tests (no CI waiting)');
  validate(scope);

  step('Topic branch + commit');
  git(['switch', '-c', opts.branch, '--no-track', remoteBase]);
  // --only commits just the staged scope; unrelated staged/unstaged work stays as it was.
  git(paths.length ? ['commit', '--only', '-m', opts.message, '--', ...paths] : ['commit', '-m', opts.message]);
  const headSha = git(['rev-parse', 'HEAD']).trim();
  say(`  committed ${headSha.slice(0, 7)} on ${opts.branch}`);

  step('Push + PR');
  git(['push', '-u', 'origin', opts.branch]);
  const body =
    userBody ||
    `${opts.message.trim()}\n\n## Local validation\n- \`npm run check\`: passed\n- \`npm test\`: passed\n- \`git diff --check\`: passed\n`;
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-')), 'body.md');
  fs.writeFileSync(bodyFile, body);
  const out = gh(['pr', 'create', '--base', base, '--head', opts.branch, '--title', opts.subject, '--body-file', bodyFile]);
  fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
  const prUrl = out.trim().split('\n').pop().trim();
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  if (!prNumber) throw new Fail(`Could not determine PR number from: ${prUrl}`);
  say(`  created ${prUrl}`);

  step('Merge with gh (squash)');
  const merge = run('gh', ['pr', 'merge', prNumber, '--squash', '--match-head-commit', headSha], { allowFail: true });
  const info = merge.status === 0 ? JSON.parse(gh(['pr', 'view', prNumber, '--json', 'state,mergeCommit'])) : null;
  if (!info || info.state !== 'MERGED') {
    const reason = info ? `PR is ${info.state}, not MERGED` : (merge.stderr || merge.stdout).trim();
    throw new Fail(`Not merged: ${prUrl}\n${reason}\nDo not bypass protections; resolve the blocker, then run: gh pr merge ${prNumber} --squash`, EXIT_BLOCKED);
  }
  merged = true;
  say(`  merged, commit ${info.mergeCommit?.oid ?? 'unknown'}`);

  step(`Update ${base}`);
  git(['fetch', 'origin', base]);
  if (localBase) git(['switch', base]);
  else git(['switch', '-c', base, '--track', remoteBase]);
  git(['merge', '--ff-only', remoteBase]);
  say(`  on ${base} @ ${git(['rev-parse', '--short', 'HEAD']).trim()} (= ${remoteBase})`);

  say(`\nRESULT: merged ${prUrl} commit=${info.mergeCommit?.oid ?? 'unknown'}`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof Fail)) throw error;
  console.error(`\nFAILED: ${error.message}`);
  if (error.extra) console.error(error.extra);
  if (error.code === EXIT_FAIL) {
    console.error(merged ? '\nThe PR was merged; only updating the local default branch failed. Run: git switch <default> && git pull --ff-only' : '\nNot merged. Fix the problem and re-run; if a PR was already created, check `gh pr list` first.');
  }
  process.exit(error.code);
}
