# Observation hardening report

Honest gap analysis of the Browsy Browser Observation pipeline after Sprint 2
and the post-Sprint hardening pass.

Date: 2026-05-25.

## TL;DR

The capture bridge is now real, not simulated. The bridge has been
acceptance-tested end-to-end against a local fixture (every event type), and
the production-vs-demo boundary has been locked down. **It will still break
the first time it meets a real SaaS site.** The list at the end of this doc is
the next slice.

---

## What is now genuinely real

These are the parts that have direct, automated proof. They are not aspirational.

- **Real Playwright capture.** The wizard server launches a real Chromium
  instance via Playwright on session start; injects a DOM-listener script via
  `addInitScript`; and emits structured events for every interaction. Verified
  end-to-end in
  [scripts/acceptance-observation-playwright.mjs](../scripts/acceptance-observation-playwright.mjs)
  (22 checks).

- **Event-driven stats only.** The wizard's seven counters
  (`stat-pages`, `stat-fields`, `stat-buttons`, `stat-groups`, `stat-outputs`,
  `stat-dangerous`, `stat-checkpoints`) are derived from canonical events by
  the same function on server (`deriveStatsFromEvents`) and client
  (`deriveStatsFromObsEvents`). No path mutates counters directly. Verified in
  [scripts/acceptance-observation-hardening.mjs](../scripts/acceptance-observation-hardening.mjs)
  checks 5 and 6.

- **Visible-browser default.** `chromium.launch({ headless })` only goes
  headless when `BROWSY_OBS_HEADLESS=1`. Locked verbatim against the source —
  any refactor that flips the default will trip the hardening test
  ([acceptance-observation-hardening.mjs](../scripts/acceptance-observation-hardening.mjs)
  check 1). Manual procedure: [observation-manual-test.md](observation-manual-test.md).

- **Start-URL required for Playwright.** Both the server (`/api/observation/session/start`
  returns 400 if `startUrl` is missing for `playwrightRecorder`) and the UI
  (alert + focus the input) enforce this contract. Locked by hardening check 2.

- **Session isolation.** Restart hygiene is real: starting a second session
  after stopping the first produces a brand-new event log with a distinct
  `sessionId`, and zero events leak from the first session into the second.
  Locked by hardening check 3.

- **Multi-page navigation tracking.** `page_seen` events fire in chronological
  order across in-session navigations. Locked by hardening check 4.

- **Mock mode quarantine.** A `source: 'mock'` session never emits automatic
  timer / simulation events. Its counters only move when the user clicks
  Add note / Repeat / Dangerous manually. Verified by hardening check 7 and
  playwright check 22.

- **Raw event log inspection.** The wizard now exposes the canonical event
  list under a collapsible "Debug: raw observation events" panel with copy &
  download buttons. This is the same payload the server returns from
  `/api/observation/session/:id/events`.

- **A more realistic fixture exists.** [fixtures/observation-realistic-upload/release.html](../fixtures/observation-realistic-upload/release.html)
  models a multi-stage SaaS release upload: required text/email/date,
  required image upload, dynamic repeated track group (with delete), required
  audio uploads, mixed required/optional checkbox confirmations, derived
  review pane, and a `Submit & Publish Release` dangerous action.

---

## What is still fixture-only

These are the *parts the tests cover* — but they only prove behavior against
local HTML pages we control. There is no production data point yet.

- **DOM shape coverage.** Tests assert that `<input>`, `<select>`,
  `<textarea>`, `<button>`, `<a>`, `<form>` all emit the expected events. The
  fixture is plain HTML5 — no shadow DOM, no iframes, no Web Components, no
  React-rendered controlled inputs, no virtualization.

- **Auth.** Every test fixture is served from `localhost:3333/fixtures/...` —
  no real login, no third-party SSO, no CSRF tokens, no captcha.

- **Heuristics for dangerous / repeat actions.** The regex matches
  (`submit|publish|pay|delete|confirm|checkout|release|charge|purchase|send`
  and `add(\s+(another|track|row|speaker|item|more|file|line|entry))?`) work
  on plain English labels. They have not been tested on internationalized UI
  copy, icon-only buttons, or labels that live in tooltips/aria-only.

- **The mock/demo source.** It is asserted to *not* leak fake activity; nobody
  has signed off that its UX presentation is correct.

- **The runtime variable inference downstream of capture.** The captured
  observation flows into `buildObsFromSession()` → `previewObservation` →
  `importObservation` — but the only field type the realistic fixture
  exercises that the inference layer hasn't seen before is `email`. Other
  surface bugs are likely.

---

## What will likely break on real SaaS sites

A frank list. Hands-on triage required when each shows up:

1. **Shadow DOM components.** `document.querySelectorAll('input, button, …')`
   inside the init script does not pierce closed shadow roots. Any site using
   Salesforce LWC, Lit, modern Stripe Elements, or Shopify Polaris will be
   partially or entirely invisible. **Severity: blocking** for many real
   distribution targets.

2. **Iframes.** The init script is registered on the main page; cross-origin
   iframes won't run it at all, and same-origin iframes only run it if
   Playwright's `addInitScript` propagates to children (it does, but the
   `__browsyEmit` exposure only ran on the top frame — to confirm). Stripe
   Checkout, Plaid, HCaptcha, embedded YouTube uploads, etc. fall here.

3. **Auth walls.** First-time observation of any real SaaS workflow will land
   on a login page, which Browsy currently has no story for in this session
   surface. The user has to log in *inside the Playwright-launched browser*
   manually, and we don't persist storage state across sessions.

4. **Bot/captcha challenges.** Distrokid, Bandcamp, TuneCore — any release
   target with anti-automation will probably reject a Playwright-launched
   Chromium (CDP signals, missing `navigator.webdriver` quirks, headed but
   automation-flagged). We don't currently install evasion patches, and we
   probably shouldn't in the first cut.

5. **Single-page app navigation.** `page.on('framenavigated')` only fires on
   real navigations. SPA route changes (history.pushState) do not trigger
   `page_seen` events. Almost every modern SaaS app falls here.

6. **Stable selectors.** The `selectorFor()` helper picks `#id`, then
   `tag[name="…"]`, then bare tag. On a real site with React-generated class
   names and no semantic ids/names, the best we can produce is `input`,
   which is useless. Selector candidate generation needs a real fallback
   chain (data-testid → role → label → text→nearby).

7. **Virtualized / lazy-loaded controls.** A scrollable list of upload rows
   may only mount visible rows. Our `initialScan` runs once on
   `DOMContentLoaded` — controls that appear later via observer never get
   scanned.

8. **Dynamic dangerous actions.** Sites that progressively enable the Submit
   button after async validation will fire `action_detected` for an enabled
   click, but if the label changes between disabled/enabled states, the
   dangerous-keyword regex may not match. Severity: medium — labels still
   usually match.

9. **Repeat-group detection.** Our regex catches "+ Add another track"-style
   text. It will miss icon-only `+` buttons, contextual menus
   ("Actions → Duplicate row"), and drag-to-add patterns. The realistic
   fixture is more representative but does not stress these cases.

10. **File-upload confirmation.** We emit `field_detected` on `change` with
    the file name. We don't observe the post-upload state (progress, server
    response, ID-of-uploaded-asset). Most real workflows depend on these.

11. **Captured outputs.** The current pipeline only infers outputs from the
    observation JSON downstream — `playwrightRecorder` does not emit any
    `output_candidate_detected` events. Generated IDs, confirmation numbers,
    and "your release is at https://…" URLs are completely uncaptured today.

12. **Manual annotations are UI-only.** `markRepeatGroup` / `markDangerous`
    / `saveObsNote` push events into the client-side `obsSession.events`
    only — they are not posted back to the server. The next 1.5s server
    poll wipes them. This is a real bug, currently mitigated by the
    finish-time event aggregation; would surface immediately if a user paused
    long enough.

---

## What needs Atlas/Codex/Appshots-assisted observation next

The local Playwright recorder is the right primary surface for
internal/known-good sites. For everything else, Browsy's longer-term plan
([atlas-codex-observation.md](atlas-codex-observation.md)) involves a
human-in-the-loop observation pipeline. Concrete next moves:

- **Chrome Extension capture source.** The card exists in the UI but is
  disabled. This is the right answer for shadow DOM + iframes + auth: the
  extension lives inside the user's already-authenticated session and can
  pierce DOM boundaries the way Playwright cannot. Highest leverage.

- **Atlas-assisted notes adapter wiring.** Atlas/ChatGPT manually paged
  through a real workflow, the user pastes their observations in. The
  `atlasAssistedNotesAdapter` exists but is currently a fallback narrative
  path only — wiring it to produce canonical events would let it feed the
  same inference pipeline.

- **Codex round-trip.** Once an Atlas/Chrome-Extension observation lands as
  a draft observation JSON, hand it to Codex to enrich (selector candidates,
  failure heuristics, retry plans). The structure for this already exists in
  the import path; the agent prompt does not.

- **Appshots / screenshot diff.** Capture screenshots at every page_seen and
  user-marked dangerous action. Use them later to validate that what
  Browsy plays back at run-time matches what the observer saw. Currently
  no screenshot is taken anywhere on the observation path.

---

## Recommended next engineering slice

Pick **one** of:

### Slice A — Selector-candidate fallback chain (1–2 days)

In `PLAYWRIGHT_OBS_INIT_SCRIPT` `selectorFor()`, walk a real fallback chain
before falling back to bare tag: `[data-testid]` → `[aria-label]` → role +
nearest label → text-based nth-of-type. Emit a `selectorCandidates` array,
not just a single selector. Cheap, narrows the biggest real-world gap (item
6 above), and is testable with a new fixture that has no ids/names.

### Slice B — Output candidate detection (2–3 days)

Add a `MutationObserver` after each click that emits
`output_candidate_detected` for newly-appeared text matching common
ID/URL/confirmation-number patterns. The conference-proposal sample already
defines what this looks like downstream; producing them upstream closes
item 11.

### Slice C — Persisted manual annotations (1 day)

Make `markRepeatGroup`/`markDangerous`/`saveObsNote` POST to
`/api/observation/events` so server-side and UI agree, and the 1.5s poll
stops wiping them. Closes item 12. Low risk, high trust gain.

### Slice D — Chrome Extension capture stub (1 week)

Stand up a minimum extension that can register itself as a session source
and post the same canonical events to the wizard server. Closes the
biggest real-SaaS gap (shadow DOM + iframes + auth). High value but big
slice — should not be combined with A/B/C.

Recommendation: **C → A → B → D.** C is a same-day cleanup of a real bug;
A and B harden the existing path before we bet a week on D.

---

## Reproduction commands

- Manual test (visible browser): `npm run wizard`, then follow
  [observation-manual-test.md](observation-manual-test.md).
- End-to-end real capture: `npm run acceptance:observation-playwright`.
- Hardening contract checks: `npm run acceptance:observation-hardening`.
- Full suite: `npm test`.
