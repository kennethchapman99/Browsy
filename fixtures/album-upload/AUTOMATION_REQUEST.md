# Browsy Automation Request

## 1. Workflow name

`album-upload`

## 2. Goal

Upload an album to DistroKid. Fill album-level fields once (artist name, release title, genre, label, release date, cover art). Then for each track in the manifest, add a track section and fill per-track fields (title, audio file, track number, songwriter, explicit flag). Stop before any final release, legal certification, or payment action.

## 3. Target websites / pages

| Purpose | URL | Requires login? | Notes |
| --- | --- | --- | --- |
| Upload page | https://distrokid.com/upload | yes | Must be logged in; use saved session state |

## 4. Existing APIs, files, or local systems

| Name | Type | Usage | Contains | Example path | Required |
| --- | --- | --- | --- | --- | --- |
| Local album folder | local folder | source of truth | album metadata, track audio files, cover art | ./fixtures/album-upload | yes |

```json
[
  {
    "name": "Local album folder",
    "type": "local_folder",
    "examplePath": "./fixtures/album-upload",
    "contains": "album metadata, track audio files, cover art",
    "required": true,
    "usage": "source of truth"
  }
]
```

## 5. Input data contract

```json
{
  "id": "ALBUM_001",
  "album": {
    "artistName": "Pancake Robot",
    "releaseTitle": "Breakfast Beats",
    "primaryGenre": "Children's Music",
    "language": "English",
    "releaseDate": "2026-06-26",
    "labelName": "Figment Factory",
    "albumArtPath": "./album-cover.png",
    "explicit": false
  },
  "tracks": [
    {
      "trackNumber": 1,
      "trackTitle": "Tiny Robot Parade",
      "audioPath": "./01-tiny-robot-parade.wav",
      "songwriter": "Figment Factory",
      "performer": "Pancake Robot",
      "explicit": false,
      "instrumental": false
    }
  ],
  "dryRun": true
}
```

## 5a. Runtime variables

```json
{
  "input": [],
  "captured": [],
  "derived": []
}
```

## 5b. Repeat groups

```json
{
  "repeatGroups": [
    {
      "name": "tracks",
      "source": "tracks[]",
      "itemName": "track",
      "sectionDescription": "Per-track song entry section — each track gets its own expandable row",
      "repeatAction": {
        "type": "click",
        "selector": "[data-testid='add-track']",
        "description": "Click '+ Add another song' to add a new track section before filling per-track fields",
        "discover": false
      },
      "stopCondition": "index >= tracks.length",
      "globalFields": [
        "album.artistName",
        "album.releaseTitle",
        "album.primaryGenre",
        "album.language",
        "album.releaseDate",
        "album.labelName",
        "album.albumArtPath"
      ],
      "itemFields": [
        { "name": "trackTitle",   "source": "track.trackTitle",   "description": "Track title text field" },
        { "name": "audioUpload",  "source": "track.audioPath",    "description": "WAV or MP3 audio file upload" },
        { "name": "trackNumber",  "source": "track.trackNumber",  "description": "Track number / order field" },
        { "name": "songwriter",   "source": "track.songwriter",   "description": "Songwriter / composer credit field" },
        { "name": "explicit",     "source": "track.explicit",     "description": "Explicit lyrics checkbox" }
      ]
    }
  ]
}
```

## 6. Desired workflow steps

1. Navigate to the upload page (session cookie already set).
2. Fill album-level fields once: artist name, release title, genre, language, release date, label name.
3. Upload album artwork once (global asset, not per-track).
4. For each track in `tracks[]`:
   a. If not the first track, click `+ Add another song` to add a new track section.
   b. Fill track title, track number, songwriter, and explicit flag.
   c. Upload the track audio file.
5. Stop before final release / payment / legal certification. Human checkpoint required.

## 7. Fields to fill or upload

| Field / action | Source in input | Website field/page | Scope / rule |
| --- | --- | --- | --- |
| Artist name | `album.artistName` | Artist name input | global / fill once |
| Release title | `album.releaseTitle` | Album title input | global / fill once |
| Primary genre | `album.primaryGenre` | Genre dropdown | global / fill once |
| Language | `album.language` | Language dropdown | global / fill once |
| Release date | `album.releaseDate` | Date picker | global / fill once |
| Label name | `album.labelName` | Label name input | global / fill once |
| Album artwork | `album.albumArtPath` | Artwork file upload | global / upload once |
| Track title | `track.trackTitle` | Track title input (per-section) | item-level / repeat per track |
| Audio file | `track.audioPath` | Audio file upload (per-section) | item-level / upload per track |
| Track number | `track.trackNumber` | Track number input (per-section) | item-level / repeat per track |
| Songwriter | `track.songwriter` | Songwriter input (per-section) | item-level / repeat per track |
| Explicit flag | `track.explicit` | Explicit checkbox (per-section) | item-level / repeat per track |

## 8. Actions that must stay manual

- Final submit / release
- Payment or purchase
- Legal certification checkboxes (I certify I own all rights...)
- Upload to stores
- Any action labelled "Distribute", "Release", or "Send to stores"

## 9. Human checkpoints

- Stop before final release / payment / legal certification. Human must review all filled fields, check the legal certification checkbox, and click final submit.

## 10. Authentication plan

- manual-save-state — session cookie saved after first manual login; loaded by Playwright context

## 11. Discovery needs

- (Discovery completed against local fixture at fixtures/album-upload/index.html)

## 12. Safety policy

```json
{
  "dry_run_default": true,
  "pause_at_end_default": true,
  "never_click_text": [
    "Submit",
    "Release",
    "Upload to stores",
    "Distribute",
    "Send to stores",
    "Pay",
    "Purchase",
    "Checkout",
    "Finalize"
  ],
  "never_click_selectors": [
    "[data-testid='final-submit']",
    "[data-testid='final-release']",
    "[data-testid='legal-certification']"
  ],
  "manual_only_categories": [
    "final submission",
    "legal certification",
    "payment",
    "destructive action"
  ]
}
```

## 13. Output artifacts expected

- `run-log.json` — timestamped log of every fill and upload action
- `filled-fields.json` — list of fields filled with values
- `skipped-fields.json` — any fields skipped and why
- `errors.json` — any fields that errored
- `run-review.md` — human-readable run summary
- `screenshot-before-submit.png` — screenshot of filled form before final submit checkpoint

## 14. Test commands expected

```
node scripts/acceptance-run-plan.mjs
node scripts/acceptance-repeat-groups.mjs
```

## 15. Acceptance criteria

- Album-level fields are filled exactly once before any track sections are touched.
- Album artwork is uploaded exactly once (global asset).
- For a 2-track manifest, exactly 2 track sections are filled.
- For a 12-track manifest, "Add another song" is clicked 11 times (first section exists by default).
- Per-track audio file is uploaded once per track section.
- The run stops before final submit; a human checkpoint is the last step.
- Final submit, "Upload to stores", and legal certification are never clicked by automation.
- A screenshot is saved before the human checkpoint.
- Run artifacts (log, filled-fields, errors, review) are written to the run directory.

## 16. Narrated walkthrough

Navigate to the DistroKid upload page (already logged in). The form starts with album-level fields at the top — fill artist name, release title, genre, language, release date, and label name in order. Then upload the album artwork using the artwork file input. Below the album section is a track list area starting with one empty track row. Fill that first track's title, upload its audio file, set the track number and songwriter, check or uncheck explicit. For each additional track, click "+ Add another song" to reveal a new track row, then fill it the same way. When all tracks are done, stop. Do not click Submit, Release, or any legal certification checkbox. Take a screenshot and hand off to the human for final review.
