# Browsy Automation Run Report

Generated: 2026-05-25T23:55:33.431Z
Mode: fixture
Status: OK

## Request
- File: `/Users/kchapman/browsy/fixtures/album-upload/AUTOMATION_REQUEST.md`
- Workflow: `album-upload` (album-upload)

## Manifest
- File: `/Users/kchapman/browsy/fixtures/album-upload/manifest.json`
- Items: 2

## Target
- `/Users/kchapman/browsy/fixtures/album-upload/index.html`

## Validation Summary
- No errors or warnings.

## Run Plan Summary
- Total steps: 10
- Global steps: 7
- Item steps: 10
- Upload steps: 3
- Checkpoint steps: 1

## Execution Summary
- Steps executed: 19
- Steps skipped: 0
- Human checkpoint reached: yes

## Global Fields Filled
- `releaseTitle`: Breakfast Beats
- `artistName`: Pancake Robot
- `primaryGenre`: Children's Music
- `language`: English
- `releaseDate`: 2026-06-26
- `labelName`: Figment Factory
- `albumArtPath`: C:\fakepath\album-cover.png

## Repeated Item Groups Processed
- Item sections in DOM: 2
  - Item 1: trackTitle="Tiny Robot Parade"
  - Item 2: trackTitle="Waffle Moon"

## Upload Fields Handled
- global: album.albumArtPath → `album-cover.png`
- track[0]: audioUpload → `01-tiny-robot-parade.wav`
- track[1]: audioUpload → `02-waffle-moon.wav`

## Human Checkpoint
- **Checkpoint reached.** Human review required before any final action.

## Blocked Actions
- "Submit"
- "Upload to stores"
- "Release"
- "Distribute"
- "Send to stores"

## Safety Statement
> **Final submit, "Upload to stores", legal certification, and distribution
> actions were NOT clicked by this automation.**
> A human must review all filled fields, complete any legal certifications,
> and click final submit manually.
