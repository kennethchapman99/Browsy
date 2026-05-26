# Controlled DistroKid dry-run capture

This document is the **operator checklist** for running a strictly bounded,
human-driven observation capture against the real `distrokid.com` site.

**Sprint:** 4 — capture-side evidence (2026-05-25).
**Status:** ready for the dry run described below; **not** ready for
unattended replay or automation generation in the same session.

Read [observation-real-world-readiness.md](observation-real-world-readiness.md)
before doing this. That document explains *why* we stop where we stop.

## What you're doing

You will:

1. Start the wizard server with evidence capture enabled.
2. Open the recorder against `https://distrokid.com/`.
3. Log in **manually**, in the browser window the server opened.
4. Walk a release-upload flow **manually**. Type the metadata, select files
   from your local disk, click through the stages — every action is yours.
5. **Stop before any irreversible step.** No clicking "Submit", "Publish",
   "Confirm Final", "Pay", or any button on the final review page.
6. End the session.
7. Export the observation preview.
8. Review the preview offline.

You will not:

- Generate automation from this capture in the same session.
- Run a Browsy package against DistroKid in this session.
- Let Browsy click anything on DistroKid. Browsy only listens.
- Persist any DistroKid credentials anywhere. Auth state stays in the
  ephemeral Chromium profile and is discarded on close.

## Safety boundary (non-negotiable)

| # | Rule | Why |
|---|------|-----|
| 1 | The human drives every action. Browsy only listens. | Selectors are not yet verified against DistroKid's React-generated IDs. |
| 2 | Log in manually inside the opened Chromium window. Do not paste credentials into Browsy. | Browsy has no auth story and no credential storage. |
| 3 | Stop before any button whose label matches `submit`, `publish`, `pay`, `confirm final`, `finalize`, `purchase`, `charge`, `withdraw`, `delete`, or "go live". | These are the labels [`isHardDangerous`](../src/core/observation-from-events.mjs) is tuned to catch — they correspond to irreversible state on DistroKid. |
| 4 | Use **test metadata** — title like `"BROWSY DRY RUN — DO NOT PUBLISH"`, artist your own draft project, ISRCs left blank. | A bug or stray click should never put real-looking content into the queue. |
| 5 | Use **scratch files** for cover art and audio — a 1×1 PNG and a 1-second WAV are fine. Never upload a real production master. | If we somehow trigger an upload-stage save we want it to be obviously a test asset. |
| 6 | Review the exported preview offline before generating any automation. | The preview is the trust gate. If anything in it looks wrong, the capture is discarded — not patched. |
| 7 | Discard the capture if `isHardDangerous` failed to flag any obviously irreversible button DistroKid actually showed. | A miss here is a P0 capture-pipeline bug, not a workflow issue. |
| 8 | One DistroKid origin per session. Close the browser between sessions. No cross-tenant capture. | Keeps the captured event log scoped to one tenant. |

If any of the above can't be honored, **stop**.

## Prerequisites

- Node ≥ 22 installed.
- Playwright Chromium installed (`npx playwright install chromium`).
- A DistroKid account you control, with at least one **draft** release you
  can edit without committing.
- Disk space for screenshots + DOM snapshots — budget ~100 MB per session.

## Exact startup command

```bash
# In the repo root.

# Evidence capture is ON by default; we set it explicitly here so the
# operator sees what's happening. The CDP port is optional but useful if
# you want to attach extra Playwright tooling later.
BROWSY_OBS_CAPTURE_SCREENSHOTS=1 \
BROWSY_OBS_CAPTURE_DOM=1 \
BROWSY_OBS_HEADLESS=0 \
node wizard/server.mjs
```

The server prints `http://localhost:3333`. Open that URL in **your normal
browser** (Chrome / Safari / whatever). The wizard UI is what you'll drive;
the Playwright Chromium window is what records.

## Exact browser flow

1. In the wizard UI, open the Observation Import section.
2. Pick **Playwright Recorder** as the capture source.
3. Enter `https://distrokid.com/signin/` as the start URL.
4. Click **Start session**.
   - A new Chromium window opens at the DistroKid sign-in page.
   - The wizard begins recording events.
5. **Log in manually** in the Chromium window.
   - Use 2FA if your account requires it.
   - Browsy sees zero credentials.
6. Once logged in, navigate to **New Upload** (or your draft release).
7. Fill in metadata:
   - Title: `BROWSY DRY RUN — DO NOT PUBLISH`
   - Artist: your draft-project name
   - Release date: a date several weeks out
   - Genre: any
   - Don't enable any "publish immediately" toggle
8. Upload **scratch** cover art (1×1 PNG is enough).
9. Move to the tracks stage.
10. Add one track. Title: `dry run track 1`. Upload a 1-second WAV.
11. Click `+ Add another track` (this proves the repeat-group capture
    fires).
12. Add a second track. Title: `dry run track 2`. Upload the same WAV.
13. Toggle the required confirmation checkboxes (rights / terms).
14. Click through to the review page.

### Hard stop

When you arrive at the review page or the final "Submit & Publish" stage:

> **Do not click any final-submit button.**
> Do not click anything labelled `Submit`, `Publish`, `Pay`, `Confirm`,
> `Finalize`, `Go Live`, or `Charge`.
> Take a screenshot of the page manually if it's useful for review, but
> the capture pipeline has already snapshotted it for you.

### Ending the session

In the wizard UI, click **Stop session**. The wizard:

- Drains pending screenshot/DOM captures.
- Writes the canonical event log to memory.
- Closes the Chromium window automatically.

You can then export the preview (see below).

## What to export

After stopping:

```bash
# Export the canonical event log (JSON).
curl -s http://localhost:3333/api/observation/session/<sessionId>/events \
  > /tmp/distrokid-dry-run-events.json
```

The screenshots and DOM snapshots are already on disk under:

```
output/observations/_sessions/<sessionId>/screenshots/
output/observations/_sessions/<sessionId>/dom/
```

Both directories are in `.gitignore` — they live on your machine and are
not committed.

To render the human-readable preview:

```js
import fs from 'node:fs';
import { buildObservationFromEvents } from './src/core/observation-from-events.mjs';
import { renderObservationPreview } from './src/core/observation-preview.mjs';

const { events } = JSON.parse(fs.readFileSync('/tmp/distrokid-dry-run-events.json', 'utf8'));
const obs = buildObservationFromEvents({
  events,
  workflowId: 'distrokid-dry-run',
  captureSource: 'playwrightRecorder',
});
fs.writeFileSync('/tmp/distrokid-dry-run-preview.md', renderObservationPreview(obs));
```

Or run the equivalent ad-hoc via `node -e`.

## What to inspect in the preview

Open the rendered markdown and look at every section. The reviewer is
asking "does this match the workflow I just walked through?". Specifically:

### Pages / states observed

- One entry per stage you visited. DistroKid is an SPA, so most stages
  share a URL — you'll likely see fewer page entries than stages walked.
  **This is a known capture gap** (SPA navigation isn't tracked yet).
- Each entry's **Evidence** subsection should show:
  - `Screenshot:` with a path under `output/observations/_sessions/...`
  - `DOM snapshot:` with a path under the same tree
  - `Visible text summary:` matching what you actually saw on screen at
    that moment. If the summary describes the login page when you were on
    the tracks page, the capture missed an SPA route change — discard.

### Fields detected

- Every field you typed into should appear with the right `inputType`
  (text / email / select-one / file).
- `required:` should be `true` for fields DistroKid actually required (the
  metadata fields, the confirmation checkboxes).
- `selectorConfidence` should be `high` or `medium` for most fields. If
  every field shows `low`, the capture would not be safe to automate
  against — selectors fall back to structural-only.

### Repeat groups

- The `+ Add another track` button must surface as a repeat group.
- The tracks must cluster into structured instances (`Instance 1`,
  `Instance 2`).
- If only one instance appears, the capture missed the second add click —
  re-do the flow with a clearer pause between clicks.

### Manual-only / dangerous actions

- Every irreversible button DistroKid showed must appear here. Common
  ones: `Submit & Publish Release`, `Confirm and Pay`, `Go Live`.
- **If a real publish/submit button DistroKid displayed is missing from
  this section, the capture is unsafe.** That's a P0 — file a heuristic
  bug, discard this capture, do not generate automation.

### Selector confidence warnings

- Any entry here is a selector the runner cannot trust. For a production
  flow this section should ideally be empty; in practice DistroKid uses
  React-generated IDs so expect several `low` confidence selectors.

### Suggested assertions / checkpoints

- `manual-action-presence` should include every dangerous button.
- `required-field-value` should match every field DistroKid marked
  required.
- `page-title-match` is the weakest signal on an SPA — don't rely on it.

## Pass / fail criteria

**Pass — the capture is reviewable.** All of:

- Preview renders without error.
- Every stage you walked appears either as a page or as a snapshot.
- Every dangerous button you saw is in `manualOnlyActions`.
- Both track instances cluster into a single tracks repeat group with two
  structured `instances`.
- Cover art + both track audio files appear as file-input assets with
  `<file: ...>` placeholders — **no absolute path strings anywhere**.
- No event in the log carries an absolute filesystem path (the
  `acceptance-observation-evidence-capture` test enforces this for synthetic
  inputs; visually scan the real capture too).

**Fail — discard and re-capture.** Any of:

- A real submit/publish/pay button you actually saw on screen is missing
  from `manualOnlyActions`.
- A field that was clearly required came through with `required: false`.
- The visible-text summary for a stage doesn't match the page you were
  looking at (capture missed a state transition).
- The preview shows screenshots/DOM evidence as "not captured" for every
  page (env flags / file-system permissions issue — fix and re-run).
- The event log contains any absolute path string.

## P0 conditions (stop everything)

These are bugs serious enough that the **next** action is filing a fix,
not re-trying:

1. `isHardDangerous` missed a label that genuinely commits irreversible
   action on DistroKid. The heuristic must be tightened **before** another
   capture.
2. Browsy clicked something on DistroKid. (It is not supposed to — the
   capture pipeline only listens. If a click event has `source !=
   'user'` evidence, that's a bug.)
3. A credential string appeared anywhere in the captured event log.
4. An absolute filesystem path appeared anywhere in the captured event log
   or the rendered preview.
5. The wizard wrote anything outside `output/` or `workflows/` while
   capturing.

For any of the above: file a bug, discard the capture, do **not** proceed
to automation generation.

## What you do AFTER the dry run

This document does not authorize automation generation from the dry-run
capture. The user-facing flow after this is:

1. Stop the wizard. Close the Chromium window.
2. Move `/tmp/distrokid-dry-run-events.json` and the preview markdown
   somewhere you can read offline.
3. Walk through the preview against your memory of the flow.
4. **Sleep on it** — re-read the next day. Selector confidence and
   missing snapshots are easier to spot with rested eyes.
5. Decide one of three next moves:
   - **Proceed to automation generation** — only if every Pass criterion
     above is met *and* the preview matches your memory of the flow.
     Generation must happen in a fresh session, against the exported
     JSON, never against DistroKid live.
   - **Improve capture heuristics** — if false positives / false negatives
     showed up. Sprint 5 work, not dry-run work.
   - **Add Appshots / Atlas visual enrichment** — if selectors are too
     unstable to trust and you need a model pass over the screenshots to
     interpret them.

## Reproduction notes

The acceptance suite gating this work:

```bash
npm run acceptance:observation-evidence-capture    # the new evidence-capture surface
npm run acceptance:observation-workflow-preview    # the existing handoff hardening
npm run acceptance:observation-real-world          # the existing event-conversion bar
npm test                                            # everything together
```

Related documents:

- [observation-real-world-readiness.md](observation-real-world-readiness.md)
  — gap analysis + safety boundary rationale
- [observation-hardening-report.md](observation-hardening-report.md)
  — prior-sprint heuristic + dedupe work
- [observation-manual-test.md](observation-manual-test.md)
  — the same procedure against the local fixture (test before doing the real thing)
