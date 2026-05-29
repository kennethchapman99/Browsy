# Browsy

**Automation project intake and harness factory.** v0.3

> Read AGENTS.md first. Then read AUTOMATION_REQUEST.md plus `workflows/<workflow-id>/project.json`. Build the completed automation harness described there under `workflows/<workflow-id>/`. Use APIs where available, Playwright where deterministic, and adapter-based browser control only where needed. Preserve safety gates.

---

## What Browsy is

Browsy is an automation project intake and harness factory that converts expert walkthroughs, structured data contracts, Atlas observations, Playwright discovery, and safety policies into reusable browser/API automation harnesses.

Browsy helps a workflow expert describe what needs to happen in plain English, then produces durable artifacts a coding agent can inspect and extend:

- `AUTOMATION_REQUEST.md` for human/agent readability
- `project.json` for canonical project state
- `workflow-package.example.json` for the run package contract
- `manifest.schema.json` and `manifest.example.json`
- observation templates and checklists
- safety policy and field-map scaffolds
- local fixtures for deterministic tests

The harness uses:

- **APIs** where a stable interface exists
- **Playwright** for deterministic browser actions: fill, select, upload, safe click, screenshots, logging
- **Adapter placeholders** for AI browser control when deterministic selectors are insufficient
- **Human checkpoints** for final submit, payment, legal attestation, publishing, and other high-impact actions

Every run produces logs, screenshots, filled/skipped/error artifacts, and pauses before anything dangerous.

## What Browsy is NOT

- Not a general-purpose autonomous browser agent
- Not a no-code tool that hides implementation from review
- Not autonomous — dangerous actions always require a human
- Not a scraper
- Not a replacement for Playwright codegen; Browsy adds project structure, business logic, safety, and reusable harness generation

See [docs/product-positioning.md](docs/product-positioning.md) for a full comparison.

---

## Project lifecycle

```text
Intake
  → Atlas observation
  → Discovery
  → Field map
  → Package
  → Dry run
  → Human checkpoint
  → Live run
  → Output capture
  → Reusable workflow
```

Project readiness is tracked with these states:

```text
intake_draft → intake_validated → observation_needed → observation_captured
→ discovery_ready → discovery_complete → field_map_candidate_ready
→ field_map_verified → harness_scaffolded → dry_run_ready → dry_run_passed
→ live_run_ready → live_run_gated → live_run_completed
→ output_capture_completed → promoted_to_reusable
```

---

## Workflow project structure

Generated workflow projects are file-based:

```text
workflows/<workflow-id>/
  project.json
  workflow.yaml
  workflow.json
  manifest.schema.json
  manifest.example.json
  workflow-package.example.json
  safety-policy.json
  field-map.example.json
  field-map.local.json.example
  field-map.local.json
  walkthrough.md
  observations/
    atlas-observation-template.md
    observation-YYYY-MM-DD.md
    observation-checklist.md
  fixtures/
    observed-form.html
    observed-review.html
    observed-success.html
  README.md
  run.mjs
  smoke-test.mjs

output/
  plans/<workflow-id>/
  runs/<workflow-id>/<timestamp>/
  observations/<workflow-id>/
```

---

## Core project model

Browsy separates workflow data by intent:

| Bucket | Meaning |
| --- | --- |
| Global fields | Filled once per run |
| Repeated item fields | Filled once per item |
| Captured fields | Extracted from the target site during/after execution |
| Derived fields | Computed from input or captured data |
| External links | URLs created or discovered by the target site |
| Output-only fields | Stored back into project/run state, not filled into the browser |
| Gates | Conditions that unlock downstream stages only after captured outputs verify |
| Safety policy | Dangerous actions and human checkpoints |

See [docs/patterns/global-repeat-captured-outputs.md](docs/patterns/global-repeat-captured-outputs.md).

---

## Atlas/Codex observation

Atlas observation is first-class but does not replace Playwright discovery.

- Atlas/Codex captures workflow meaning, page states, validation messages, repeated-section behavior, dangerous buttons, success states, and gotchas.
- Playwright discovery captures DOM inventory, screenshots, HTML, page text, and selector candidates.
- Field-map verification turns both into deterministic automation.

See [docs/atlas-codex-observation.md](docs/atlas-codex-observation.md) and [templates/observation/atlas-observation-template.md](templates/observation/atlas-observation-template.md).

---

## Install

```bash
npm install
npx playwright install chromium
```

## Commands

### Open the wizard

```bash
npm run wizard
```

The wizard writes `AUTOMATION_REQUEST.md` and can save a complete automation project draft under `workflows/<workflow-id>/`.

It also hosts the real **browser workflow recorder** (step 4) — context-scoped
observation that handles multi-tab/popup flows, same-origin iframes, file
inputs, drag/drop uploads, clipboard paste, contenteditable / rich editors,
and downloads. The recorder produces a replay-ready package describing
required assets, produced artifacts, and explicit replay notes for steps
that cannot be safely automated from observation alone. See
[docs/workflow-recorder.md](docs/workflow-recorder.md) for details and the
exact event schema.

### Validate the request file

```bash
npm run validate:request
```

Checks sections, extracts data, validates safety policy JSON, captured outputs, repeat groups, gates, and observation requirements.

### Generate a build plan

```bash
npm run plan
# or
npm run plan -- --request AUTOMATION_REQUEST.md
```

Saves `output/plans/<workflow-id>/build-plan.md` and `build-plan.json`.

### Create a workflow scaffold

```bash
npm run init:workflow -- --id my-workflow
npm run init:workflow -- --from-request
```

`--from-request` reads `AUTOMATION_REQUEST.md` and creates workflow files populated with real data.

### Save / check auth

```bash
npm run auth:list
npm run auth:save -- --site distrokid --url https://distrokid.com/new
npm run auth:check -- --site distrokid --url https://distrokid.com/new
npm run auth:save -- --workflow my-workflow --url https://example.com/login
npm run auth:check -- --workflow my-workflow --url https://example.com/dashboard
```

Site-scoped auth profiles are the preferred path for authenticated recording.
Browsy stores them locally under `.auth/profiles/<siteId>/` using a persistent
Chromium `userDataDir`, then exports Playwright `storage-state.json` for reuse.
Do not record or automate OAuth / login steps.

### Authenticated recording sessions

Use a recording setup manifest when a workflow needs multiple tabs or a manual
auth preflight. Example: Pancake Robot + DistroKid.

```json
{
  "workflowId": "distrokid_album_art_upload",
  "appId": "pancake-robot",
  "tabs": [
    {
      "siteId": "pancake-robot",
      "title": "Pancake Robot Release",
      "url": "http://localhost:3737/releases/album/ALBUM_MPK9H71S_RTCM",
      "requiresAuth": false
    },
    {
      "siteId": "distrokid",
      "title": "DistroKid Upload",
      "url": "https://distrokid.com/new",
      "requiresAuth": true
    }
  ]
}
```

In the wizard's Step 4 recording panel:

- Paste the manifest.
- Click `Authenticate` for each auth-required site.
- Log in manually in the persistent browser profile and close it.
- Refresh auth status.
- Start recording only after required auth is valid or explicitly skipped.

Browsy opens the declared tabs already authenticated and records only the
business workflow steps.

### Discover a page DOM

```bash
npm run discover -- --workflow my-workflow --url https://example.com/form
npm run discover -- --workflow my-workflow --url https://example.com/form --candidates
```

`--candidates` writes ranked selector suggestions and semantic labels.

### Run a workflow

```bash
npm run run -- --workflow my-workflow --manifest workflows/my-workflow/manifest.example.json --dry-run
npm run run -- --workflow my-workflow --manifest workflows/my-workflow/manifest.local.json
```

Live runs still block final actions unless explicitly and safely approved.

### Input & completion signals

Browsy makes it unmistakable when it needs a real human and when it is done.
Every run emits a signal over up to three channels (see `src/core/signals.mjs`):

- **Terminal** — a boxed banner plus a single greppable, machine-readable line:
  - `⏸  BROWSY NEEDS YOU` (on stderr) when a human must act — e.g. a manual
    checkpoint, login, captcha, or final-action gate.
  - `✅  BROWSY DONE` (on stdout) when the run finishes, with status and counts.
  - A calling app can parse stdout/stderr for the `[BROWSY_SIGNAL] {…json…}`
    line. The JSON includes `kind` (`needs_input` | `done`), `reason`,
    `blockedActions`, `status`, `workflowId`, `runId`, and artifact info.
- **Calling app (webhook)** — set `BROWSY_CALLBACK_URL` (or pass `callbackUrl`)
  and Browsy POSTs the same JSON payload to it. Best-effort: a failed or slow
  webhook never breaks a run.
- **Browser** — when a headed run pauses for a human, Browsy paints a banner
  across the top of the live page so the operator sees *"Browsy needs you"*
  instead of a silent, idle window. The window closes on its own when the run
  completes cleanly.

```bash
# Push completion / needs-input events to a calling app
BROWSY_CALLBACK_URL=https://my-app.example.com/browsy-hook \
  npm run workflow:run -- --package path/to/package.json
```

### Smoke and acceptance tests

```bash
npm run smoke
npm run smoke:browser
npm run test
npm run acceptance:project-lifecycle
npm run acceptance:workflow-recorder
```

---

## Safety model

Every generated harness:

- Defaults `dry_run: true`
- Defaults `headed: true`
- Defaults `pause_at_end: true`
- Blocks clicks on dangerous text: Submit, Pay, Purchase, Release, Delete, Finalize, Checkout, Send, Publish, and related final-action text
- Blocks legal certification, payment, paid extras, final submission, publishing, and high-impact action categories
- Requires an explicit human checkpoint before any dangerous action

These defaults are enforced in `src/core/safety.mjs` and represented in each workflow's `safety-policy.json`.

---

## How to create a new automation

1. Run `npm run wizard`.
2. Describe the workflow in plain English.
3. Define data sources, run inputs, repeat groups, captured outputs, gates, and safety checkpoints.
4. Save `AUTOMATION_REQUEST.md` and the workflow project draft.
5. Capture Atlas/Codex observations in `workflows/<id>/observations/`.
6. Run discovery with `--candidates`.
7. Create `field-map.local.json` using verified selectors only.
8. Run a dry-run.
9. Review run artifacts and safety skips.
10. Only then consider a live, human-gated run.

---

## How to use a coding agent with Browsy

Point Claude Code, Codex, or similar at this repo and give the agent this prompt:

```text
Read AGENTS.md first. Then read AUTOMATION_REQUEST.md and workflows/<workflow-id>/project.json. Build the completed automation harness described there. Use APIs where available, Playwright where deterministic, and adapter-based browser control only where needed. Use Atlas observation docs when available. Preserve all safety gates. Run npm run smoke before final response.
```

The agent should report exact files, commands, test results, skipped fields, failed selectors, and remaining human steps.

---

## Key files

| File | Purpose |
|---|---|
| `AUTOMATION_REQUEST.md` | Human-readable intake request |
| `AGENTS.md` | Coding-agent contract |
| `src/core/project-model.mjs` | Project/package/readiness/gate model |
| `src/core/request-parser.mjs` | Parse + validate request file |
| `src/core/workflow-runtime.mjs` | Shared run primitives |
| `src/core/field-map-candidates.mjs` | Selector candidate generator |
| `src/core/safety.mjs` | Dangerous action detection |
| `src/core/signals.mjs` | "Needs input" / "done" signals (terminal, webhook, in-browser banner) |
| `src/core/discovery.mjs` | Playwright DOM inventory |
| `src/core/playwright-executor.mjs` | Safe Playwright execution |
| `docs/atlas-codex-observation.md` | Observation workflow guide |
| `docs/patterns/global-repeat-captured-outputs.md` | General repeat/capture/gate pattern |
| `templates/observation/` | Observation templates |
| `fixtures/local-form/` | Local test fixture page |
| `examples/workflows/distrokid-album-upload/` | Reference example only; not hardcoded core logic |
