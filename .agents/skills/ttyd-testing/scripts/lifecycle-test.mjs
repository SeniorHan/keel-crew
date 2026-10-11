#!/usr/bin/env node
// Regression checks for process cleanup, cancellation, private artifacts and Unicode.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './common.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./terminal.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixture-terminal.mjs', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ttyd-lifecycle-'));
const env = { ...process.env, TTYD_TESTING_HOME: root };
const active = new Set();
async function call(command, ...args) {
  const { stdout } = await exec(process.execPath, [cli, command, ...args], { env, timeout: 45000, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}
async function state(name) { return JSON.parse(await fs.readFile(path.join(root, name, 'session.json'), 'utf8')); }
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check().catch(() => false)) return; await sleep(75); }
  throw new Error('Regression check timed out');
}
async function start(name, ...args) {
  active.add(name);
  return call('start', '--session', name, '--idle-timeout', '120000', ...args);
}
try {
  const insecure = path.join(root, 'insecure');
  await fs.mkdir(insecure, { mode: 0o755 });
  await assert.rejects(exec(process.execPath, [cli, 'start', '--', '/bin/sh'], { env: { ...env, TTYD_TESTING_HOME: insecure } }), /mode 0700/);
  const link = path.join(root, 'symlink');
  await fs.symlink(insecure, link);
  await assert.rejects(exec(process.execPath, [cli, 'start', '--', '/bin/sh'], { env: { ...env, TTYD_TESTING_HOME: link } }), /non-symlink/);
  assert.deepEqual(await fs.readdir(insecure), [], 'unsafe roots receive no session files');

  await start('queue', '--', process.execPath, fixture);
  await call('wait', '--session', 'queue', '--text', 'TTYD_TEST_READY');
  await call('type', '--session', 'queue', '--text', '--help');
  await call('press', '--session', 'queue', '--key', 'Enter');
  await call('wait', '--session', 'queue', '--text', 'RECEIVED:--help');
  const s = await state('queue');
  const body = Buffer.from(JSON.stringify({ action: 'type', text: 'é' }));
  const split = body.indexOf(Buffer.from('é')) + 1;
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: s.controlPort, path: '/action', method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => {
        try { assert.equal(res.statusCode, 200); assert.ok(JSON.parse(Buffer.concat(chunks)).text.includes('é')); resolve(); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 40);
  });
  await call('press', '--session', 'queue', '--key', 'Enter');

  const blocked = call('wait', '--session', 'queue', '--text', 'NO_MATCH', '--timeout', '1500').catch(() => {});
  await sleep(200);
  await assert.rejects(fetch(`http://127.0.0.1:${s.controlPort}/action`, {
    method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'type', text: 'SHOULD_NOT_EXECUTE' }), signal: AbortSignal.timeout(100),
  }));
  await blocked;
  assert.ok(!(await call('text', '--session', 'queue')).text.includes('SHOULD_NOT_EXECUTE'), 'cancelled queued input never executes');
  const longWait = call('wait', '--session', 'queue', '--text', 'NO_MATCH', '--timeout', '20000').catch(() => {});
  await sleep(150);
  const before = Date.now();
  await call('stop', '--session', 'queue');
  assert.ok(Date.now() - before < 5000, 'stop bypasses long-running wait');
  await longWait;

  const pidFile = path.join(root, 'stubborn.pid');
  const stubborn = `require('fs').writeFileSync(process.env.PID_FILE,String(process.pid)); process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{}); console.log('STUBBORN_READY'); setInterval(()=>{},1000)`;
  await start('stubborn', '--env', `PID_FILE=${pidFile}`, '--', process.execPath, '-e', stubborn);
  await call('wait', '--session', 'stubborn', '--text', 'STUBBORN_READY');
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  await call('stop', '--session', 'stubborn');
  await until(async () => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });

  const slowBinary = path.join(root, 'slow-ttyd');
  await fs.writeFile(slowBinary, '#!/bin/sh\nsleep 5\nexec ttyd "$@"\n', { mode: 0o700 });
  active.add('cancel-start');
  const starting = exec(process.execPath, [cli, 'start', '--session', 'cancel-start', '--', process.execPath, fixture], { env: { ...env, TTYD_BINARY: slowBinary }, timeout: 45000 }).then(() => { throw new Error('Cancelled startup unexpectedly succeeded'); }, error => { assert.match(error.stderr, /cancelled/i); });
  await until(async () => (await state('cancel-start')).workerPid);
  assert.equal((await call('stop', '--session', 'cancel-start')).status, 'stopped');
  await starting;

  // Do not rediscover a known-dead ttyd's process tree via a potentially reused PID.
  const bin = path.join(root, 'bin');
  const psMarker = path.join(root, 'ps-called');
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'ps'), '#!/bin/sh\nprintf captured >> "$PS_MARKER"\nexec /bin/ps "$@"\n', { mode: 0o700 });
  active.add('exited-ttyd');
  await exec(process.execPath, [cli, 'start', '--session', 'exited-ttyd', '--', process.execPath, fixture], {
    env: { ...env, PATH: bin + path.delimiter + process.env.PATH, PS_MARKER: psMarker }, timeout: 45000,
  });
  const live = await call('status', '--session', 'exited-ttyd');
  process.kill(live.ttydPid, 'SIGTERM');
  await until(async () => (await call('status', '--session', 'exited-ttyd')).terminalExit);
  await call('stop', '--session', 'exited-ttyd');
  await assert.rejects(fs.stat(psMarker), /ENOENT/, 'known-dead ttyd PID must not initiate process discovery');

  active.add('idle');
  await call('start', '--session', 'idle', '--idle-timeout', '1200', '--', process.execPath, fixture);
  await until(async () => (await state('idle')).status === 'stopped');
  assert.equal((await state('idle')).stopReason, 'idle timeout');
  console.log(JSON.stringify({ ok: true, artifacts: root, checks: ['reject insecure/symlink artifact roots', 'literal option-shaped text', 'split-chunk Unicode', 'cancel queued input on client timeout', 'stop interrupts wait', 'kill SIGHUP/SIGTERM-ignoring PTY child', 'cancel startup', 'skip known-dead ttyd PID discovery', 'idle cleanup'] }, null, 2));
} finally {
  for (const session of active) await call('stop', '--session', session).catch(error => console.error(error.message));
}
