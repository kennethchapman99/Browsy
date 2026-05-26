# Browsy Build Status

**Updated:** 2026-05-26  
**Branch:** main  
**HEAD:** `7164e83` — feat: workflow package import + real registry execution (#9)

---

## PR #9 — Merged

`workflow-package-import-runtime` → `main` via PR #9

---

## Verification Passed

```
npm test                                           → 51 passed, 0 failed
browsy workflow import workflows/local-form-demo \
  --app smoke-app --app-name "Smoke App" \
  --register-app --workflow-id smoke-wf           → workflowRef + packagePath returned ✓
browsy workflow contract smoke-app.smoke-wf \
  --format json                                   → full contract JSON with endpoints ✓
```

---

## What Browsy Can Do Now

| Capability | Command / Endpoint |
|---|---|
| Register an app | `POST /api/apps/register` |
| Import a workflow package | `browsy workflow import <path> --app <id> --workflow-id <id>` |
| Get workflow contract | `browsy workflow contract <ref> --format json\|markdown` |
| Trigger a run (dry-run) | `browsy workflow run <ref> --mode preview` |
| Trigger a run (real) | `POST /api/apps/:appId/workflows/import` |
| Fetch run status | `GET /api/runs/:runId` |
| Fetch run artifacts | `GET /api/runs/:runId/artifacts` |
| Registry stores | `packagePath`, `packageWorkflowId`, full contract |
| run-executor | Loads and executes real imported package (not fixture) |

---

## What Remains Before Pancake Robot Can Call Browsy

1. **Auth / approval token** — live mode requires `approvalToken`; no auth layer yet. Pancake Robot needs a token strategy (env var, header, or skip for trusted internal use).
2. **Server startup** — Browsy API must be running (`npm start` or equivalent) before Pancake Robot can POST. No daemon/process management yet.
3. **Pancake Robot workflow package** — the actual `pancake-robot` workflow package needs to exist under `workflows/` and be imported with `browsy workflow import`.
4. **Payload schema agreement** — Pancake Robot must send the exact `requiredPayloadFields` from the contract. Use `browsy workflow contract <ref> --format json` to inspect.
5. **Run polling** — Pancake Robot needs to poll `GET /api/runs/:runId` until `processStatus` is terminal (`completed`/`failed`).

---

## Next Superprompt — Wiring Pancake Robot to Browsy

```
Goal: Wire Pancake Robot to call Browsy as its automation runtime.

Context:
- Browsy API: http://localhost:3001
- Workflow contract endpoint: GET /api/apps/:appId/workflows/:workflowId/contract
- Run trigger endpoint: POST /api/apps/:appId/workflows/import (or POST /api/workflows/:ref/runs)
- Run status: GET /api/runs/:runId
- Artifacts: GET /api/runs/:runId/artifacts
- Auth: none yet (add approvalToken: "" for live mode or use mode: "preview" to skip)

Tasks:
1. Import the pancake-robot workflow package into Browsy registry:
   browsy workflow import workflows/pancake-robot --app pancake-robot --app-name "Pancake Robot" --register-app --workflow-id main
2. Fetch the contract to confirm required payload fields:
   browsy workflow contract pancake-robot.main --format json
3. In Pancake Robot's caller code, POST a run with the correct payload shape.
4. Poll GET /api/runs/:runId every 2s until processStatus !== "running".
5. Fetch artifacts and surface output to the user.
6. Write an acceptance test: scripts/acceptance-pancake-robot-integration.mjs
```

---

## Risks / Unknowns

- `hasRealExecutor: false` on `local-form-demo` package — the smoke workflow has no real executor module. Pancake Robot's package must export a valid `executor.mjs`.
- Registry is local filesystem (`registry/` dir, gitignored). No persistence across machines or restarts beyond the flat JSON files in that dir.
- No versioning enforcement — re-importing same `workflowId` will overwrite. Semver bumping is manual.
- `run-executor.mjs` dynamically imports the package path — if Browsy is deployed remotely, absolute local paths break. All paths must be relative to Browsy's install root.
