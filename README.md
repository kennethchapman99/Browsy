# Browsy

**Browser automation harness factory.** v0.2

> Read AGENTS.md first. Then read AUTOMATION_REQUEST.md. Build the completed automation harness described there under `workflows/<workflow-id>/`. Use APIs where available, Playwright where deterministic, and adapter-based browser control only where needed. Preserve safety gates. Run `npm run smoke` before final response.

---

## What Browsy is

Browsy lets you fill in one request file, then a coding agent (or you) can generate a safe, inspectable automation harness for a repeatable web workflow.

The harness uses:
- **APIs** where a stable interface exists
- **Playwright** for deterministic browser actions (fill, select, upload, safe navigation)
- **Adapter placeholders** for AI browser control when Playwright selectors are insufficient
- **Human checkpoints** for final submit, payment, legal attestation, and destructive actions

Every run produces logs, screenshots, filled/skipped/error artifacts, and pauses before anything dangerous.

## What Browsy is NOT

- Not a general-purpose browser agent
- Not a no-code tool (code is written and reviewed)
- Not autonomous — dangerous actions always require a human
- Not a scraper
- Not a replacement for Playwright codegen (Browsy adds business logic on top)

See [docs/product-positioning.md](docs/product-positioning.md) for a full comparison.

---

## Workflow lifecycle

```
1. Fill AUTOMATION_REQUEST.md
        ↓
2. npm run validate:request       ← check request is complete
        ↓
3. npm run plan                   ← generate build-plan.md
        ↓
4. npm run init:workflow --from-request   ← scaffold workflow files
        ↓
5. npm run auth:save (if login needed)
        ↓
6. npm run discover --candidates  ← discover DOM + selector candidates
        ↓
7. Create field-map.local.json   ← pick verified selectors
        ↓
8. npm run run --dry-run          ← test without real actions
        ↓
9. npm run smoke                  ← verify all checks pass
        ↓
10. Human reviews + approves final action
```

---

## Install

```bash
npm install
npx playwright install chromium
```

## Commands

### Validate the request file

```bash
npm run validate:request
```

Checks sections, extracts data, validates safety policy JSON, reports errors with fix hints.

### Generate a build plan

```bash
npm run plan
# or
npm run plan -- --request AUTOMATION_REQUEST.md
```

Saves `output/plans/<workflow-id>/build-plan.md` and `build-plan.json`.

### Create a workflow scaffold

```bash
# Basic scaffold
npm run init:workflow -- --id my-workflow

# Populated from request file
npm run init:workflow -- --from-request
```

`--from-request` reads `AUTOMATION_REQUEST.md` and creates all workflow files populated with real data (goal, URLs, safety policy, auth mode, README, run.mjs).

### Save / check auth

```bash
npm run auth:save -- --workflow my-workflow --url https://example.com/login
npm run auth:check -- --workflow my-workflow --url https://example.com/dashboard
```

### Discover a page DOM

```bash
# Basic discovery
npm run discover -- --workflow my-workflow --url https://example.com/form

# Discovery + field-map candidates
npm run discover -- --workflow my-workflow --url https://example.com/form --candidates
```

`--candidates` writes `field-map.candidates.json` and `field-map.candidates.md` with ranked selector suggestions and semantic labels.

### Run a workflow

```bash
# Dry-run (default, recommended first)
npm run run -- --workflow my-workflow --manifest workflows/my-workflow/manifest.example.json --dry-run

# Live run (still blocked at final action unless --allow-final-action is passed AND safety policy permits)
npm run run -- --workflow my-workflow --manifest workflows/my-workflow/manifest.local.json
```

### Smoke test

```bash
npm run smoke              # fast, no browser (file checks + logic tests)
npm run smoke:browser      # includes fixture-based Playwright tests
```

---

## Safety model

Every generated harness:

- Defaults `dry_run: true`
- Defaults `headed: true` (browser is visible)
- Defaults `pause_at_end: true` (waits before closing)
- Blocks clicks on text matching: Submit, Pay, Purchase, Release, Delete, Finalize, Checkout, Send, and more
- Blocks `legal certification`, `payment`, `paid extras`, `final submission`, `destructive action` field categories
- Requires `--allow-final-action` flag AND explicit safety policy approval to proceed past checkpoint

These defaults are enforced in `src/core/safety.mjs` and are testable.

---

## How to create a new automation

1. Copy or edit `AUTOMATION_REQUEST.md` — fill in all sections.
2. Run `npm run validate:request` — fix any errors.
3. Run `npm run plan` — read the build plan.
4. Run `npm run init:workflow -- --from-request` — creates `workflows/<id>/`.
5. Save auth if needed: `npm run auth:save -- --workflow <id> --url <login-url>`.
6. Discover the live page: `npm run discover -- --workflow <id> --url <form-url> --candidates`.
7. Review `output/runs/<id>/.../field-map.candidates.md`.
8. Create `workflows/<id>/field-map.local.json` from verified selectors.
9. Run `npm run run -- --workflow <id> --dry-run`.
10. Review artifacts in `output/runs/<id>/<timestamp>/`.

---

## How to use a coding agent with Browsy

Point Claude Code, Codex, or similar at this repo and give the agent this prompt:

```text
Read AGENTS.md first. Then read AUTOMATION_REQUEST.md. Build the completed automation harness described there under workflows/<workflow-id>/. Use APIs where available, Playwright where deterministic, and adapter-based browser control only where needed. Preserve all safety gates. Run npm run smoke before final response.
```

The agent should:
- Parse `AUTOMATION_REQUEST.md`
- Create or update `workflows/<workflow-id>/`
- Populate `field-map.example.json` from discovery
- Write a real `run.mjs` using `src/core/workflow-runtime.mjs`
- Run `npm run smoke` and report the result

See [AGENTS.md](AGENTS.md) for the full agent contract.

---

## How to test locally

Run non-browser smoke tests:
```bash
npm run smoke
```

Run with browser fixture (requires Playwright):
```bash
npm run smoke:browser
```

The fixture at `fixtures/local-form/index.html` includes safe fields, a paid add-on checkbox, a legal certification checkbox, and a Submit button. The browser smoke test verifies:
- Discovery finds all fields
- Dry-run fills safe fields (title, artist, description, category)
- Dry-run skips legal checkbox and paid add-on
- Submit is never clicked
- All artifacts are written

---

## Key files

| File | Purpose |
|---|---|
| `AUTOMATION_REQUEST.md` | Fill this in for a new workflow |
| `AGENTS.md` | Coding-agent contract |
| `docs/product-positioning.md` | What Browsy is and isn't |
| `docs/architecture.md` | System design |
| `docs/agent-build-runbook.md` | Step-by-step agent process |
| `src/core/request-parser.mjs` | Parse + validate request file |
| `src/core/workflow-runtime.mjs` | Shared run primitives |
| `src/core/field-map-candidates.mjs` | Selector candidate generator |
| `src/core/safety.mjs` | Dangerous action detection |
| `src/core/discovery.mjs` | Playwright DOM inventory |
| `src/adapters/playwright-adapter.mjs` | Playwright execution adapter |
| `src/adapters/api-adapter.mjs` | API adapter (placeholder) |
| `src/adapters/browser-agent-adapter.mjs` | AI browser agent adapter (placeholder) |
| `templates/workflow/` | Reference structure |
| `fixtures/local-form/` | Local test fixture page |
| `examples/distrokid-upload/` | Reference DistroKid example |
