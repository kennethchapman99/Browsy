# Recording a brand-new Browsy automation

A repeatable, site-agnostic procedure for turning a workflow you can do by hand
into a safe, inspectable Browsy automation. This is the generic version of the
[Pancake Robot + DistroKid runbook](./pancake-distrokid-recording-validation.md);
use it for any new, unrelated target.

## The core idea: record **and** discover **and** enrich

A recording alone replays your motions, but it binds to whatever was on screen —
and we have repeatedly seen that **visible labels do not match what you actually
need to wire to on the backend.** Reliable automations come from three separate
layers, every time:

| Layer | How you produce it | What it gives you | The failure it prevents |
| --- | --- | --- | --- |
| **1. Intent** | Wizard → `AUTOMATION_REQUEST.md` + a [field-mapping instruction](../templates/automation-request/field-mapping-instruction-template.md) | What you want, in plain English: goal, inputs, value rules, what stays manual | The agent understands the clicks but not the *point* |
| **2. Observation** | Wizard Step 4 recorder → `events.json` + replay package | What you did, in order, across tabs/popups/uploads | Missing steps, multi-tab flows, "how do you even get there" |
| **3. Discovery** | `npm run discover -- --workflow <id> --url <page> --candidates` | The **real DOM** — actual selectors, `name`, `data-*`, `aria` — vs. the visible label | Wiring to a label that lies; brittle selectors |

> **Observation does not replace discovery.** The recorder sees the page like a
> human; discovery reads its guts. You need both, then you reconcile them into a
> verified field map.

## The procedure

### 1. Intake — run the wizard
```bash
npm run wizard
```
Describe the workflow in plain English. Let it write `AUTOMATION_REQUEST.md` and
scaffold `workflows/<id>/`. Define data sources, run inputs, repeat groups,
captured outputs, gates, and safety checkpoints here.

### 2. Enrich — write the field-mapping instruction
Copy
[`templates/automation-request/field-mapping-instruction-template.md`](../templates/automation-request/field-mapping-instruction-template.md)
to `workflows/<id>/field-mapping-instruction.md` and fill it in. This is the
single highest-leverage step for "make the automation understand what I want."

Map **only the fields that require action** — everything else accepts defaults.
For each mapped field, capture:
- the value or the rule (`if brand profile = X then "A" else "B"`),
- where a file comes from (a path pattern with `{item.id}` placeholders is fine),
- whether it is run-once, per-item, or set-once-applies-to-all,
- multi-step dialog click sequences (e.g. `Yes → dialog → "All of the audio" → Save`),
- the explicit **human checkpoint** where automation must stop,
- captured outputs to save back to the source system,
- **gotchas where the label ≠ the backend field.**

A real, worked example of this artifact:
[`examples/field-mapping-instruction-distrokid-album.md`](../examples/field-mapping-instruction-distrokid-album.md).

### 3. Authenticate first (if the target needs login)
```bash
npm run auth:save  -- --site <site> --url <login-url>
npm run auth:check -- --site <site> --url <logged-in-url>
```
Log in manually in the persistent profile, then close it. **Never record through
the login/OAuth itself** — keep auth separate from the business steps.

### 4. Record the business steps (wizard Step 4)
Start recording only after auth is valid (or explicitly skipped). Walk the real
workflow. **Stop before any Submit / Pay / Publish / Finalize / Release / Confirm
/ "I agree" / "I certify" boundary.** If a dangerous control appears and the
recorder does not flag it, discard the run and fix safety detection first.

### 5. Discover the real DOM — `--candidates`
```bash
npm run discover -- --workflow <id> --url <page-1> --candidates
npm run discover -- --workflow <id> --url <page-2> --candidates
```
Run this on **every** page the workflow touches. It writes ranked selector
candidates, semantic labels, screenshots, page text, and HTML — the ground truth
you reconcile the recording against.

### 6. Build the verified field map
Create `workflows/<id>/field-map.local.json` using **verified selectors only**.
Reconcile three things: the instruction doc's *meaning*, the recording's *what I
clicked*, and discovery's *what it actually is*. Prefer stable `data-testid` /
`name` / `aria` over visible text. Never fabricate selectors; mark unknowns as
`"(run discovery to find selector)"`.

### 7. Dry-run and review
```bash
npm run run -- --workflow <id> --manifest workflows/<id>/manifest.example.json --dry-run
```
Review `run-log.json`, `filled-fields.json`, `skipped-fields.json`,
`errors.json`, and screenshots. Dry-run is the default and must never take a
dangerous action.

### 8. Human-gated live run (only after the above is clean)
Live runs still block final actions unless explicitly and safely approved at the
checkpoint you documented in step 2.

## What carries over to every new automation

The safety model, dry-run-first default, lifecycle states, and artifact contract
are **site-agnostic** — they don't change per target. What changes per site is
only: auth, the recorded steps, and the verified field map. So the muscle memory
is always:

```text
wizard → enrich (field-mapping instruction) → auth → record → discover --candidates
       → verify field-map → dry-run → human-gated live
```

## Checklist

- [ ] `AUTOMATION_REQUEST.md` written via the wizard
- [ ] `field-mapping-instruction.md` filled (only action-requiring fields)
- [ ] Conditional rules written as `if/then/else`
- [ ] Multi-step dialogs written as ordered clicks
- [ ] Auth saved + checked (login kept separate from recording)
- [ ] Step 4 recording stops before any dangerous boundary
- [ ] `discover --candidates` run on every page touched
- [ ] `field-map.local.json` uses verified selectors only
- [ ] Dry-run reviewed; skips/errors understood
- [ ] Human checkpoint + captured outputs documented
- [ ] Label-vs-backend gotchas captured
