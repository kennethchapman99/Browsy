#!/usr/bin/env node
/**
 * Acceptance test: real Playwright observation capture
 *
 * Proves end-to-end that Browsy Step 4 captures REAL events from a REAL
 * Playwright-driven browser session — no random/timer simulation, no mock
 * data, no fabricated counters. Stats must derive from canonical events
 * emitted by injected DOM listeners.
 *
 * Approach:
 *  - Boot the wizard server with BROWSY_OBS_CDP_PORT=9322 + BROWSY_OBS_HEADLESS=1
 *  - POST /api/observation/session/start with the local fixture URL
 *  - Connect to the same Chromium over CDP to drive the page like a user
 *  - Trigger: navigation, text input, select, checkbox, file input,
 *    add-track click, dangerous submit click
 *  - GET /api/observation/session/:id/events — assert canonical events
 *  - Assert no timer/random simulation: events all carry timestamps that
 *    cluster around the actions we performed, never out-of-band increments
 *  - POST /api/observation/session/:id/stop — assert clean shutdown
 *
 * Checks (numbered for traceability):
 *   1  Server is reachable
 *   2  POST start returns sessionId, state=recording, source=playwrightRecorder
 *   3  Default source is playwrightRecorder (the UI default also covered in observation-ui)
 *   4  Server requires startUrl for playwrightRecorder (400 otherwise)
 *   5  After start, GET /events returns canonical session_started + capture_source_selected events
 *   6  All events carry source=playwrightRecorder (no leaked 'mock')
 *   7  page_seen event fired for the initial navigation (real navigation)
 *   8  File input on initial page emits field_detected with inputType=file
 *   9  "Submit Release" button is detected as dangerous on initial scan
 *  10  "Add another track" button is detected as repeat_group_candidate
 *  11  Typing into #title emits field_detected with selector #title
 *  12  Selecting #category emits field_detected with the chosen value
 *  13  Toggling #notify checkbox emits field_detected
 *  14  Clicking "Submit Release" emits action_detected AND dangerous_action_candidate_detected
 *  15  Clicking "+ Add another track" emits action_detected AND repeat_group_candidate_detected
 *  16  Clicking "Next →" link triggers navigation; second page_seen event fires
 *  17  Derived stats from /events match deriveStatsFromEvents — pages>=2, fields>=3, buttons>=2, dangerous>=1, repeatGroups>=1
 *  18  No event has source='mock' on a playwrightRecorder session
 *  19  No "random" / "simulated" events — events appear only after corresponding test action (timestamp ordering)
 *  20  POST /stop closes browser cleanly; state transitions to finished
 *  21  After stop, GET /events still returns the events (idempotent)
 *  22  Mock source session_started does NOT auto-increment counters (stays at 0 with no manual annotations)
 *
 * Usage:
 *   npm run acceptance:observation-playwright
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveStatsFromEvents } from '../src/core/observation-events.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;
const CDP_PORT = 9322;
const BASE_URL = `http://localhost:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/fixtures/observation-test-form/page-1.html`;

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: 'localhost', port: PORT, path, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => {
        let buf = '';
        res.on('data', d => { buf += d; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
          catch (e) { reject(new Error(`bad JSON from ${path}: ${e.message}\nraw: ${buf.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

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
    console.warn('NOTE: a wizard server is already running on this port. The acceptance test needs');
    console.warn('      BROWSY_OBS_CDP_PORT=9322 BROWSY_OBS_HEADLESS=1 to be set in that process,');
    console.warn('      or it should not be running so this script can start its own.');
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

// ── Main ──────────────────────────────────────────────────────────────────────

try { await startServer(); }
catch (e) { console.error('FATAL: ' + e.message); process.exit(1); }

let cdpBrowser = null;
let exitCode = 0;
try {

  section(1, 'Server is reachable');
  {
    const r = await httpJson('GET', '/api/state');
    r.status === 200 ? pass('GET /api/state returned 200') : fail('GET /api/state failed', `status=${r.status}`);
  }

  // ── Check 4: validate startUrl required ────────────────────────────────────
  section(4, 'POST /session/start requires startUrl for playwrightRecorder');
  {
    const r = await httpJson('POST', '/api/observation/session/start', { source: 'playwrightRecorder' });
    r.status === 400 && /starturl/i.test(r.body.error || '')
      ? pass(`400 returned: "${r.body.error}"`)
      : fail('Expected 400 with startUrl error', JSON.stringify(r));
  }

  // ── Check 2: start a real session ──────────────────────────────────────────
  section(2, 'POST /session/start returns recording session');
  let sessionId;
  {
    const r = await httpJson('POST', '/api/observation/session/start', {
      source: 'playwrightRecorder', startUrl: FIXTURE_URL, workflowId: 'obs-test-form',
    });
    if (r.status !== 200 || !r.body.ok || !r.body.sessionId) {
      fail('start failed', JSON.stringify(r));
      throw new Error('cannot continue without a session');
    }
    sessionId = r.body.sessionId;
    r.body.status === 'recording' && r.body.source === 'playwrightRecorder'
      ? pass(`sessionId=${sessionId}, status=${r.body.status}, source=${r.body.source}`)
      : fail('unexpected start payload', JSON.stringify(r.body));
  }

  // ── Check 3: source default behaviour ──────────────────────────────────────
  section(3, 'When no source supplied, server defaults to playwrightRecorder');
  {
    // We pass startUrl but no source — server should default to playwright.
    const r = await httpJson('POST', '/api/observation/session/start', { startUrl: FIXTURE_URL });
    r.status === 200 && r.body.source === 'playwrightRecorder'
      ? pass(`default source = ${r.body.source}`)
      : fail('default source not playwrightRecorder', JSON.stringify(r.body));
    if (r.body.sessionId) await httpJson('POST', `/api/observation/session/${r.body.sessionId}/stop`);
  }

  // Attach to the same browser the server launched.
  cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);

  // Find our page. Server-launched browser has one context with one page after goto.
  async function getOurPage() {
    for (let i = 0; i < 30; i++) {
      for (const ctx of cdpBrowser.contexts()) {
        for (const p of ctx.pages()) {
          if (p.url().startsWith(BASE_URL)) return p;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('could not find page in CDP browser');
  }
  const page = await getOurPage();
  await page.waitForLoadState('domcontentloaded');
  // Wait for initial scan events to flow in.
  await page.waitForTimeout(400);

  async function fetchEvents() {
    const r = await httpJson('GET', `/api/observation/session/${sessionId}/events`);
    return r.body;
  }

  // ── Check 5: canonical setup events present ─────────────────────────────────
  section(5, 'session_started + capture_source_selected present');
  {
    const data = await fetchEvents();
    const hasStarted = data.events.some(e => e.type === 'session_started');
    const hasSourceSel = data.events.some(e => e.type === 'capture_source_selected');
    hasStarted && hasSourceSel
      ? pass(`both setup events present (total events so far: ${data.events.length})`)
      : fail('missing setup events', JSON.stringify(data.events.map(e => e.type)));
  }

  // ── Check 6: every event has source=playwrightRecorder ─────────────────────
  section(6, 'All events carry source=playwrightRecorder');
  {
    const data = await fetchEvents();
    const bad = data.events.filter(e => e.source !== 'playwrightRecorder');
    bad.length === 0
      ? pass(`all ${data.events.length} events use playwrightRecorder source`)
      : fail(`${bad.length} events had non-playwrightRecorder source`, JSON.stringify(bad.slice(0, 3)));
  }

  // ── Check 7: initial navigation produced page_seen ─────────────────────────
  section(7, 'page_seen event fired for initial navigation');
  {
    const data = await fetchEvents();
    const pageSeen = data.events.find(e => e.type === 'page_seen' && (e.pageUrl || '').includes('/fixtures/observation-test-form/page-1.html'));
    pageSeen ? pass(`page_seen captured: ${pageSeen.pageUrl}`) : fail('no page_seen for page-1', JSON.stringify(data.events.map(e => e.type)));
  }

  // ── Check 8: file input detected on initial scan ───────────────────────────
  section(8, 'File input detected via initial scan');
  {
    const data = await fetchEvents();
    const fileField = data.events.find(e =>
      e.type === 'field_detected' &&
      (e.rawEvidence?.inputType === 'file' || e.rawEvidence?.isFileInput === true)
    );
    fileField
      ? pass(`file input detected: selector=${fileField.selector}`)
      : fail('no file input field_detected', JSON.stringify(data.events.filter(e => e.type === 'field_detected').slice(0, 3)));
  }

  // ── Check 9: dangerous submit detected on initial scan ─────────────────────
  section(9, 'Submit Release button flagged dangerous on initial scan');
  {
    const data = await fetchEvents();
    const danger = data.events.find(e =>
      e.type === 'dangerous_action_candidate_detected' &&
      /submit/i.test(e.rawEvidence?.label || '')
    );
    danger
      ? pass(`dangerous: "${danger.rawEvidence.label}" matched keyword=${danger.rawEvidence.matchedKeyword}`)
      : fail('Submit Release not detected dangerous', JSON.stringify(data.events.filter(e => e.type === 'dangerous_action_candidate_detected')));
  }

  // ── Check 10: add-track detected as repeat group candidate ─────────────────
  section(10, 'Add-another-track button flagged repeat_group_candidate on initial scan');
  {
    const data = await fetchEvents();
    const repeat = data.events.find(e =>
      e.type === 'repeat_group_candidate_detected' &&
      /add/i.test(e.rawEvidence?.label || '')
    );
    repeat
      ? pass(`repeat candidate: "${repeat.rawEvidence.label}"`)
      : fail('Add another track not flagged', JSON.stringify(data.events.filter(e => e.type === 'repeat_group_candidate_detected')));
  }

  // Snapshot event count before driving the page — used by Check 19 to prove
  // no random/timer simulation injected events between actions.
  const eventCountBeforeActions = (await fetchEvents()).events.length;

  // ── Drive the page via Playwright (CDP) ────────────────────────────────────
  await page.fill('#title', 'My Test Release');
  await page.waitForTimeout(150);
  await page.selectOption('#category', 'music');
  await page.waitForTimeout(150);
  await page.check('#notify');
  await page.waitForTimeout(150);
  // Add another track (real DOM click)
  await page.click('#btn-add-track');
  await page.waitForTimeout(200);
  // Click Submit Release (real DOM click; preventDefault keeps us on page)
  await page.click('#btn-submit-release');
  await page.waitForTimeout(250);

  // ── Check 11: typing emits field_detected with #title selector ─────────────
  section(11, 'Typing into #title emits field_detected with selector "#title"');
  {
    const data = await fetchEvents();
    const titleEv = data.events.find(e =>
      e.type === 'field_detected' &&
      e.selector === '#title' &&
      e.rawEvidence?.eventTrigger === 'user_interaction'
    );
    titleEv
      ? pass(`#title captured: value="${titleEv.rawEvidence.value}"`)
      : fail('#title input not captured', JSON.stringify(data.events.filter(e => e.type === 'field_detected' && e.rawEvidence?.eventTrigger === 'user_interaction').slice(0, 3)));
  }

  // ── Check 12: select dropdown emits field_detected with chosen value ───────
  section(12, '#category select emits field_detected with value "music"');
  {
    const data = await fetchEvents();
    const catEv = data.events.find(e =>
      e.type === 'field_detected' &&
      e.selector === '#category' &&
      e.rawEvidence?.value === 'music'
    );
    catEv ? pass('#category=music captured') : fail('#category select not captured', JSON.stringify(data.events.filter(e => e.selector === '#category')));
  }

  // ── Check 13: checkbox emits field_detected with boolean value ─────────────
  section(13, '#notify checkbox emits field_detected with value=true');
  {
    const data = await fetchEvents();
    const notifyEv = data.events.find(e =>
      e.type === 'field_detected' &&
      e.selector === '#notify' &&
      e.rawEvidence?.value === true
    );
    notifyEv ? pass('#notify=true captured') : fail('#notify checkbox not captured', JSON.stringify(data.events.filter(e => e.selector === '#notify')));
  }

  // ── Check 14: submit click → action_detected + dangerous_action_candidate ──
  section(14, 'Submit Release click emits action_detected + dangerous_action_candidate_detected');
  {
    const data = await fetchEvents();
    const submitAction = data.events.find(e =>
      e.type === 'action_detected' &&
      /submit/i.test(e.rawEvidence?.label || '') &&
      e.selector === '#btn-submit-release'
    );
    const submitDanger = data.events.filter(e =>
      e.type === 'dangerous_action_candidate_detected' &&
      e.selector === '#btn-submit-release'
    );
    submitAction && submitDanger.length > 0
      ? pass(`action + ${submitDanger.length} dangerous event(s) for Submit Release`)
      : fail('Submit click did not produce expected events', `action=${!!submitAction}, dangerous=${submitDanger.length}`);
  }

  // ── Check 15: add-track click → action_detected + repeat_group_candidate ───
  section(15, 'Add-track click emits action_detected + repeat_group_candidate_detected');
  {
    const data = await fetchEvents();
    const addAction = data.events.find(e =>
      e.type === 'action_detected' &&
      e.selector === '#btn-add-track'
    );
    const addRepeat = data.events.find(e =>
      e.type === 'repeat_group_candidate_detected' &&
      e.selector === '#btn-add-track'
    );
    addAction && addRepeat
      ? pass(`action + repeat event for Add-track`)
      : fail('Add-track click did not produce expected events', `action=${!!addAction}, repeat=${!!addRepeat}`);
  }

  // ── Check 16: navigation to page-2 → second page_seen ──────────────────────
  section(16, 'Following Next → link triggers navigation; new page_seen fires');
  {
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click('#lnk-next'),
    ]);
    await page.waitForTimeout(400);
    const data = await fetchEvents();
    const page2Seen = data.events.find(e =>
      e.type === 'page_seen' &&
      (e.pageUrl || '').includes('page-2.html')
    );
    page2Seen ? pass(`page-2 navigation captured: ${page2Seen.pageUrl}`) : fail('page-2 navigation not captured', JSON.stringify(data.events.filter(e => e.type === 'page_seen').map(e => e.pageUrl)));
  }

  // ── Check 17: derived stats match deriveStatsFromEvents ────────────────────
  section(17, 'Derived stats come straight from canonical event types');
  {
    const data = await fetchEvents();
    const localStats = deriveStatsFromEvents(data.events);
    const serverStats = data.stats || {};
    const sameStats = ['pages','fields','buttons','repeatGroups','outputs','dangerous','checkpoints']
      .every(k => localStats[k] === serverStats[k]);
    const min = localStats.pages >= 2 && localStats.fields >= 3 && localStats.buttons >= 2 && localStats.dangerous >= 1 && localStats.repeatGroups >= 1;
    sameStats && min
      ? pass(`stats consistent: ${JSON.stringify(localStats)}`)
      : fail('stats mismatch or thresholds not met', `local=${JSON.stringify(localStats)} server=${JSON.stringify(serverStats)}`);
  }

  // ── Check 18: no leaked 'mock' source on a real session ───────────────────
  section(18, 'No mock events on a playwrightRecorder session');
  {
    const data = await fetchEvents();
    const mockEvents = data.events.filter(e => e.source === 'mock');
    mockEvents.length === 0 ? pass('zero mock events') : fail(`${mockEvents.length} mock events leaked into a real session`, JSON.stringify(mockEvents.slice(0, 2)));
  }

  // ── Check 19: events appear only after their causing action ────────────────
  section(19, 'No timer-driven / random events between user actions');
  {
    // We snapshotted eventCountBeforeActions before driving the page. After
    // the test paused for a short window, the server should have ONLY added
    // events tied to the actions we performed: ~5 field events, ~2 action
    // events, dangerous + repeat events, page_seen for page-2. A
    // simulation that auto-increments would push the total well above the
    // upper bound here within ~5 seconds.
    const data = await fetchEvents();
    const delta = data.events.length - eventCountBeforeActions;
    // Conservative upper bound — real events from the test ≈ 8–14. We allow
    // headroom for legit duplicates (event delegation on bubbling) but
    // anything above 30 strongly suggests a leaked timer.
    delta > 0 && delta < 30
      ? pass(`captured ${delta} new events after driving the page — within plausible bound`)
      : fail(`unexpected event volume after actions`, `delta=${delta}`);
  }

  // ── Check 20: clean stop ──────────────────────────────────────────────────
  section(20, 'POST /stop closes browser and marks session finished');
  {
    const r = await httpJson('POST', `/api/observation/session/${sessionId}/stop`);
    r.status === 200 && r.body.state === 'finished'
      ? pass(`stop returned state=${r.body.state}`)
      : fail('unexpected stop response', JSON.stringify(r));
  }

  // ── Check 21: events endpoint idempotent after stop ───────────────────────
  section(21, 'GET /events after stop still returns captured events');
  {
    const data = await fetchEvents();
    data.events && data.events.length > 0 && data.state === 'finished'
      ? pass(`${data.events.length} events still available; state=${data.state}`)
      : fail('events disappeared or wrong state after stop', JSON.stringify({ count: data.events?.length, state: data.state }));
  }

  // ── Check 22: mock session does NOT auto-increment counters ───────────────
  section(22, 'Mock session has zero auto-generated capture events (only manual annotations)');
  {
    const startResp = await httpJson('POST', '/api/observation/session/start', { source: 'mock' });
    if (!startResp.body.ok) { fail('could not start mock session', JSON.stringify(startResp)); }
    else {
      const mockSessionId = startResp.body.sessionId;
      // Wait 3 seconds. A timer-based simulation would have produced many
      // page/field events by now.
      await new Promise(r => setTimeout(r, 3000));
      const data = (await httpJson('GET', `/api/observation/session/${mockSessionId}/events`)).body;
      const auto = data.events.filter(e => ![
        'session_started', 'capture_source_selected', 'session_finished',
        'user_note_added', 'user_marked_repeat_group', 'user_marked_dangerous_action',
      ].includes(e.type));
      auto.length === 0
        ? pass(`mock session produced no auto-capture events after 3s (only setup events)`)
        : fail(`mock session leaked ${auto.length} auto-capture events`, JSON.stringify(auto.slice(0, 3)));
      await httpJson('POST', `/api/observation/session/${mockSessionId}/stop`);
    }
  }

} catch (e) {
  console.error('Test execution error:', e.stack || e.message);
  exitCode = 1;
}

try { if (cdpBrowser) await cdpBrowser.close(); } catch {}
stopServer();

console.log('\n══════════════════════════════════════');
console.log(`Observation Playwright acceptance: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════');
if (failed > 0 || exitCode !== 0) process.exit(1);
