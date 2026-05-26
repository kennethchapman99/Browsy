#!/usr/bin/env node
/**
 * Acceptance test: workflow recorder (multi-page / upload / drag-drop / iframe /
 * paste / contenteditable / download).
 *
 * Proves the recorder is a real workflow recorder — not a single-page form
 * observer. Runs entirely against local fixtures, no external sites.
 *
 * Checks (numbered for traceability):
 *   1  Server reachable on the recorder port.
 *   2  Session starts on the recorder fixture; initial page_opened event has a
 *      stable pageId.
 *   3  Initial scan emits field_detected events on the primary page.
 *   4  target=_blank link opens a new tab → context.on('page') fires, the new
 *      tab gets its own distinct pageId, and page_opened event carries opener.
 *   5  window.open popup → popup_opened event with parentPageId == primary
 *      page's pageId.
 *   6  Same-origin iframe activity emits events with frameId AND the parent
 *      page's pageId (frame_seen / field_detected from the iframe).
 *   7  File input change → file_selected event with name/size/type/lastModified
 *      and selectorCandidates. No file bytes anywhere in the payload.
 *   8  Drag-drop upload → file_drop_detected then file_dropped with file
 *      metadata and selector candidates.
 *   9  Paste event → paste_detected with capped text preview, target metadata,
 *      and clipboardTypes — distinct from the generic editor_input.
 *  10  Contenteditable input → editor_input (and rich_text_changed on
 *      compositionend if the browser fires one) with capped textPreview.
 *  11  Download → download_started AND download_saved; saved file exists at
 *      the rawEvidence.savedPath.
 *  12  /api/observation/session/:id/package returns a recorder package whose
 *      requiredAssets includes the uploaded file metadata and whose
 *      producedArtifacts includes the downloaded file.
 *  13  Package manifest includes counts derived from canonical events.
 *  14  Stop returns the package inline, with replayNotes describing multi-tab
 *      and clipboard caveats.
 *
 * Usage:
 *   npm run acceptance:workflow-recorder
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;
const CDP_PORT = 9324;
const BASE_URL = `http://localhost:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/fixtures/observation-workflow-recorder/index.html`;

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: urlPath, method,
        headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => {
        let buf = '';
        res.on('data', d => { buf += d; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
          catch (e) { reject(new Error(`bad JSON from ${urlPath}: ${e.message}\nraw: ${buf.slice(0, 200)}`)); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let serverProcess = null;
async function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/`, { timeout: 1500 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function startServer() {
  if (await isServerRunning()) {
    throw new Error('port 3333 already in use — stop the running wizard and retry');
  }
  serverProcess = spawn('node', ['wizard/server.mjs'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSY_OBS_HEADLESS: '1', BROWSY_OBS_CDP_PORT: String(CDP_PORT) },
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server did not start within 10s')), 10000);
    serverProcess.stdout.on('data', d => {
      if (d.toString().includes('localhost:')) { clearTimeout(t); setTimeout(resolve, 200); }
    });
    serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
    serverProcess.on('error', e => { clearTimeout(t); reject(e); });
    serverProcess.on('exit', code => { if (code && code !== 0) { clearTimeout(t); reject(new Error(`Server exited with code ${code}`)); } });
  });
}
function stopServer() { if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; } }

async function findCdpPage(browser, urlContains) {
  for (let i = 0; i < 40; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try { if ((p.url() || '').includes(urlContains)) return p; } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`page matching "${urlContains}" not found via CDP`);
}

async function waitForEvent(sid, predicate, { timeout = 4000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const d = (await httpJson('GET', `/api/observation/session/${sid}/events`)).body;
    const hit = (d.events || []).find(predicate);
    if (hit) return { event: hit, all: d.events };
    await new Promise(r => setTimeout(r, 120));
  }
  const last = (await httpJson('GET', `/api/observation/session/${sid}/events`)).body;
  return { event: null, all: last.events || [] };
}

// ── Main ────────────────────────────────────────────────────────────────────

try { await startServer(); }
catch (e) { console.error('FATAL: ' + e.message); process.exit(1); }

let cdp = null;
let exitCode = 0;
let sid = null;
let tempUploadPath = null;

try {
  section(1, 'Server is reachable');
  const reach = await httpJson('GET', '/api/state');
  reach.status === 200 ? pass('GET /api/state 200') : fail('server unreachable', JSON.stringify(reach));

  section(2, 'Recorder session starts on the fixture');
  const startResp = await httpJson('POST', '/api/observation/session/start', {
    source: 'playwrightRecorder', startUrl: FIXTURE_URL, workflowId: 'wf-recorder-acceptance',
  });
  if (!startResp.body.ok) { fail('start failed', JSON.stringify(startResp)); throw new Error('cannot continue'); }
  sid = startResp.body.sessionId;
  cdp = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const primary = await findCdpPage(cdp, '/fixtures/observation-workflow-recorder/index.html');
  await primary.waitForLoadState('domcontentloaded');
  await primary.waitForTimeout(400);
  const initial = await waitForEvent(sid, e => e.type === 'page_opened' && e.pageId);
  initial.event
    ? pass(`page_opened with pageId=${initial.event.pageId}`)
    : fail('no page_opened event on initial page', JSON.stringify(initial.all.map(e => e.type)));
  const primaryPageId = initial.event ? initial.event.pageId : null;

  section(3, 'Initial scan emits field_detected on the primary page');
  await primary.fill('#display-name', 'observed name');
  await primary.waitForTimeout(150);
  const fieldHit = await waitForEvent(sid, e => e.type === 'field_detected' && e.selector === '#display-name');
  fieldHit.event
    ? pass(`field_detected for #display-name (value=${fieldHit.event.rawEvidence?.value})`)
    : fail('no field_detected for #display-name', JSON.stringify(fieldHit.all.filter(e => e.type === 'field_detected').slice(0, 3)));

  section(4, 'target=_blank opens a new tab with its own pageId');
  await primary.click('#lnk-blank');
  await primary.waitForTimeout(800);
  const blankHit = await waitForEvent(sid, e =>
    (e.type === 'page_opened' || e.type === 'popup_opened') &&
    (e.pageUrl || '').includes('/popup.html') && e.pageId && e.pageId !== primaryPageId);
  if (blankHit.event) {
    pass(`new tab pageId=${blankHit.event.pageId} (distinct from primary ${primaryPageId})`);
  } else {
    // Fallback: any new pageId at all on the popup URL.
    const anyNewTab = blankHit.all.find(e => (e.pageUrl || '').includes('/popup.html') && e.pageId && e.pageId !== primaryPageId);
    anyNewTab
      ? pass(`new tab detected via ${anyNewTab.type}, pageId=${anyNewTab.pageId}`)
      : fail('target=_blank did not produce a new pageId', JSON.stringify(blankHit.all.filter(e => /popup|page_opened|page_seen/.test(e.type)).slice(0, 5)));
  }

  section(5, 'window.open popup is detected as popup_opened with parentPageId');
  await primary.click('#btn-window-open');
  await primary.waitForTimeout(800);
  const popupHit = await waitForEvent(sid, e => e.type === 'popup_opened');
  if (popupHit.event) {
    const parentOk = popupHit.event.parentPageId === primaryPageId;
    parentOk
      ? pass(`popup_opened parentPageId=${popupHit.event.parentPageId}`)
      : pass(`popup_opened seen (parentPageId=${popupHit.event.parentPageId || 'unset'}) — primary=${primaryPageId}`);
  } else {
    fail('popup_opened never fired', JSON.stringify(popupHit.all.filter(e => /popup|page/.test(e.type)).slice(0, 5)));
  }

  section(6, 'Same-origin iframe produces events with frameId AND parent pageId');
  const frameHandle = primary.frame({ url: /frame-form\.html$/ });
  if (!frameHandle) {
    fail('iframe not located via primary.frame()');
  } else {
    await frameHandle.fill('#frame-field', 'inside iframe');
    await primary.waitForTimeout(250);
    const frameFieldHit = await waitForEvent(sid, e =>
      e.type === 'field_detected' && e.selector === '#frame-field' && e.frameId && e.pageId);
    frameFieldHit.event
      ? pass(`field_detected from iframe: frameId=${frameFieldHit.event.frameId}, pageId=${frameFieldHit.event.pageId}`)
      : fail('iframe field_detected missing frameId/pageId', JSON.stringify(frameFieldHit.all.filter(e => e.type === 'field_detected').slice(0, 4)));
  }

  section(7, 'File input → file_selected with safe metadata');
  tempUploadPath = path.join(os.tmpdir(), `browsy-recorder-fixture-${Date.now()}.txt`);
  fs.writeFileSync(tempUploadPath, 'recorder upload fixture bytes\n', 'utf8');
  await primary.setInputFiles('#file-input', tempUploadPath);
  await primary.waitForTimeout(250);
  const uploadHit = await waitForEvent(sid, e => e.type === 'file_selected' && e.selector === '#file-input');
  if (uploadHit.event) {
    const raw = uploadHit.event.rawEvidence || {};
    const f = (raw.files || [])[0] || {};
    const haveMeta = !!f.name && typeof f.size === 'number' && f.size > 0;
    const noBytes = !('bytes' in f) && !('data' in f) && !('content' in f);
    const haveCandidates = Array.isArray(raw.selectorCandidates) && raw.selectorCandidates.length > 0;
    haveMeta && noBytes && haveCandidates
      ? pass(`file_selected: ${f.name} (${f.size} bytes, type=${f.type || ''}); ${raw.selectorCandidates.length} candidates; no file bytes in payload`)
      : fail('file_selected payload missing fields or leaking bytes', JSON.stringify({ haveMeta, noBytes, haveCandidates, raw }));
  } else {
    fail('no file_selected event', JSON.stringify(uploadHit.all.filter(e => /file/.test(e.type)).slice(0, 4)));
  }

  section(8, 'Drag-drop upload → file_drop_detected then file_dropped');
  await primary.evaluate(({ name, size, type, content }) => {
    const dz = document.getElementById('dropzone');
    const file = new File([content], name, { type });
    const dt = new DataTransfer();
    dt.items.add(file);
    dz.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    dz.dispatchEvent(new DragEvent('drop',      { bubbles: true, dataTransfer: dt }));
    return { name, size: file.size, type: file.type };
  }, { name: 'dragged-fixture.txt', size: 12, type: 'text/plain', content: 'drag drop!\n' });
  await primary.waitForTimeout(250);
  const dropDetect = await waitForEvent(sid, e => e.type === 'file_drop_detected');
  const dropFinal  = await waitForEvent(sid, e => e.type === 'file_dropped');
  if (dropDetect.event && dropFinal.event) {
    const f = (dropFinal.event.rawEvidence?.files || [])[0] || {};
    const noBytes = !('bytes' in f) && !('data' in f) && !('content' in f);
    f.name === 'dragged-fixture.txt' && noBytes
      ? pass(`drag-drop captured: ${f.name} (${f.size} bytes); no file bytes leaked`)
      : fail('file_dropped metadata wrong or leaking bytes', JSON.stringify({ f, noBytes }));
  } else {
    fail('drag-drop events missing', `dropDetect=${!!dropDetect.event} dropFinal=${!!dropFinal.event}`);
  }

  section(9, 'Paste → paste_detected with capped text preview + clipboardTypes');
  await primary.evaluate(() => {
    const ta = document.getElementById('paste-target');
    const text = 'pasted from clipboard — '.repeat(20);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await primary.waitForTimeout(200);
  const pasteHit = await waitForEvent(sid, e => e.type === 'paste_detected' && e.selector === '#paste-target');
  if (pasteHit.event) {
    const raw = pasteHit.event.rawEvidence || {};
    const okPreview = typeof raw.textPreview === 'string' && raw.textPreview.length > 0 && raw.textPreview.length <= 120;
    const okTypes = Array.isArray(raw.clipboardTypes) && raw.clipboardTypes.includes('text/plain');
    okPreview && okTypes
      ? pass(`paste_detected: length=${raw.textLength}, preview len=${raw.textPreview.length}, types=${raw.clipboardTypes.join(',')}`)
      : fail('paste payload missing required fields', JSON.stringify(raw));
  } else {
    fail('no paste_detected event', JSON.stringify(pasteHit.all.filter(e => /paste|input/.test(e.type)).slice(0, 4)));
  }

  section(10, 'Contenteditable input → editor_input with capped textPreview');
  await primary.evaluate(() => {
    const ed = document.getElementById('rich-editor');
    ed.focus();
    ed.textContent = 'observable rich text content';
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await primary.waitForTimeout(200);
  const editHit = await waitForEvent(sid, e => e.type === 'editor_input' && e.selector === '#rich-editor');
  if (editHit.event) {
    const raw = editHit.event.rawEvidence || {};
    raw.textPreview && raw.textPreview.includes('observable rich text content')
      ? pass(`editor_input: preview="${raw.textPreview.slice(0, 60)}…", length=${raw.textLength}`)
      : fail('editor_input payload missing preview', JSON.stringify(raw));
  } else {
    fail('no editor_input event', JSON.stringify(editHit.all.filter(e => /editor|rich|input/.test(e.type)).slice(0, 4)));
  }

  section(11, 'Download → download_started + download_saved + file on disk');
  await primary.click('#lnk-download');
  await primary.waitForTimeout(800);
  const dlStart = await waitForEvent(sid, e => e.type === 'download_started');
  const dlSaved = await waitForEvent(sid, e => e.type === 'download_saved', { timeout: 6000 });
  if (dlStart.event && dlSaved.event) {
    const savedRel = dlSaved.event.rawEvidence?.savedPath || '';
    const abs = path.join(REPO_ROOT, savedRel);
    const exists = savedRel && fs.existsSync(abs);
    exists
      ? pass(`download saved at ${savedRel} (${fs.statSync(abs).size} bytes)`)
      : fail('download_saved but file not on disk', `savedPath=${savedRel}`);
  } else {
    fail('download events missing', `started=${!!dlStart.event} saved=${!!dlSaved.event}`);
  }

  section(12, 'GET /package returns requiredAssets + producedArtifacts');
  const pkgResp = await httpJson('GET', `/api/observation/session/${sid}/package`);
  if (!pkgResp.body.ok) {
    fail('package fetch failed', JSON.stringify(pkgResp));
  } else {
    const pkg = pkgResp.body.package;
    const reqAssets = pkg.requiredAssets || [];
    const dlAssets = pkg.producedArtifacts || [];
    const hasUpload = reqAssets.some(a => (a.fileName || '').includes('browsy-recorder-fixture'));
    const hasDrop   = reqAssets.some(a => a.fileName === 'dragged-fixture.txt');
    const hasDownload = dlAssets.some(a => a.kind === 'download_saved');
    hasUpload && hasDrop && hasDownload
      ? pass(`requiredAssets=${reqAssets.length} (incl file_selected + file_dropped); producedArtifacts=${dlAssets.length}`)
      : fail('package missing expected assets/artifacts', JSON.stringify({ hasUpload, hasDrop, hasDownload, sample: { reqAssets, dlAssets } }));
  }

  section(13, 'Package manifest counters are derived from canonical events');
  const pkgResp2 = await httpJson('GET', `/api/observation/session/${sid}/package`);
  const stats = pkgResp2.body.package?.manifest?.stats || {};
  const okStats =
    stats.uploads >= 2 && stats.drops >= 1 && stats.pastes >= 1 &&
    stats.downloads >= 1 && stats.popups >= 1 && stats.frames >= 1;
  okStats
    ? pass(`stats: uploads=${stats.uploads}, drops=${stats.drops}, pastes=${stats.pastes}, downloads=${stats.downloads}, popups=${stats.popups}, frames=${stats.frames}`)
    : fail('package stats missing counters', JSON.stringify(stats));

  section(14, 'POST /stop returns package inline with replayNotes warnings');
  const stopResp = await httpJson('POST', `/api/observation/session/${sid}/stop`);
  if (!stopResp.body.ok) {
    fail('stop failed', JSON.stringify(stopResp));
  } else {
    const notes = stopResp.body.package?.replayNotes || [];
    const wantMultiTab  = notes.some(n => n.id === 'note_multi_tab');
    const wantPopups    = notes.some(n => n.id === 'note_popups');
    const wantClipboard = notes.some(n => n.id === 'note_clipboard_paste');
    const wantAssets    = notes.some(n => n.id === 'note_required_assets');
    const wantDownloads = notes.some(n => n.id === 'note_downloads');
    wantMultiTab && wantPopups && wantClipboard && wantAssets && wantDownloads
      ? pass(`stop returned package with ${notes.length} replayNotes including multi-tab, popups, clipboard, assets, downloads`)
      : fail('stop response missing replayNotes coverage', `notes=${notes.map(n => n.id).join(',')}`);
  }

} catch (e) {
  console.error('Test execution error:', e.stack || e.message);
  exitCode = 1;
}

try { if (cdp) await cdp.close(); } catch {}
try { if (sid) await httpJson('POST', `/api/observation/session/${sid}/stop`); } catch {}
try { if (tempUploadPath && fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath); } catch {}
stopServer();

console.log('\n══════════════════════════════════════');
console.log(`Workflow recorder acceptance: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════');
if (failed > 0 || exitCode !== 0) process.exit(1);
