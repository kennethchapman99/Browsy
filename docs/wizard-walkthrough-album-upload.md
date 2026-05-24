# Browsy Wizard Walkthrough: Album Upload Workflow

This guide shows exactly what a non-technical workflow expert enters into the Browsy wizard to define an album upload workflow (like DistroKid). No coding required.

## Before you start

1. Open a terminal and run: `npm run wizard`
2. Open `http://localhost:3333` in Chrome
3. You'll see the Browsy wizard — 10 steps to define your workflow

---

## Step 1: Mission

**Workflow name:** `album-upload`

**Goal:**
> Upload an album to a music distribution service. Fill album-level fields once (artist, title, genre, release date, artwork), then fill one track section per song (title, audio file, songwriter, track number). Stop before any final release action — a human must review and click submit.

---

## Step 2: Target Pages

Click **+ Add page** and fill in:

| Field | Value |
|---|---|
| Purpose | Upload page |
| URL | `https://distrokid.com/upload` |
| Requires login? | Yes |

---

## Step 3: Data Sources

Click **+ Add source** and fill in:

| Field | Value |
|---|---|
| Name | Local album folder |
| Type | local folder |
| Usage | source of truth |
| Example path | `./fixtures/album-upload` |
| Contains | album metadata, track audio files, cover art |
| Required | Yes |

---

## Step 4: Walkthrough (optional)

You can skip this or click the microphone and narrate:

> "Open the upload page. Fill in the album title, artist name, genre, language, release date, and label name. Upload the album artwork. Then for each track, fill in the title, upload the audio file, set the track number and songwriter. When all tracks are done, stop — don't click Submit or Upload to stores."

---

## Step 5: Variables (optional)

Leave empty unless you use `{{varName}}` in your URLs.

---

## Step 6: Run Inputs

This is where you define every field the automation will fill. Click **+ Add field** for each row:

### Album-level fields (filled once for the whole album)

| Field name | Type | Example value | Scope |
|---|---|---|---|
| `album.releaseTitle` | text | `Sunrise Sessions` | **album-level** |
| `album.artistName` | text | `Example Artist` | **album-level** |
| `album.primaryGenre` | text | `Pop` | **album-level** |
| `album.language` | text | `English` | **album-level** |
| `album.releaseDate` | date | `2026-09-01` | **album-level** |
| `album.labelName` | text | `Independent` | **album-level** |
| `album.coverArt` | **file path** | `./assets/cover.png` | **album-level** |

> Note: `album.coverArt` uses type **file path** — Browsy will upload this file to the artwork field.

### Shared defaults (filled for each track unless overridden)

| Field name | Type | Example value | Scope |
|---|---|---|---|
| `track.songwriter` | text | `Example Artist` | **shared default** |
| `track.language` | text | `English` | **shared default** |

> Shared defaults are used for every track. If a specific track has a different songwriter, that overrides the default.

### Per-track fields (filled once for each song)

| Field name | Type | Example value | Scope |
|---|---|---|---|
| `track.trackTitle` | text | `Morning Light` | **item-level / repeated** |
| `track.trackNumber` | text | `1` | **item-level / repeated** |
| `track.audioFile` | **file path** | `./assets/track-01.wav` | **item-level / repeated** |

---

## Step 7: Repeat Groups

Check the box: **Yes — part of this workflow repeats for each item in a list**

Click **+ Add repeat group** and fill in:

| Field | Value |
|---|---|
| Group name | `tracks` |
| Source array path | `tracks[]` |
| Item name (singular) | `track` |
| What browser section repeats? | Song/track entry section |
| What button text adds another section? | Add another track |
| CSS selector for that button | `[data-browsy-action="add-track"]` |

**Fields filled once for the whole workflow** (click + Add for each):
- `album.releaseTitle`
- `album.artistName`
- `album.primaryGenre`
- `album.language`
- `album.releaseDate`
- `album.labelName`
- `album.coverArt`

**Fields filled individually for each track** (click + Add for each):
- `track.trackTitle`
- `track.trackNumber`
- `track.audioFile`

---

## Step 8: Data Wiring

Leave empty for now, or describe what to do after the automation finishes.

---

## Step 9: Safety

The defaults are already set correctly. Browsy will never click:
- Submit, Finalize, Pay, Release, Upload to stores, etc.

The automation will stop at:
- "Stop before final release / payment / legal certification"

You can add more danger words if needed.

---

## Step 10: Generate

You'll see two tabs:

### AUTOMATION_REQUEST.md tab

Click **Write AUTOMATION_REQUEST.md** to write the full specification file. Your coding agent reads this to build the automation harness.

### Package JSON tab

Click the **Package JSON** tab to preview the automation package.

Click **Save Package JSON** to save the package to `workflows/album-upload/package.json`.

**What the saved package looks like:**

```json
{
  "workflowId": "album-upload",
  "target": {
    "name": "album-upload",
    "url": "https://distrokid.com/upload"
  },
  "globals": {
    "releaseTitle": "Sunrise Sessions",
    "artistName": "Example Artist",
    "primaryGenre": "Pop",
    "language": "English",
    "releaseDate": "2026-09-01",
    "labelName": "Independent"
  },
  "defaults": {
    "songwriter": "Example Artist",
    "language": "English"
  },
  "assets": {
    "coverArt": "./assets/cover.png"
  },
  "repeatGroups": [
    {
      "id": "tracks",
      "label": "Song/track entry section",
      "itemLabel": "track",
      "createAction": {
        "type": "click",
        "selector": "[data-browsy-action='add-track']"
      },
      "items": [
        {
          "fields": {
            "trackTitle": "Morning Light",
            "trackNumber": "1"
          },
          "assets": {
            "audioFile": "./assets/track-01.wav"
          }
        }
      ]
    }
  ],
  "humanCheckpoints": [
    {
      "id": "checkpoint-1",
      "label": "Stop before final release / payment / legal certification"
    }
  ]
}
```

**Next steps:**
1. Edit `workflows/album-upload/package.json` to add your real album data and additional tracks
2. Point the asset paths to your actual audio and image files
3. Run: `node -e "import('./src/core/package-runner.mjs').then(m => m.runPackage({ packagePath: './workflows/album-upload/package.json', fixturePath: './fixtures/album-upload/index.html', dryRun: true }))"`

---

## Architecture note

Browsy is completely generic. The fields above use album/track names as examples, but the engine doesn't know anything about music. The same wizard and runner work for:
- Tax filing forms with repeating dependent entries
- Project management tools with repeating task rows
- E-commerce product uploads with repeating variant entries
- Any multi-item form with repeated sections
