# Browsy result contract — `automation-result-v1`

Every Browsy workflow run writes a single normalized result file:

```
output/runs/<workflow-id>/<timestamp>/result.json
```

Browsy is a harness — it produces this artifact and stops. Interpretation (does
the captured URL look right? should we re-run? should we surface this to a
human?) belongs to the calling client.

## Shape

```json
{
  "ok": true,
  "workflow_id": "distrokid-album-submit",
  "run_id": "distrokid-album-submit-2026-05-25T...",
  "source_system": "external_client",
  "entity_type": "album",
  "entity_id": "EXTERNAL_ENTITY_ID",
  "status": "dry_run_passed",
  "captured_outputs": {
    "external_release_url": { "status": "pending", "value": null }
  },
  "filled_fields": [],
  "skipped_fields": [],
  "errors": [],
  "screenshots": [],
  "artifact_paths": ["..."],
  "manual_checkpoints": [],
  "client_action_requests": [],
  "next_required_action": null,
  "return_contract_version": "automation-result-v1",
  "generated_at": "2026-05-25T20:30:00.000Z"
}
```

## Status values

| Status | Meaning | Exit |
|---|---|---|
| `dry_run_passed` | Dry-run completed without violating safety policy. | 0 |
| `live_run_gated` | Live execution paused at a human gate. Nothing dangerous was clicked. | 3 |
| `live_run_completed` | Live execution finished; all gates were satisfied. | 0 |
| `blocked` | Stopped because of safety policy, missing input, or unverified selector. | 4 |
| `failed` | Unexpected error or contract validation failure. | 2 |

`ok` is `true` for `dry_run_passed`, `live_run_gated`, `live_run_completed`;
`false` for `blocked` and `failed`.

## `captured_outputs`

Each entry is `{ status, value }`:

```json
{
  "external_release_url": { "status": "captured", "value": "https://..." },
  "smart_link_url": { "status": "pending", "value": null },
  "submission_status": { "status": "captured", "value": "in_review" }
}
```

`pending` is the default until the workflow proves a value. Clients should treat
`pending` as "Browsy could not capture this on this run."

## `client_action_requests`

Generic, client-neutral signals. **Never** `needs_ken_tasks` or any other
client-specific concept — use `type` + `severity` + `reason` so any client can
consume them.

Defined types:

| Type | When emitted |
|---|---|
| `human_decision_required` | Workflow needs a human decision (e.g. multiple candidate files). |
| `human_approval_required` | Final action requires explicit approval (mode=live + human_gate). |
| `selector_verification_required` | `field-map.local.json` missing or selectors unverified. |
| `missing_input` | Asset or required input is missing. |
| `unverified_capture` | A `capture_output` was requested but could not be captured. |
| `safety_block` | Workflow tried a dangerous action that the policy blocks. |

Severity is `blocking` or `advisory`.

Example:

```json
[
  {
    "type": "human_decision_required",
    "severity": "blocking",
    "reason": "Multiple candidate audio files were detected. Client must choose one before live execution.",
    "suggested_action": "Select release master audio",
    "related_field": "track.audio_file",
    "related_item_id": "TRACK_01"
  },
  {
    "type": "human_approval_required",
    "severity": "blocking",
    "reason": "Final submit is a high-impact action and requires approval.",
    "suggested_action": "Approve final submit in target browser session"
  },
  {
    "type": "selector_verification_required",
    "severity": "blocking",
    "reason": "Field selector changed or is unverified.",
    "suggested_action": "Run discovery and update verified field map"
  }
]
```

## `manual_checkpoints`

Records every safety stop Browsy made. Each entry has `type`, `reason`, and (for
final-action gates) `blocked_actions` listing the text Browsy refused to click.

## `next_required_action`

A short string the client can branch on:
- `scaffold_and_discover` — scaffold is known but not materialized
- `run_discovery_and_verify_field_map` — workflow has no verified field map yet
- `null` — nothing required from the client beyond reading the result

## What Browsy never writes here

- Anything client-specific. No release lifecycle states, no campaign IDs, no
  brand concepts, no platform-specific status enums.
- Anything implying Browsy will retry. `on_failure` is always
  `stop_and_return_blocked_result`.
- DB write directives. Browsy does not touch databases.
