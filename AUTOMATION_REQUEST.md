# Browsy Automation Request

## 1. Workflow name

`salesforce-reports`

## 2. Goal

submit

## 3. Target websites / pages

| Purpose | URL | Requires login? | Notes |
| --- | --- | --- | --- |
| Start page |  | yes | |

## 4. Existing APIs or local systems

| System | Type | Purpose | Auth/notes |
| --- | --- | --- | --- |
| Local files | files | Source of truth | |

## 5. Input data contract

```json
{
  "id": "ITEM_123"
}
```

## 6. Desired workflow steps

1. Open the start page.
2. Authenticate if needed.
3. Fill, upload, or select fields.
4. Stop before final action.
5. Save artifacts and logs.

## 7. Fields to fill or upload

| Field / action | Source in input | Website field/page | Rule / why |
| --- | --- | --- | --- |
| id | `id` | unknown until discovery | Unique item identifier |

## 8. Actions that must stay manual

- Final submit
- Payment or purchase
- Legal certification checkboxes
- Paid extras or add-ons
- Deletion or destructive changes

## 9. Human checkpoints

- Stop before final submit.
- Leave browser open by default.
- Provide `--no-pause` only for non-destructive dry-runs.

## 10. Authentication plan

- manual-save-state

## 11. Discovery needs

- https://d2l.okta.com/app/UserHome

The generated harness should produce:

- discovered-fields.json
- discovered-fields.md
- screenshots
- HTML snapshot
- page text snapshot

## 12. Safety policy

```json
{
  "never_click_text": [
    "Submit",
    "Finalize",
    "Pay",
    "Purchase",
    "Release",
    "Send",
    "Delete",
    "Checkout",
    "Continue & submit"
  ],
  "never_click_selectors": [],
  "manual_only_categories": [
    "Final submit",
    "Payment or purchase",
    "Legal certification checkboxes",
    "Paid extras or add-ons",
    "Deletion or destructive changes"
  ]
}
```

## 13. Output artifacts expected

Every run should save:

- run-log.json
- filled-fields.json
- skipped-fields.json
- errors.json
- screenshot-start.png
- screenshot-after-fill.png
- screenshot-final-review.png if reached
- page-text-snapshot.txt
- html-snapshot.html

## 14. Test commands expected

```bash
npm install
npm run smoke
npm run auth:save -- --workflow salesforce-reports
npm run auth:check -- --workflow salesforce-reports --url https://d2l.okta.com/app/UserHome
npm run discover -- --workflow salesforce-reports --url https://d2l.okta.com/app/UserHome
npm run run -- --workflow salesforce-reports --manifest workflows/salesforce-reports/manifest.example.json --dry-run
```

## 15. Acceptance criteria

- Auth works or failure path is clearly documented.
- DOM discovery works.
- Dry-run fills/uploads safe fields.
- Dangerous actions are blocked.
- Browser pauses before manual checkpoint.
- Logs/screenshots are saved.
- A coding agent can rerun tests and understand failures.

## 16. Narrated walkthrough

(No walkthrough recorded yet — run the wizard to add narration.)
