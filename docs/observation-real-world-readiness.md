# Observation real-world capture readiness

Honest assessment of whether the Browsy Playwright observation bridge is
ready for a controlled DistroKid (or DistroKid-style) dry run, grounded in
the captured event log at
[docs/fixtures/observation-realistic-upload-events.json](fixtures/observation-realistic-upload-events.json)
and the captured workflow preview at
[docs/fixtures/observation-realistic-upload-preview.md](fixtures/observation-realistic-upload-preview.md).

**Date:** 2026-05-25 (Sprint 4 — capture-side evidence; previously Sprint 3
landed observation → automation handoff hardening).
**Branch:** `feat/observation-ingestion`.
**Capture source:** `playwrightRecorder` against
[`fixtures/observation-realistic-upload/release.html`](../fixtures/observation-realistic-upload/release.html).
**Tests covering this assessment:**
- `npm run acceptance:observation-real-world` (12 checks, 0 fail)
- `npm run acceptance:observation-workflow-preview` (19 checks, 0 fail —
  Sprint 3, covers dedupe / heuristics / repeat-group instances /
  assertions / evidence shape / preview rendering)
- `npm run acceptance:observation-evidence-capture` (10 checks, 0 fail —
  **new this sprint**, covers page_snapshot_captured ingestion, multiple
  snapshots per page, partial evidence, dangerous-heuristic survival,
  path-leak guard, preview evidence sections, opt-out env flags).

## TL;DR — is this ready for a controlled DistroKid dry run?

**Yes — recommended now.** Run the procedure in
[distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md). The
capture pipeline now emits per-state evidence (screenshot + DOM snapshot +
visible text summary) at session start, on every navigation, after every
click, and after every repeat-group add. The human-readable preview shows
that evidence per page, alongside the existing field / repeat-group /
manual-action / assertion sections.

The capture is still **not** ready for unattended replay. The dry run is
a one-way trip: human drives, Browsy listens, stop before any irreversible
button. Do not generate or run automation from the dry-run capture in the
same session.

Sprint 3 landed the post-processing slice (dedupe, tightened heuristics,
repeat-group instance modeling, suggested assertions, preview render).
Sprint 4 (this slice) is the capture-side companion: every detected state
now has visual evidence attached, so the reviewer can verify a stage looked
right rather than only that the events looked right. See
[#exact-human-safety-boundary-for-a-controlled-distrokid-dry-run](#exact-human-safety-boundary-for-a-controlled-distrokid-dry-run)
below for the rules.

The bridge correctly captures the **shape** of a DistroKid-like flow from a
single-page fixture: required text fields, an email field, a select, file
inputs for cover art and audio, a repeated track group with add-another
semantics, mixed required/optional confirmation checkboxes, and a clearly
labelled "Submit & Publish Release" dangerous action.

What changed this sprint (the handoff is now defensible):

1. **Deterministic event dedupe.** The raw 38-event golden collapses to
   26 deduped events: 9 redundant input/change pairs dropped, 2 redundant
   repeat-group candidates, 1 redundant dangerous-action candidate. Raw
   audit trail preserved on `obs.sessionEvents`; cleaned view exposed on
   `obs.dedupedSessionEvents` and `obs.noiseReduction`.
2. **Tightened heuristics.** "Next: add tracks →" no longer becomes a
   repeat group; "Review release →" no longer becomes a dangerous action;
   "Submit & Publish Release" still does. Verbs (`submit`, `publish`,
   `delete`, `pay`, `purchase`, `charge`, `finalize`, `irreversible`,
   …) drive dangerous detection. Repeat-group detection requires either
   a `+` marker or an `add another / more / row / track / entry / line /
   field / speaker / guest / file` verb form — bare "Add" or "Add to cart"
   no longer triggers.
3. **Repeat-group instance modeling.** `track_*_<n>` fields cluster into
   structured `instances`, each with its own `fields[]` and `assets[]` —
   the realistic fixture surfaces a `tracks` group with `Instance 1 →
   track_title_1, track_isrc_1, track_audio_1` and `Instance 2 → …_2`.
4. **Suggested assertions.** `obs.suggestedAssertions` now lists manual-
   action-presence (one per dangerous button), required-field-value (one
   per required input), page-title-match (one per `page_seen`), and
   output-candidate (one per `output_candidate_detected` event when the
   capture pipeline emits them).
5. **Evidence metadata.** Every page state carries an
   `evidence: { screenshotsAvailable, screenshots, reason }` field. The
   capture pipeline does not yet emit `page_snapshot_captured` events with
   `screenshotPath`, so today every page is explicitly marked
   `screenshotsAvailable: false` with the reason quoted. The shape is wired
   end-to-end and will flip to `true` the moment screenshots land.
6. **Human-readable preview.** The full observation now renders to
   markdown via `renderObservationPreview()` and is committed to
   [docs/fixtures/observation-realistic-upload-preview.md](fixtures/observation-realistic-upload-preview.md)
   for review. A non-engineer can scan it and verify the captured workflow
   matches reality before any automation is generated.

The **capture pipeline itself** still has these gaps — they're upstream of
the handoff and remain blocking for **unattended** DistroKid automation but
not for the controlled dry run defined below:

1. **No auth / login story** in the observation surface — the user has to
   log in manually inside the Playwright window, with no persistence between
   sessions. (Most DistroKid workflows start authenticated.)
2. **SPA navigation isn't tracked** — `page_seen` only fires on
   `framenavigated`. Multi-stage flows that swap visible sections via
   `history.pushState` (which DistroKid's upload flow does) collapse into a
   single page in the captured log — exactly the behaviour we see in the
   golden, which has 1 `page_seen` for a 3-stage flow. **Partially mitigated
   in Sprint 4**: every click / add-instance now emits a
   `page_snapshot_captured` event with a visible-text summary, so even when
   `page_seen` misses an SPA route change, the reviewer can see the state
   shift via the per-snapshot text summaries.
3. **Selectors stop at `#id` / `[name]`** in the live capture today on
   sites that don't expose either — the realistic fixture happens to use
   semantic ids everywhere; DistroKid does not.
4. ~~No screenshot / DOM snapshot at each detected event~~ **— done in
   Sprint 4.** The Playwright recorder now captures a screenshot + DOM
   snapshot + visible-text summary at session start, on `framenavigated`,
   after every `action_detected` click, and after every
   `repeat_group_candidate_detected` add-instance click. Files are written
   under `output/observations/_sessions/<sessionId>/{screenshots,dom}/`
   (gitignored). The `page_snapshot_captured` event carries repo-relative
   paths so the golden / event log never leaks absolute paths. Screenshots
   and DOM snapshots are independently opt-out-able via
   `BROWSY_OBS_CAPTURE_SCREENSHOTS=0` and `BROWSY_OBS_CAPTURE_DOM=0` so
   headless tests stay stable.
5. **No output_candidate_detected events** — the structural support for
   output assertions is in place, but the in-page listener does not
   currently mutation-observe for confirmation banners / IDs / URLs. Still
   open after Sprint 4 — needed before unattended replay can verify
   captured outputs.

## What the current event model captures *well*

Quoting from the golden event log (38 events captured):

### Fields

- Required text inputs: `release_title`, `primary_artist`, `release_date` —
  all surface with `inputType: text`, `value: <user text>`, and
  `required: true`.
- Email type detected as `inputType: email` (the listener trusts the DOM
  type attribute, not the label).
- `<select>` captured with `inputType: select-one` and the chosen value
  (`"electronic"`) — usable directly as field-map data.
- File inputs detected on **initial scan**, before any user interaction —
  `#cover-art` and `#track-audio-1` are both visible in the events at
  timestamps +3 and +4. The `accept="image/png,image/jpeg"` attribute is
  now propagated to `rawEvidence.accept` (added in this branch).
- File-input *intent* is preserved without leaking local paths — the
  captured value is `<file: cover.png>` (the *filename*, no directory
  component). The acceptance test
  ([scripts/acceptance-observation-real-world.mjs](../scripts/acceptance-observation-real-world.mjs)
  check 7) walks the entire event tree to confirm no absolute path leaks.

### Repeat groups

- `+ Add another track` flagged as `repeat_group_candidate_detected` on
  **initial scan** *and* again when clicked — duplicated, but never missed.

### Dangerous actions

- `Submit & Publish Release` flagged as
  `dangerous_action_candidate_detected` on initial scan, with the matched
  keyword `Submit`. The user never had to click it (and in the capture
  script, deliberately did not — preserving the "no irreversible action"
  rule).

### Selector candidates (new in this branch)

Every field/action event now carries a ranked
`rawEvidence.selectorCandidates` array:

```json
"selectorCandidates": [
  { "selector": "#release-title",                "kind": "id",          "confidence": "high"   },
  { "selector": "input[name=\"release_title\"]", "kind": "name",        "confidence": "medium" },
  { "selector": "label:has-text(\"Release title*\")", "kind": "label-text", "confidence": "medium" },
  { "selector": "input:nth-of-type(1)",          "kind": "nth-of-type", "confidence": "low"    },
  { "selector": "input",                         "kind": "tag",         "confidence": "low"    }
]
```

The top selector is also surfaced as `rawEvidence.selectorConfidence` so a
downstream consumer can quickly bucket evidence quality without parsing the
chain. `data-testid` / `data-cy` / `aria-label` / `role` all bump candidates
to the top with `high` / `medium` ratings before the structural fallbacks
kick in.

### Stats

`deriveStatsFromEvents` returns `{ pages: 1, fields: 25, buttons: 3,
repeatGroups: 4, outputs: 0, dangerous: 3, checkpoints: 0 }` on the golden.
The `fields: 25` is inflated by duplicates (see "noise" below) but is
correctly de-duplicated to 14 distinct fields by
`buildObservationFromEvents()` (11 global + 3 assets).

## Before / after noise reduction (this sprint)

Golden raw event log: **38 events**. After
`normalizeAndDedupeEvents()`: **26 events**. Breakdown of the 12 dropped:

| Drop type | Count | Why |
|---|---|---|
| Redundant `field_detected` pairs | 9 | Both `input` and `change` DOM listeners fire for every text field; the second event in each pair has identical `rawEvidence`. |
| Redundant `repeat_group_candidate_detected` | 2 | Initial-scan emission + click-time emission for the same button (e.g. `+ Add another track`). |
| Redundant `dangerous_action_candidate_detected` | 1 | Same initial-scan + click overlap for `Review release →`. |

Repeat-group surface count: **2 candidates in raw → 1 in observation**
(false-positive `Next: add tracks →` dropped by the tightened heuristic).

Dangerous-action surface count: **2 candidates in raw → 1 in observation**
(false-positive `Review release →` dropped).

## What is still noisy or open

Issues that survive this sprint and need separate slices:

1. **Generic checkbox labels.** `chk-rights` and `chk-terms` come through
   labelled by their `name` attribute (`confirm_rights`, `confirm_terms`)
   because the fixture wraps the input with `<label>` rather than using
   `for=`/`id`. The `labelFor()` helper only walks `label[for=id]`; on
   sites that wrap inputs in labels (which is common), we lose the human
   text. **Fix: also walk `el.closest('label')`** — a 3-line change in
   the in-page script, not done in this sprint to keep the slice tight.

2. **Initial scan misses text/email/date inputs.** The in-page
   `initialScan()` only emits `field_detected` for `input[type="file"]`;
   text fields surface only after the user interacts with them. Required
   metadata fields exist on the page but go uncaptured if the user
   skips them. Plan in Slice C below.

3. **No SPA navigation events.** `history.pushState` doesn't fire
   `framenavigated`, so the realistic fixture's three visible stages
   collapse to one `page_seen` event. The instance modeling masks this
   on the field side (track 1 vs. track 2 are correctly clustered), but
   the *page* count is wrong. Plan in Slice C.

4. **No output candidates yet in capture.** The structural support is in
   place (`suggestedAssertions` of kind `output-candidate`) but the
   in-page listener does not emit `output_candidate_detected` events.
   For the realistic fixture this means the suggested-assertions list
   contains presence + value assertions but no real captured-output
   gates. Plan in Slice C.

## What is missing for DistroKid-style automation

The list below is what we'd need to fix BEFORE pointing the bridge at
distrokid.com (or any production SaaS) and trusting the output:

1. **Shadow DOM / iframe penetration.** `document.querySelectorAll(...)`
   inside the init script does not pierce closed shadow roots, and
   `addInitScript` does not always propagate `__browsyEmit` into
   cross-origin iframes. DistroKid uses Stripe for payment (iframe) and
   has multiple internal embeds. **Severity: blocking** for end-to-end
   capture; the dangerous-action gating sits in front of the irreversible
   step, so partial visibility is survivable for *capture*, less so for
   *replay*.

2. **SPA route changes.** `framenavigated` doesn't fire for
   `history.pushState`. We need a `MutationObserver` on `document.title`
   *and* a `popstate` / `pushstate` shim to emit a synthetic `page_seen`.

3. **Auth wall.** First observation lands the user on a login form. The
   bridge has no `storageState` save / restore; every session begins
   unauthenticated. We should at least *prompt* the user to log in
   manually before the recorder begins emitting field events (currently it
   starts emitting on `DOMContentLoaded` of the login page itself —
   harmless but noisy).

4. **Output candidates.** Once the user submits something, there is
   typically an ID / confirmation number / "your release is at https://…"
   URL. Today the pipeline emits zero `output_candidate_detected` events.
   **Without these, captured workflows can't generate gates** (the safety
   contract in `AGENTS.md` requires gates to verify against captured
   outputs).

5. **Screenshot evidence per page_seen / dangerous-action.** Capture is
   blind today — re-driving a workflow tomorrow has no visual reference.
   For a real DistroKid dry run, screenshots at every observed page state
   are how we'd prove fidelity.

6. **Repeat-group instance grouping.** As noted in "noisy" #6: the
   captured events don't say "fields 23–26 form one instance of the same
   group". The wizard's downstream code re-derives this from naming
   conventions (`track_title_<n>`), which works for our fixture but is
   fragile in the wild.

7. **HTML / accessibility-tree snapshot.** Even one `page_snapshot_captured`
   event per page would let us audit what the recorder *should* have seen
   and didn't.

8. **Required-flag fidelity in initial scan.** The new `required: !!el.required`
   field is propagated for live `field_detected` events but not for the
   initial-scan file-input event path (the scan branch reads `name`/`id`/
   `label` but not `required`). This branch already adds `required` to the
   initial scan; once we extend `initialScan` to *also* enumerate text /
   email / date inputs (not just file inputs), every field's required-flag
   will be visible without the user having to type into it. Small slice
   but high value — would catch DistroKid's required fields even when the
   user just visits the page.

## Should Appshots / Atlas observation supplement DOM events?

**Yes — for two specific reasons, but not as the primary surface.**

1. **Visual fidelity (Appshots).** A screenshot at each detected page state
   is the cheapest way to convert "I captured 38 events" into "I captured
   38 events *and here's what I was looking at when each one fired*". This
   should land regardless of the rest of the work — every captured workflow
   without screenshots is unverifiable.

2. **Semantic interpretation (Atlas / Codex-assisted).** Heuristics like
   ADD_RX / DANGEROUS_RX produce the false positives noted above. A model
   pass over the captured events + screenshots can:
   - re-label "Review release →" as navigation, not dangerous;
   - re-label "Next: add tracks →" as a stage advance, not a repeat-group
     trigger;
   - infer the difference between a per-item field and a global field;
   - propose stable selector picks when the DOM hands us only generated
     IDs.

The Atlas surface should **enrich** the canonical event log, not replace
it. Today the bridge produces the raw signal; Atlas/Codex can write
annotations alongside without re-doing the capture.

**Not as the primary surface** because:
- Atlas observation is human-in-the-loop — slow, expensive, and won't
  scale to "user opens browser, walks the workflow once".
- The Playwright bridge already produces 90% of the structure for free.

## Slice B+ — done in Sprint 3 (2026-05-25)

Implemented in `src/core/observation-from-events.mjs` +
`src/core/observation-preview.mjs`:

- [x] Heuristic tightening (`isHardDangerous`, `isLikelyAddInstanceAction`)
- [x] Event dedupe (`normalizeAndDedupeEvents`)
- [x] Repeat-group instance modeling (`inferRepeatGroupInstances`)
- [x] Suggested assertion candidates (manual-action-presence,
  required-field-value, page-title-match, output-candidate)
- [x] Evidence metadata on pages (wired end-to-end; flips to available the
  moment a `page_snapshot_captured` event with `screenshotPath` arrives)
- [x] Human-readable markdown preview written to
  [docs/fixtures/observation-realistic-upload-preview.md](fixtures/observation-realistic-upload-preview.md)
- [x] New 19-check acceptance suite
  (`acceptance:observation-workflow-preview`)

## Slice C — done in Sprint 4 (2026-05-25): capture-side evidence

Implemented in `src/adapters/observation/visual-evidence-adapter.mjs` +
`wizard/server.mjs` + `src/core/observation-from-events.mjs` +
`src/core/observation-preview.mjs`:

- [x] `captureVisualEvidence({ page, sessionId, repoRoot, kind, hint, index })`
  adapter — local Playwright implementation now, with the seam reserved for
  Appshots / Atlas later.
- [x] `page_snapshot_captured` events emitted at:
  - session start (initial page load, after a 400ms settle for the in-page
    initial scan to flush)
  - every `framenavigated` (multi-page navigation)
  - every `action_detected` click (`kind: 'click_after'`, label-based hint)
  - every `repeat_group_candidate_detected` click that isn't from the
    initial scan (`kind: 'add_instance'`)
- [x] Each event carries `rawEvidence` with: `kind`, `hint`, `url`,
  `title`, `visibleTextSummary` (≤ 600 chars, one line), `viewport`,
  `screenshotPath` (repo-relative), `domSnapshotPath` (repo-relative),
  `capturedAt`, optional `error` / `screenshotError` / `domSnapshotError`.
- [x] Files written under `output/observations/_sessions/<sessionId>/`
  (gitignored). Screenshots are PNG, viewport (not full-page) by default.
  DOM snapshots are the result of `page.content()`.
- [x] Per-session serialized snapshot chain — multiple actions in flight
  produce deterministically-ordered `page_snapshot_captured` events
  regardless of screenshot wall-clock time.
- [x] Drains pending captures on `stopPlaywrightSession()` before closing
  the page so the event log is complete.
- [x] `BROWSY_OBS_CAPTURE_SCREENSHOTS=0` and `BROWSY_OBS_CAPTURE_DOM=0` env
  toggles — headless acceptance runs keep clean by disabling both.
- [x] `evidenceForPage()` expanded — surfaces `screenshotsAvailable`,
  `domSnapshotsAvailable`, `visibleTextAvailable`, plus the full
  `snapshots[]` array. Backward-compatible `screenshots[]` (the subset
  that carries a real path) is preserved for the prior callers.
- [x] Dedupe rule split — `page_seen` still de-dupes by URL, but
  `page_snapshot_captured` events are never de-duped (a state can have
  multiple legitimate snapshots: session_start / click_after / add_instance).
- [x] `renderObservationPreview()` shows per-page Evidence subsection with
  screenshot path / DOM path / visible-text summary / viewport, or
  explicit "not captured" placeholders when missing.
- [x] New 10-check acceptance suite
  (`acceptance:observation-evidence-capture`).
- [x] [distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md) —
  exact operator checklist for the real-site dry run.

## Slice D — recommended next (still capture-pipeline side)

What's left before unattended replay becomes safe:

1. **Output candidate detection.** Add a `MutationObserver` after each
   click that emits `output_candidate_detected` for newly-appeared text
   matching common ID / URL / confirmation-number patterns
   (`UPC: \d{12}`, `ISRC: ...`, `https://distrokid\.com/release/...`).
   `suggestedAssertions` already consumes this event type.
2. **Initial-scan widening.** Extend `initialScan` to enumerate *all*
   inputs (text/email/date/checkbox/radio), not just files. Drops the
   "user has to type to be seen" gap.
3. **SPA navigation shim.** Patch `history.pushState` / `replaceState`
   to emit a synthetic `page_seen` when the URL or visible-stage
   changes. The Sprint 4 snapshot capture partially papers over this on
   the *evidence* side, but page-level structure still collapses.
4. **Wrapping-label fix.** In `labelFor`, walk `el.closest('label')`
   if `label[for=id]` doesn't match. Fixes the `confirm_rights`
   label loss.
5. **Persisted manual annotations.** POST `markRepeatGroup` /
   `markDangerous` / `saveObsNote` results to
   `/api/observation/events` so the 1.5s server poll stops wiping
   them.
6. **Atlas / Appshots enrichment pass.** Use the screenshots captured in
   Slice C as input to a model-driven labeller that re-classifies
   ambiguous buttons and proposes stable selectors when DistroKid only
   emits generated IDs.

## Exact human safety boundary for a controlled DistroKid dry run

A controlled dry run is permissible **today** under these conditions —
every one is non-negotiable.

| # | Boundary | Rationale |
|---|----------|-----------|
| 1 | **The human drives.** Playwright Recorder captures; nothing in Browsy clicks any DistroKid button automatically during the dry run. | The current selector capture is good against the realistic fixture but unverified against DistroKid's React-generated IDs. |
| 2 | **Login happens manually inside the Playwright window.** No credentials are passed via Browsy. Auth state is not persisted between sessions. | The capture pipeline has no auth story (see "still noisy or open" #3 above). |
| 3 | **The human stops before any button whose label matches `isHardDangerous`.** For DistroKid this means: never click "Submit", "Publish", "Pay", "Confirm Final", or any button on the final review page. | Heuristic is tight enough now to catch these; runner still has zero authority to click them. |
| 4 | **Verify the captured-workflow preview before any automation is generated.** Open `docs/fixtures/observation-realistic-upload-preview.md`-style preview for the new capture and sanity-check fields, repeat-group instances, and dangerous-action labels. | The preview is now the trust gate — it's the only way a non-engineer can verify the capture matches reality. |
| 5 | **No automation is generated from the dry-run capture in the same session.** The captured artifacts are reviewed offline; if the preview is wrong, the capture is discarded and re-run. | Belt-and-suspenders against the "we captured something noisy and immediately turned it into a runnable workflow" failure mode. |
| 6 | **The capture must be reproducible.** A second dry run on the same flow should produce a preview that diffs cleanly against the first — meaningful changes only, no event-order noise. | Validates that dedupe + heuristics produced a stable observation, not a snapshot of timing artifacts. |
| 7 | **Anything labeled "release" / "publish" / "submit" on DistroKid that the heuristic *fails* to flag must be reported.** If the dry-run capture contains a real dangerous button that did not become a `manualOnlyAction`, the heuristic is broken — stop and fix before retrying. | Failures of `isHardDangerous` against a real site are the highest-severity bug class for this pipeline; treat them as P0. |

Anything beyond this boundary (auto-fill, auto-click, auto-publish,
running an automation generated from a dry-run capture without offline
review) **requires Slice D to land first** — specifically, output
candidate detection, SPA navigation tracking, and an Atlas/Appshots pass
over captured screenshots.

The exact operator checklist for running the dry run is in
[distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md).

## Reproduction

```bash
# Re-capture the golden event log from the realistic fixture (screenshots
# and DOM snapshots disabled, so the golden stays git-stable)
BROWSY_OBS_CAPTURE_SCREENSHOTS=0 BROWSY_OBS_CAPTURE_DOM=0 \
  node scripts/capture-observation-realistic-upload.mjs

# Validate that the conversion still produces the expected observation
npm run acceptance:observation-real-world

# Validate Sprint 3's hardening (dedupe, heuristics, instances,
# assertions, evidence shape, preview) and refresh the markdown preview
npm run acceptance:observation-workflow-preview

# Validate Sprint 4's capture-side evidence surface
npm run acceptance:observation-evidence-capture

# Full hardening + Playwright + UI suite
npm run acceptance:observation-playwright
npm run acceptance:observation-hardening
npm run acceptance:observation-ui

# Everything
npm test
```

## Related documents

- [distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md) —
  **new this sprint**, operator checklist for the real-site dry run.
- [observation-manual-test.md](observation-manual-test.md) — exact manual
  procedure for verifying the bridge against the test-form fixture.
- [observation-hardening-report.md](observation-hardening-report.md) —
  prior-sprint gap analysis (the baseline this report builds on).
- [observation-playwright-test-report.md](observation-playwright-test-report.md)
  — full Playwright acceptance run report.
- [atlas-codex-observation.md](atlas-codex-observation.md) — long-term
  observation pipeline plan.
