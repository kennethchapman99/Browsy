# Field-mapping instruction — distrokid-album-submit (worked example)

> A real, filled-in example of the
> [field-mapping instruction template](../templates/automation-request/field-mapping-instruction-template.md).
> Source: Figment Factory / Pancake Robot → DistroKid album upload.
>
> **Golden rule applied:** only the fields that require an action are mapped.
> Every other DistroKid field accepts its default.

## Metadata

- Workflow id: `distrokid-album-submit`
- Source system: Figment Factory (Pancake Robot release packages)
- Target site / page: DistroKid — `https://distrokid.com/new`
- Auth required?: yes (manual login, saved profile; never recorded)
- One-sentence goal: Upload a Figment Factory release to DistroKid up to the
  final review, capture the HyperFollow link, and stop before publishing.

## Input the run is given

A Figment Factory release attached to the automation run.

```json
{
  "album": { "id": "ALBUM_…", "releaseDate": "…", "brandProfile": "…" },
  "tracks": [ { "id": "TRACK_…", "trackNumber": 1, "title": "…" } ]
}
```

## Repetition legend

| Marker | Meaning |
| --- | --- |
| Once per automation run | Filled a single time for the whole release |
| Once per item | Filled again for each track in the release |
| Set-once, applies-to-all | Filled on track 1, then propagated via a "copy to all" link |

---

## Run-once (global) fields

| Field (visible label) | What to enter / value rule | Repetition |
| --- | --- | --- |
| Number of Songs | # of tracks in the Figment Factory release | Once per automation run |
| Artist / band name | if brand profile = default Pancake Robot profile → `"Pancake Robot"`; else → `"Figment Factory"` | Once per automation run |
| Release date | Release date from Figment Factory. **If that date is in the past, use the current date.** | Once per automation run |
| Record Label | `"Figment Factory"` | Once per automation run |
| Primary Genre | `"Alternative"` | Once per automation run |
| Album Title | Brand-profile display name from Figment Factory. If the release has multiple brand profiles, use `"Figment Factory"`. | Once per automation run |

**File / asset fields:**

| Field | File source / path pattern | Repetition |
| --- | --- | --- |
| Album Cover | `cover-art.png` from Figment Factory, e.g. `/Users/kchapman/PancakeRobot/output/release-packages/{album.id}/cover-art.png` | Once per automation run |

---

## Per-item (repeated) fields

### ▼ BEGIN PER-ITEM STEPS  (repeat once per track)

| Field (visible label) | What to enter / value rule | Repetition |
| --- | --- | --- |
| Song Title | Song title from Figment Factory | Once per item |
| Upload your audio file | Track audio from Figment Factory, filename like `<track#> - <song title>.mp3`, e.g. `/Users/kchapman/PancakeRobot/output/songs/{track.id}/audio/{track name}.mp3` | Once per item |

**Multi-step dialogs (per track):**

| Trigger field | Step-by-step | Repetition |
| --- | --- | --- |
| "Does this song include AI-generated music, vocals, or lyrics?" | 1. Select `Yes` &nbsp; 2. Dialog opens → click `All of the audio` &nbsp; 3. Click `Save` | Once per item |

**Set-once, applies-to-all controls** (do on the first track; propagates to all):

| Control | Click sequence | Effect |
| --- | --- | --- |
| Songwriter(s) real name | Enter First name = `Kenneth`, Last name = `Chapman` on track 1 | Sets the songwriter before copy-to-all |
| "Copy these songwriters to all tracks on this album" | 1. Click the link &nbsp; 2. Dialog → click `Do it` &nbsp; 3. Next dialog → click `Ok` | Applies songwriter to every track |

### ▲ END PER-ITEM STEPS

---

## Mandatory pre-checkpoint actions (run-once)

**Credits** — "Add Credits for each song on this release":

| Field | What to enter / value rule | Then |
| --- | --- | --- |
| Performer | Role = `Performer`; Name = `Pancake Robot` if default Pancake Robot brand profile, else `Figment Factory` | "Copy this performer to all tracks": click link → `Do it` → `Ok` |
| Producer | Role = `Executive Producer`; Name = `Kenneth Chapman` | "Copy this producer to all tracks": click link → `Do it` → `Ok` |

**Important checkboxes (mandatory):** check all 5 boxes.

---

## ⛔ HUMAN CHECKPOINT — automation stops here

- Stop at: after the mandatory checkboxes are checked, **before** `Continue`.
- Human verifies: metadata, audio, credits, and checkboxes are correct.
- Resume action: clicking `Continue` (stays manual unless explicitly approved).

---

## Post-checkpoint steps (manual or explicitly-approved only)

| Step | Action | Notes |
| --- | --- | --- |
| Continue | Click `Continue` | Once per automation run |
| Wait for upload | Let the release finish uploading | — |
| Mastering choice | On `…/new/mixea/?albumuuid=xxxx`, choose radio `Use my originals` | Once per automation run |
| Continue | Click `Continue` | — |
| Grab HyperFollow link | On `…/new/done/?albumuuid=xxxx`, click `Copy link` to copy the URL | Captured output |

## Captured outputs to save back

| Output | Where it appears | Save back to | Done-when |
| --- | --- | --- | --- |
| HyperFollow link | `…/new/done/?albumuuid=xxxx` → `Copy link` | Figment Factory (the release) | User sees confirmation in Figment Factory that it saved |

## Gotchas

- "Artist / band name", "Album Title", and "Performer" name all depend on the
  **brand profile** of the release, not on a single static value — read the rule,
  don't hardcode.
- Past release dates must be bumped to today, or DistroKid rejects the date.
- The "copy to all tracks" links each fire **two** confirmation dialogs (`Do it`
  then `Ok`); both must be handled or the propagation silently doesn't apply.
- The AI-disclosure control is a per-track flow with a nested dialog (`Yes` →
  `All of the audio` → `Save`), not a single click.
