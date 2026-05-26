# distributor-album-submit

Materialized Browsy scaffold for uploading an album-style multi-track release to a music distributor up to the human-gated final submit.

## What this is

A *reusable* Browsy workflow that fills an album-upload form deterministically and stops before any final-action control. Browsy never clicks Submit / Upload to stores / Publish / Pay. A human must complete the final action manually.

This workflow is verified against the local fixture at `fixtures/distrokid-wizard/index.html`. It does not require a real DistroKid account to dry-run.

## Files

- `workflow.json` — runtime settings + start URL
- `field-map.local.json` — verified selectors against the fixture (no fabricated selectors)
- `safety-policy.json` — never-click text + selector list for final-action controls
- `manifest.schema.json` — JSON Schema for the canonical_payload Browsy expects

## How to run

Dry-run (default — no browser side-effects):

```bash
npm run workflow:run -- --package examples/workflow-packages/distributor-album-submit.example.json --dry-run
```

Expected: `status: dry_run_passed`.

Live (gated — Browsy stops at the human-approval checkpoint):

```bash
npm run workflow:run -- --package examples/workflow-packages/distributor-album-submit.example.json --live
```

Expected: `status: live_run_gated` and a `human_approval_required` `client_action_request`. Final submit is **not** clicked.

## Acceptance

`npm run acceptance:workflow-contract` exercises the generic contract.
`scripts/acceptance-distrokid-album-wizard.mjs` exercises the wizard package generator against the DistroKid-style fixture.

## Auth setup (only required for real distributor sites — not the fixture)

```bash
npm run auth:save  -- --workflow distributor-album-submit --url <distributor-upload-url>
npm run auth:check -- --workflow distributor-album-submit --url <distributor-upload-url>
```

## Manual checkpoints (never automated)

Browsy refuses to click any control listed in `safety-policy.json::never_click_text` or `never_click_selectors`. For this workflow that includes the fixture's `#btn-submit` ("Submit") and `#btn-release` ("Upload to stores").
