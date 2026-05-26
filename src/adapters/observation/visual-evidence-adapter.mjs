/**
 * Visual evidence adapter — captures per-page-state evidence at the moment
 * of observation, so the downstream preview / reviewer / automation
 * generator has more than DOM events to verify against.
 *
 * Captured per call:
 *   - screenshot     (PNG, full visible viewport — NOT full page by default)
 *   - dom snapshot   (current page.content() — sanitized)
 *   - visible text   (first ~600 chars of innerText, single-line)
 *   - viewport       (width × height)
 *   - url + title    (already on the canonical event)
 *
 * Design notes:
 *   - This module is the only place that talks to the live Playwright page
 *     for visual evidence. The rest of the codebase reads the resulting
 *     event payloads.
 *   - Screenshots are written under
 *       output/observations/<sessionId>/screenshots/snapshot-<n>.png
 *     The returned `screenshotPath` is always REPO-RELATIVE, never absolute —
 *     so we don't leak the capturing operator's home directory into the
 *     golden event log or into the preview.
 *   - Screenshots are OPTIONAL via env var `BROWSY_OBS_CAPTURE_SCREENSHOTS`.
 *     Default = enabled when a Playwright page is available; can be
 *     disabled by setting `BROWSY_OBS_CAPTURE_SCREENSHOTS=0` (used by the
 *     headless capture goldens to keep diffs stable). When disabled the
 *     event still surfaces with the URL/title/visibleText and a clear
 *     `screenshotPath: null` so the preview renders "not captured".
 *   - Adapter seam: a future Appshots / Atlas implementation can replace
 *     `captureVisualEvidence` without changing wizard/server.mjs or the
 *     observation conversion. Keep the contract narrow.
 *
 * Contract:
 *   await captureVisualEvidence({ page, sessionId, repoRoot, kind, hint, index })
 *     → { screenshotPath?, domSnapshotPath?, visibleTextSummary, title, url, viewport, kind, hint, capturedAt }
 *
 * Never throws — visual capture is best-effort. Failures emit a payload
 * with `error: <message>` and otherwise-null evidence so the recorder loop
 * does not break on a flaky screenshot.
 */

import fs from 'node:fs';
import path from 'node:path';

const VISIBLE_TEXT_MAX = 600;

function screenshotsEnabled() {
  const v = process.env.BROWSY_OBS_CAPTURE_SCREENSHOTS;
  if (v === undefined) return true;
  return !(v === '0' || v === 'false' || v === '');
}
function domSnapshotsEnabled() {
  const v = process.env.BROWSY_OBS_CAPTURE_DOM;
  if (v === undefined) return true;
  return !(v === '0' || v === 'false' || v === '');
}

function evidenceDir({ repoRoot, sessionId }) {
  if (!repoRoot || !sessionId) return null;
  return path.join(repoRoot, 'output', 'observations', '_sessions', String(sessionId));
}

function relPath(repoRoot, abs) {
  if (!repoRoot) return abs;
  const rel = path.relative(repoRoot, abs);
  return rel.startsWith('..') ? abs : rel;
}

function sanitizeFsSegment(s) {
  return String(s || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
}

/**
 * Capture per-state evidence from the active Playwright page.
 *
 * @param {object} opts
 * @param {object} opts.page         — Playwright Page (required for live capture)
 * @param {string} opts.sessionId    — observation session id
 * @param {string} opts.repoRoot     — absolute path to repo root (so we can
 *                                     return repo-relative paths)
 * @param {string} [opts.kind]       — 'session_start' | 'navigation' | 'click' |
 *                                     'add_instance' | 'manual'
 * @param {string} [opts.hint]       — short label (e.g. 'after_click_add_track')
 * @param {number} [opts.index]      — caller-managed counter for filenames
 * @returns {Promise<object>}        — evidence payload (see file header)
 */
export async function captureVisualEvidence({ page, sessionId, repoRoot, kind = 'page', hint, index } = {}) {
  const capturedAt = new Date().toISOString();
  const out = {
    capturedAt,
    kind,
    hint: hint || null,
    url: null,
    title: null,
    visibleTextSummary: null,
    viewport: null,
    screenshotPath: null,
    domSnapshotPath: null,
  };

  if (!page) {
    out.error = 'no Playwright page provided';
    return out;
  }

  // ── URL / title / visible text — cheap, always attempted ──────────────────
  try {
    out.url = page.url();
  } catch {}
  try {
    out.title = await page.title();
  } catch {}
  try {
    const summary = await page.evaluate((maxLen) => {
      const txt = (document.body && document.body.innerText) || '';
      const oneLine = txt.replace(/\s+/g, ' ').trim();
      return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
    }, VISIBLE_TEXT_MAX);
    out.visibleTextSummary = summary;
  } catch (e) {
    out.visibleTextSummary = '';
  }
  try {
    const vp = page.viewportSize ? page.viewportSize() : null;
    if (vp && typeof vp.width === 'number') out.viewport = { width: vp.width, height: vp.height };
  } catch {}

  // ── Optional: screenshot ──────────────────────────────────────────────────
  if (screenshotsEnabled()) {
    const dir = evidenceDir({ repoRoot, sessionId });
    if (dir) {
      try {
        const shotDir = path.join(dir, 'screenshots');
        fs.mkdirSync(shotDir, { recursive: true });
        const n = typeof index === 'number' ? String(index).padStart(3, '0') : Date.now().toString(36);
        const file = `${n}-${sanitizeFsSegment(kind)}${hint ? '-' + sanitizeFsSegment(hint) : ''}.png`;
        const abs = path.join(shotDir, file);
        await page.screenshot({ path: abs, fullPage: false });
        out.screenshotPath = relPath(repoRoot, abs);
      } catch (e) {
        out.screenshotError = e.message || String(e);
      }
    }
  }

  // ── Optional: DOM snapshot ────────────────────────────────────────────────
  if (domSnapshotsEnabled()) {
    const dir = evidenceDir({ repoRoot, sessionId });
    if (dir) {
      try {
        const domDir = path.join(dir, 'dom');
        fs.mkdirSync(domDir, { recursive: true });
        const n = typeof index === 'number' ? String(index).padStart(3, '0') : Date.now().toString(36);
        const file = `${n}-${sanitizeFsSegment(kind)}${hint ? '-' + sanitizeFsSegment(hint) : ''}.html`;
        const abs = path.join(domDir, file);
        const html = await page.content();
        fs.writeFileSync(abs, html, 'utf8');
        out.domSnapshotPath = relPath(repoRoot, abs);
      } catch (e) {
        out.domSnapshotError = e.message || String(e);
      }
    }
  }

  return out;
}

/**
 * Build the rawEvidence payload for a `page_snapshot_captured` event from a
 * captureVisualEvidence() result. Stable shape:
 *   { kind, hint, url, title, visibleTextSummary, viewport,
 *     screenshotPath, domSnapshotPath, capturedAt, errors? }
 */
export function evidenceToRawEvidence(evidence) {
  if (!evidence) return null;
  const out = {
    kind: evidence.kind || 'page',
    hint: evidence.hint || null,
    url: evidence.url || null,
    title: evidence.title || null,
    visibleTextSummary: evidence.visibleTextSummary || null,
    viewport: evidence.viewport || null,
    screenshotPath: evidence.screenshotPath || null,
    domSnapshotPath: evidence.domSnapshotPath || null,
    capturedAt: evidence.capturedAt || null,
  };
  if (evidence.error) out.error = evidence.error;
  if (evidence.screenshotError) out.screenshotError = evidence.screenshotError;
  if (evidence.domSnapshotError) out.domSnapshotError = evidence.domSnapshotError;
  return out;
}

export const __testing = {
  screenshotsEnabled,
  domSnapshotsEnabled,
  evidenceDir,
  relPath,
  VISIBLE_TEXT_MAX,
};
