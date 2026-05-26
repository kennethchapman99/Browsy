# DistroKid Upload Reference Example

This example documents the first Browsy use case: generating a safe browser harness for uploading a music release to DistroKid up to manual final review.

> **Example only.** Pancake Robot was the first external client to exercise this
> pattern. Browsy does not import, depend on, or write back to Pancake Robot —
> any client can produce a workflow package shaped like the one shown here.

## Pattern observed with an early client (Pancake Robot)

- Build a local manifest with audio, artwork, title, genre, language, lyrics, and callback data.
- Save DistroKid auth through a browser session.
- Discover the live DistroKid DOM.
- Create a selector map from verified selectors.
- Use Playwright for deterministic upload/fill actions.
- Leave final submit, paid extras, rights confirmations, and legal terms manual.

## Example selectors discovered

```text
#artwork
#js-track-upload-1
input[id^="title_"][placeholder="Track 1 title"]
#language
#genrePrimary
#genreSecondary
#not_coversong_radio_button_1
#js-not-explicit-radio-button-1
#js-explicit-radio-button-1
#js-not-cleaned-radio-button-1
#js-not-instrumental-radio-button-1
input[name^="ai_gate_"]
input[name^="ai_lyrics_"]
input[name^="ai_music_"]
```

## Manual-only

- Continue/final submit
- paid extras
- legal certifications
- terms agreement
- YouTube/Snap/TikTok rights confirmations
- songwriter real-name fields unless confidently sourced

## Why this belongs in Browsy

This is the canonical example of how Browsy should turn a narrated workflow plus DOM discovery into a safe, repeatable automation harness.
