# Reusable workflow scaffolds

Browsy ships a registry of generic workflow shapes. Each scaffold defines what a
workflow expects to consume and what it captures, but **not** how a specific
client wants to use the result. The actual selectors, auth, and discovery for a
specific target site live under `workflows/<id>/` after the scaffold is
materialized for that site.

To browse the registry:

```bash
npm run workflow:scaffolds
```

To submit a workflow package:

```bash
npm run workflow:run -- --package examples/workflow-packages/<scaffold>.example.json --dry-run
```

If the scaffold has not been materialized, Browsy returns `blocked` with a
`selector_verification_required` action request telling the client to run
discovery first.

## Scaffolds

### `distributor-album-submit`
**Entity:** `album` — multi-track release uploaded to a music distributor.
Stops before the human-gated final submit.

- Canonical payload: `album.{title, artistName, releaseDate, language, genrePrimary, genreSecondary, recordLabel, upc, explicit, aiDisclosure}`, `tracks[].{trackNumber, trackTitle, songwriter, producer, performer, isrc, explicit, instrumental, aiDisclosure}`
- Required assets: `album_artwork`, `track_audio[]`
- Captured outputs: `external_release_url`, `smart_link_url`, `submission_status`, `review_page_screenshot`
- Safety: final submit, legal certification, paid extras, payment

### `distributor-single-submit`
**Entity:** `single` — single-track release uploaded to a music distributor.

- Canonical payload: `release.{title, artistName, releaseDate, language, genrePrimary, recordLabel, isrc, upc, explicit, aiDisclosure}`, `track.{trackTitle, songwriter, producer, performer, instrumental}`
- Required assets: `release_artwork`, `track_audio`
- Captured outputs: `external_release_url`, `smart_link_url`, `submission_status`, `review_page_screenshot`
- Safety: final submit, legal certification, paid extras, payment

### `smart-link-capture`
**Entity:** `smart_link` — capture an external smart-link / HyperFollow / landing page URL associated with a release.

- Canonical payload: `lookup.{release_id, release_title, artistName}`
- Required assets: none
- Captured outputs: `smart_link_url`, `smart_link_dashboard_url`, `capture_timestamp`
- Safety: none beyond defaults

### `smart-link-enrich`
**Entity:** `smart_link` — enrich an existing landing page with media, copy, social URLs, pre-save links.

- Canonical payload: `page.{smart_link_url, title, release_date, description, social_urls, streaming_urls, video_url}`
- Required assets: `profile_image`, `banner_image`, `cover_art`
- Captured outputs: `updated_fields`, `skipped_fields`, `before_screenshot`, `after_screenshot`
- Safety: final publish

### `artist-profile-pitch-or-update`
**Entity:** `artist_profile` — pitch a track to a platform or update artist profile fields. Stops before publish.

- Canonical payload: `artist.{artist_id, name, bio, profile_image, banner_image, social_urls}`, `pitch.{track_id, pitch_text, genre, mood, release_date}`
- Required assets: optional `profile_image`, `banner_image`
- Captured outputs: `profile_url`, `pitch_status`, `review_page_screenshot`
- Safety: final submit, publish

### `creator-platform-upload-schedule`
**Entity:** `video_upload` — upload a video to a creator platform and schedule a publish time.

- Canonical payload: `upload.{title, description, tags, category, visibility, scheduled_publish_at, audience}`
- Required assets: `video_file`, `thumbnail_image`
- Captured outputs: `external_video_url`, `video_id`, `scheduled_status`, `review_page_screenshot`
- Safety: final publish

### `social-platform-upload-schedule`
**Entity:** `social_post` — upload and schedule a post on a social platform.

- Canonical payload: `post.{caption, hashtags, location, scheduled_publish_at, target_pages}`
- Required assets: `media_file[]`
- Captured outputs: `scheduled_post_id`, `scheduled_status`, `review_page_screenshot`
- Safety: final publish

### `media-generation-download`
**Entity:** `media_asset` — generate or download media via a third-party tool. Never publishes; only generates and downloads.

- Canonical payload: `job.{entity_id, item_id, prompt, duration, aspect_ratio, style_guardrails, variants_requested, output_dir}`
- Required assets: optional `reference_image`
- Captured outputs: `job_id`, `prompt`, `result_url`, `downloaded_file_path`, `variant_paths`
- Safety: never publishes generated media

### `platform-link-harvest`
**Entity:** `external_links` — harvest the public URLs a platform created for an entity.

- Canonical payload: `lookup.{entity_id, entity_type, lookup_query}`
- Required assets: none
- Captured outputs: `external_urls`, `platform_ids`, `capture_timestamp`
- Safety: none beyond defaults

### `contact-form-submit`
**Entity:** `outreach_message` — fill an outreach/contact form. Stops before submit/send unless the workflow explicitly authorizes a live gated send.

- Canonical payload: `message.{name, email, subject, body}`
- Required assets: optional `attachment[]`
- Captured outputs: `submission_status`, `confirmation_url`, `review_page_screenshot`
- Safety: final submit, send

## Specific implementations vs. scaffolds

The scaffold names above are deliberately generic. Concrete implementations
target one site:

- `distrokid-album-submit` — a `distributor-album-submit` for DistroKid
- `distrokid-single-submit` — a `distributor-single-submit` for DistroKid
- `distrokid-hyperfollow-capture` — a `smart-link-capture` for HyperFollow
- `distrokid-hyperfollow-enrich` — a `smart-link-enrich` for HyperFollow
- `spotify-artist-pitch` — an `artist-profile-pitch-or-update` for Spotify
- `youtube-upload-schedule` — a `creator-platform-upload-schedule` for YouTube
- `meta-instagram-facebook-schedule` — a `social-platform-upload-schedule` for Meta
- `byteseed-video-generate` — a `media-generation-download` for ByteSeed
- `outreach-contact-form-submit` — a `contact-form-submit` for an outreach form

These specific implementations are scaffolded with `npm run init:workflow --
--id <name>`, then hardened with discovery + field-map verification before they
can run.

Browsy stays generic — it does not import client modules, write to client
databases, or interpret captured outputs.
