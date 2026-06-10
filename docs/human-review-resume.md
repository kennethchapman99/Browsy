# Human review → manual finish (live final submit)

For a live run that fills a real form and must stop for a human to approve the
final, dangerous action (e.g. DistroKid "Submit"), Browsy uses a **fill → park →
manual finish** flow. The executor never clicks final submit on the live site and
never blocks waiting for a human (an earlier blocking design fought the caller's
own run timeout and produced `did not reach a terminal state within the timeout`).

## How it works

1. **Fill + park (non-blocking).** The run-plan executor fills every field, reaches
   the mandatory `human_checkpoint`, and — because this is the live site — does
   **not** click submit. It leaves the live, logged-in browser open with the form
   filled and returns **immediately**. The run reports
   `waiting_for_approval_to_submit` (a non-terminal *waiting* status), so the
   caller sees "paused for a human", not a hang.

2. **Human finishes the tail.** In the open browser window the person:
   - reviews the filled form,
   - clicks the final Submit,
   - completes the Mixea upsell,
   - grabs the HyperFollow link.

   Browsy does not automate any of these on the live site — this is the reliable,
   human-owned tail. (The post-submit chain — submit → mixea → done → capture
   HyperFollow — runs automatically only against the fake fixture in tests, where
   no real account is touched.)

3. **Confirm to finalize.** When done, the caller sends:

   ```
   POST /api/runs/:runId/confirm-submit
   { "capturedOutputs": { "hyperfollow_url": "https://distrokid.com/hyperfollow/..." } }
   ```

   This marks the parked run `completed` (so the caller stops spinning) and folds
   in any outputs the human reports. `capturedOutputs` is optional.

## What the caller (e.g. Figment Factory / Pancake Robot) must do

- Treat `waiting_for_approval_to_submit` as "paused for human", not a failure —
  do **not** time the run out while it sits here.
- After the human finishes the manual submit, call
  `POST /api/runs/:runId/confirm-submit` to finalize the run. A "Continue" /
  "Mark done" button is a natural place to wire this.

## Tests

- `scripts/acceptance-distrokid-postsubmit.mjs` — inline auto-submit (no human
  gate) against the fake fixture: proves the declarative `postSubmitSteps`
  interpreter works end-to-end without touching a real account.
