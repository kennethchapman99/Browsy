# Example workflow packages

These files are reference inputs for `npm run workflow:run`. They show the shape
of a Browsy workflow package for each reusable scaffold. **They are not tied to
any one client.** A client like Pancake Robot (or any other) might build packages
shaped like these — but Browsy itself never imports, references, or writes back
to that client.

Each example contains:

- a generic envelope (`workflow_id`, `source_system`, `entity_type`, `entity_id`,
  `mode`, `human_gate`, `capture_outputs`, `on_failure`, `return_contract_version`)
- a `canonical_payload` showing the shape of the workflow-specific data the
  scaffold consumes
- `assets` with `role` and a placeholder `path`

To try one (it will return a blocked result with `selector_verification_required`
until the workflow is discovered and the field map verified):

```bash
npm run workflow:run -- --package examples/workflow-packages/distributor-album-submit.example.json --dry-run
```

The output is written to `output/runs/<workflow_id>/<timestamp>/result.json`.

## Reusable scaffolds covered

| File | Scaffold |
|---|---|
| `distributor-album-submit.example.json` | distributor-album-submit |
| `distributor-single-submit.example.json` | distributor-single-submit |
| `smart-link-capture.example.json` | smart-link-capture |
| `smart-link-enrich.example.json` | smart-link-enrich |
| `artist-profile-pitch-or-update.example.json` | artist-profile-pitch-or-update |
| `creator-platform-upload-schedule.example.json` | creator-platform-upload-schedule |
| `social-platform-upload-schedule.example.json` | social-platform-upload-schedule |
| `media-generation-download.example.json` | media-generation-download |
| `platform-link-harvest.example.json` | platform-link-harvest |
| `contact-form-submit.example.json` | contact-form-submit |
