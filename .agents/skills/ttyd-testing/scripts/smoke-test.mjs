#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, sleep } from './common.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./terminal.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixture-terminal.mjs', import.meta.url));
const session = `smoke-${Date.now()}`;
const screenshots = [];
let started = false;
async function call(command, ...args) {
  const result = await exec(process.execPath, [cli, command, ...args], { timeout: 60000, maxBuffer: 2_000_000 });
  return JSON.parse(result.stdout);
}
async function frame(name) {
  const result = await call('screenshot', '--session', session, '--name', name);
  const bytes = await fs.readFile(result.screenshot);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
  screenshots.push(result.screenshot);
  return result;
}
try {
  const initial = await call('start', '--session', session, '--cols', '80', '--rows', '24', '--idle-timeout', '120000', '--', process.execPath, fixture);
  started = true;
  assert.equal(initial.cols, 80); assert.equal(initial.rows, 24);
  assert.equal(initial.font, 'JetBrainsMono Nerd Font Propo');
  assert.ok(initial.screenshot);
  await call('wait', '--session', session, '--text', 'TTYD_TEST_READY');
  const { state } = await readState(session);
  assert.equal((await fetch(state.url)).status, 401, 'ttyd requires credentials');
  assert.equal((await fetch(`http://127.0.0.1:${state.controlPort}/action`, { method: 'POST', body: '{}' })).status, 403, 'control requires bearer token');
  assert.equal((await fs.stat(path.join(initial.artifacts, 'session.json'))).mode & 0o777, 0o600);
  await frame('ready');
  await call('type', '--session', session, '--text', 'hello screenshot');
  await call('press', '--session', session, '--key', 'Enter');
  await call('wait', '--session', session, '--text', 'RECEIVED:hello screenshot');
  await call('type', '--session', session, '--text', 'héllo ●');
  await call('press', '--session', session, '--key', 'Enter');
  await call('wait', '--session', session, '--text', 'RECEIVED:héllo ●');
  await call('press', '--session', session, '--key', 'ArrowDown');
  await call('wait', '--session', session, '--text', 'KEY:ArrowDown');
  await frame('after-input');
  await call('type', '--session', session, '--text', 'alt');
  await call('press', '--session', session, '--key', 'Enter');
  await call('wait', '--session', session, '--text', 'ALTERNATE_SCREEN_READY');
  assert.equal((await frame('alternate')).alternateScreen, true);
  await call('press', '--session', session, '--key', 'Escape');
  await call('wait', '--session', session, '--text', 'NORMAL_SCREEN_RESTORED');
  assert.equal((await call('text', '--session', session)).alternateScreen, false);
  const resized = await call('resize', '--session', session, '--cols', '60', '--rows', '12');
  assert.equal(resized.cols, 60); assert.equal(resized.rows, 12);
  await call('type', '--session', session, '--text', 'size');
  await call('press', '--session', session, '--key', 'Enter');
  await call('wait', '--session', session, '--text', 'PTY_SIZE:60x12');
  await frame('resized');
  await assert.rejects(call('wait', '--session', session, '--text', 'NONEXISTENT_SENTINEL', '--timeout', '150'), /Timed out/);
  assert.equal((await call('status', '--session', session)).status, 'running', 'a wait timeout leaves session usable');
  await assert.rejects(call('screenshot', '--session', session, '--name', '../escape'), /Screenshot name/);
  const stopped = await call('stop', '--session', session);
  assert.equal(stopped.status, 'stopped');
  assert.equal((await call('status', '--session', session)).status, 'stopped');
  assert.equal((await call('stop', '--session', session)).status, 'stopped', 'stop is idempotent');
  await sleep(200);
  await assert.rejects(fetch(state.url), 'ttyd port closes on stop');
  await assert.rejects(fetch(`http://127.0.0.1:${state.controlPort}/action`), 'control port closes on stop');
  console.log(JSON.stringify({ ok: true, session, artifacts: initial.artifacts, screenshots, checks: ['separate CLI processes share live session', 'real PTY keyboard + Unicode + arrow input', 'actual PNG screenshots', 'alternate screen', '60x12 emulator + PTY ioctl resize', 'authenticated loopback services', 'private metadata', 'timeouts/path validation', 'stop closes ports and keeps artifacts'] }, null, 2));
} finally {
  if (started) await call('stop', '--session', session).catch(error => console.error(error.message));
}
