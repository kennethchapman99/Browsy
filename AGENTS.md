# Browsy Agent Instructions

Browsy is a developer-facing browser automation harness factory.

A coding agent should treat `AUTOMATION_REQUEST.md` as the single source of truth for the requested automation. The goal is to generate a safe, inspectable automation harness using the best available mechanism: APIs first, then Playwright, then OpenClaw or real-browser control when needed.

## Operating principles

1. Prefer APIs over browser automation when a stable API exists.
2. Use Playwright for deterministic browser steps: fill, select, upload, click safe navigation, screenshot, and logging.
3. Use OpenClaw or real-browser control for workflows that are too dynamic for selectors or require human-like browser interaction.
4. Keep final, payment, legal, destructive, or externally-visible actions behind human checkpoints unless the request explicitly allows them and the safety policy permits them.
5. dry-run must default to true for every generated automation.
6. Every generated workflow must save logs, screenshots, skipped fields, failed fields, and page snapshots.
7. Never claim success when selectors are missing. Report what was filled, skipped, and failed.
8. Keep the harness boring and inspectable. No hidden magic.

## Agent workflow

When asked to build an automation:

1. Read `AUTOMATION_REQUEST.md`.
2. Create or update a workflow under `workflows/<workflow-name>/`.
3. Create `workflow.yaml`, `manifest.schema.json`, `safety-policy.json`, and `walkthrough.md`.
4. Add or update field maps under `workflows/<workflow-name>/field-map.local.json`.
5. Generate a runner that uses the shared runtime helpers under `src/core/`.
6. Add smoke tests for the workflow.
7. Update docs with exact commands.
8. Run smoke tests.

## Required generated workflow files

Each workflow should contain:

```text
workflows/<workflow-name>/
  workflow.yaml
  manifest.example.json
  manifest.schema.json
  safety-policy.json
  field-map.example.json
  field-map.local.json        # local/ignored when sensitive or site-specific
  walkthrough.md
  README.md
```

Generated runs should write to:

```text
output/runs/<workflow-name>/<timestamp>/
```

## Safety baseline

The default safety policy must block text matching:

- Submit
- Finalize
- Pay
- Purchase
- Release
- Send
- Delete
- Continue and submit
- Save and submit

A workflow may add stricter rules, but should not loosen these without an explicit request and a test proving the behavior.

## Auth baseline

Support these modes where appropriate:

- API key / token
- OAuth callback
- Playwright storage state
- Chrome real profile
- Chrome CDP
- Manual login then save state
- OpenClaw browser control

For browser auth flows, save state while the session is live. Do not rely only on browser close, because context shutdown can race against storage-state persistence.

## Acceptance criteria for generated automations

- `npm run smoke` passes.
- Discovery writes readable `discovered-fields.md`.
- dry-run does not take dangerous actions.
- Artifacts are saved.
- The README tells a human exactly how to run and verify the workflow.
