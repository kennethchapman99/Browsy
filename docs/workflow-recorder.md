# Browsy Workflow Recorder

The Browsy wizard ships with a real browser **workflow recorder** that runs
a Chromium browser locally, observes the entire context (every tab, popup,
and same-origin frame), and emits a canonical event log plus a replay-ready
package — all from local fixtures, never relying on external sites.

This document explains what the recorder captures, what it does **not**
capture, and how to run it.

## What it captures

### Browser context (not just one page)
- `context.on('page')` attaches every new tab/popup to the same session.
- Each page gets a stable `pageId`; each non-main frame gets a stable
  `frameId`.
- `page.on('framenavigated' | 'frameattached' | 'framedetached')` produce
  `page_navigated` / `frame_seen` / `frame_navigated` / `frame_detached`
  events that carry both `pageId` and `frameId`.
- Same-origin iframes receive the injected recorder script via
  `context.addInitScript`, so frame DOM events flow through the same
  `__browsyEmit` binding with the originating page+frame metadata.

### Multi-tab / popups
- `target="_blank"` links → `page_opened` for the new tab with an own
  `pageId`.
- `window.open(...)` → `popup_opened` event carrying `parentPageId =
  openerPageId`.
- Each page also emits `page_closed` when it closes.

### Inputs
- `input` / `textarea` / `select` → `field_detected` (existing behavior).
- `input[type=file]` change → `file_selected` with `{name, size, type,
  lastModified, accept, multiple, fileCount}` and ranked
  `selectorCandidates`. **Recorder never reads file bytes.**
- Drag/drop on the document → `file_drop_detected` (on `dragenter`) and
  `file_dropped` (on `drop`) with the same file metadata schema.
- Clipboard:
  - `paste_detected` with `clipboardTypes`, capped `textPreview`
    (≤120 chars), `textLength`, `hasHtml`, `hasFiles`, and file metadata
    when files are pasted.
  - `copy_detected` / `cut_detected` with target metadata and the same
    capped preview.
- Contenteditable / `role=textbox` / common rich-editor surfaces
  (`.ProseMirror`, `.ql-editor`, `.DraftEditor-root`, `.tiptap`) →
  `editor_input` and `rich_text_changed` with a capped (≤240 chars)
  `textPreview` of the current `textContent`.

### Downloads
- `page.on('download')` is bound on every observed page.
- `download_started` then `download_saved` (with `savedPath` relative to
  the repo) — bytes are persisted to
  `output/observations/_sessions/<sessionId>/downloads/`.
- `download_failed` if `Download.saveAs()` rejects.

### Evidence
Per-state screenshots + DOM snapshots + visible-text summaries are captured
around: `session_start`, navigation, click_after, add_instance,
`file_selected`, `file_dropped`, paste, and `download`. Paths are
repo-relative and stored under
`output/observations/_sessions/<sessionId>/{screenshots,dom}/`.

Disable with `BROWSY_OBS_CAPTURE_SCREENSHOTS=0` /
`BROWSY_OBS_CAPTURE_DOM=0` — used by golden tests; **not** recommended for
real recording.

## Event schema

Every event carries: `id`, `sessionId`, `timestamp`, `type`, `source`
(`playwrightRecorder`). Page/frame-scoped events additionally carry
`pageId` (and `frameId` when emitted from a sub-frame), `pageUrl`,
`pageTitle`, `selector`, `selectorCandidates`, and `rawEvidence` payload.

Per-type required fields are validated in `validateEvent()` — invalid
events are dropped with a server-side warning rather than silently
appended. See [src/core/observation-events.mjs](../src/core/observation-events.mjs).

## Replay package

`buildRecorderPackage({sessionId, events, …})` (in
[src/core/recorder-package.mjs](../src/core/recorder-package.mjs)) produces
the structure the wizard returns from `POST
/api/observation/session/:id/stop` and `GET
/api/observation/session/:id/package`:

```jsonc
{
  "schemaVersion": "browsy.recorder-package.v1",
  "manifest":          { "sessionId", "source", "workflowId", "startUrl",
                         "startedAt", "finishedAt", "durationMs",
                         "eventCount", "stats" },
  "events":            [/* full canonical log, ordered */],
  "evidence":          { "snapshots": [/* per-state screenshot+DOM+text */] },
  "requiredAssets":    [/* one entry per file_selected/file_dropped file */],
  "producedArtifacts": [/* one entry per download_started/saved/failed   */],
  "replayNotes":       [/* structured warnings: multi-tab, popups,
                          clipboard, dangerous actions, downloads, etc. */]
}
```

### Required assets
The recorder never copies upload bytes. `requiredAssets[i]` carries
`{fileName, size, type, lastModified, selectorCandidates, label,
captureTrigger, replayRequirement}` and an `id` like `asset_1`. **Replay
must declare an asset map** (`assetMap[asset_1] = "/abs/path/to/file"`).
`hash` is left `null` — if integrity matters at replay, hashes must be
computed by the replay engine using the mapped local file.

### Produced artifacts
`producedArtifacts[i]` records downloads as `{kind: "download_started" |
"download_saved" | "download_failed", suggestedFilename, savedPath, size,
url, error}` — `savedPath` is the path on disk so the replay engine can
compare bytes / hashes.

### Replay notes
Each replay note is `{id, severity, summary, detail, events: [eventIds]}`.
Auto-emitted notes:
- `note_required_assets` — replay must supply an asset map.
- `note_downloads` — verify produced artifacts.
- `note_popups` (warning) — popup workflows are fragile.
- `note_multi_tab` (warning) — multiple pages observed.
- `note_frames` — cross-origin frames cannot be hooked.
- `note_clipboard_paste` (warning) — paste needs a workflow input.
- `note_dangerous_actions` (warning) — keep behind human checkpoint.
- `note_download_failures` (error) — re-record or mark manual.

## What is **not** supported (manual / re-record required)

- **Cross-origin iframes.** Playwright runs the init script per origin;
  if a frame is cross-origin, the recorder cannot inject listeners into
  it. Replay must verify selectors manually.
- **System clipboard contents pasted from outside the browser.** Recorder
  sees `paste_detected` and a capped preview but cannot replay a real
  OS clipboard; replay must declare the value as an input.
- **Generic OS file open dialogs without a triggering DOM event.**
  `setInputFiles` is what records — a custom OS picker invoked by
  non-DOM means is not visible.
- **Drag/drop sources outside the browser.** Replay must reconstruct the
  drop with a known file mapping.
- **Dangerous final actions.** Submit / Pay / Publish stay manual by
  policy — replay never auto-clicks them unless explicitly approved.

## Commands

### Run the wizard

```bash
npm run wizard
# then open http://localhost:3333 and walk through step 4
```

`BROWSY_OBS_HEADLESS=1` makes the recorder launch headless Chromium (used
by tests). Default = visible browser.

### Run the recorder acceptance suite

```bash
npm run acceptance:workflow-recorder
```

Covers: multi-tab, popups, iframe, file input, drag/drop, paste,
contenteditable, downloads, replay-package assets/artifacts/notes.
Uses local fixtures under
[fixtures/observation-workflow-recorder/](../fixtures/observation-workflow-recorder/).

### Run the entire test suite

```bash
npm test
```
