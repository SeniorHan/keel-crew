#!/usr/bin/env node
// Real-PTY fixture for screenshots, Unicode, alt-screen, keys and ioctl resizing.
import { execFileSync } from 'node:child_process';
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Fixture must run inside a real PTY.');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let line = '';
let alternate = false;
function geometry() {
  const [rows, cols] = execFileSync('stty', ['size'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim().split(/\s+/);
  return `PTY_SIZE:${cols}x${rows}`;
}
function print(text) { process.stdout.write(text + '\r\n'); }
function normal() {
  print('\x1b[32mTTYD_TEST_READY\x1b[0m');
  print('Font: JetBrainsMono Nerd Font Propo');
  print('Dots: \x1b[32mGlobal ●\x1b[0m  \x1b[33mProject ●\x1b[0m');
  print('Nerd icons: \uf120 \uf121 \uf0a0');
  print('Unicode: café 日本語');
  print(geometry());
}
normal();
process.stdout.on('resize', () => print(geometry()));
process.stdin.on('data', data => {
  if (data === '\x1b[B') { print('KEY:ArrowDown'); return; }
  if (data === '\x1b') {
    if (alternate) { process.stdout.write('\x1b[?1049l'); alternate = false; }
    print('NORMAL_SCREEN_RESTORED');
    return;
  }
  for (const character of data) {
    if (character === '\x03') { print('FIXTURE_EXIT'); process.exit(0); }
    if (character === '\r' || character === '\n') {
      print('');
      if (line === 'alt') {
        process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
        alternate = true;
        print('\x1b[36mALTERNATE_SCREEN_READY\x1b[0m');
        print('Press Escape to restore normal screen.');
      } else if (line === 'size') print(geometry());
      else print(`RECEIVED:${line}`);
      line = '';
    } else if (character === '\x7f') {
      line = [...line].slice(0, -1).join('');
      process.stdout.write('\b \b');
    } else {
      line += character;
      process.stdout.write(character);
    }
  }
});
