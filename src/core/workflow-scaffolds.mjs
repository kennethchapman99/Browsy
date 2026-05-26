// Browsy reusable workflow scaffolds.
//
// A scaffold is a generic, client-neutral workflow shape Browsy already knows
// how to package and validate. The actual selectors/auth/discovery live under
// workflows/<id>/ after the workflow is materialized.
//
// Browsy stays generic: scaffolds describe what a workflow expects to consume
// and what it captures, never which downstream product cares about the result.
//
// To enable a scaffold for a real target site, run:
//   npm run init:workflow -- --id <scaffold-id>
//   npm run discover -- --workflow <scaffold-id> --url <url> --candidates
//   (then verify selectors into workflows/<scaffold-id>/field-map.local.json)

export const SCAFFOLDS = [
  {
    id: 'distributor-album-submit',
    category: 'distributor-upload',
    entity_type: 'album',
    description: 'Upload an album-style multi-track release to a music distributor up to the human-gated final submit.',
    canonical_payload_fields: {
      album: ['title', 'artistName', 'releaseDate', 'language', 'genrePrimary', 'genreSecondary', 'recordLabel', 'upc', 'explicit', 'aiDisclosure'],
      tracks: ['trackNumber', 'trackTitle', 'songwriter', 'producer', 'performer', 'isrc', 'explicit', 'instrumental', 'aiDisclosure'],
    },
    required_assets: ['album_artwork', 'track_audio[]'],
    capture_outputs: ['external_release_url', 'smart_link_url', 'submission_status', 'review_page_screenshot'],
    safety_baseline: ['final_submit', 'legal_certification', 'paid_extras', 'payment'],
  },
  {
    id: 'distributor-single-submit',
    category: 'distributor-upload',
    entity_type: 'single',
    description: 'Upload a single-track release to a music distributor up to the human-gated final submit.',
    canonical_payload_fields: {
      release: ['title', 'artistName', 'releaseDate', 'language', 'genrePrimary', 'recordLabel', 'isrc', 'upc', 'explicit', 'aiDisclosure'],
      track: ['trackTitle', 'songwriter', 'producer', 'performer', 'instrumental'],
    },
    required_assets: ['release_artwork', 'track_audio'],
    capture_outputs: ['external_release_url', 'smart_link_url', 'submission_status', 'review_page_screenshot'],
    safety_baseline: ['final_submit', 'legal_certification', 'paid_extras', 'payment'],
  },
  {
    id: 'smart-link-capture',
    category: 'smart-link',
    entity_type: 'smart_link',
    description: 'Capture an external smart-link / HyperFollow / landing page URL associated with a release.',
    canonical_payload_fields: {
      lookup: ['release_id', 'release_title', 'artistName'],
    },
    required_assets: [],
    capture_outputs: ['smart_link_url', 'smart_link_dashboard_url', 'capture_timestamp'],
    safety_baseline: [],
  },
  {
    id: 'smart-link-enrich',
    category: 'smart-link',
    entity_type: 'smart_link',
    description: 'Enrich an existing smart-link / landing page with images, copy, video, social URLs, and pre-save links. Stops before public/persistent save.',
    canonical_payload_fields: {
      page: ['smart_link_url', 'title', 'release_date', 'description', 'social_urls', 'streaming_urls', 'video_url'],
    },
    required_assets: ['profile_image', 'banner_image', 'cover_art'],
    capture_outputs: ['updated_fields', 'skipped_fields', 'before_screenshot', 'after_screenshot'],
    safety_baseline: ['final_publish'],
  },
  {
    id: 'artist-profile-pitch-or-update',
    category: 'artist-profile',
    entity_type: 'artist_profile',
    description: 'Submit a profile pitch or update artist profile fields on a streaming/creator platform. Stops before submit/publish.',
    canonical_payload_fields: {
      artist: ['artist_id', 'name', 'bio', 'profile_image', 'banner_image', 'social_urls'],
      pitch: ['track_id', 'pitch_text', 'genre', 'mood', 'release_date'],
    },
    required_assets: [],
    capture_outputs: ['profile_url', 'pitch_status', 'review_page_screenshot'],
    safety_baseline: ['final_submit', 'publish'],
  },
  {
    id: 'creator-platform-upload-schedule',
    category: 'creator-upload',
    entity_type: 'video_upload',
    description: 'Upload a video to a creator platform (YouTube-like) and schedule a publish time. Stops before publish.',
    canonical_payload_fields: {
      upload: ['title', 'description', 'tags', 'category', 'visibility', 'scheduled_publish_at', 'audience'],
    },
    required_assets: ['video_file', 'thumbnail_image'],
    capture_outputs: ['external_video_url', 'video_id', 'scheduled_status', 'review_page_screenshot'],
    safety_baseline: ['final_publish'],
  },
  {
    id: 'social-platform-upload-schedule',
    category: 'social-upload',
    entity_type: 'social_post',
    description: 'Upload and schedule a post on a social platform (Instagram/Facebook/etc). Stops before publish.',
    canonical_payload_fields: {
      post: ['caption', 'hashtags', 'location', 'scheduled_publish_at', 'target_pages'],
    },
    required_assets: ['media_file[]'],
    capture_outputs: ['scheduled_post_id', 'scheduled_status', 'review_page_screenshot'],
    safety_baseline: ['final_publish'],
  },
  {
    id: 'media-generation-download',
    category: 'media-generation',
    entity_type: 'media_asset',
    description: 'Generate or download a media asset (video, image, audio) via a third-party tool. Never publishes; only generates and downloads.',
    canonical_payload_fields: {
      job: ['entity_id', 'item_id', 'prompt', 'duration', 'aspect_ratio', 'style_guardrails', 'variants_requested', 'output_dir'],
    },
    required_assets: ['reference_image?'],
    capture_outputs: ['job_id', 'prompt', 'result_url', 'downloaded_file_path', 'variant_paths'],
    safety_baseline: [],
  },
  {
    id: 'platform-link-harvest',
    category: 'link-harvest',
    entity_type: 'external_links',
    description: 'Harvest the public URLs that an external platform created for an entity (release/track/profile/page).',
    canonical_payload_fields: {
      lookup: ['entity_id', 'entity_type', 'lookup_query'],
    },
    required_assets: [],
    capture_outputs: ['external_urls', 'platform_ids', 'capture_timestamp'],
    safety_baseline: [],
  },
  {
    id: 'contact-form-submit',
    category: 'contact-form',
    entity_type: 'outreach_message',
    description: 'Fill an outreach/contact form. Stops before the final submit/send unless the workflow explicitly authorizes a live gated send.',
    canonical_payload_fields: {
      message: ['name', 'email', 'subject', 'body', 'attachments'],
    },
    required_assets: ['attachment[]?'],
    capture_outputs: ['submission_status', 'confirmation_url', 'review_page_screenshot'],
    safety_baseline: ['final_submit', 'send'],
  },
];

export function listScaffolds() {
  return SCAFFOLDS.map(s => ({ id: s.id, category: s.category, entity_type: s.entity_type, description: s.description }));
}

export function getScaffold(id) {
  return SCAFFOLDS.find(s => s.id === id) || null;
}
