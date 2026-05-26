/**
 * Canonical observation event model for Browsy Browser Observation.
 *
 * Capture sources:
 *   chromeExtension     — recommended future user-facing source
 *   playwrightRecorder  — local automation-grade capture
 *   manualImport        — JSON import (advanced)
 *   atlasAssistedNotes  — user uses Atlas/ChatGPT manually and annotates findings
 *   mock                — developer-only demo/simulation mode
 *   futureAtlasNative   — placeholder only if official Atlas APIs become available
 */

export const CAPTURE_SOURCES = /** @type {const} */ ([
  'chromeExtension',
  'playwrightRecorder',
  'manualImport',
  'atlasAssistedNotes',
  'mock',
  'futureAtlasNative',
]);

/**
 * Every recorder event type emitted by Browsy Browser Observation.
 *
 * Grouping (informational — the runtime treats them as a flat enum):
 *   Lifecycle           session_started / capture_source_selected / session_paused
 *                       session_resumed / session_finished / user_note_added /
 *                       user_marked_repeat_group / user_marked_dangerous_action
 *   Page / tab          page_seen / page_opened / page_navigated / page_closed /
 *                       popup_opened / page_snapshot_captured
 *   Frame               frame_seen / frame_navigated / frame_detached
 *   DOM observation     field_detected / action_detected /
 *                       repeat_group_candidate_detected /
 *                       output_candidate_detected /
 *                       dangerous_action_candidate_detected
 *   Rich input          editor_input / rich_text_changed
 *   Clipboard           paste_detected / copy_detected / cut_detected
 *   File upload         file_selected / file_drop_detected / file_dropped
 *   Download            download_started / download_saved / download_failed
 */
export const EVENT_TYPES = /** @type {const} */ ([
  // lifecycle
  'session_started',
  'capture_source_selected',
  'session_paused',
  'session_resumed',
  'session_finished',
  'user_note_added',
  'user_marked_repeat_group',
  'user_marked_dangerous_action',

  // pages / tabs
  'page_seen',
  'page_opened',
  'page_navigated',
  'page_closed',
  'popup_opened',
  'page_snapshot_captured',

  // frames
  'frame_seen',
  'frame_navigated',
  'frame_detached',

  // DOM observation
  'field_detected',
  'action_detected',
  'repeat_group_candidate_detected',
  'output_candidate_detected',
  'dangerous_action_candidate_detected',

  // rich input
  'editor_input',
  'rich_text_changed',

  // clipboard
  'paste_detected',
  'copy_detected',
  'cut_detected',

  // file upload
  'file_selected',
  'file_drop_detected',
  'file_dropped',

  // downloads
  'download_started',
  'download_saved',
  'download_failed',
]);

/**
 * Event types that contribute uploaded-file metadata. The package generator
 * uses this to assemble the `requiredAssets` list.
 */
export const UPLOAD_EVENT_TYPES = ['file_selected', 'file_dropped'];

/**
 * Event types that contribute downloaded-file metadata. The package generator
 * uses this to assemble the `producedArtifacts` list.
 */
export const DOWNLOAD_EVENT_TYPES = ['download_started', 'download_saved', 'download_failed'];

/**
 * Create a normalized observation event.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.type — one of EVENT_TYPES
 * @param {string} opts.source — one of CAPTURE_SOURCES
 * @param {string} [opts.pageId]   — stable id for the page that emitted the event
 * @param {string} [opts.frameId]  — frame id when the event came from a sub-frame
 * @param {string} [opts.parentPageId] — opener pageId when relevant (popup_opened, etc.)
 * @param {string} [opts.pageUrl]
 * @param {string} [opts.pageTitle]
 * @param {string} [opts.selector]
 * @param {Array<{selector:string,kind:string,confidence:string}>} [opts.selectorCandidates]
 * @param {number} [opts.confidence]   — 0-1, if inferred
 * @param {*}      [opts.rawEvidence]
 * @param {string} [opts.userAnnotation]
 * @param {object} [opts.payload]      — event-specific data
 */
export function createEvent({
  sessionId, type, source,
  pageId, frameId, parentPageId,
  pageUrl, pageTitle, selector, selectorCandidates, confidence,
  rawEvidence, userAnnotation, payload = {},
}) {
  return {
    id: `${sessionId}-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    source,
    ...(pageId !== undefined && { pageId }),
    ...(frameId !== undefined && { frameId }),
    ...(parentPageId !== undefined && { parentPageId }),
    ...(pageUrl !== undefined && { pageUrl }),
    ...(pageTitle !== undefined && { pageTitle }),
    ...(selector !== undefined && { selector }),
    ...(selectorCandidates !== undefined && { selectorCandidates }),
    ...(confidence !== undefined && { confidence }),
    ...(rawEvidence !== undefined && { rawEvidence }),
    ...(userAnnotation !== undefined && { userAnnotation }),
    ...payload,
  };
}

/**
 * Validate that an event object conforms to the minimal schema.
 * Returns an array of error strings (empty = valid).
 *
 * Required for every event: id, sessionId, timestamp, type, source.
 * Per-type required keys are enforced below — keep this list narrow so the
 * recorder doesn't silently drop legitimate events for missing payload data.
 */
export function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') {
    return ['event must be an object'];
  }
  if (!event.id)        errors.push('missing id');
  if (!event.sessionId) errors.push('missing sessionId');
  if (!event.timestamp) errors.push('missing timestamp');
  if (!EVENT_TYPES.includes(event.type)) errors.push(`unknown type: ${event.type}`);
  if (!CAPTURE_SOURCES.includes(event.source)) errors.push(`unknown source: ${event.source}`);

  switch (event.type) {
    case 'page_opened':
    case 'page_navigated':
    case 'page_closed':
    case 'popup_opened':
      if (!event.pageId) errors.push(`${event.type}: missing pageId`);
      break;
    case 'frame_seen':
    case 'frame_navigated':
    case 'frame_detached':
      if (!event.pageId)  errors.push(`${event.type}: missing pageId`);
      if (!event.frameId) errors.push(`${event.type}: missing frameId`);
      break;
    case 'download_started':
    case 'download_saved':
    case 'download_failed':
      if (!event.pageId) errors.push(`${event.type}: missing pageId`);
      break;
    default:
      break;
  }
  return errors;
}

/**
 * Derive observation statistics from a list of events.
 * Used to drive UI counters from real event payloads rather than fabricated state.
 *
 * Backward compatible: the original counters (pages, fields, buttons,
 * repeatGroups, outputs, dangerous, checkpoints) keep their semantics.
 * New counters cover the additional recorder capabilities (popups, frames,
 * uploads, downloads, clipboard).
 */
export function deriveStatsFromEvents(events) {
  const stats = {
    pages: 0,
    fields: 0,
    buttons: 0,
    repeatGroups: 0,
    outputs: 0,
    dangerous: 0,
    checkpoints: 0,
    popups: 0,
    frames: 0,
    uploads: 0,
    drops: 0,
    pastes: 0,
    downloads: 0,
    richEdits: 0,
  };
  const seenPageKeys = new Set();
  const seenFrameIds = new Set();
  // Count a "page" the way a reviewer sees one: every distinct URL visited
  // in the workflow, plus every distinct opened tab/popup (so a single-page
  // app that never navigates still contributes one page per tab).
  const recordPage = ev => {
    const url = ev.pageUrl || '';
    const key = `${ev.pageId || 'p?'}::${url}`;
    if (seenPageKeys.has(key)) return;
    seenPageKeys.add(key);
    stats.pages++;
  };
  for (const ev of events) {
    switch (ev.type) {
      case 'page_seen':
      case 'page_navigated':
      case 'page_opened':
        recordPage(ev);
        break;
      case 'popup_opened':
        recordPage(ev);
        stats.popups++;
        break;
      case 'page_snapshot_captured':
        // Snapshots reflect intra-page state changes; do not inflate the
        // distinct-page counter, but a snapshot without a prior page_seen
        // is the only signal we have, so count once per distinct URL.
        recordPage(ev);
        break;
      case 'frame_seen':
      case 'frame_navigated':
        if (ev.frameId && !seenFrameIds.has(ev.frameId)) { seenFrameIds.add(ev.frameId); stats.frames++; }
        break;
      case 'field_detected':
        stats.fields++;
        break;
      case 'action_detected':
        stats.buttons++;
        break;
      case 'repeat_group_candidate_detected':
      case 'user_marked_repeat_group':
        stats.repeatGroups++;
        break;
      case 'output_candidate_detected':
        stats.outputs++;
        break;
      case 'dangerous_action_candidate_detected':
      case 'user_marked_dangerous_action':
        stats.dangerous++;
        break;
      case 'file_selected':
        stats.uploads++;
        break;
      case 'file_dropped':
        stats.uploads++;
        stats.drops++;
        break;
      case 'paste_detected':
        stats.pastes++;
        break;
      case 'editor_input':
      case 'rich_text_changed':
        stats.richEdits++;
        break;
      case 'download_started':
      case 'download_saved':
        stats.downloads++;
        break;
    }
  }
  return stats;
}
