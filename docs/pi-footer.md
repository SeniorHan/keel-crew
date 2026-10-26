# Subagent dollar totals in pi-footer

With `npm:pi-footer` loaded, choose one of the two integration paths below. Both
show the selected **Display value**: settled subagent-only USD (default), or total
main-session + settled-subagent USD. Keep pi-footer’s native cost widget if you
want the main-session cost shown separately.

The shared status key / event Widget ID is exactly **`subagent_cost`**. It is not
`keel-crew`, an extension file path, or an npm package ID.

## Extension Status (recommended; default)

1. Open `/agents settings` → **[labs] Footer display** → **Location**, choose
   **pi-footer status widget**, return to settings, and save with **Ctrl+S**.
2. Open `/footer`, choose **Edit lines**, select a row, and add **Extension Status**.
3. Set **Status key** to **`subagent_cost`** and enable **Raw value only**.
4. Save the footer configuration.

The corresponding keel-crew setting is:

```json
{
  "costDisplay": "pi-footer-status"
}
```

For a file-based footer setup, insert this widget object into an existing row
array in `lines` in `~/.pi/agent/extensions/pi-footer.json`:

```json
{
  "id": "subagent-cost-status",
  "type": "external-status",
  "enabled": true,
  "options": {
    "externalStatusKey": "subagent_cost",
    "raw": true,
    "hideWhenEmpty": true,
    "trimValue": 0
  }
}
```

Here `id` identifies the footer widget instance; **`externalStatusKey`** is the
lookup key that must match the publisher. Do not put the package name in it.
The manager already publishes the value using this API (no extra extension needed):

```typescript
ctx.ui.setStatus("subagent_cost", "💵 $0.1234");
```

It clears the status with `ctx.ui.setStatus("subagent_cost", undefined)`.

## Pi Event Value (alternative)

1. Open `/agents settings` → **[labs] Footer display** → **Location**, choose
   **pi-footer event**, return to settings, and save with **Ctrl+S**.
2. In `/footer`, add a **Pi Event Value** widget to the desired row.
3. Enter **Widget ID** as **`subagent_cost`** manually, replacing the generated ID,
   and enable **Raw value only**. Event IDs do **not** appear in the status-key selector.
4. Save the footer configuration.

The corresponding keel-crew setting is:

```json
{
  "costDisplay": "pi-footer-event"
}
```

Insert this widget object into an existing row array in the footer's `lines`:

```json
{
  "id": "subagent-cost-event",
  "type": "event",
  "enabled": true,
  "options": {
    "widgetId": "subagent_cost",
    "raw": true,
    "hideWhenEmpty": true
  }
}
```

The manager already emits the following event; no custom publisher is required.
This is the exact event name and payload shape, with an illustrative dollar value:

```typescript
pi.events.emit("pi-footer:update-widget", {
  widgetId: "subagent_cost",
  value: "💵 $0.1234",
});
```

To clear the event value, the manager emits:

```typescript
pi.events.emit("pi-footer:update-widget", {
  widgetId: "subagent_cost",
  value: null,
});
```

## File locations and refresh behavior

- Merge `costDisplay`, `costValue`, and `costIcon` settings into
  `~/.pi/agent/keel-crew/settings.json`, or the trusted-project override
  `.pi/agent/keel-crew/settings.json`. Preserve your other settings.
- Footer widget snippets are **objects inside a row**, not complete configuration
  files: the structure is `"lines": [[widgetObject, otherWidgetObject]]`. Preserve
  existing rows and widgets. `PI_FOOTER_CONFIG` can override the footer file path.
- After manual file edits, use Pi's `/reload` to reload extensions and settings.
  Using the settings dialogs applies changes immediately when saved.
- Choose only the widget matching your selected mode. Switching modes clears the
  old output; shutdown clears the published value too.
- `$0.0000` appears at session start/reload and immediately on subagent startup.
  Running costs settle on completion, pause, stop, or failure; they remain in
  agent rows until then. Nested agents are counted once, and accounting survives
  resume and reaping. The selected money, coins, or wallet icon prefixes the
  dollar value: emoji with Nerd Font icons off, or a Nerd Font glyph with it on.
- If the status key is missing, check that the manager is loaded and the location
  is **pi-footer status widget**, not **pi-footer event**. **Replace Pi status**
  uses the same status key but includes a Subagents/Total label. All locations
  support either display value; choose **Only subagent cost** for a subtotal.

See [Cost display settings](settings.md#labs-cost-display-costdisplay) for all modes
and fallback behavior when pi-footer is not loaded.
