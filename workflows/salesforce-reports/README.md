# salesforce-reports

Download partner pipeline reports from salesforce

## Purpose

Download partner pipeline reports from salesforce

## Auth setup

Auth mode: `manual-save-state`

1. Log in manually once:
   ```bash
   npm run auth:save -- --workflow salesforce-reports --url https://d2l.okta.com/app/UserHome
   ```
2. Verify the session was saved:
   ```bash
   npm run auth:check -- --workflow salesforce-reports --url https://d2l.okta.com/app/UserHome
   ```

## Discovery

Run discovery to map the live page DOM:

```bash
npm run discover -- --workflow salesforce-reports --url https://d2l.okta.com/app/UserHome --candidates
```

Artifacts written to: `output/runs/salesforce-reports/<timestamp>/`

Review `field-map.candidates.md`, then create `workflows/salesforce-reports/field-map.local.json` with verified selectors.

## Dry-run

```bash
npm run run -- --workflow salesforce-reports --manifest workflows/salesforce-reports/manifest.example.json --dry-run
```

## Expected artifacts

Every run writes to `output/runs/salesforce-reports/<timestamp>/`:

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

- Final submit
- Payment or purchase
- Legal certification checkboxes
- Paid extras or add-ons
- Deletion or destructive changes

The browser pauses before any final action. Review the form, then complete manually.

## Known limitations

- Field selectors in `field-map.example.json` are placeholders. Run discovery and verify.
- Auth state must be saved before the first run on authenticated pages.
- This automation does not handle CAPTCHAs or dynamic login flows.

## Running smoke tests

```bash
npm run smoke
```
