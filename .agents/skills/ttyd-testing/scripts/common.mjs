import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const DEFAULT_FONT = 'JetBrainsMono Nerd Font Propo';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const home = () => path.resolve(process.env.TTYD_TESTING_HOME || path.join(os.tmpdir(), 'ttyd-testing'));
export function sessionDir(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name || '')) throw new Error('Session names must be 1–80 letters, digits, underscores or hyphens.');
  return path.join(home(), name);
}
export async function privateDirectory(dir, create = false) {
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
    throw new Error(`Artifact directory must be an owned, non-symlink directory with mode 0700: ${dir}`);
  }
}
export function integer(value, name, min, max) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return result;
}
export async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}
export async function readState(name) {
  const dir = sessionDir(name);
  await privateDirectory(home());
  await privateDirectory(dir);
  return { dir, state: JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8')) };
}
export async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'];
  try { candidates.push(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 10000 }).trim(), 'playwright')); } catch {}
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate); } catch (error) {
      if (process.env.PLAYWRIGHT_MODULE === candidate) throw new Error(`Cannot load PLAYWRIGHT_MODULE=${candidate}: ${error.message}`);
    }
  }
  throw new Error('Playwright not found. Install with: npm install -g playwright && playwright install chromium. Or set PLAYWRIGHT_MODULE to its module directory.');
}
export async function request(name, action, args = {}, timeout = 20000) {
  const { dir, state } = await readState(name);
  if (state.status === 'starting' && action === 'stop') {
    await fs.writeFile(path.join(dir, 'stop.request'), 'cancel startup\n', { mode: 0o600 });
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      const current = (await readState(name)).state;
      if (current.status === 'stopped' || current.status === 'failed') return publicState(current);
      if (current.status === 'running') return request(name, 'stop');
      await sleep(100);
    }
    throw new Error(`Startup cancellation requested; worker still shutting down. Inspect ${dir}/daemon.log.`);
  }
  if (state.status !== 'running') {
    if (action === 'status' || action === 'stop') return publicState(state);
    throw new Error(`Session ${name} is ${state.status}. ${state.error || ''} Logs: ${dir}`);
  }
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ action, ...args }), signal: AbortSignal.timeout(timeout),
  }).catch(error => { throw new Error(`Cannot reach session ${name}: ${error.message}. Inspect ${dir}/daemon.log; the daemon may have stopped.`); });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Session request failed: ${response.status}`);
  return result;
}
export function publicState(state) {
  const { token, ttydPassword, env, ...safe } = state;
  return safe;
}
