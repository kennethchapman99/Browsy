# DistroKid controlled dry-run — analysis & decision

**Date:** 2026-05-25
**Branch:** `feat/observation-ingestion`
**Sprint context:** Sprint 4 (capture-side visual evidence) just landed. The
operator checklist at [distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md)
is the artifact that authorized a controlled real-site capture.

## Verdict — blunt

**DO NOT PROCEED to automation generation.**

The controlled DistroKid dry run defined by
[distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md) **has not
been executed.** No event log, screenshot directory, DOM-snapshot directory,
or preview Markdown referencing `distrokid.com` exists on this machine or in
this repository. The only DistroKid-named artifacts in the tree are:

- the procedure document itself,
- the local fixture `fixtures/distrokid-wizard/index.html` (styled to look like
  DistroKid; **not** distrokid.com),
- the example workflow under `examples/workflows/distrokid-album-upload/`,
- the acceptance-suite snapshots under
  `artifacts/test-runs/acceptance-distrokid-album-example/`.

None of these are a real-site dry-run capture. There is therefore nothing to
analyse against the criteria in `distrokid-controlled-dry-run.md`. The verdict
is forced — we cannot certify a capture we did not take.

## Evidence summary — what was searched

| Looked for | Where | Result |
|---|---|---|
| `*distrokid*events*` / `*distrokid*preview*` | repo + `/tmp` | none |
| Session dirs under `output/observations/_sessions/` referencing distrokid.com | grep | none — every session traces back to acceptance fixtures |
| Any JSON/MD containing the string `distrokid.com` | repo | only [docs/distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md), [docs/observation-real-world-readiness.md](observation-real-world-readiness.md), [docs/wizard-walkthrough-album-upload.md](wizard-walkthrough-album-upload.md), and [fixtures/album-upload/AUTOMATION_REQUEST.md](../fixtures/album-upload/AUTOMATION_REQUEST.md) — all *prose*, no captured events |
| Screenshots / DOM snapshots dated after Sprint 4 land that came from `distrokid.com` | `output/observations/_sessions/*` | none — all sessions are synthetic fixtures (test-form / realistic-upload / album-upload) |
| Closest realistic capture | [docs/fixtures/observation-realistic-upload-events.json](fixtures/observation-realistic-upload-events.json) | 38 raw events, fixture-local URLs only, **0** `page_snapshot_captured` events because the golden is regenerated with screenshots/DOM disabled |

The synthetic `observation-realistic-upload` golden is the closest thing we
have. It is **explicitly disqualified** from this analysis by its own README,
which states "It is *not* a substitute for testing on a real SaaS site (shadow
DOM, popups, real auth, CAPTCHA, custom widgets)." Treating it as a stand-in
for DistroKid would defeat the entire purpose of the safety boundary.

## Safety findings

| Item | Status |
|---|---|
| Heuristic miss on a real DistroKid dangerous button (`isHardDangerous` P0) | **Cannot be evaluated.** No real-site events captured. |
| Browsy clicked something on DistroKid (P0) | **Cannot be evaluated.** No real-site session ran. |
| Credential string in event log (P0) | **Cannot be evaluated.** No real-site session ran. |
| Absolute filesystem path leak in event log (P0) | Acceptance suite still enforces this on synthetic captures; no real capture to check. |
| Wizard wrote outside `output/` or `workflows/` (P0) | **Cannot be evaluated.** No real-site session ran. |
| Dry run stopped before irreversible action | **N/A.** The dry run did not start. |

Critically, none of these are *clean*; they are *unanswered*. The point of
the dry run was to answer them. Until that happens, the safety contract that
governs automation generation is unproven against the real target.

## Capture quality

Cannot be evaluated against DistroKid. The capture pipeline itself
(`src/adapters/observation/visual-evidence-adapter.mjs` + `wizard/server.mjs`)
has been hardened in Sprint 4 and the
`acceptance:observation-evidence-capture` suite covers the surface end to
end. What we have is a pipeline that *should* perform well on a real site;
what we do not have is empirical evidence that it does.

Known capture gaps still in force, quoted from
[observation-real-world-readiness.md](observation-real-world-readiness.md)
without revision:

- **SPA navigation isn't tracked.** DistroKid's upload uses `history.pushState`;
  the per-stage `page_seen` events will collapse to one. Sprint 4 papers over
  this on the *evidence* side via `page_snapshot_captured`, but page-level
  structure still collapses.
- **Selectors stop at `#id` / `[name]`.** DistroKid uses React-generated IDs;
  expect many `low` selector confidences in the real capture.
- **No `output_candidate_detected` events.** Confirmation/UPC/ISRC text
  emitted post-action is not yet observed.
- **Wrapping `<label>` loses human text.** `chk-rights` style fields would
  surface labelled by their `name` attribute, not the user-visible string.
- **No auth story.** Manual login in the Playwright window only.

These are the things a real-site dry run was supposed to *measure*. We have
predictions, not measurements.

## Preview quality

Cannot be evaluated against DistroKid. The preview renderer
(`src/core/observation-preview.mjs`) produces a section-by-section
human-readable markdown view — verified against the realistic fixture in
[docs/fixtures/observation-realistic-upload-preview.md](fixtures/observation-realistic-upload-preview.md).
The preview was designed to be the trust gate; whether it actually serves
that purpose on a real DistroKid capture is the open question.

## Repeat-group quality

Cannot be evaluated against DistroKid. The realistic fixture clusters
`track_*_<n>` fields into structured `instances` correctly, and the
"+ Add another track" heuristic correctly fires on `+` markers and verb
forms (`add another / more / track / …`) while ignoring stage-advance
buttons like "Next: add tracks →". DistroKid's actual add-track button label
and DOM structure are unverified.

## Selector quality

Cannot be evaluated against DistroKid. The synthetic fixture surfaces every
field at `high` confidence because the fixture uses semantic IDs. DistroKid's
React-generated IDs would predictably degrade selector confidence; the
`acceptance:observation-real-world` suite checks that the *shape* of the
selector-candidate chain survives, but the *quality* of those selectors on
the real DOM is unknown.

## Dangerous-action quality

Cannot be evaluated against DistroKid. The heuristic catches
"Submit & Publish Release" on the fixture and was tightened in Sprint 3 so
that "Review release →" no longer trips it. The P0 question — "did
`isHardDangerous` miss any real DistroKid button that genuinely commits an
irreversible action" — is unanswered.

## Recommended next step

**Branch D — repeat (i.e., actually execute) the dry run with clearer operator
steps.**

This is the only valid next branch. Branches A / B / C all presuppose a
capture exists to either build on (A), correct heuristics against (B), or
visually enrich (C). None of them can be executed without first taking a
real capture.

Specifically:

1. Have a human operator follow
   [distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md) end to
   end against a *draft* DistroKid release they control.
2. Export `/tmp/distrokid-dry-run-events.json` and the preview markdown.
3. Move both into a place this analysis (and a future re-analysis) can
   reference — propose `docs/fixtures/distrokid-dry-run-1/` for the events
   JSON + preview Markdown, with the actual screenshot/DOM-snapshot
   directories left under `output/observations/_sessions/<sessionId>/` and
   *not* committed.
4. Re-run this analysis against the real artefacts. Verdict at that point
   will be A / B / C, not D again.

The operator checklist already exists; the failure mode here was procedural,
not technical — the procedure was written but not executed. Step 0 of any
"clearer operator steps" pass is just *running the procedure that already
exists*.

## Exact blockers before automation execution

These are the gates that must close *in addition to* a successful dry-run
capture, before any automation generated from a DistroKid capture can run
even in dry-run mode against the real site:

1. **A real DistroKid dry-run capture exists** and passes every Pass criterion
   in [distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md)
   §"Pass / fail criteria". (Open — capture not taken.)
2. **The preview markdown for that capture has been reviewed offline** at
   least once, the next day, by someone who walked the flow. (Open — depends
   on #1.)
3. **Every dangerous button DistroKid actually displayed appears in
   `manualOnlyActions`.** (Open — depends on #1.)
4. **SPA route changes have been verified.** Either (a) every walked stage
   surfaces a distinct `page_snapshot_captured` event whose
   `visibleTextSummary` matches what the operator saw, or (b) Slice D's SPA
   navigation shim has landed. (Open.)
5. **Selector confidence on the real DOM has been measured.** If a majority
   of selectors are `low`, automation must wait on either selector-discovery
   improvements or Atlas/Appshots enrichment (Branch C). (Open — depends on
   #1.)
6. **Output candidate detection is wired.** Without
   `output_candidate_detected`, automation has no captured-output gate to
   verify success against — Slice D explicitly calls this out as required
   before unattended replay. (Open — Sprint 5 work.)
7. **The wrapping-`<label>` fix has landed** if any of DistroKid's required
   confirmation checkboxes use wrapped labels. (Conditional on #1.)
8. **Automation generation runs in a separate session from capture**, against
   the exported JSON, never against DistroKid live. (Procedural; documented
   in `distrokid-controlled-dry-run.md` §"What you do AFTER the dry run" — to
   be honored when #1–#7 are met.)

Only when #1–#7 are green is the question "Branch A vs. B vs. C" even
askable. Today the answer is forced: Branch D, run the dry run that was
already scoped and authorized.

## Related documents

- [distrokid-controlled-dry-run.md](distrokid-controlled-dry-run.md) — the
  procedure that needs to actually be executed.
- [observation-real-world-readiness.md](observation-real-world-readiness.md)
  — what the capture pipeline is and isn't ready for, with the safety
  boundary rationale.
- [docs/fixtures/observation-realistic-upload-preview.md](fixtures/observation-realistic-upload-preview.md)
  — the closest available preview, against a synthetic fixture; **not**
  DistroKid.
