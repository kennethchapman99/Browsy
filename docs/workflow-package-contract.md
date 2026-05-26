# Browsy workflow package contract

Browsy is a generic harness factory. Any external client (Pancake Robot or
otherwise) can submit a **workflow package** describing what they want Browsy to
do, and Browsy will validate it, run it (or dry-run it), and return a normalized
result. Browsy never embeds client business logic, never writes to client
databases, and never interprets captured outputs — those concerns belong to the
calling client.

## Envelope

```json
{
  "workflow_id": "distrokid-album-submit",
  "source_system": "external_client",
  "entity_type": "album",
  "entity_id": "EXTERNAL_ENTITY_ID",
  "mode": "dry_run",
  "human_gate": true,
  "manifest_path": "path/to/client/manifest.json",
  "canonical_payload": {},
  "assets": [],
  "capture_outputs": [
    "external_release_url",
    "smart_link_url",
    "submission_status",
    "review_page_screenshot"
  ],
  "on_failure": "stop_and_return_blocked_result",
  "return_contract_version": "automation-result-v1"
}
```

### Required fields

| Field | Notes |
|---|---|
| `workflow_id` | Names a reusable scaffold or a materialized workflow under `workflows/<id>/`. |
| `source_system` | Free-form string identifying the calling system (`"external_client"` is fine). |
| `entity_type` | The thing being acted on (`album`, `single`, `smart_link`, ...). |
| `entity_id` | Client-owned ID for the entity. Browsy stores it verbatim in the result. |
| `mode` | `dry_run` (default) or `live`. |

### Optional fields

| Field | Notes |
|---|---|
| `human_gate` | When `true` and `mode=live`, Browsy stops at the final-action gate and emits `human_approval_required`. Default `true`. |
| `manifest_path` | Path to an external JSON manifest. Browsy reads it into `canonical_payload` (file values are the base, inline values override). |
| `canonical_payload` | Inline workflow-specific data. Browsy passes this to the reusable workflow without inspecting it. |
| `assets` | Array of `{ role, path?, url? }` entries describing files to upload. Browsy flags entries with neither `path` nor `url` as `missing_input`. |
| `capture_outputs` | Names of values Browsy will try to capture during the run. Each starts as `{ status: "pending", value: null }` and is updated when captured. |
| `on_failure` | Currently only `stop_and_return_blocked_result`. Browsy never retries blindly. |
| `return_contract_version` | Must be `automation-result-v1` if present. |

### Forbidden fields

Browsy rejects packages containing any of these (they would mean the client is
trying to smuggle non-Browsy responsibilities into the package):

- `db_write`, `database_write` — Browsy never writes to a database
- `sql`, `connection_string` — Browsy is not a SQL driver

## Reusable workflow scaffolds

See [docs/reusable-workflows.md](reusable-workflows.md). The current scaffolds
are: `distributor-album-submit`, `distributor-single-submit`,
`smart-link-capture`, `smart-link-enrich`, `artist-profile-pitch-or-update`,
`creator-platform-upload-schedule`, `social-platform-upload-schedule`,
`media-generation-download`, `platform-link-harvest`, `contact-form-submit`.

## Running a package

```bash
npm run workflow:run -- --package examples/workflow-packages/distributor-album-submit.example.json --dry-run
```

Browsy writes `output/runs/<workflow_id>/<timestamp>/result.json` and prints the
path on stdout. Exit codes:

| Exit | Meaning |
|---|---|
| 0 | `dry_run_passed` or `live_run_completed` |
| 2 | validation failure or unexpected error |
| 3 | `live_run_gated` (expected human gate; machine-readable status) |
| 4 | `blocked` (safety / missing input / unverified selector) |

## What Browsy does with the package

1. Validates the envelope.
2. Resolves the workflow_id against the scaffold registry and `workflows/<id>/`.
3. Loads `canonical_payload` (inline + `manifest_path`).
4. Checks `assets` for `path`/`url`. Missing entries → `missing_input`.
5. Checks for `field-map.local.json`. Missing → `selector_verification_required`.
6. If `mode=live` and `human_gate=true`, emits `human_approval_required` and
   records the manual checkpoint.
7. Records every requested `capture_output` as `pending`. Only the run itself
   can flip these to a captured value.
8. Writes `result.json` (see [docs/automation-result-contract.md](automation-result-contract.md)).

Browsy stops at safety gates. It does not click final-submit, pay, release,
publish, send, or delete controls. See `src/core/safety.mjs` and
`workflows/<id>/safety-policy.json`.
