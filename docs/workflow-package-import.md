# Workflow package import

How to import a Browsy workflow package, run it via the registry, and integrate from external apps.

---

## What a workflow package is

A workflow package is a directory containing:

| File | Required | Purpose |
|------|----------|---------|
| `workflow.json` | Yes | Workflow config with `id` field |
| `manifest.schema.json` | Yes | JSON Schema for the input payload |
| `workflow-package.local.json` | Recommended | Execution entrypoint (real browser run) |
| `workflow-package.example.json` | Fallback | Example entrypoint if local is absent |
| `safety-policy.json` | Optional | Override safety rules |
| `field-map.local.json` | Optional | Field selectors for Playwright |

---

## Import a workflow package

### CLI

```bash
# App must already be registered (or use --register-app)
browsy workflow import ./workflows/my-workflow \
  --app my-app \
  --workflow-id my-workflow \
  --version 1.0.0

# Auto-register the app if it doesn't exist yet
browsy workflow import ./workflows/my-workflow \
  --app my-app \
  --app-name "My App" \
  --register-app \
  --workflow-id my-workflow \
  --version 1.0.0
```

Output is JSON:
```json
{
  "appId": "my-app",
  "workflowId": "my-workflow",
  "version": "1.0.0",
  "workflowRef": "my-app.my-workflow@1.0.0",
  "packagePath": "/abs/path/to/workflows/my-workflow",
  "requiredInputs": ["field1", "field2"],
  "requiredAssets": [],
  "supportedModes": ["preview", "live", "discover", "repair"],
  "hasRealExecutor": true
}
```

### HTTP API

```bash
# Register an app first
curl -X POST http://localhost:3001/api/apps/register \
  -H 'Content-Type: application/json' \
  -d '{"appId": "my-app", "name": "My App"}'

# Import the package
curl -X POST http://localhost:3001/api/apps/my-app/workflows/import \
  -H 'Content-Type: application/json' \
  -d '{
    "packagePath": "/abs/path/to/workflows/my-workflow",
    "workflowId": "my-workflow",
    "version": "1.0.0"
  }'
```

---

## How external apps call Browsy

### 1. Get the integration contract

```bash
browsy workflow contract my-app.my-workflow@1.0.0
# or: browsy workflow contract my-app.my-workflow@1.0.0 --format markdown
```

The contract JSON tells callers exactly what's needed:

```json
{
  "workflowRef": "my-app.my-workflow@1.0.0",
  "requiredPayloadFields": ["albumTitle", "artistName"],
  "optionalPayloadFields": ["releaseDate"],
  "requiredAssets": [],
  "supportedModes": ["preview", "live"],
  "approvalRequired": "live mode requires a non-empty approvalToken",
  "exampleCLIRun": "browsy workflow run my-app.my-workflow@1.0.0 --payload payload.json --mode preview",
  "exampleHTTPCall": "POST http://localhost:3001/api/workflows/my-app.my-workflow@1.0.0/runs",
  "exampleHTTPBody": { "payload": { "albumTitle": "<albumTitle>", "artistName": "<artistName>" }, "mode": "preview" },
  "runStatusEndpoint": "GET http://localhost:3001/api/runs/:runId",
  "artifactEndpoint": "GET http://localhost:3001/api/runs/:runId/artifacts"
}
```

### 2. Start a run

```bash
# CLI (preview = no final submit, safe for testing)
browsy workflow run my-app.my-workflow@1.0.0 \
  --payload payload.json \
  --mode preview

# HTTP
curl -X POST http://localhost:3001/api/workflows/my-app.my-workflow@1.0.0/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": { "albumTitle": "My Album", "artistName": "My Artist" },
    "mode": "preview"
  }'
# → { "ok": true, "runId": "run-...", "run": { ... } }
```

For live mode (real submission), add `"approvalToken": "<operator-token>"`.

### 3. Poll run status

```bash
curl http://localhost:3001/api/runs/<runId>
# → { "ok": true, "run": { "processStatus": "completed", "workflowOutcome": "success", ... } }
```

| `processStatus` | Meaning |
|-----------------|---------|
| `running` | In progress |
| `completed` | Finished (check `workflowOutcome`) |
| `rejected` | Payload or safety gate failed — see `validationErrors` |
| `failed` | Unexpected execution error |
| `stopped` | Manually stopped |

| `workflowOutcome` | Meaning |
|-------------------|---------|
| `success` | Assertions passed (or no assertions) |
| `failed` | One or more assertions failed |
| `stopped` | Run was stopped |

### 4. Fetch artifacts

```bash
curl http://localhost:3001/api/runs/<runId>/artifacts
# → { "ok": true, "runId": "...", "artifacts": [ { "name": "engine-result.json", "path": "...", "type": "json" } ] }
```

---

## Example: Pancake Robot (or any caller)

```javascript
// 1. Start a run
const res = await fetch('http://localhost:3001/api/workflows/my-app.my-workflow@1.0.0/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    payload: { albumTitle: 'My Album', artistName: 'My Artist' },
    mode: 'preview',
    callerId: 'pancake-robot',
  }),
});
const { runId } = await res.json();

// 2. Poll until complete
let run;
do {
  await new Promise(r => setTimeout(r, 1000));
  run = await fetch(`http://localhost:3001/api/runs/${runId}`).then(r => r.json()).then(r => r.run);
} while (run.processStatus === 'running');

console.log(run.processStatus, run.workflowOutcome);

// 3. Fetch artifacts
const { artifacts } = await fetch(`http://localhost:3001/api/runs/${runId}/artifacts`).then(r => r.json());
```

---

## Validation errors

When `processStatus === 'rejected'`, the `validationErrors` array explains what failed:

```json
{
  "validationErrors": [
    "missing required field: albumTitle",
    "live mode requires a non-empty approvalToken in the request"
  ]
}
```

Fix the payload or add an `approvalToken` and retry.
