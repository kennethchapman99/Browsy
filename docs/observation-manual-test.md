# Manual test — Browser Observation (Playwright capture)

This is the exact step-by-step procedure for verifying that **real Playwright
capture** works end-to-end, by hand, using the bundled local fixture.

It exercises the same code path the acceptance suite covers
([scripts/acceptance-observation-playwright.mjs](../scripts/acceptance-observation-playwright.mjs)),
but with a human driving so you can see the visible browser open, watch events
flow into the wizard, and inspect the generated workflow files.

If anything below does not work as described, the capture bridge is broken —
file a bug.

## Prerequisites

- Node 22+
- Playwright installed (already a dep — `npm install` is enough)
- A free port `3333` (the wizard's default)
- A browser to open the wizard in (Chrome recommended for voice features)

## 1 — Start the wizard server

In a terminal at the repo root:

```bash
npm run wizard
```

You should see:

```
  Browsy Wizard
  http://localhost:3333

  Open the URL above in Chrome for best voice support.
  Ctrl+C to stop.
```

Leave this terminal running. All subsequent steps assume the server is up.

> **Note on visibility.** The Playwright browser that the server launches for an
> observation session opens **visibly** by default. Headless mode is only used
> when the env var `BROWSY_OBS_HEADLESS=1` is set (the acceptance test sets
> this; `npm run wizard` does not). If a browser does not pop up in step 5
> below, check that you did not export `BROWSY_OBS_HEADLESS` in your shell.

## 2 — Open the wizard and go to Step 4

In Chrome, open <http://localhost:3333>.

Click through to **Step 4 of 10 · Browser Observation** (the step is titled
"Browser Observation"). Use the sidebar or `Next`.

## 3 — Confirm Playwright Recorder is the default capture source

Under "Choose capture method", three cards are shown:

- **Chrome Extension** — disabled, "Not yet available"
- **Playwright Recorder** — selected by default, badged "Default · Real capture"
- **Demo / Mock** — labelled "Demo mode — no real website is being observed"

The status line below the cards reads:

> Connected: Playwright Recorder — local automation-grade capture

If any of the above is wrong, stop and report — Playwright must be the default.

## 4 — Enter the fixture URL

In the "Target URL" field, paste:

```
http://localhost:3333/fixtures/observation-test-form/page-1.html
```

This is a multi-page fixture served by the same wizard server. It includes
text fields, a select, a checkbox, a file input, a dynamic "Add another track"
button, a "Submit Release" button (dangerous-action keyword), and a "Next →"
link to a second page.

## 5 — Start Browser Observation

Click **▶ Start Browser Observation**.

Expected:

- The UI transitions to "Setting up observation session…" then "Recording".
- A **new Chromium window opens** (not headless) and loads page-1 of the
  fixture.
- The recording-state UI shows seven counters (Pages, Fields, Actions, Repeat
  groups, Outputs, Dangerous, Checkpoints) and a `● Recording` badge with the
  `Playwright Recorder` source badge.
- Within 1–2 seconds, the counters update from initial scan:
  - **Fields** ≥ 1 (the file input is detected)
  - **Dangerous** ≥ 1 (the "Submit Release" button)
  - **Repeat groups** ≥ 1 (the "+ Add another track" button)

## 6 — Drive the browser like a user

In the launched Chromium window:

1. Type a release title in the "Release Title" field.
2. Pick "Music" from the Category dropdown.
3. Toggle the "Send me an email…" checkbox.
4. (Optional) Use the cover-art file input to attach any local image — Browsy
   does not upload the file anywhere; the capture is purely DOM-level.
5. Click **+ Add another track** at least once.
6. Click **Submit Release** (the page intercepts it; nothing is actually
   submitted).
7. Click the **Next →** link to navigate to page-2.

As you act, in the wizard you should see the counters move:

- **Pages** rises after the Next → navigation.
- **Fields** grows with each typed/selected control.
- **Actions** grows on each click.
- **Dangerous** stays at ≥ 1 (the submit click adds another).
- **Repeat groups** stays at ≥ 1 (the add-track click adds another).

You can also use the wizard buttons to add structured annotations:

- **📝 Add note** — free-text observation note.
- **↻ Repeat group** — manual repeat-group annotation.
- **⚠ Dangerous** — manual dangerous-action annotation.

Each appears in the annotations list and increments the corresponding counter.

## 7 — Inspect raw events (optional)

In the recording panel, expand **⚙ Debug: raw observation events**. You will
see the live canonical event log for the current session (one row per
`session_started`, `page_seen`, `field_detected`, `action_detected`,
`dangerous_action_candidate_detected`, `repeat_group_candidate_detected`,
`user_marked_*`, etc).

- Click **Copy JSON** to copy the full event payload to the clipboard.
- Click **Download JSON** to save it as `observation-events-<sessionId>.json`.

Every event carries `source: "playwrightRecorder"` for a real session. There
should be **zero** events with `source: "mock"`.

Each `field_detected` / `action_detected` / dangerous / repeat event also
carries a `rawEvidence.selectorCandidates` array — a ranked fallback chain
(`[{ selector, kind, confidence: 'high' | 'medium' | 'low' }]`) plus a
top-level `rawEvidence.selectorConfidence`. The first candidate is the same
string the legacy `selector` field carries; downstream consumers can walk
the list if the top pick goes stale on a real site.

## 8 — Finish observation

Click **✓ Finish Observation**.

Expected:

- The launched Chromium window closes.
- The wizard transitions to the "Observation complete" state with a stats
  summary (e.g. *"2 pages, 4 fields, 3 actions, 1 repeat group, 2 dangerous
  actions flagged captured."*).
- The `✦ Review inferred workflow` button is enabled.

## 9 — Inspect the generated workflow

Click **✦ Review inferred workflow**. The wizard moves to the Advanced import
section pre-filled with the observation JSON it just built from the captured
event log. The Preview pane shows:

- Workflow ID, global fields, global assets, repeat groups, captured outputs,
  derived variables, checkpoints, and manual-only actions.
- Generated `workflow.json`, `workflow-package.example.json`, and `run-plan.md`
  artifacts (expand the `<details>` for each).

If you click **✦ Create workflow**, the wizard writes these into the repo
under `workflows/<workflowId>/` and `output/observations/<workflowId>/` —
verify with:

```bash
ls workflows/<your-workflowId>/
ls output/observations/<your-workflowId>/
```

## 10 — Shutdown

`Ctrl+C` in the wizard terminal. The server gracefully closes any
still-attached Playwright browsers on `SIGINT` / `SIGTERM`.

## What this manual test proves

- The wizard server actually drives a real visible browser via Playwright.
- DOM listeners injected into the page emit canonical observation events
  (`page_seen`, `field_detected`, `action_detected`,
  `dangerous_action_candidate_detected`, `repeat_group_candidate_detected`).
- Counters in the wizard derive **only** from those events — no timer / random
  data, no fake mock activity on a Playwright session.
- The finish handler closes the browser cleanly.
- The captured event log can be re-rendered as an observation JSON and turned
  into a real workflow package.

## What this manual test does NOT prove

- That it works against real third-party SaaS sites (shadow DOM, iframes,
  custom widgets, auth walls, popups, CAPTCHA) — see
  [observation-hardening-report.md](observation-hardening-report.md) for the
  honest gap analysis.
