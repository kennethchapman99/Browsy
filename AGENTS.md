# Browsy Agent Instructions — v0.2

Browsy is a developer-facing browser automation harness factory.

Treat `AUTOMATION_REQUEST.md` as the single source of truth for the requested automation. Generate a safe, inspectable, deterministic automation harness. **Do not claim success when a step fails or a selector is unverified.**

---

## Operating principles

1. **APIs first.** When a stable REST or GraphQL API exists for the target action, use it.
2. **Playwright for deterministic browser steps.** Fill, select, upload, safe navigation click, screenshot, logging.
3. **Adapter placeholders for dynamic flows.** Use `BrowserAgentAdapter` placeholder only when CSS selectors are genuinely unreliable. Never default to this — it requires human configuration.
4. **human checkpoints for final actions.** Any action that is externally visible, financially consequential, legally binding, or destructive must stay behind a manual-only human checkpoint.
5. **dry-run defaults to true.** Every generated automation must default to `--dry-run true` with no override unless the user explicitly sets `--dry-run false` AND `--allow-final-action`.
6. **Log everything.** Every run must produce `run-log.json`, `filled-fields.json`, `skipped-fields.json`, `errors.json`, screenshots, page text, and HTML snapshot.
7. **never claim success when selectors are missing.** If a selector is a placeholder, say so. Report what was filled, skipped, and failed.
8. **Never click dangerous actions.** Not even in tests. Not even with `--allow-final-action` unless the workflow safety policy explicitly permits it.
9. **Use the shared runtime.** Generated `run.mjs` files must use `src/core/workflow-runtime.mjs` primitives, not re-implement logging or artifact writing.
10. **Run smoke tests before reporting done.** Run `npm run smoke` and report the output.

---

## Agent workflow

When asked to build an automation:

1. Read `AUTOMATION_REQUEST.md` using `npm run validate:request`.
2. Run `npm run plan` to generate the build plan.
3. Run `npm run init:workflow -- --from-request` (or `--id <id>`) to scaffold workflow files.
4. Save auth if the target requires login: `npm run auth:save`.
5. Discover the live page DOM: `npm run discover -- --candidates`.
6. Review `field-map.candidates.md`. Pick verified selectors.
7. Write `workflows/<id>/field-map.local.json` with verified selectors only.
8. Implement `workflows/<id>/run.mjs` using `src/core/workflow-runtime.mjs`.
9. Run `npm run run -- --workflow <id> --dry-run` and review output.
10. Run `npm run smoke`.
11. Report exactly what was done, what succeeded, what was skipped, and what remains for a human.

---

## Required generated workflow files

```text
workflows/<workflow-id>/
  workflow.yaml              human-readable config
  workflow.json              machine-readable config (used by loadWorkflowConfig)
  manifest.schema.json       JSON schema for input data
  manifest.example.json      example manifest values
  safety-policy.json         danger rules (never_click_text, etc.)
  field-map.example.json     placeholder field map (from request fields table)
  field-map.local.json       verified field map (created after discovery)
  field-map.local.json.example  copy template
  walkthrough.md             narrated walkthrough
  README.md                  purpose, auth, commands, manual checkpoints, limitations
  run.mjs                    the automation runner (uses workflow-runtime)
  smoke-test.mjs             workflow-specific smoke checks
```

Generated runs write to:
```text
output/runs/<workflow-id>/<timestamp>/
```

---

## Safety baseline — hard rules

The following text must NEVER be clicked by automation under any circumstances:

- Submit, Finalize, Release, Pay, Purchase, Checkout, Confirm order
- Upload to stores, Send to stores
- Continue & submit, Continue and submit, Save and submit
- Send, Delete, Remove, Publish

These are enforced by `isDangerousText()` in `src/core/safety.mjs`. Do not bypass them.

The following field categories must ALWAYS be skipped and recorded in `skipped-fields.json`:

- `legal certification` — I certify / I agree / terms / rights
- `payment` — pay / purchase / billing / credit card
- `paid extras` — paid add-on / upgrade / premium / price
- `final submission` — any final submit action
- `destructive action` — delete / remove / wipe / purge

A workflow may add stricter rules. It must not loosen these without an explicit human-approved request AND a new test proving the behavior.

---

## Selector quality rules

1. Prefer `data-testid` and `data-*` attributes (stability ≥ 80).
2. Prefer `aria-label` (stability 75).
3. Use `#id` only for non-generated IDs (stability 70 stable, 40 generated).
4. Use `[name]` as fallback (stability 65).
5. Use `[placeholder]` only when nothing else is available (stability 50).
6. Use XPath or index-based selectors only as last resort — document why.
7. Mark placeholder selectors as `"(run discovery to find selector)"`. Never fabricate a selector.

---

## Auth baseline

Support these modes as documented in the request:

| Mode | Implementation |
|---|---|
| `manual-save-state` | `npm run auth:save`, saves Playwright storage state |
| `none` | No auth needed |
| `api-key` | Set in manifest or env var, pass via API adapter |
| `oauth` | Manual login, save state |

For browser auth: save state on each page load event, not only on browser close. Context shutdown can race against storage-state persistence.

---

## What to report when done

Return a structured final response:

**A. Files created or changed** (list every file)

**B. Commands to run**
```bash
npm run validate:request
npm run discover -- --workflow <id> --url <url> --candidates
npm run run -- --workflow <id> --dry-run
npm run smoke
```

**C. What was filled** (field names, types, selector used)

**D. What was skipped** (field name + reason)

**E. What failed** (field name + error message + selector tried)

**F. Manual checkpoints** (exactly what the human must do, and when)

**G. Smoke test output** (exact output of `npm run smoke`)

**H. Limitations and assumptions** (unverified selectors, missing auth, unresolved fields)

**Never summarize a step as "done" without reporting the actual outcome.**

---

## Acceptance criteria for generated automations

- `npm run smoke` passes (non-browser).
- Discovery writes readable `discovered-fields.json` and `discovered-fields.md`.
- Field map candidates are generated when `--candidates` is passed.
- `run.mjs` imports from `src/core/workflow-runtime.mjs` and uses its primitives.
- Dry-run does not take dangerous actions.
- `skipped-fields.json` records every field that was skipped and why.
- `errors.json` records every field that failed and the error message.
- The workflow README explains exactly how to run and verify the workflow.
- No placeholder success claims remain (`console.log('TODO')`, fake PASS, etc.).
- Any limitation is documented explicitly.
