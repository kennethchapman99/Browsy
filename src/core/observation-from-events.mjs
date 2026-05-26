/**
 * Convert a canonical event log (produced by the Browser Observation capture
 * pipeline — see [observation-events.mjs](./observation-events.mjs)) into a
 * shaped observation object the wizard's importer + Browsy's package
 * generator already understand.
 *
 * Hardened in Sprint 3 (2026-05-25) to deliver a clean handoff to automation
 * generation:
 *   - Deterministic event dedupe (input+change pairs, repeated initial-scan
 *     candidates) without losing meaningful changes.
 *   - Tighter dangerous/repeat-group heuristics that drop navigation false
 *     positives ("Next: add tracks", "Review release →") while keeping real
 *     irreversible actions ("Submit & Publish Release").
 *   - Repeat-group instance modeling: clusters `track_*_1` / `track_*_2` into
 *     a single `tracks` group with explicit instance metadata.
 *   - Suggested assertion candidates derived from manual-only actions, required
 *     fields, page-titles, and explicit `output_candidate_detected` events.
 *   - Optional screenshot/Appshot evidence metadata on pages — clearly marked
 *     unavailable until the capture pipeline emits them.
 *
 * Pure function — does not touch the network, file system, or random.
 */

import { deriveStatsFromEvents } from './observation-events.mjs';

const SOURCE_LABELS = {
  mock: 'Demo mode — simulated session, not real capture',
  chromeExtension: 'Chrome Extension',
  playwrightRecorder: 'Playwright Recorder — local automation-grade capture',
  manualImport: 'Manual import',
  atlasAssistedNotes: 'Atlas-assisted notes — manual annotations only',
  futureAtlasNative: 'Future Atlas native capture (placeholder)',
};

// ── Heuristic classifiers ────────────────────────────────────────────────────
//
// These run AFTER capture, on the shaped observation — they trim the raw
// event log's noise without touching the canonical record. The raw log keeps
// every candidate (so the audit trail is intact); the built observation only
// surfaces the ones that pass the tightened heuristic.

// Verbs that genuinely imply an irreversible / costly action.
const DANGEROUS_VERBS_RX = /\b(submit|publish|delete|destroy|remove\s+permanently|pay|purchase|charge|checkout|confirm\s+final|finali[sz]e|go\s+live|irreversible|wire\s+transfer|withdraw|send\s+payment)\b/i;

// Navigation prefixes. A label starting with one of these is a *stage advance*
// and must NOT be flagged dangerous even when the rest of the label contains
// a noun like "release" or "publish".
const NAV_PREFIX_RX = /^(next|back|previous|skip|review|continue|preview|return|go\s+to|cancel|edit|view)\b/i;

// Real dangerous verbs that should outweigh the nav prefix above. e.g. a
// button literally labelled "Submit final answer" or "Publish now" can still
// have an imperative verb later in the label; we keep it dangerous.
const STRONG_DANGEROUS_VERBS_RX = /\b(submit|publish|delete|pay|purchase|charge|finali[sz]e|irreversible|withdraw)\b/i;

// Repeat-group add buttons. We require the word "add" combined with an
// item noun ("another"/"more"/"row"/"track"/...) OR a leading "+" marker —
// the prefix that web apps almost universally use to mean "create another
// instance in this same group".
const REPEAT_ADD_VERBS_RX = /\badd\s+(another|more|item|row|track|entry|line|field|speaker|guest|file|attachment|stop|leg)\b/i;
const REPEAT_PLUS_MARKER_RX = /^\s*[+＋]\s*add\b/i;
const REPEAT_APPEND_RX = /\bappend\s+(another|more|item|row|track)\b/i;

/**
 * Returns true when the label is a *real* dangerous action — irreversible,
 * costly, or destructive. Filters out nav-style buttons that happen to
 * contain a dangerous noun ("Review release →").
 *
 * @param {string} label
 */
export function isHardDangerous(label) {
  if (!label || typeof label !== 'string') return false;
  const trimmed = label.trim();
  if (!DANGEROUS_VERBS_RX.test(trimmed)) return false;
  // Pure navigation label — accept only if a strong dangerous verb is also
  // present (e.g. "Continue and Submit" still has "Submit").
  if (NAV_PREFIX_RX.test(trimmed) && !STRONG_DANGEROUS_VERBS_RX.test(trimmed.replace(NAV_PREFIX_RX, ''))) {
    return false;
  }
  return true;
}

/**
 * Returns true when the label looks like a button that creates another
 * instance inside the same form section (a real repeat-group trigger).
 * Filters out navigation buttons that happen to contain "add".
 *
 * @param {string} label
 */
export function isLikelyAddInstanceAction(label) {
  if (!label || typeof label !== 'string') return false;
  const trimmed = label.trim();
  // "+ Add another track" — explicit plus marker is the strongest signal.
  if (REPEAT_PLUS_MARKER_RX.test(trimmed)) return true;
  // Navigation labels ("Next: add tracks →") never count, even if they say "add".
  if (NAV_PREFIX_RX.test(trimmed)) return false;
  return REPEAT_ADD_VERBS_RX.test(trimmed) || REPEAT_APPEND_RX.test(trimmed);
}

// ── Event normalization + dedupe ─────────────────────────────────────────────

/**
 * Collapse noisy event runs while preserving meaningful change.
 *
 * Rules:
 *   - `field_detected` for the same (selector, name, id, inputType) is
 *     deduped against the *previous* event for that key — if the value &
 *     required flag are identical, drop it (covers the input+change pair).
 *     When the value genuinely changes (user types more), the new event is
 *     kept.
 *   - `repeat_group_candidate_detected` and `dangerous_action_candidate_detected`
 *     are deduped globally by (type, selector, label). The initial-scan and
 *     click-time emission for the same button collapse to one entry.
 *   - `page_seen` events are deduped globally by URL — the wizard's tests
 *     already assume one entry per URL.
 *   - Other event types pass through unchanged.
 *
 * Returns a *new* array; the input is never mutated.
 *
 * @param {Array} events
 */
export function normalizeAndDedupeEvents(events = []) {
  const out = [];
  const lastFieldByKey = new Map();
  const seenCandidate = new Set();
  const seenPageUrl = new Set();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'field_detected') {
      const raw = ev.rawEvidence || {};
      const key = [ev.selector || '', raw.name || '', raw.id || '', raw.inputType || ''].join('|');
      const sig = JSON.stringify({ v: raw.value ?? null, r: raw.required ?? null });
      const prev = lastFieldByKey.get(key);
      if (prev === sig) continue;
      lastFieldByKey.set(key, sig);
      out.push(ev);
      continue;
    }
    if (ev.type === 'repeat_group_candidate_detected' || ev.type === 'dangerous_action_candidate_detected') {
      const label = (ev.rawEvidence && ev.rawEvidence.label) || '';
      const key = `${ev.type}|${ev.selector || ''}|${label}`;
      if (seenCandidate.has(key)) continue;
      seenCandidate.add(key);
      out.push(ev);
      continue;
    }
    if (ev.type === 'page_seen') {
      const url = ev.pageUrl || '';
      const key = `page_seen|${url}`;
      if (seenPageUrl.has(key)) continue;
      seenPageUrl.add(key);
      out.push(ev);
      continue;
    }
    if (ev.type === 'page_snapshot_captured') {
      // Snapshots represent distinct *states* (session_start, click_after,
      // add_instance, ...). Never collapse by URL — keep them all in order.
      out.push(ev);
      continue;
    }
    out.push(ev);
  }
  return out;
}

// ── Repeat-group instance modeling ───────────────────────────────────────────

/**
 * Cluster fields/assets whose ids look like `{stem}_{n}` into structured
 * repeat-group instances.
 *
 * Returns an array of `{ stem, fieldStems, instances: [{ index, fields, assets }], itemFieldCount }`.
 *
 * @param {{ globalFields: Array, globalAssets: Array }} input
 */
export function inferRepeatGroupInstances({ globalFields = [], globalAssets = [] } = {}) {
  const tagged = [];
  for (const f of [...globalFields, ...globalAssets]) {
    const idMatch = (f.id || '').match(/^(.+?)_(\d+)$/);
    if (!idMatch) continue;
    const base = idMatch[1];
    const index = parseInt(idMatch[2], 10);
    if (!Number.isFinite(index)) continue;
    tagged.push({ base, index, field: f });
  }
  if (tagged.length < 2) return [];

  // Bucket by the first underscore-separated token. For `track_title_1` and
  // `track_isrc_1`, that's `track` — these belong to the same group.
  const stemBuckets = new Map();
  for (const item of tagged) {
    const stem = item.base.split('_')[0] || item.base;
    if (!stemBuckets.has(stem)) stemBuckets.set(stem, []);
    stemBuckets.get(stem).push(item);
  }

  const groups = [];
  for (const [stem, items] of stemBuckets.entries()) {
    const indices = [...new Set(items.map(i => i.index))].sort((a, b) => a - b);
    if (indices.length < 2) continue; // a single trailing _1 isn't a repeat group
    const instances = indices.map(idx => {
      const fieldsForIdx = items.filter(i => i.index === idx).map(i => i.field);
      return {
        index: idx,
        fields: fieldsForIdx.filter(f => f.scope !== 'asset').map(f => f.id),
        assets: fieldsForIdx.filter(f => f.scope === 'asset').map(f => f.id),
      };
    });
    groups.push({
      stem,
      fieldStems: [...new Set(items.map(i => i.base))].sort(),
      instances,
      itemFieldCount: instances[0] ? instances[0].fields.length + instances[0].assets.length : 0,
    });
  }
  return groups;
}

// ── Suggested assertion / output candidates ──────────────────────────────────

/**
 * Build a list of suggested assertions / checkpoints from the observation.
 * These are *not* automation steps — they are things the runner should verify
 * before / after the workflow runs, and that a human reviewer should check.
 *
 * Sources:
 *   - explicit `output_candidate_detected` events (highest signal)
 *   - manual-only / dangerous actions (presence assertion)
 *   - required global fields (value-set assertion)
 *   - page_seen events (title / URL match)
 *
 * @param {object} input
 * @param {object} input.obs
 * @param {Array}  input.events
 */
export function inferSuggestedAssertions({ obs, events = [] }) {
  const out = [];

  // Explicit output candidates emitted by the capture pipeline.
  for (const ev of events) {
    if (ev.type !== 'output_candidate_detected') continue;
    const raw = ev.rawEvidence || {};
    out.push({
      id: `output_${raw.outputId || raw.id || (raw.label || 'candidate').replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 32) || `o_${out.length + 1}`}`,
      kind: 'output-candidate',
      label: raw.label || raw.text || 'Captured output candidate',
      selector: ev.selector || null,
      selectorCandidates: Array.isArray(raw.selectorCandidates) ? raw.selectorCandidates : [],
      selectorConfidence: raw.selectorConfidence || 'low',
      pattern: raw.pattern || null,
      pageUrl: ev.pageUrl || null,
      source: 'output_candidate_detected',
      confidence: 0.85,
    });
  }

  // Manual-only action presence — the safety contract says a human must
  // confirm before clicking. Pin the assertion to the captured selector.
  for (const a of obs.manualOnlyActions || []) {
    out.push({
      id: `manual_action_present_${a.id}`,
      kind: 'manual-action-presence',
      label: `Before any manual click, verify "${a.label}" is present`,
      selector: a.selector,
      selectorCandidates: a.selectorCandidates || [],
      selectorConfidence: a.selectorConfidence || 'low',
      source: 'manual_only_action',
      confidence: 0.9,
    });
  }

  // Required fields must hold an expected value before progressing.
  for (const f of [...(obs.globalFields || []), ...(obs.globalAssets || [])]) {
    if (!f.required) continue;
    out.push({
      id: `required_field_${f.id}`,
      kind: 'required-field-value',
      label: `Required field "${f.label || f.id}" must hold the expected value before progressing`,
      selector: f.selector,
      selectorCandidates: f.selectorCandidates || [],
      selectorConfidence: f.selectorConfidence || 'low',
      source: 'required_field',
      confidence: 0.75,
    });
  }

  // Page title / URL assertions — verify we arrived at the expected page.
  for (const p of obs.pages || []) {
    out.push({
      id: `page_match_${p.name}`,
      kind: 'page-title-match',
      label: `On URL "${p.url}", expect title "${p.title || '(any)'}"`,
      selector: null,
      selectorCandidates: [],
      selectorConfidence: 'medium',
      source: 'page_seen',
      confidence: 0.6,
    });
  }

  return out;
}

// ── Evidence (screenshots / Appshots) ────────────────────────────────────────

/**
 * Build evidence metadata for a given page from any `page_snapshot_captured`
 * events present in the log. When no snapshots were captured, the page's
 * evidence is marked unavailable with a clear reason — downstream consumers
 * (preview renderer, run-plan reviewer) know to show a placeholder rather
 * than guess.
 *
 * Each surfaced snapshot is one of: a screenshot, a DOM-content snapshot,
 * a visible-text summary, or any combination. `screenshotsAvailable` stays
 * for backward compatibility with the prior shape; the broader flags below
 * answer "does this page have ANY kind of evidence and which kind".
 *
 * @param {string} pageUrl
 * @param {Array} events
 */
function evidenceForPage(pageUrl, events) {
  const snapshots = [];
  for (const ev of events) {
    if (ev.type !== 'page_snapshot_captured') continue;
    if (ev.pageUrl && ev.pageUrl !== pageUrl) continue;
    const raw = ev.rawEvidence || {};
    const snap = {
      capturedAt: raw.capturedAt || ev.timestamp || null,
      kind: raw.kind || 'page',
      hint: raw.hint || null,
      url: raw.url || ev.pageUrl || null,
      title: raw.title || ev.pageTitle || null,
      screenshotPath: raw.screenshotPath || null,
      screenshotDataUrl: raw.screenshotDataUrl || null,
      domSnapshotPath: raw.domSnapshotPath || null,
      visibleTextSummary: raw.visibleTextSummary || null,
      viewport: raw.viewport || null,
    };
    if (raw.screenshotError) snap.screenshotError = raw.screenshotError;
    if (raw.domSnapshotError) snap.domSnapshotError = raw.domSnapshotError;
    if (raw.error) snap.error = raw.error;
    snapshots.push(snap);
  }
  const hasAnyScreenshot = snapshots.some(s => s.screenshotPath || s.screenshotDataUrl);
  const hasAnyDom        = snapshots.some(s => s.domSnapshotPath);
  const hasAnyText       = snapshots.some(s => s.visibleTextSummary);
  if (snapshots.length === 0) {
    return {
      screenshotsAvailable: false,
      domSnapshotsAvailable: false,
      visibleTextAvailable: false,
      snapshots: [],
      screenshots: [],
      reason: 'capture pipeline did not emit a page_snapshot_captured event for this page',
    };
  }
  // Backward-compat: `screenshots` is the subset of snapshots that carry a
  // real screenshot path; older tests/UI iterate it expecting that shape.
  return {
    screenshotsAvailable: hasAnyScreenshot,
    domSnapshotsAvailable: hasAnyDom,
    visibleTextAvailable: hasAnyText,
    snapshots,
    screenshots: snapshots.filter(s => s.screenshotPath || s.screenshotDataUrl),
  };
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array}  opts.events           — canonical event list
 * @param {string} [opts.workflowId]     — defaults to 'observed-workflow'
 * @param {string} [opts.sourceUrl]      — explicit start URL override
 * @param {string} [opts.capturedAt]     — ISO timestamp override
 * @param {string} [opts.captureSource]  — override (else taken from first event)
 */
export function buildObservationFromEvents({
  events = [],
  workflowId = 'observed-workflow',
  sourceUrl,
  capturedAt,
  captureSource,
} = {}) {
  const rawEvents = Array.isArray(events) ? events : [];
  const dedupedEvents = normalizeAndDedupeEvents(rawEvents);
  const src = captureSource
    || (rawEvents.find(e => e.source) || {}).source
    || 'mock';
  const isDemo = src === 'mock';

  // Pages
  const pageEvents = dedupedEvents.filter(e => e.type === 'page_seen' || e.type === 'page_snapshot_captured');
  const seenUrls = new Map();
  pageEvents.forEach((ev, i) => {
    const u = ev.pageUrl || `page_${i + 1}`;
    if (!seenUrls.has(u)) {
      seenUrls.set(u, {
        name: `page_${seenUrls.size + 1}`,
        url: u,
        title: ev.pageTitle || u,
        fields: [], assets: [], buttons: [],
        evidence: evidenceForPage(u, dedupedEvents),
      });
    }
  });
  const pages = Array.from(seenUrls.values());

  // Fields — dedup by selector/name/id/label.
  const fieldEvents = dedupedEvents.filter(e => e.type === 'field_detected');
  const seenFields = new Map();
  for (const ev of fieldEvents) {
    const raw = ev.rawEvidence || {};
    const key = ev.selector || raw.name || raw.id || raw.label || `f_${seenFields.size + 1}`;
    if (seenFields.has(key)) continue;
    const isFileInput = raw.isFileInput === true || raw.inputType === 'file';
    const inputType = isFileInput ? 'file' : (raw.inputType || 'text');
    seenFields.set(key, {
      id: raw.name || raw.id || key.replace(/[^a-z0-9_]/gi, '_').slice(0, 40),
      label: raw.label || raw.placeholder || raw.name || raw.id || '',
      inputType,
      required: !!raw.required,
      scope: isFileInput ? 'asset' : 'global',
      selector: ev.selector || null,
      selectorCandidates: Array.isArray(raw.selectorCandidates) ? raw.selectorCandidates : [],
      selectorConfidence: raw.selectorConfidence || 'low',
      exampleValue: raw.value !== undefined && raw.value !== null && raw.value !== '' ? raw.value : undefined,
    });
  }
  const allFields  = Array.from(seenFields.values());
  const globalFields = allFields.filter(f => f.scope !== 'asset');
  const globalAssets = allFields.filter(f => f.scope === 'asset');

  // Repeat groups — keep only entries whose label survives the tightened
  // `isLikelyAddInstanceAction` heuristic. The raw event log still carries
  // every candidate (so the audit trail is intact); we just don't surface
  // them as repeat groups.
  const repeatEvents = dedupedEvents.filter(e =>
    e.type === 'repeat_group_candidate_detected' || e.type === 'user_marked_repeat_group');
  const seenRepeats = new Map();
  repeatEvents.forEach(ev => {
    const rawLabel = ev.userAnnotation || (ev.rawEvidence && ev.rawEvidence.label) || 'Repeat group';
    // User-annotated entries are trusted as-is (the human explicitly tagged
    // them). Heuristic-detected entries must survive the tightened filter.
    const isUserMarked = ev.type === 'user_marked_repeat_group';
    if (!isUserMarked && !isLikelyAddInstanceAction(rawLabel)) return;
    if (seenRepeats.has(rawLabel)) return;
    const raw = ev.rawEvidence || {};
    seenRepeats.set(rawLabel, {
      id: `group_${seenRepeats.size + 1}`,
      label: rawLabel,
      itemLabel: 'item',
      fields: [],
      assets: [],
      selector: ev.selector || null,
      addButtonSelector: ev.selector || null,
      selectorCandidates: Array.isArray(raw.selectorCandidates) ? raw.selectorCandidates : [],
      selectorConfidence: raw.selectorConfidence || 'low',
      detectedBy: ev.type,
      heuristicConfidence: ev.confidence || (isUserMarked ? 1 : 0.8),
    });
  });
  const repeatGroups = Array.from(seenRepeats.values());

  // Repeat-group instance modeling — cluster `track_*_<n>` fields.
  const instanceGroups = inferRepeatGroupInstances({ globalFields, globalAssets });
  // Attach instances to existing repeat groups when the stem looks related to
  // the group label; otherwise add as an inferred group so they aren't lost.
  for (const ig of instanceGroups) {
    // Find a matching existing repeat group by label keyword.
    const match = repeatGroups.find(g => {
      const lbl = (g.label || '').toLowerCase();
      return lbl.includes(ig.stem.toLowerCase()) || (ig.stem.length > 3 && lbl.includes(ig.stem.toLowerCase().slice(0, -1)));
    });
    if (match) {
      match.itemLabel = ig.stem;
      match.fieldStems = ig.fieldStems;
      match.instances = ig.instances;
      match.instanceCount = ig.instances.length;
      match.itemFieldCount = ig.itemFieldCount;
      match.inferredFromFieldNaming = true;
    } else {
      repeatGroups.push({
        id: `group_${repeatGroups.length + 1}`,
        label: `Inferred repeat group: ${ig.stem}`,
        itemLabel: ig.stem,
        fields: [],
        assets: [],
        selector: null,
        addButtonSelector: null,
        selectorCandidates: [],
        selectorConfidence: 'low',
        detectedBy: 'field_naming_inference',
        heuristicConfidence: 0.6,
        fieldStems: ig.fieldStems,
        instances: ig.instances,
        instanceCount: ig.instances.length,
        itemFieldCount: ig.itemFieldCount,
        inferredFromFieldNaming: true,
      });
    }
  }
  // For repeat groups with no matched instances, expose an explicit empty
  // marker so the preview renderer can say "no instances captured" rather
  // than guessing.
  for (const g of repeatGroups) {
    if (g.instances === undefined) {
      g.instances = [];
      g.instanceCount = 0;
      g.inferredFromFieldNaming = false;
    }
  }

  // Dangerous / manual-only actions — keep only entries whose label survives
  // the tightened `isHardDangerous` heuristic.
  const dangerousEvents = dedupedEvents.filter(e =>
    e.type === 'dangerous_action_candidate_detected' || e.type === 'user_marked_dangerous_action');
  const seenDangerous = new Map();
  dangerousEvents.forEach(ev => {
    const rawLabel = ev.userAnnotation || (ev.rawEvidence && ev.rawEvidence.label) || 'Dangerous action';
    const isUserMarked = ev.type === 'user_marked_dangerous_action';
    if (!isUserMarked && !isHardDangerous(rawLabel)) return;
    if (seenDangerous.has(rawLabel)) return;
    const raw = ev.rawEvidence || {};
    seenDangerous.set(rawLabel, {
      id: `manual_${seenDangerous.size + 1}`,
      label: rawLabel,
      reason: isUserMarked ? 'user-flagged as dangerous during observation' : 'matches strict dangerous-verb heuristic',
      selector: ev.selector || null,
      selectorCandidates: Array.isArray(raw.selectorCandidates) ? raw.selectorCandidates : [],
      selectorConfidence: raw.selectorConfidence || 'low',
      detectedBy: ev.type,
      matchedKeyword: raw.matchedKeyword || null,
      heuristicConfidence: ev.confidence || (isUserMarked ? 1 : 0.85),
    });
  });
  const manualOnlyActions = Array.from(seenDangerous.values());

  const noteTexts = dedupedEvents
    .filter(e => e.type === 'user_note_added')
    .map(e => e.userAnnotation)
    .filter(Boolean);

  const obsScaffold = {
    pages,
    globalFields,
    globalAssets,
    manualOnlyActions,
    repeatGroups,
  };
  const suggestedAssertions = inferSuggestedAssertions({ obs: obsScaffold, events: dedupedEvents });

  // Selector confidence warnings — anything that landed on a low-confidence
  // top selector deserves a flag so the preview renderer can list them.
  const selectorWarnings = [];
  const pushWarn = (kind, label, conf, selector) => {
    if (conf === 'low') selectorWarnings.push({ kind, label, selector, selectorConfidence: conf });
  };
  for (const f of globalFields) pushWarn('global-field', f.id, f.selectorConfidence, f.selector);
  for (const f of globalAssets) pushWarn('global-asset', f.id, f.selectorConfidence, f.selector);
  for (const a of manualOnlyActions) pushWarn('manual-action', a.label, a.selectorConfidence, a.selector);
  for (const g of repeatGroups) pushWarn('repeat-group', g.label, g.selectorConfidence, g.selector);

  const noiseReduction = {
    eventsBeforeDedupe: rawEvents.length,
    eventsAfterDedupe: dedupedEvents.length,
    dropped: rawEvents.length - dedupedEvents.length,
    droppedFieldDetected: rawEvents.filter(e => e.type === 'field_detected').length
      - dedupedEvents.filter(e => e.type === 'field_detected').length,
    droppedRepeatCandidates: rawEvents.filter(e => e.type === 'repeat_group_candidate_detected').length
      - dedupedEvents.filter(e => e.type === 'repeat_group_candidate_detected').length,
    droppedDangerousCandidates: rawEvents.filter(e => e.type === 'dangerous_action_candidate_detected').length
      - dedupedEvents.filter(e => e.type === 'dangerous_action_candidate_detected').length,
  };

  return {
    workflowId,
    title: workflowId,
    captureSource: src,
    captureSourceLabel: SOURCE_LABELS[src] || src,
    sourceUrl: sourceUrl || (pages[0] && pages[0].url) || '',
    capturedAt: capturedAt || new Date().toISOString(),
    mode: isDemo ? 'demo' : 'session',
    pages,
    globalFields,
    globalAssets,
    capturedOutputs: [],
    repeatGroups,
    humanCheckpoints: [],
    manualOnlyActions,
    suggestedAssertions,
    selectorWarnings,
    annotations: noteTexts,
    sessionStats: deriveStatsFromEvents(rawEvents),
    noiseReduction,
    sessionEvents: rawEvents,
    dedupedSessionEvents: dedupedEvents,
  };
}
