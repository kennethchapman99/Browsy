# Pancake Robot + DistroKid Recording Validation

This runbook validates the live path behind the automated fixture tests:

- Pancake Robot creates a Browsy recording session.
- Browsy opens an auth setup browser for DistroKid.
- A human signs in to DistroKid.
- Browsy reuses the saved persistent profile for recording.
- The recording launches without stray `about:blank` tabs.
- The operator completes a bounded test recording and stops before final actions.

Do not use this runbook to publish, submit, pay, certify, delete, or release anything.

## Prerequisites

- A DistroKid account you control.
- A Pancake Robot release/test payload that uses scratch metadata and scratch files.
- Node 22+ installed.
- Chrome available to Playwright. Browsy prefers `channel: "chrome"` for this flow.
- Optional: `jq` for the shell checks below.

## Safety Boundary

The human may log in, navigate, type fields, select scratch files, and stop the recording.

The human must stop before any action labeled like:

- `Submit`
- `Publish`
- `Finalize`
- `Release`
- `Pay`
- `Purchase`
- `Checkout`
- `Confirm`
- `I agree`
- `I certify`

If DistroKid shows a final-review or payment page, stop the recording there. Do not click through.

## Start Browsy

```bash
npm run api
```

The examples below assume the API is at `http://localhost:3001`.

At any point, ask the validator what evidence exists and what command is next:

```bash
npm run validate:pancake-distrokid-recording -- status
```

For a fresh run it should print:

```text
PASS note: overall not_started
PASS note: next command npm run validate:pancake-distrokid-recording -- create-session
```

## 1. Create A Pancake-Initiated Recording Session

Use a real Pancake Robot source URL if available. If the source URL is not needed for the auth launch validation, keep only the DistroKid target tab.

```bash
npm run validate:pancake-distrokid-recording -- create-session
```

Expected output includes the wizard URL and the next command:

```text
PASS note: recordingSessionId rec_...
PASS note: open Browsy wizard http://localhost:3001/recordings/rec_...
PASS note: DistroKid target https://distrokid.com/new/
PASS note: next command npm run validate:pancake-distrokid-recording -- prepare-auth
```

Open the `open Browsy wizard` URL. If you need to recover it later:

```bash
node -e "const s=require('/tmp/browsy-distrokid-session.json'); console.log(s.wizardUrl || 'http://localhost:3001/recordings/'+s.recordingSessionId)"
```

Evidence required:

- `/tmp/browsy-distrokid-session.json` has `"ok": true`.
- `recordAutomationControl.label` is `Record Automation`.
- `recordAutomationControl.action` is `open_browsy_new_automation_wizard`.
- `recordAutomationControl.href` equals `wizardUrl`.
- `recordingSetup.authProfileId` is `distrokid`.
- The DistroKid tab URL is not `about:blank`.
- The command output includes `open Browsy wizard http://localhost:3001/recordings/...`.

## 2. Open The DistroKid Auth Profile

```bash
npm run validate:pancake-distrokid-recording -- prepare-auth
```

Expected output includes:

```text
PASS note: auth userDataDir output/auth-profiles/pancake-robot/distrokid/user-data
PASS note: auth storageStatePath output/auth-profiles/pancake-robot/distrokid/storageState.json
PASS note: after manual DistroKid login, run npm run validate:pancake-distrokid-recording -- preflight
```

In the opened Chrome window:

1. Sign in to DistroKid manually.
2. Complete 2FA if required.
3. Confirm you can reach a logged-in DistroKid page.
4. Leave the browser open for a few seconds, then close it.

Evidence required:

- The profile path in `/tmp/browsy-distrokid-auth-prepare.json` is under `output/auth-profiles/pancake-robot/distrokid/`.
- `output/auth-profiles/pancake-robot/distrokid/user-data/` exists.
- If `savedAuthState` is present, that path exists.

## 3. Preflight The Saved Auth Profile

```bash
npm run validate:pancake-distrokid-recording -- preflight
```

Expected output includes:

```text
PASS note: preflight finalUrl ...
PASS note: next command npm run validate:pancake-distrokid-recording -- start-recording
```

Evidence required:

- `/tmp/browsy-distrokid-preflight.json` has `"ok": true` at the response envelope.
- `.preflight.ok` is `true`.
- `.preflight.code` is `"authenticated"`.
- `.preflight.finalUrl` is not `about:blank`.
- `.preflight.finalUrl` does not include `/signin` or `/login`.

If preflight reports `auth_required`, repeat step 2. Do not start recording until preflight passes.

## 4. Start The Recording

This request intentionally does not pass `usePersistentProfile`. For auth-required recordings, Browsy should automatically reuse the existing persistent profile.

```bash
npm run validate:pancake-distrokid-recording -- start-recording
```

Expected output includes:

```text
PASS persistent profile used
PASS launch verification passed
PASS verification has no blank tabs
PASS note: persistentProfile true
PASS note: openedTabs distrokidUpload=...
```

Evidence required:

- Response has `"ok": true`.
- `.launch.mode` is `"real_playwright_recorder"`.
- `.launch.persistentProfile` is `true`.
- `.launch.verification.ok` is `true`.
- `.launch.verification.blankTabs` is an empty array.
- `.launch.openedTabs[]` has no `finalUrl` equal to `about:blank` or `chrome://newtab`.
- The DistroKid tab opens on a logged-in DistroKid page, not a login page.

Useful check:

```bash
jq '.launch | {
  mode,
  persistentProfile,
  verification,
  openedTabs
}' /tmp/browsy-distrokid-recording-start.json
```

## 5. Complete A Bounded Test Recording

In the opened DistroKid browser:

1. Use scratch metadata, for example `BROWSY DRY RUN - DO NOT PUBLISH`.
2. Use scratch upload files only.
3. Exercise the fields needed for Pancake Robot's release flow.
4. Add at least one repeated track if the workflow requires repeat groups.
5. Stop at the final review, payment, certification, publish, or submit boundary.

Do not click final-action buttons. If a final-action button appears and Browsy does not flag it as dangerous in the recorded observation, discard the run and fix safety detection first.

## 6. Stop The Recording

```bash
npm run validate:pancake-distrokid-recording -- stop-recording
```

Expected output includes:

```text
PASS stop recording response ok
PASS runtime stopped
PASS savedAuthState exists
PASS note: savedAuthState output/auth-profiles/pancake-robot/distrokid/storageState.json
PASS note: wrote validation report /tmp/browsy-distrokid-validation-report.json
PASS note: validation report overall needs_manual_attestation
PASS note: next command npm run validate:pancake-distrokid-recording -- check-artifacts
```

Evidence required:

- Response has `"ok": true`.
- `.runtime.status` is `"stopped"`.
- `.runtime.savedAuthState` is non-empty and the file exists.
- `output/recordings/${RECORDING_SESSION_ID}/events.json` exists.
- `output/recordings/${RECORDING_SESSION_ID}/runtime-status.json` has `"status": "stopped"`.
- `output/recordings/${RECORDING_SESSION_ID}/screenshots/` contains screenshots.

Useful checks:

```bash
jq '.runtime' /tmp/browsy-distrokid-recording-stop.json
test -f "output/recordings/${RECORDING_SESSION_ID}/events.json"
test -f "$(jq -r '.runtime.savedAuthState' /tmp/browsy-distrokid-recording-stop.json)"
```

To re-check artifacts later:

```bash
npm run validate:pancake-distrokid-recording -- check-artifacts
```

This also writes:

```text
/tmp/browsy-distrokid-validation-report.json
/tmp/browsy-distrokid-validation-report.md
```

The report is requirement-by-requirement evidence for the live goal. It remains
`needs_manual_attestation` until the operator confirms no final action was
clicked.
One required report row is `record_automation_control_available`; it must be
`PASSED` before treating Pancake Robot's launch surface as validated.

After you personally confirm no final action was clicked, write the attested
report:

```bash
npm run validate:pancake-distrokid-recording -- report --attest-no-final-actions true
```

Expected result:

```text
PASS validation report written
PASS note: validation report overall passed
```

Confirm the whole live validation is complete:

```bash
npm run validate:pancake-distrokid-recording -- status
```

Expected result:

```text
PASS note: overall passed
PASS note: next command none
```

## 7. Review The Evidence

Inspect:

```text
output/recordings/<recordingSessionId>/events.json
output/recordings/<recordingSessionId>/observation.json
output/recordings/<recordingSessionId>/runtime-status.json
output/recordings/<recordingSessionId>/screenshots/
output/auth-profiles/pancake-robot/distrokid/storageState.json
output/auth-profiles/pancake-robot/distrokid/user-data/
/tmp/browsy-distrokid-validation-report.json
/tmp/browsy-distrokid-validation-report.md
```

Pass criteria:

- Auth profile exists and is reused.
- Auth preflight passes.
- Recording launch uses `persistentProfile: true`.
- Every requested tab navigates away from `about:blank`.
- No unexpected `about:blank` or `chrome://newtab` tab remains in `openedTabs`.
- The run records events and screenshots.
- `stop` writes `savedAuthState`.
- The operator stopped before final actions.
- The validation report is `passed` after explicit operator attestation, or
  `needs_manual_attestation` before that final confirmation.

Fail criteria:

- Any launch response has `launchFailed: true`.
- Any requested tab remains on `about:blank`.
- DistroKid redirects to login after auth setup.
- `runtime.savedAuthState` is missing after stop.
- A final action was clicked.
- A dangerous DistroKid action was visible but not recorded as dangerous.

## Automated Coverage Before Live Validation

Run these before touching DistroKid:

```bash
npm run acceptance:recording-persistent-profile
npm run acceptance:recording-stack
npm run smoke:browser
npm run validate:pancake-distrokid-recording -- help
```

The persistent-profile test proves the same properties with a local auth fixture:

- auth setup writes `storageState.json`;
- preflight reuses the auth cookie;
- a second recording launch automatically uses a persistent profile;
- the second recording opens exactly one tab;
- the final URL is authenticated, not login or blank;
- stopping the recording saves auth state again.
