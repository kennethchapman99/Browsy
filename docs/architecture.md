# Browsy Architecture

Browsy is a harness factory for repeatable web workflows.

## Mental model

Browsy separates intent from execution:

```text
Request file + walkthrough
        ↓
Discovery artifacts
        ↓
Selector/API strategy
        ↓
Generated workflow harness
        ↓
Dry-run logs and human checkpoint
```

The coding agent decides the best execution mix:

1. **API first** when stable APIs exist.
2. **Playwright** for deterministic browser actions such as fill, select, upload, screenshot, and safe navigation.
3. **OpenClaw-style browser control** for workflows that need human-like page operation, brittle flows, or dynamic UI recovery.
4. **Human checkpoint** for final submit, payment, legal attestation, destructive changes, or anything externally visible.

## Repo contract

The user fills in one file:

```text
AUTOMATION_REQUEST.md
```

The coding agent reads:

```text
AGENTS.md
AUTOMATION_REQUEST.md
```

The coding agent then creates or updates:

```text
workflows/<workflow-id>/
```

## Generated workflow anatomy

```text
workflows/<workflow-id>/
  workflow.yaml
  manifest.schema.json
  manifest.example.json
  safety-policy.json
  field-map.example.json
  field-map.local.json.example
  walkthrough.md
  run.mjs
  smoke-test.mjs
  README.md
```

## Shared primitives

```text
src/core/args.mjs       CLI args
src/core/paths.mjs      repo/workflow/output paths
src/core/safety.mjs     dangerous action detection
src/core/discovery.mjs  Playwright DOM inventory and artifacts
```

## Safety philosophy

Browsy should produce automation that is inspectable before it is powerful.

Default generated harnesses should:

- run in dry-run mode
- leave the browser visible
- pause before manual checkpoints
- save screenshots and logs
- never click final submit/payment/purchase buttons
- never select paid extras by accident
- never certify legal terms without explicit approval

## Output artifacts

Every run should save to:

```text
output/runs/<workflow-id>/<timestamp>/
```

Suggested artifacts:

- `run-log.json`
- `filled-fields.json`
- `skipped-fields.json`
- `errors.json`
- `discovered-fields.json`
- `discovered-fields.md`
- `screenshot-start.png`
- `screenshot-after-fill.png`
- `page-text-snapshot.txt`
- `html-snapshot.html`

## Why this is not just Playwright codegen

Playwright codegen records clicks and selectors. It does not understand business rules.

Browsy adds:

- workflow intent
- safety policy
- API-vs-browser selection
- field-source mapping
- dry-run defaults
- logs and screenshots
- human checkpoints

## First template

The DistroKid example is the first reference template. It shows the pattern for a logged-in web form that requires file uploads, live DOM discovery, and strict final-submit blocking.
