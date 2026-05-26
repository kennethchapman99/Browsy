# Real Playwright Capture — Test Report

**Date:** 2026-05-25
**Branch:** `feat/observation-ingestion`
**Test:** `scripts/acceptance-observation-playwright.mjs` (`npm run acceptance:observation-playwright`)
**Status:** 22 / 22 PASS

## Summary

The Browsy Step 4 capture pipeline now opens a real Playwright Chromium and
records DOM events. Counters and stats are derived from the canonical event
model in [src/core/observation-events.mjs](../src/core/observation-events.mjs) — no random data,
no timer-based simulation, no fabricated state.

## What the test actually captured

The acceptance test drove a real Playwright browser via CDP and observed
21 canonical events for the session. Stats derived from those events:

```
{ pages: 2, fields: 6, buttons: 4, repeatGroups: 2, outputs: 0, dangerous: 4, checkpoints: 0 }
```

### Sequence captured (in order)

1. `session_started` (`source: playwrightRecorder`)
2. `capture_source_selected` (`captureSource: playwrightRecorder`)
3. `page_seen` for `http://localhost:3333/fixtures/observation-test-form/page-1.html`
4. `field_detected` — `<input type="file">` at `#cover-art` (initial scan)
5. `dangerous_action_candidate_detected` — `"Submit Release"`, keyword `Submit`
6. `repeat_group_candidate_detected` — `"+ Add another track"`, keyword `Add another`
7. `field_detected` — `#title` value `"My Test Release"` (user_interaction)
8. `field_detected` — `#category` value `"music"` (user_interaction)
9. `field_detected` — `#notify` value `true` (user_interaction)
10. `action_detected` — Add-track button click at `#btn-add-track`
11. `repeat_group_candidate_detected` — same button (click trigger)
12. `action_detected` — Submit-release button click at `#btn-submit-release`
13. `dangerous_action_candidate_detected` — same button (click trigger)
14. `action_detected` — form submit event (`<form id="release-form">`)
15. `dangerous_action_candidate_detected` — form submit
16. `action_detected` — Next-link click
17. `page_seen` for `.../page-2.html` (real navigation)
18. `session_finished` on stop

## How real capture is wired

* **Server endpoint** `POST /api/observation/session/start` launches Chromium
  via `playwright.chromium.launch`, exposes `window.__browsyEmit` on the page,
  injects a DOM-listener script via `page.addInitScript`, and navigates to
  the user's `startUrl`.
* **Listeners** fire on `input`, `change`, `click`, `submit`, and Playwright's
  `framenavigated`. Each event is normalized via `createEvent()` and
  validated against `validateEvent()` before being appended to the session.
* **Stats** are derived from the captured event list via
  `deriveStatsFromEvents()` — both in the server response and (mirrored) in the
  wizard UI. There is no separate counter state to fall out of sync.
* **`POST /api/observation/session/:id/stop`** closes the browser cleanly
  and appends `session_finished`.

## Demo / mock quarantine

`startObsSimulation()` is gone. Mock mode no longer auto-increments counters:
the acceptance test verifies that, 3 seconds after starting a mock session,
the only events present are `session_started` and `capture_source_selected`.
Demo/mock is selectable as a dev path; the card now reads "Demo mode — no
real website is being observed", the default selected card is Playwright
Recorder, and the start-URL field is required before a real session begins.

## Suite-level results

```
Song-flow acceptance:                   23 passed, 0 failed
Repeat-group acceptance:                25 passed, 0 failed
Run-plan acceptance:                    40 passed, 0 failed
Playwright executor acceptance:         26 passed, 0 failed
Automation package acceptance:          36 passed, 0 failed
Generic repeat package acceptance:      33 passed, 0 failed
DistroKid album example acceptance:     31 passed, 0 failed
Wizard package generation acceptance:   30 passed, 0 failed
Friendly-label wizard acceptance:       29 passed, 0 failed
DistroKid album-upload wizard:          60 passed, 0 failed
Project lifecycle acceptance:           passed
Runtime variables acceptance:           passed
Observation ingestion acceptance:       passed
Field-map LLM acceptance:               passed
Observation UI acceptance:              62 passed, 0 failed
Observation Playwright acceptance:      22 passed, 0 failed
```

`npm test` exits 0.
