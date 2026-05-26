# Captured Workflow Preview: observation-realistic-upload

> A non-engineer should be able to read this preview and confirm "yes,
> that matches the workflow I just walked through". If anything below
> looks wrong, the captured observation is wrong — fix it before
> generating automation.

- **Capture source:** Playwright Recorder — local automation-grade capture
- **Workflow ID:** `observation-realistic-upload`
- **Captured at:** 2026-05-25T00:00:00.000Z
- **Start URL:** /fixtures/observation-realistic-upload/release.html
- **Mode:** session

## Pages / states observed

- **page_1** — /fixtures/observation-realistic-upload/release.html
  - URL: `/fixtures/observation-realistic-upload/release.html`
  - Evidence: _none captured_ — capture pipeline did not emit a page_snapshot_captured event for this page
    - Screenshot: not captured
    - DOM snapshot: not captured
    - Visible text summary: not captured

## Fields detected

### Global fields (11)

- `release_title` — Release title* (text, required) — selector: `#release-title` _(high confidence)_
- `primary_artist` — Primary artist* (text, required) — selector: `#primary-artist` _(high confidence)_
- `release_date` — Release date* (text, required) — selector: `#release-date` _(high confidence)_
- `genre` — Genre (select-one) — selector: `#genre` _(high confidence)_
- `label_email` — Label contact email (email) — selector: `#label-email` _(high confidence)_
- `track_title_1` — Track 1 title (text, required) — selector: `#track-title-1` _(high confidence)_
- `track_isrc_1` — ISRC (text) — selector: `#track-isrc-1` _(high confidence)_
- `track_title_2` — Track 2 title (text) — selector: `#track-title-2` _(high confidence)_
- `track_isrc_2` — ISRC (text) — selector: `#track-isrc-2` _(high confidence)_
- `confirm_rights` — confirm_rights (checkbox, required) — selector: `#chk-rights` _(high confidence)_
- `confirm_terms` — confirm_terms (checkbox, required) — selector: `#chk-terms` _(high confidence)_

### Global assets (file inputs) (3)

- `cover_art` — Cover image (JPG / PNG, ≥ 3000×3000)* (file, required) — selector: `#cover-art` _(high confidence)_
- `track_audio_1` — Audio file (file, required) — selector: `#track-audio-1` _(high confidence)_
- `track_audio_2` — Audio file (file) — selector: `#track-audio-2` _(high confidence)_

## Repeat groups (1)

### + Add another track

- ID: `group_1`
- Item label: `track`
- Add button selector: `#btn-add-track` _(high confidence)_
- Detected by: `repeat_group_candidate_detected` (heuristic confidence 0.80)
- Field stems: `track_audio`, `track_isrc`, `track_title`
- Instances captured: **2**
  - **Instance 1** — fields: `track_title_1`, `track_isrc_1`; assets: `track_audio_1`
  - **Instance 2** — fields: `track_title_2`, `track_isrc_2`; assets: `track_audio_2`

## Manual-only / dangerous actions (1)

> These MUST stay manual. The runner stops here for human review.

- ⚠ **Submit & Publish Release** — selector: `#btn-publish-release` _(high confidence)_
  - Reason: matches strict dangerous-verb heuristic
  - Matched keyword: `Submit`
  - Detected by: `dangerous_action_candidate_detected` (heuristic confidence 0.85)

## Suggested assertions / checkpoints (10)

> These are *not* automation steps. They are things the runner should
> verify before / after, and that a human reviewer should sanity-check.

### manual-action-presence

- Before any manual click, verify "Submit & Publish Release" is present — selector `#btn-publish-release` _(high)_ _(confidence 0.90)_

### page-title-match

- On URL "/fixtures/observation-realistic-upload/release.html", expect title "/fixtures/observation-realistic-upload/release.html" _(confidence 0.60)_

### required-field-value

- Required field "Release title*" must hold the expected value before progressing — selector `#release-title` _(high)_ _(confidence 0.75)_
- Required field "Primary artist*" must hold the expected value before progressing — selector `#primary-artist` _(high)_ _(confidence 0.75)_
- Required field "Release date*" must hold the expected value before progressing — selector `#release-date` _(high)_ _(confidence 0.75)_
- Required field "Track 1 title" must hold the expected value before progressing — selector `#track-title-1` _(high)_ _(confidence 0.75)_
- Required field "confirm_rights" must hold the expected value before progressing — selector `#chk-rights` _(high)_ _(confidence 0.75)_
- Required field "confirm_terms" must hold the expected value before progressing — selector `#chk-terms` _(high)_ _(confidence 0.75)_
- Required field "Cover image (JPG / PNG, ≥ 3000×3000)*" must hold the expected value before progressing — selector `#cover-art` _(high)_ _(confidence 0.75)_
- Required field "Audio file" must hold the expected value before progressing — selector `#track-audio-1` _(high)_ _(confidence 0.75)_

## Selector confidence warnings (0)

_No low-confidence selectors detected. Selectors look stable enough to drive automation against this fixture._

## Event noise reduction

- Raw events: **38**
- After dedupe: **26**
- Dropped overall: 12
- Dropped field_detected pairs: 9
- Dropped redundant repeat-group candidates: 2
- Dropped redundant dangerous-action candidates: 1

