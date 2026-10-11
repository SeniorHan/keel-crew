import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { loadPlaywright, writeJson, publicState, sleep, integer } from './common.mjs';
import { captureProcessTree, signalProcessTree } from './processes.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('Internal worker: requires a session directory. Use terminal.mjs start.');
const file = path.join(dir, 'session.json');
const state = JSON.parse(await fs.readFile(file, 'utf8'));
let browser, browserLaunch, page, ttyd, control, idleTimer, stopping = false;
let sequence = 0;
let queue = Promise.resolve();
const persist = () => writeJson(file, state);
const activity = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void shutdown('idle timeout'), state.idleTimeout);
};
async function checkCancelled() {
  if (stopping || await fs.stat(path.join(dir, 'stop.request')).then(() => true).catch(() => false)) {
    const error = new Error('Startup cancelled'); error.code = 'CANCELLED'; throw error;
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function settle(ms = 100) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await sleep(ms);
}
async function terminalText(history = false) {
  return page.evaluate(history => {
    const term = window.term;
    const buffer = term.buffer.active;
    const start = history ? Math.max(0, buffer.length - 10000) : buffer.viewportY;
    const end = history ? buffer.length : start + term.rows;
    const lines = [];
    for (let i = start; i < end; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return { text: lines.join('\n'), cols: term.cols, rows: term.rows, alternateScreen: buffer.type === 'alternate', font: term.options.fontFamily, fontSize: term.options.fontSize };
  }, history);
}
async function resize(cols, rows) {
  cols = integer(cols, 'cols', 10, 500);
  rows = integer(rows, 'rows', 5, 200);
  const cell = await page.evaluate(() => {
    const rect = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { width: rect.width / window.term.cols, height: rect.height / window.term.rows, x: rect.x, y: rect.y };
  });
  // Fit the viewport around measured cells, then explicitly resize the emulator.
  // ttyd's onResize forwards the resulting character geometry to the real PTY.
  await page.setViewportSize({ width: Math.ceil(cols * cell.width + cell.x * 2 + 20), height: Math.ceil(rows * cell.height + cell.y * 2 + 1) });
  await sleep(180);
  await page.evaluate(({ cols, rows }) => window.term.resize(cols, rows), { cols, rows });
  await settle();
  state.cols = cols;
  state.rows = rows;
  await persist();
  return terminalText();
}
async function screenshot(name = 'frame') {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('Screenshot name must be 1–80 letters, digits, underscores or hyphens.');
  await settle();
  const output = path.join(dir, 'screenshots', `${String(++sequence).padStart(4, '0')}-${name}.png`);
  await page.screenshot({ path: output, animations: 'disabled' });
  await fs.chmod(output, 0o600);
  return { screenshot: output, ...await terminalText() };
}
async function shutdown(reason = 'requested', error) {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  state.status = error ? 'failed' : 'stopped';
  state.stopReason = reason;
  state.stoppedAt = new Date().toISOString();
  if (error) state.error = error.message;
  let tree = [];
  // Never rediscover ownership using the PID of an already-exited child (PID reuse).
  if (ttyd?.pid && ttyd.exitCode === null && ttyd.signalCode === null) {
    try { tree = captureProcessTree(ttyd.pid); } catch (error) { console.error(error); }
  }
  signalProcessTree(tree, 'SIGTERM');
  try {
    if (!browser && browserLaunch) browser = await browserLaunch;
    await browser?.close();
  } catch {}
  await sleep(150);
  signalProcessTree(tree, 'SIGKILL');
  try { await persist(); } catch (error) { console.error(error); }
  control?.close();
  setTimeout(() => process.exit(error ? 1 : 0), 100).unref();
}
async function action(body, signal) {
  if (signal?.aborted) throw new Error('Client disconnected; action cancelled.');
  if (stopping && body.action !== 'stop') throw new Error('Session is stopping.');
  switch (body.action) {
    case 'status': return { ...publicState(state), ...await terminalText() };
    case 'text': return { session: state.session, ...await terminalText(Boolean(body.history)) };
    case 'screenshot': return { session: state.session, ...await screenshot(body.name) };
    case 'resize': return { session: state.session, ...await resize(body.cols, body.rows) };
    case 'type':
      if (typeof body.text !== 'string' || Buffer.byteLength(body.text) > 1_000_000) throw new Error('text must be a string under 1 MB.');
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(body.text);
      await settle();
      return { session: state.session, ...await terminalText() };
    case 'press':
      if (typeof body.key !== 'string' || body.key.length > 100) throw new Error('key must be a Playwright keyboard key, e.g. Enter or Control+c.');
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press(body.key);
      await settle();
      return { session: state.session, ...await terminalText() };
    case 'wait': {
      const timeout = integer(body.timeout ?? 15000, 'timeout', 1, 300000);
      if (typeof body.text !== 'string' || !body.text.length) throw new Error('wait requires a nonempty --text substring.');
      const deadline = Date.now() + timeout;
      do {
        if (signal?.aborted || stopping) throw new Error('Wait cancelled.');
        const frame = await terminalText();
        if (frame.text.includes(body.text)) return { session: state.session, ...frame };
        await sleep(75);
      } while (Date.now() < deadline);
      throw new Error(`Timed out after ${timeout} ms waiting for ${JSON.stringify(body.text)}. Capture a screenshot and inspect ttyd.log.`);
    }
    case 'stop': {
      const result = { ...publicState(state), status: 'stopped', stopReason: 'requested' };
      await shutdown();
      return result;
    }
    default: throw new Error(`Unknown action: ${body.action}`);
  }
}
async function handle(req, res) {
  if (req.method !== 'POST' || req.url !== '/action' || req.headers.authorization !== `Bearer ${state.token}`) {
    res.writeHead(403); res.end('{"error":"Forbidden"}'); return;
  }
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      chunks.push(chunk); bytes += chunk.length;
      if (bytes > 1_100_000) throw new Error('Request too large.');
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const cancellation = new AbortController();
    res.on('close', () => { if (!res.writableEnded) cancellation.abort(); });
    const execute = async () => {
      clearTimeout(idleTimer);
      try { return await action(body, cancellation.signal); }
      finally { if (!stopping) activity(); }
    };
    // Stop must interrupt a long wait; cancelled queued input must never execute later.
    const job = body.action === 'stop' ? execute() : queue.then(execute);
    if (body.action !== 'stop') queue = job.catch(() => {});
    const result = await job;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', error => void shutdown('uncaught exception', error));
process.on('unhandledRejection', error => void shutdown('unhandled rejection', error instanceof Error ? error : new Error(String(error))));

try {
  state.workerPid = process.pid;
  await persist();
  await checkCancelled();
  const { chromium } = await loadPlaywright();
  await checkCancelled();
  const port = await freePort();
  const ttydLog = createWriteStream(path.join(dir, 'ttyd.log'), { mode: 0o600 });
  ttyd = spawn(process.env.TTYD_BINARY || 'ttyd', [
    '-i', '127.0.0.1', '-p', String(port), '-W', '-O', '-m', '1',
    '-c', `terminal:${state.ttydPassword}`,
    '-t', `fontFamily=${state.font}`, '-t', `fontSize=${state.fontSize}`,
    '-t', 'disableResizeOverlay=true', '-t', 'scrollback=10000',
    '--', ...state.command,
  ], { cwd: state.cwd, env: { ...process.env, ...state.env }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  ttyd.stdout.pipe(ttydLog); ttyd.stderr.pipe(ttydLog);
  let spawnError;
  ttyd.on('error', error => { spawnError = error; });
  ttyd.on('exit', (code, signal) => {
    state.terminalExit = { code, signal, at: new Date().toISOString() };
    // Keep the browser and final frame available for inspection after app exit.
  });
  state.ttydPid = ttyd.pid;
  state.url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + state.timeout;
  let listening = false;
  while (Date.now() < deadline) {
    await checkCancelled();
    if (spawnError) throw spawnError;
    if (state.terminalExit) throw new Error(`ttyd exited during startup. See ${dir}/ttyd.log.`);
    listening = await fetch(state.url, { headers: { Authorization: `Basic ${Buffer.from(`terminal:${state.ttydPassword}`).toString('base64')}` }, signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
    if (listening) break;
    await sleep(75);
  }
  if (!listening) throw new Error(`ttyd startup timed out. See ${dir}/ttyd.log.`);
  await checkCancelled();
  browserLaunch = chromium.launch({ headless: true });
  browser = await browserLaunch;
  await checkCancelled();
  const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1, httpCredentials: { username: 'terminal', password: state.ttydPassword } });
  page = await context.newPage();
  page.setDefaultTimeout(state.timeout);
  page.on('console', message => console.log(`[browser ${message.type()}] ${message.text()}`));
  page.on('pageerror', error => console.error(`[browser error] ${error.message}`));
  await page.goto(state.url);
  await page.waitForFunction(() => window.term?.buffer?.active && window.term.cols > 0 && window.term.rows > 0);
  await page.locator('.xterm-screen').waitFor({ state: 'visible' });
  await settle(200);
  await resize(state.cols, state.rows);
  const initial = await screenshot('initial');
  state.screenshot = initial.screenshot;
  control = http.createServer((req, res) => void handle(req, res));
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
  state.controlPort = control.address().port;
  await checkCancelled();
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  await persist();
  activity();
} catch (error) {
  console.error(error);
  if (!stopping) await shutdown(error.code === 'CANCELLED' ? 'startup cancelled' : 'startup failure', error.code === 'CANCELLED' ? undefined : error);
}
