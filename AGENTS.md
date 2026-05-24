# Browsy Agent Instructions — v0.3

Browsy is an automation project intake and harness factory.

Treat `AUTOMATION_REQUEST.md` plus `workflows/<workflow-id>/project.json` as the source of truth for the requested automation. Generate a safe, inspectable, deterministic automation harness. **Do not claim success when a step fails, a selector is unverified, or a live action has not been tested — never claim success unless tests have run and passed.** Use human checkpoints for final actions and never automate past them without explicit approval.

---

## Operating principles

1. **APIs first.** When a stable REST, GraphQL, or official integration API exists for the target action, prefer it.
2. **Playwright for deterministic browser steps.** Fill, select, upload, safe navigation click, screenshot, logging.
3. **Browser-agent adapter only when needed.** Use adapter-based browser control only when deterministic selectors are insufficient and the workflow explicitly needs semantic/browser-agent help.
4. **Atlas observation enriches discovery.** Use Atlas/Codex observation docs when available. Observation captures workflow meaning, gotchas, page state, labels, and validation behavior; Playwright discovery captures DOM and selector candidates.
5. **Do not guess selectors.** If observation and discovery are missing, document that selectors are unverified and run/ask for observation/discovery.
6. **External sites are execution targets, not source of truth.** Canonical project data lives in local project/package/manifest files and run artifacts.
7. **Human checkpoints for final actions.** Any action that is externally visible, financially consequential, legally binding, publishing-related, or otherwise high-impact must stay behind a manual-only checkpoint.
8. **Dry-run defaults to true.** Every generated automation must default to dry-run unless the user explicitly requests live execution and the safety policy allows it.
9. **Log everything.** Every run must produce run logs, filled fields, skipped fields, errors, screenshots, page text, HTML, and captured outputs when relevant.
10. **Run tests before reporting done.** Run the repo's relevant acceptance/smoke commands and report exact output.

---

## Separate the lifecycle stages

Do not collapse these into a one-off script:

1. Intake generation
2. Atlas/Codex observation
3. Canonical package/project generation
4. Discovery
5. Field-map candidate generation
6. Field-map verification
7. Harness scaffolding
8. Dry-run validation
9. Human review
10. Live gated run
11. Output capture
12. Promotion to reusable workflow

---

## Required generated workflow files

```text
workflows/<workflow-id>/
  project.json                     canonical project/readiness state
  workflow.yaml                    human-readable config
  workflow.json                    machine-readable config
  manifest.schema.json             JSON schema for run manifest/package
  manifest.example.json            example manifest values
  workflow-package.example.json    example automation package; do not call this package.json
  safety-policy.json               danger rules and checkpoints
  field-map.example.json           candidate/placeholder field map
  field-map.local.json.example     local verified-field-map template
  field-map.local.json             verified field map, created after discovery
  walkthrough.md                   workflow expert narrative
  observations/
    atlas-observation-template.md
    observation-YYYY-MM-DD.md
    observation-checklist.md
  fixtures/
    observed-form.html
    observed-review.html
    observed-success.html
  README.md
  run.mjs
  smoke-test.mjs
```

Generated runs write to:

```text
output/runs/<workflow-id>/<timestamp>/
```

Observation artifacts may also write to:

```text
output/observations/<workflow-id>/
```

---

## Data model rules

Keep these separate:

| Bucket | Rule |
| --- | --- |
| Global fields | Filled once per run |
| Repeated item fields | Filled once per item in a repeat group |
| Global assets | Uploaded once per run |
| Item assets | Uploaded once per repeated item |
| Captured outputs | Extracted from page text, URL, selectors, success pages, dashboards |
| Derived fields | Computed from input/captured data |
| External links | Captured URLs created/discovered by the target site |
| Gates | Downstream unlock rules that require captured outputs to exist and verify |

Do not let global fields leak into item fields. Do not let item fields leak into globals.

---

## Observation rules

Use `docs/atlas-codex-observation.md` and `templates/observation/atlas-observation-template.md`.

Each observation should capture:

- workflow id, date, observer, site/page, URL pattern, auth state
- visible labels and field groups
- global fields and repeated item fields
- add/remove item behavior
- file upload behavior
- buttons/actions and dangerous actions
- validation messages
- success indicators
- captured output candidates
- selector candidates
- screenshot, page text, and HTML snapshot paths
- unclear/gotcha notes
- recommended strategy: API, Playwright, browser-agent adapter, human checkpoint

Observation does not replace Playwright discovery. Use both.

---

## Safety baseline — hard rules

The following text must NEVER be clicked by automation under normal operation:

- Submit, Finalize, Release, Pay, Purchase, Checkout, Confirm order
- Upload to stores, Send to stores
- Continue & submit, Continue and submit, Save and submit
- Send, Delete, Remove, Publish
- I agree, I certify

The following categories must ALWAYS be skipped and recorded in `skipped-fields.json` unless there is an explicit human-approved final-action path and a new test proving the behavior:

- legal certification
- payment
- paid extras
- final submission
- high-impact publishing

Preserve dangerous-action gates in `safety-policy.json` and generated code.

---

## Selector quality rules

1. Prefer stable `data-testid` and `data-*` attributes.
2. Prefer `aria-label` when semantically stable.
3. Use stable `#id` only if not generated.
4. Use `[name]` as a fallback.
5. Use visible label mapping when Playwright can reliably bind label to control.
6. Use XPath or index-based selectors only as a last resort and document why.
7. Mark placeholder selectors as `"(run discovery to find selector)"`.
8. Never fabricate selectors.

---

## What to report when done

Return a structured final response:

**A. Files created or changed**

**B. New/updated data structures**

**C. Commands run**

```bash
npm run validate:request
npm run smoke
npm run smoke:browser
npm run test
```

Add targeted commands when relevant:

```bash
npm run acceptance:repeat-groups
npm run acceptance:automation-package
npm run acceptance:generic-repeat-package
npm run acceptance:wizard-package-gen
npm run acceptance:distrokid-album-wizard
npm run acceptance:project-lifecycle
```

**D. Test results**

**E. What was filled or generated**

**F. What was skipped for safety**

**G. What failed or remains unverified**

**H. Manual checkpoints**

**I. What still requires live Atlas observation**

Never summarize a step as “done” without reporting the actual outcome.

---

## Acceptance criteria for generated automations

- `npm run smoke` passes.
- Discovery writes readable `discovered-fields.json` and `discovered-fields.md`.
- Field-map candidates are generated when `--candidates` is passed.
- `run.mjs` imports/uses shared runtime or clearly documents why a scaffold is still draft-only.
- Dry-run does not take dangerous actions.
- `skipped-fields.json` records every skipped field and reason.
- `errors.json` records every failed field and selector tried.
- Captured outputs are stored in run artifacts.
- Gates block downstream stages until required captured outputs verify.
- The workflow README explains exactly how to run and verify the workflow.
- No placeholder success claims remain.
