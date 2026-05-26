# Browsy Automation Run Report

Generated: 2026-05-25T23:55:32.623Z
Mode: execute
Status: OK

## Package
- File: `/Users/kchapman/browsy/examples/workflows/distrokid-album-upload/sample-package.json`
- Workflow: `distrokid-album-upload`
- Target: DistroKid-like Album Upload
- Items: 2 across 1 repeat group(s)

## Target
- `/Users/kchapman/browsy/examples/workflows/distrokid-album-upload/fixture.html`

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
- `releaseTitle`: Sunrise Sessions
- `artistName`: Example Artist
- `primaryGenre`: Pop
- `language`: English
- `releaseDate`: 2026-09-01
- `labelName`: Independent
- `coverArt`: C:\fakepath\cover.png

## Repeated Item Groups Processed
- Item sections in DOM: 2
  - Item 1: trackTitle="Morning Light"
  - Item 2: trackTitle="Evening Calm"

## Upload Fields Handled
- global: coverArt → `cover.png`
- item[0]: audioFile → `track-01.wav`
- item[1]: audioFile → `track-02.wav`

## Defaults Applied
- item[0].songwriter = `Example Artist` (from defaults)
- item[0].language = `English` (from defaults)
- item[1].language = `English` (from defaults)

## Human Checkpoint
- **Checkpoint reached.** Human review required before any final action.

## Blocked Actions
- "Submit"
- "Confirm"
- "Finalize"
- "Distribute"
- "Release"
- "Send"

## Safety Statement
> **Final submit and irreversible actions were NOT clicked by this automation.**
> A human must review all filled fields and click final submit manually.
