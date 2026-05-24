# Atlas + Codex observation workflow

Browsy uses observation as a first-class project artifact. Observation does **not** replace Playwright discovery. It gives meaning to what discovery finds.

## Why this exists

A workflow expert should describe the workflow in plain English. They should not paste CSS selectors, dotted JSON paths, or guesses about a live site's hidden implementation.

Atlas/Codex observation captures what the real browser shows:

- visible field labels
- page state and validation behavior
- repeated sections and add/remove behavior
- file upload behavior
- button/action text
- dangerous actions
- success indicators
- generated IDs, public URLs, confirmation numbers, and other captured outputs
- gotchas that raw DOM discovery cannot infer

Codex then turns those observations into durable engineering artifacts:

- observation docs
- selector candidates
- field maps
- local fixtures
- Playwright adapters
- smoke tests
- dry-run and live-run harnesses

## Recommended flow

```text
Intake
→ Atlas observation
→ Playwright discovery
→ Field map candidates
→ Verified field map
→ Local observed fixtures
→ Dry run
→ Human checkpoint
→ Live gated run
→ Output capture
→ Promote reusable workflow
```

## Observation is not discovery

| Layer | Source | Purpose |
| --- | --- | --- |
| Human/Atlas observation | real browser state + expert meaning | intent, gotchas, page-state interpretation |
| Playwright discovery | DOM, screenshots, text, HTML | machine inventory and selector candidates |
| Field map verification | human/Codex review | durable selectors and safe execution plan |

## Required observation states

Capture examples when the workflow includes them:

- blank form
- partially filled form
- validation error
- repeated item added
- review/confirmation page
- success page
- post-submit dashboard or listing

## Required artifacts

Store paths to:

- screenshots
- page text snapshots
- HTML snapshots
- Atlas notes
- selector candidates
- validation examples
- success indicators

## Safety rules

Observation must identify final-submit, payment, legal, destructive, publishing, and externally visible actions. These stay behind human checkpoints. Browsy may prepare and preview; it must not silently perform the dangerous action.

## Where to store observations

```text
workflows/<workflow-id>/observations/
  atlas-observation-template.md
  observation-YYYY-MM-DD.md

output/observations/<workflow-id>/
  screenshot-*.png
  page-text-*.txt
  html-*.html
```

## Coding-agent contract

A coding agent should not guess selectors when both observation and discovery are missing. The correct next action is to ask for or create an observation, then run discovery, then build a verified field map.
