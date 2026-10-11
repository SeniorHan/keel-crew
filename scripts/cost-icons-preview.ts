/** Visual fixture: run with tsx inside the ttyd-testing terminal harness. */
import { costIconGlyph } from "../src/ui/cost-footer.ts";

function render() {
  const width = process.stdout.columns ?? 80;
  const lines = [
    "Cost icon preview",
    "JetBrainsMono Nerd Font Propo",
    "",
    ...(["money", "coins", "wallet"] as const).flatMap((icon) => [
      `${icon}: ${costIconGlyph(icon, true)} $12.3456`,
      `emoji: ${costIconGlyph(icon, false)} $12.3456`,
    ]),
    "",
    "Old incorrect mappings:",
    "coins: \u{f0512} (thumb down)",
    "wallet: \u{f055d} (intersection)",
    "",
    "Alternatives:",
    "cash: \u{f0114} $12.3456",
    "wallet: \u{f0584} $12.3456",
    "",
    `PREVIEW_READY ${width} columns`,
  ];
  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n");
}
process.stdout.on("resize", render);
render();
setInterval(() => {}, 60_000);
