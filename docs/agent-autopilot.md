# Autopilot — one command from intent to a reviewable dry-run

`browsy autopilot` chains the three steps you'd otherwise run by hand —
**discover → field-map → dry-run** — into a single pass and hands back one
structured report of what is done and what still needs a human.

You bring the intent (the field-mapping instruction), do **one recording pass**
plus a **one-time login**, and run one command. Autopilot drives the consoles
for you: it sees what the DOM exposes, asks the LLM mapper for selectors (behind
the hallucination guard), runs a dry-run, and tells you exactly where the
remaining human touchpoints are.

```bash
npm run autopilot -- --workflow <id> [--from-recording <id|path>] [--urls a,b] [--model <m>]
```

## What it is / is not

**It is** an orchestrator over existing Browsy primitives:
- `launchBrowser` + `writeDiscoveryArtifacts` — discovery
- `generateFieldMapForWorkflow` — the same LLM mapper as `discover:map`, with the
  hallucination guard that only ever writes selectors found in discovery
- `runWorkflowPackage` — the dry-run + `result.json` contract

**It is not** a way around any human boundary. Autopilot **never** logs in,
**never** clicks a dangerous action, and **never** does a live run. It always
runs the executor in `dry_run` and offers no `--live` flag — live remains the
separate, explicitly human-gated `workflow:run --live`.

## Inputs

| Input | Where | Role |
|---|---|---|
| Field-mapping instruction | `workflows/<id>/field-mapping-instruction.md` | The human's declared intent. Surfaced in the report. |
| Automation request | `AUTOMATION_REQUEST.md` | Optional. Provides request fields for candidate matching. |
| Discovery URLs | `workflow.json` `discovery_urls` (or `targets.start_url`) | Pages to discover. |
| `--urls a,b` | CLI | Extra discovery URLs, merged with the above. |
| `--from-recording <id\|path>` | CLI | A recording session id or an `events.json`/observation file. Its page URLs become discovery targets — this is how deep pages get in (see below). |

## The loop

| Phase | What it does | Reuses |
|---|---|---|
| 0 | Load `workflow.json` + intent doc + request fields | — |
| 1 | Resolve the page set: `discovery_urls` ∪ `--urls` ∪ recording URLs | `buildObservationFromEvents` |
| 2 | **Auth check** — if a required site is unsaved/expired, stop with `blocked_auth_required` and the exact `auth save` command | `getMissingWorkflowAuth` |
| 3 | Discover each page; write candidates; flag dangerous controls found | `writeDiscoveryArtifacts`, `generateCandidates` |
| 4 | Generate `field-map.local.json` (hallucination-guarded) | `generateFieldMapForWorkflow` |
| 5 | Dry-run; read `result.json` | `runWorkflowPackage` (`dry_run`) |
| 6 | Readiness snapshot + write `autopilot-report.json` / `.md` | `evaluateProjectReadiness` |

The report lands in `output/runs/<id>/<timestamp>/autopilot-report.{json,md}`.

## The one human recording pass (deep pages)

Multi-step / authenticated pages that you can't reach with a single URL are
exposed by recording the flow **once**. Autopilot then harvests the distinct
page URLs from that recording (`--from-recording`) and discovers them — it does
**not** try to replay the recording to reach them. Login/SSO bounce pages are
dropped automatically.

This is the same recording you make in
[recording-new-automations.md](./recording-new-automations.md) step 4; autopilot
automates the transition from a finished recording to
discovered + mapped + dry-run.

## Residual human touchpoints

The report lists every one of these under "Needs human eyes":

- 🔴 **Auth** (blocking) — log in manually; Google/Okta reject automated login.
- 🟡 **Recording for deep pages** — capture the multi-step flow once.
- 🟡 **Unmapped intent field** — no confident selector; add one in `field-map.local.json`.
- 🟡 **Low-confidence selector** — mapped below `0.7`; verify before live.
- 🟡 **Dangerous action** — Submit/Delete/Pay controls found on the page. The
  executor and safety policy already refuse to click these; the flag is a
  heads-up so you don't wire automation to them.
- 🔴 **Dry-run client actions** — e.g. `human_approval_required` (live gate),
  `selector_verification_required`, `missing_input`.

## Reading the report

- `overall`: `ok` | `completed_with_followups` | `blocked` | `failed`
- `nextRequiredAction`: the single most important next step
- `humanTouchpoints[]`: each has `type`, `blocking`, `reason`, and sometimes a
  `command` you can copy-paste
- Exit codes (same convention as `workflow:run`): `0` clean · `3`
  completed-with-follow-ups · `4` blocked · `2` failed

## Relationship to the recording runbook

The site-agnostic muscle memory stays:

```text
wizard → enrich (field-mapping instruction) → auth → record → discover --candidates
       → verify field-map → dry-run → human-gated live
```

Autopilot collapses the `discover → verify field-map → dry-run → review` tail of
that chain into one command. **Auth, the recording, and the final live approval
remain human.**
