// Run from any directory: node scripts/cost-icons-visual-test.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const terminal = fileURLToPath(
  new URL("../.agents/skills/ttyd-testing/scripts/terminal.mjs", import.meta.url),
);
const session = `cost-icons-${Date.now()}`;
function run(...args) {
  return JSON.parse(execFileSync(process.execPath, [terminal, ...args], { encoding: "utf8" }));
}
try {
  const initial = run("start", "--session", session, "--cwd", root,
    "--cols", "80", "--rows", "24", "--", process.execPath,
    "--import", "tsx", "scripts/cost-icons-preview.ts");
  console.log(JSON.stringify(initial));
  run("wait", "--session", session, "--text", "PREVIEW_READY 80 columns");
  console.log(JSON.stringify(run("screenshot", "--session", session, "--name", "normal")));
  run("resize", "--session", session, "--cols", "20", "--rows", "30");
  run("wait", "--session", session, "--text", "PREVIEW_READY 20");
  console.log(JSON.stringify(run("screenshot", "--session", session, "--name", "narrow")));
} finally {
  console.log(JSON.stringify(run("stop", "--session", session)));
}
