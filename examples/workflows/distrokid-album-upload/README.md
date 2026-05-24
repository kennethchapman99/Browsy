# DistroKid-like Album Upload — Browsy Example Workflow

This directory is an **example workflow** showing how the generic Browsy repeat-group engine can automate a multi-track music upload form. It is NOT a production DistroKid integration.

## What this demonstrates

- A form with album-level fields filled once (global fields)
- A repeating track section — first section pre-exists, additional sections added via button click
- Per-track audio file uploads
- Shared defaults (`songwriter`, `language`) applied to all tracks unless overridden
- Human checkpoint stopping before the final submit button
- All using the generic `data-browsy-field` / `data-browsy-item-section` / `data-browsy-item-field` selector strategy

## Files

| File | Purpose |
| --- | --- |
| `fixture.html` | DistroKid-like form with generic Browsy attributes |
| `sample-package.json` | Example automation package (2 tracks, global fields, defaults) |
| `workflow.json` | Workflow metadata |
| `assets/cover.png` | Placeholder cover art |
| `assets/track-01.wav` | Placeholder audio for track 1 |
| `assets/track-02.wav` | Placeholder audio for track 2 |

## How to run

```bash
npm run acceptance:distrokid-album-example
```

## Architecture note

Browsy core (`src/core/`) has no music-specific logic. This example workflow is just one application of the generic engine. A Salesforce form, a tax filing form, or a project submission form would use the same engine with different field names.
