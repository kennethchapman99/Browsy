# local-form-demo

Browsy automation workflow.

## Purpose

(No goal specified — fill in AUTOMATION_REQUEST.md ## 2)

## Auth setup

Auth mode: `manual-save-state`

1. Log in manually once:
   ```bash
   npm run auth:save -- --workflow local-form-demo --url <START_URL>
   ```
2. Verify the session was saved:
   ```bash
   npm run auth:check -- --workflow local-form-demo --url <START_URL>
   ```

## Discovery

Run discovery to map the live page DOM:

```bash
npm run discover -- --workflow local-form-demo --url <START_URL> --candidates
```

Artifacts written to: `output/runs/local-form-demo/<timestamp>/`

Review `field-map.candidates.md`, then create `workflows/local-form-demo/field-map.local.json` with verified selectors.

## Dry-run

```bash
npm run run -- --workflow local-form-demo --manifest workflows/local-form-demo/manifest.example.json --dry-run
```

## Expected artifacts

Every run writes to `output/runs/local-form-demo/<timestamp>/`:

- `run-log.json` — timestamped action log
- `filled-fields.json` — fields that were filled
- `skipped-fields.json` — fields that were skipped and why
- `errors.json` — any errors encountered
- `screenshot-start.png`
- `screenshot-after-fill.png`
- `page-text-snapshot.txt`
- `html-snapshot.html`

## Manual checkpoints ⚠

The following actions **must stay manual** and will never be executed automatically:

- (see safety-policy.json)

The browser pauses before any final action. Review the form, then complete manually.

## Known limitations

- Field selectors in `field-map.example.json` are placeholders. Run discovery and verify.
- Auth state must be saved before the first run on authenticated pages.
- This automation does not handle CAPTCHAs or dynamic login flows.

## Running smoke tests

```bash
npm run smoke
```
