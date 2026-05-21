# Browsy Automation Request

Fill in this single file. A coding agent should read this file plus `AGENTS.md` and generate a completed automation harness.

## 1. Workflow name

`example-workflow`

## 2. Goal

Describe the outcome in plain English.

Example: Upload one music release to a distribution website up to final review, using metadata and files from a local manifest. Do not click final submit.

## 3. Target websites / pages

| Purpose | URL | Requires login? | Notes |
| --- | --- | --- | --- |
| Start page | https://example.com | yes/no |  |

## 4. Existing APIs or local systems

List APIs, CLIs, databases, folders, or local app endpoints that can provide or receive data.

| System | Type | Purpose | Auth/notes |
| --- | --- | --- | --- |
| Local app | API/DB/files | Source of truth / callback |  |

## 5. Input data contract

Describe the manifest or input file the automation will consume.

```json
{
  "id": "ITEM_123",
  "title": "Example title",
  "file_path": "output/example/file.ext",
  "callback_url": "http://localhost:3000/api/complete"
}
```

## 6. Desired workflow steps

Write the workflow in human terms. Include why each field or choice matters.

1. Open the start page.
2. Authenticate if needed.
3. Fill, upload, or select safe fields.
4. Stop before final action.
5. Save artifacts and logs.
6. Push result/status back to the local system if applicable.

## 7. Fields to fill or upload

| Field / action | Source in input | Website field/page | Rule / why |
| --- | --- | --- | --- |
| Title | `title` | unknown until discovery | Required display name |
| File upload | `file_path` | unknown until discovery | Upload the asset |

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

Choose likely auth mode:

- API key
- OAuth
- Playwright storage state
- Chrome real profile
- Chrome CDP
- OpenClaw browser control
- Manual login then save state

## 11. Discovery needs

Pages/URLs where the agent should capture DOM inventories:

- https://example.com/page

The generated harness should produce:

- discovered-fields.json
- discovered-fields.md
- screenshots
- HTML snapshot
- page text snapshot

## 12. Safety policy

Danger text/buttons/selectors:

```json
{
  "never_click_text": ["Submit", "Finalize", "Pay", "Purchase", "Release", "Send", "Delete"],
  "never_click_selectors": [],
  "manual_only_categories": ["legal", "payment", "final submission", "destructive action"]
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
npm run auth:save -- --workflow example-workflow
npm run auth:check -- --workflow example-workflow
npm run discover -- --workflow example-workflow
npm run run -- --workflow example-workflow --manifest examples/example/manifest.json --dry-run
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

Paste your narrated walkthrough here. Explain decisions, not just clicks.

Example:

> I choose clean/non-explicit because this brand is always clean unless the manifest says otherwise. I do not select the promotional pack because it is a paid extra. I stop before Continue because I want final review to remain manual.
