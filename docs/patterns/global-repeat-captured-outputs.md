# Pattern: Global + Repeated Items + Captured Outputs

This is the generic Browsy pattern for workflows where some data applies once, some data repeats per item, and later stages depend on outputs created or discovered by the target site.

## Shape

```json
{
  "globals": {
    "title": "Filled once for the run"
  },
  "assets": {
    "primaryImage": "./assets/image.png"
  },
  "repeatGroups": [
    {
      "id": "items",
      "itemLabel": "item",
      "sourceType": "manifest",
      "createAction": { "type": "click", "selector": "[data-browsy-action='add-item']" },
      "items": [
        {
          "fields": { "itemTitle": "Filled once for this item" },
          "assets": { "itemFile": "./items/item-01.pdf" }
        }
      ]
    }
  ],
  "capturedOutputs": [
    {
      "id": "publicUrl",
      "scope": "external_link",
      "source": "captured_from_success_page",
      "required": true,
      "verify": { "type": "manual_or_http_status" }
    }
  ],
  "gates": [
    {
      "id": "public_link_verified",
      "requires": ["captured.publicUrl", "checks.publicUrl.status == verified"],
      "unlocks": ["post_publish_steps"]
    }
  ]
}
```

## What belongs where

| Bucket | Meaning | Examples |
| --- | --- | --- |
| Global fields | Filled once for the whole run | account, title, date, category, owner |
| Global assets | Uploaded once for the whole run | primary image, master CSV, shared PDF |
| Repeated item fields | Filled once per item | product name, traveler name, student row, contact value |
| Item assets | Uploaded once per item | per-item file, attachment, image, audio |
| Captured outputs | Produced by the target site | public URL, assigned ID, confirmation number, status text |
| Gates | Conditions that unlock later stages | public URL verified, required ID captured, status equals approved |

## Repeated item creation

A repeat group needs an explicit create action unless the page renders all rows up front.

Examples:

- click “Add another item”
- upload a source file that creates rows
- expand a section for each record
- navigate through a wizard once per item

The action must be verified by observation and discovery before live execution.

## Ordering rules

Browsy preserves source order by default. If the target page reorders items, the observation doc must capture the rule and the run package should include the expected order.

## Captured outputs

External sites are execution targets, not the source of truth. If the target site creates a public URL, ID, confirmation number, or status, Browsy captures it back into project state and run artifacts.

Typical output artifacts:

```text
output/runs/<workflow-id>/<timestamp>/
  captured-outputs.json
  runtime-vars.json
  run-review.md
  page-text-snapshot.txt
  html-snapshot.html
```

## Downstream gates

Later automation stages should stay blocked until required captured outputs exist and verify.

Example:

```json
{
  "id": "public_link_verified",
  "requires": [
    "captured.publicUrl",
    "checks.publicUrl.status == verified"
  ],
  "unlocks": [
    "outreach",
    "post_publish_steps"
  ]
}
```

## Dry-run behavior

Dry-runs should:

- fill global fields
- create repeated item sections against a fixture or safe target
- upload fixture-safe files when possible
- skip high-impact final actions
- capture visible outputs when they already exist
- report missing captured outputs as blockers, not success

## Human checkpoints

Human checkpoints remain mandatory for irreversible, externally visible, or institutionally consequential final actions.

## Example workflow types

- album release with tracks
- ecommerce listing with product variants
- travel booking with multiple travelers
- school import with multiple students
- CRM update with multiple contacts
- conference submission with multiple speakers
- ad campaign with multiple creatives
