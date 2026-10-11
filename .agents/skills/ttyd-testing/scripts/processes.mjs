import { execFileSync } from 'node:child_process';

// forkpty starts a new session: ttyd's own process group does NOT include the TUI.
// Discover descendants before ttyd exits, then retain their independently owned groups.
export function captureProcessTree(root) {
  if (!root) return [];
  if (process.platform === 'win32') return [{ pid: root, group: null }];
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 })
    .trim().split('\n').map(line => {
      const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
      return { pid, parent, group };
    });
  const descendants = new Set([root]);
  let changed;
  do {
    changed = false;
    for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  } while (changed);
  return rows.filter(row => descendants.has(row.pid)).map(row => ({
    pid: row.pid,
    // Only signal groups whose members ALL belong to this terminal tree.
    group: rows.every(other => other.group !== row.group || descendants.has(other.pid)) ? row.group : null,
  }));
}
export function signalProcessTree(tree, signal) {
  const targets = new Set(tree.map(row => row.group ? -row.group : row.pid));
  for (const target of targets) {
    if (target === process.pid) continue;
    try { process.kill(target, signal); } catch (error) { if (error.code !== 'ESRCH') console.error(`Cannot ${signal} terminal process ${target}: ${error.message}`); }
  }
}
