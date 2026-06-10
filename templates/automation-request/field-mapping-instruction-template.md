# Field-mapping instruction — <workflow-id>

> **Purpose.** This is the *intent* artifact for a recording. The wizard captures
> what you clicked and discovery captures the real DOM, but this document says
> **what each field means, where its value comes from, and the rules behind it.**
> It is what gives a coding agent the best chance of wiring the automation to the
> right thing instead of guessing from a screen label.
>
> **Golden rule:** only map the fields that require an action. Everything else
> accepts the site's default. Do not document defaults you are happy to keep.

## How to use this template

1. Fill the metadata block.
2. List **run-once (global)** fields first.
3. Mark the boundary where **per-item (repeated)** steps begin and end.
4. Spell out every **conditional rule** in plain English (`if X then Y else Z`).
5. Spell out every **dialog / multi-click sequence** as ordered clicks.
6. Put an explicit **HUMAN CHECKPOINT** row where automation must stop.
7. Document any **post-checkpoint** steps and **captured outputs** to save back.

Pair this file with:
- `AUTOMATION_REQUEST.md` (the structured intake) — see the data contract there.
- the Step 4 recording (`events.json` + replay package) — what you did.
- `npm run discover -- --workflow <id> --url <page> --candidates` — the real DOM.

---

## Metadata

- Workflow id:
- Source system (where input data lives):
- Target site / page:
- Auth required?:
- One-sentence goal:

## Input the run is given

Describe the object an automation run receives (the "attached" entity, e.g. a
release, an order, a record). List only the parts this mapping reads.

```json
{
  "id": "ITEM_123"
}
```

## Repetition legend

| Marker | Meaning |
| --- | --- |
| Once per automation run | Filled a single time for the whole run (global) |
| Once per item | Filled again for each item in the run's repeat group |
| Set-once, applies-to-all | Filled on the first item, then propagated via a "copy to all" control |

---

## Run-once (global) fields

| Field (visible label) | What to enter / value rule | Repetition |
| --- | --- | --- |
| | | Once per automation run |
| | | Once per automation run |

**Conditional rules** (write each as `if … then … else …`):

-

**File / asset fields** — give the value *and* where the file is found (path
pattern is fine; use placeholders like `{item.id}`):

| Field | File source / path pattern | Repetition |
| --- | --- | --- |
| | | Once per automation run |

---

## Per-item (repeated) fields

> Everything between the markers below repeats **once per item** in the run.

### ▼ BEGIN PER-ITEM STEPS

| Field (visible label) | What to enter / value rule | Repetition |
| --- | --- | --- |
| | | Once per item |
| | | Once per item |

**Set-once, applies-to-all controls** (a "copy this to all items" link, and the
dialogs it triggers). Write the click sequence explicitly:

| Control | Click sequence | Effect |
| --- | --- | --- |
| | 1. Click `…` &nbsp; 2. Dialog → click `…` &nbsp; 3. Next dialog → click `…` | Propagates this value to all items |

**Multi-step dialogs** (e.g. a Yes/No that opens a sub-dialog). One row per flow:

| Trigger field | Step-by-step | Repetition |
| --- | --- | --- |
| | 1. Select `…` &nbsp; 2. Dialog opens → click `…` &nbsp; 3. Click `Save` | Once per item |

### ▲ END PER-ITEM STEPS

---

## Mandatory pre-checkpoint actions

Things that must be done before the human checkpoint (e.g. required checkboxes,
credits, attestations that are *safe* to set but not to submit):

-

---

## ⛔ HUMAN CHECKPOINT — automation stops here

State exactly where the automation pauses and what the human must verify before
anything irreversible. Automation must **never** click past this on its own.

- Stop at:
- Human verifies:
- Resume action (the click that crosses the line — stays manual unless explicitly approved):

---

## Post-checkpoint steps (manual or explicitly-approved only)

Steps that happen after a human approves. Document them so the flow is complete,
but they remain gated.

| Step | Action | Notes |
| --- | --- | --- |
| | | |

## Captured outputs to save back

What the target site generates that must be captured and written back to the
source system (URLs, IDs, confirmation numbers, smart links).

| Output | Where it appears | Save back to | Done-when |
| --- | --- | --- | --- |
| | | | |

## Gotchas

Anything the DOM cannot tell an agent — especially **where a visible label does
not match the value or field you actually need to wire to.**

-
