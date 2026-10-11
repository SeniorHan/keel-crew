#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DEFAULT_FONT, home, sessionDir, integer, writeJson, publicState, readState, request, loadPlaywright, sleep, privateDirectory } from './common.mjs';

const commands = ['doctor', 'start', 'list', 'status', 'screenshot', 'text', 'type', 'press', 'wait', 'resize', 'stop'];
const allowed = {
  doctor: ['font'], start: ['session', 'cwd', 'cols', 'rows', 'font', 'font-size', 'env', 'timeout', 'idle-timeout'],
  list: [], status: ['session'], screenshot: ['session', 'name'], text: ['session', 'history'],
  type: ['session', 'text', 'file'], press: ['session', 'key'], wait: ['session', 'text', 'timeout'],
  resize: ['session', 'cols', 'rows'], stop: ['session'],
};
function parse(argv) {
  const [command, ...rest] = argv;
  if (!commands.includes(command)) throw new Error(`Usage: node terminal.mjs <${commands.join('|')}> [--options] [-- command args].`);
  const options = {};
  let program = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') { program = rest.slice(i + 1); break; }
    if (!arg.startsWith('--') || !allowed[command].includes(arg.slice(2))) throw new Error(`Unexpected ${command} option: ${arg}`);
    const key = arg.slice(2);
    if (key === 'history') { options.history = true; continue; }
    const value = rest[++i];
    if (value === undefined) throw new Error(`Missing value for --${key}.`);
    if (key === 'env') (options.env ??= []).push(value);
    else if (options[key] !== undefined) throw new Error(`Duplicate --${key}.`);
    else options[key] = value;
  }
  if (program.length && command !== 'start') throw new Error('Only start accepts a command after --.');
  return { command, options, program };
}
async function doctor(font = DEFAULT_FONT) {
  const ttydVersion = execFileSync(process.env.TTYD_BINARY || 'ttyd', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<span id="font-probe">iW0 ● \uf120 \uf121</span>');
    await page.locator('#font-probe').evaluate((node, family) => { node.style.fontFamily = family; node.style.fontSize = '14px'; }, font);
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#font-probe' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    // CoreText reports the Nerd Fonts short family alias, not its CSS long name.
    const aliases = new Set([font.toLowerCase(), font.replace(/Nerd Font Propo/i, 'NFP').replace(/Nerd Font Mono/i, 'NFM').replace(/Nerd Font/i, 'NF').toLowerCase()]);
    const fontAvailable = fonts.some(item => aliases.has(item.familyName.toLowerCase()));
    return { ok: true, node: process.version, ttyd: ttydVersion, chromium: browser.version(), selectedFont: font, fontAvailable, actualFonts: fonts, artifactsRoot: home(), ...(fontAvailable ? {} : { warning: 'Requested family was not confirmed by Chromium. Install it or choose --font; inspect an actual screenshot for fallback/alias behavior.' }) };
  } finally { await browser.close(); }
}
async function start(options, command) {
  if (!command.length) throw new Error('start requires -- followed by the command and its arguments.');
  const session = options.session ?? `terminal-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const dir = sessionDir(session);
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  const env = {};
  for (const assignment of options.env || []) {
    const split = assignment.indexOf('=');
    if (split < 1 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(assignment.slice(0, split))) throw new Error('--env requires KEY=VALUE.');
    env[assignment.slice(0, split)] = assignment.slice(split + 1);
  }
  const state = {
    session, status: 'starting', artifacts: dir, command, cwd, env,
    cols: integer(options.cols ?? 80, 'cols', 10, 500), rows: integer(options.rows ?? 24, 'rows', 5, 200),
    font: options.font || DEFAULT_FONT, fontSize: integer(options['font-size'] ?? 14, 'font-size', 6, 48),
    timeout: integer(options.timeout ?? 15000, 'timeout', 1000, 300000),
    idleTimeout: integer(options['idle-timeout'] ?? 1800000, 'idle-timeout', 1000, 86400000),
    token: randomBytes(32).toString('hex'), ttydPassword: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  await privateDirectory(home(), true);
  try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Session ${session} already exists. Use a fresh name or omit --session; stopped session artifacts are retained.`);
    throw error;
  }
  await fs.mkdir(path.join(dir, 'screenshots'), { mode: 0o700 });
  await writeJson(path.join(dir, 'session.json'), state);
  const log = await fs.open(path.join(dir, 'daemon.log'), 'a', 0o600);
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url)), dir], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
  await log.close();
  worker.unref();
  let spawnError;
  worker.on('error', error => { spawnError = error; });
  const deadline = Date.now() + state.timeout + 20000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const current = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8'));
    if (current.status === 'running') return request(session, 'status');
    if (current.status === 'failed' || current.status === 'stopped') throw new Error(`${current.error || current.stopReason}. Logs: ${dir}`);
    await sleep(100);
  }
  worker.kill('SIGTERM');
  throw new Error(`Session startup timed out. Worker signalled to stop. Logs: ${dir}`);
}
export async function run(argv) {
  const { command, options, program } = parse(argv);
  if (command === 'doctor') return doctor(options.font);
  if (command === 'start') return start(options, program);
  if (command === 'list') {
    const names = await fs.readdir(home()).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const sessions = [];
    for (const name of names) {
      try { const { state } = await readState(name); sessions.push(publicState(state)); } catch {}
    }
    return { artifactsRoot: home(), sessions };
  }
  if (!options.session) throw new Error(`${command} requires --session NAME.`);
  switch (command) {
    case 'status': case 'stop': return request(options.session, command);
    case 'screenshot': return request(options.session, command, { name: options.name || 'frame' });
    case 'text': return request(options.session, command, { history: options.history });
    case 'type': {
      if ((options.text === undefined) === (options.file === undefined)) throw new Error('type requires exactly one of --text STRING or --file FILE.');
      const text = options.file ? await fs.readFile(path.resolve(options.file), 'utf8') : options.text;
      return request(options.session, command, { text }, 60000);
    }
    case 'press':
      if (!options.key) throw new Error('press requires --key, e.g. Enter, Escape, ArrowDown or Control+c.');
      return request(options.session, command, { key: options.key });
    case 'wait': {
      const timeout = integer(options.timeout ?? 15000, 'timeout', 1, 300000);
      return request(options.session, command, { text: options.text, timeout }, timeout + 10000);
    }
    case 'resize': return request(options.session, command, {
      cols: integer(options.cols, 'cols', 10, 500), rows: integer(options.rows, 'rows', 5, 200),
    });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: error.message }, null, 2)); process.exitCode = 1; }
}
