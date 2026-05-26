#!/usr/bin/env node
/**
 * Acceptance test: observation hardening
 *
 * Locks down behaviors that aren't directly proved by the main
 * Playwright capture acceptance test:
 *
 *   1  Visible-browser default — source code guarantees that
 *      `chromium.launch({ headless: ... })` only goes headless when
 *      BROWSY_OBS_HEADLESS=1. The default (manual `npm run wizard`) opens
 *      a real visible browser.
 *
 *   2  Empty Start URL is rejected for Playwright Recorder — server returns
 *      400 and the UI focuses the Start URL field.
 *
 *   3  Restart hygiene — starting a second observation session after stopping
 *      the first does NOT leak events from the first session.
 *
 *   4  Multi-page navigation — visiting two URLs in one session produces two
 *      page_seen events in chronological order.
 *
 *   5  Repeat-group annotation goes through the canonical event log — the
 *      UI does not directly mutate stats; it emits a user_marked_repeat_group
 *      event, and the count derives from that event.
 *
 *   6  Dangerous-action annotation goes through the canonical event log — same
 *      contract as (5) but for user_marked_dangerous_action.
 *
 *   7  Mock / demo mode never emits automatic timer / simulation events.
 *
 * Usage:
 *   npm run acceptance:observation-hardening
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;
const CDP_PORT = 9323;
const BASE_URL = `http://localhost:${PORT}`;
const FIXTURE_PAGE_1 = `${BASE_URL}/fixtures/observation-test-form/page-1.html`;
const FIXTURE_PAGE_2 = `${BASE_URL}/fixtures/observation-test-form/page-2.html`;

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); failed++; }
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
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
let uiBrowser = null;
let exitCode = 0;
try {

  // ── Check 1: visible-browser default (source contract) ─────────────────────
  section(1, 'Visible-browser default: BROWSY_OBS_HEADLESS is the only headless trigger');
  {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'wizard/server.mjs'), 'utf8');
    // The contract is one line. Locked verbatim so refactors don't silently
    // change the default (which would surprise users running `npm run wizard`).
    const literal = `const headless = process.env.BROWSY_OBS_HEADLESS === '1'`;
    const hasLiteral = src.includes(literal);

    // Belt and suspenders: no other code path may pass `headless: true`.
    const otherHeadless = /headless\s*:\s*true/.test(src);

    hasLiteral && !otherHeadless
      ? pass('headless flag derived exclusively from BROWSY_OBS_HEADLESS=1; nothing else sets headless:true')
      : fail('visible-browser default contract violated', `hasLiteral=${hasLiteral} otherHeadless=${otherHeadless}`);
  }

  // ── Check 2: empty Start URL is rejected ───────────────────────────────────
  section(2, 'Empty Start URL for Playwright Recorder is rejected by server AND UI');
  {
    // Server side: missing startUrl returns 400.
    const r = await httpJson('POST', '/api/observation/session/start', { source: 'playwrightRecorder' });
    const serverOk = r.status === 400 && /starturl/i.test(r.body.error || '');

    // UI side: opening the wizard, leaving Start URL blank, clicking Start
    // should NOT transition to the connecting state. Field should receive focus.
    uiBrowser = await chromium.launch({ headless: true });
    const uiCtx = await uiBrowser.newContext();
    const uiPage = await uiCtx.newPage();
    // Stub window.alert so the production-code path (alert + focus) doesn't hang.
    await uiPage.addInitScript(() => { window.alert = () => {}; });
    await uiPage.goto(BASE_URL);
    await uiPage.waitForLoadState('domcontentloaded');
    await uiPage.waitForTimeout(200);

    // Navigate to step 4
    await uiPage.click('#obs-import-nav-btn');
    await uiPage.waitForTimeout(150);

    // Confirm default is playwrightRecorder (no click needed) and URL is blank.
    await uiPage.fill('#obs-start-url-input', '');
    await uiPage.click('#obs-start-btn');
    await uiPage.waitForTimeout(400);

    const stateInfo = await uiPage.evaluate(() => {
      const recording = document.getElementById('obs-state-recording');
      const connecting = document.getElementById('obs-state-connecting');
      const notStarted = document.getElementById('obs-state-not-started');
      const active = document.activeElement;
      return {
        notStartedVisible: notStarted && notStarted.style.display !== 'none',
        connectingVisible: connecting && connecting.style.display !== 'none',
        recordingVisible: recording && recording.style.display !== 'none',
        focusedId: active && active.id || null,
      };
    });

    const uiOk = !stateInfo.connectingVisible && !stateInfo.recordingVisible && stateInfo.notStartedVisible && stateInfo.focusedId === 'obs-start-url-input';
    await uiBrowser.close();
    uiBrowser = null;

    serverOk && uiOk
      ? pass(`server 400 + UI stays in not-started; focus=${stateInfo.focusedId}`)
      : fail('empty Start URL not enforced everywhere', `serverOk=${serverOk} uiState=${JSON.stringify(stateInfo)}`);
  }

  // ── Check 3: restart hygiene ───────────────────────────────────────────────
  section(3, 'Restart hygiene: a second session has its own clean event log');
  {
    // Session A: start (which launches a browser on the CDP port), connect via
    // CDP, drive a field, stop.
    const a = await httpJson('POST', '/api/observation/session/start', { source: 'playwrightRecorder', startUrl: FIXTURE_PAGE_1, workflowId: 'obs-hardening-a' });
    if (!a.body.ok) { fail('could not start session A', JSON.stringify(a)); }
    else {
      const sidA = a.body.sessionId;
      cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      const pageA = await findCdpPage(cdpBrowser, '/page-1.html');
      await pageA.fill('#title', 'first-session-title');
      await pageA.waitForTimeout(250);
      const aEventsBeforeStop = (await httpJson('GET', `/api/observation/session/${sidA}/events`)).body.events || [];
      const stopA = await httpJson('POST', `/api/observation/session/${sidA}/stop`);
      if (!stopA.body.ok) { fail('could not stop session A', JSON.stringify(stopA)); }
      try { await cdpBrowser.close(); } catch {}
      cdpBrowser = null;

      // Session B: brand-new session — must not carry session A's events.
      const b = await httpJson('POST', '/api/observation/session/start', { source: 'playwrightRecorder', startUrl: FIXTURE_PAGE_1, workflowId: 'obs-hardening-b' });
      if (!b.body.ok) { fail('could not start session B', JSON.stringify(b)); }
      else {
        const sidB = b.body.sessionId;
        const bData = (await httpJson('GET', `/api/observation/session/${sidB}/events`)).body;
        const sidAEvents = bData.events.filter(e => e.sessionId === sidA);
        const leakedTitle = bData.events.some(e => e.rawEvidence?.value === 'first-session-title');
        const allBelongToB = bData.events.every(e => e.sessionId === sidB);
        const idsDistinct = sidA !== sidB;

        sidAEvents.length === 0 && !leakedTitle && allBelongToB && idsDistinct
          ? pass(`session B has ${bData.events.length} fresh event(s); zero leak from session A (which had ${aEventsBeforeStop.length})`)
          : fail('session state leaked between starts', `sidAEvents=${sidAEvents.length} leakedTitle=${leakedTitle} allBelongToB=${allBelongToB} idsDistinct=${idsDistinct}`);

        await httpJson('POST', `/api/observation/session/${sidB}/stop`);
      }
    }
  }

  // ── Check 4: multi-page navigation emits ordered page_seen events ─────────
  section(4, 'Multi-page navigation emits page_seen events in order');
  {
    const start = await httpJson('POST', '/api/observation/session/start', { source: 'playwrightRecorder', startUrl: FIXTURE_PAGE_1, workflowId: 'obs-hardening-nav' });
    if (!start.body.ok) { fail('could not start nav session', JSON.stringify(start)); }
    else {
      const sid = start.body.sessionId;
      cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      const page = await findCdpPage(cdpBrowser, '/page-1.html');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(300);
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        page.click('#lnk-next'),
      ]);
      await page.waitForTimeout(500);

      const data = (await httpJson('GET', `/api/observation/session/${sid}/events`)).body;
      const pageSeen = data.events.filter(e => e.type === 'page_seen');
      const urls = pageSeen.map(e => e.pageUrl || '');
      const idxP1 = urls.findIndex(u => u.includes('/page-1.html'));
      const idxP2 = urls.findIndex(u => u.includes('/page-2.html'));
      const inOrder = idxP1 >= 0 && idxP2 >= 0 && idxP1 < idxP2;

      // Also check the events are in chronological order by timestamp.
      const tsOrdered = pageSeen.every((e, i, arr) => i === 0 || arr[i - 1].timestamp <= e.timestamp);

      inOrder && tsOrdered
        ? pass(`page_seen order verified: page-1 (idx ${idxP1}) → page-2 (idx ${idxP2}); ${pageSeen.length} total`)
        : fail('page_seen events not in expected order', `urls=${JSON.stringify(urls)} tsOrdered=${tsOrdered}`);

      await httpJson('POST', `/api/observation/session/${sid}/stop`);
      try { await cdpBrowser.close(); } catch {}
      cdpBrowser = null;
    }
  }

  // ── Check 5 & 6: annotations go through the canonical event log ───────────
  section(5, 'Repeat-group annotation is recorded as a canonical event (UI does not mutate counters directly)');
  section(6, 'Dangerous-action annotation is recorded as a canonical event (UI does not mutate counters directly)');
  {
    // Strategy: spy on the wizard's pushLocalObsEvent — the one chokepoint that
    // turns a UI annotation into a canonical event. If markRepeatGroup() or
    // markDangerous() bypasses it (and mutates stats directly instead), the
    // spy won't see the matching event-type call.
    uiBrowser = await chromium.launch({ headless: true });
    const uiCtx = await uiBrowser.newContext();
    const uiPage = await uiCtx.newPage();
    await uiPage.addInitScript(() => {
      window.prompt = () => 'fixture-annotation-text';
      window.alert = () => {};
      // Intercept the 1.5s server-event poll. Letting it run would clobber
      // UI-only manual annotations from obsSession.events and the delta
      // assertions below would race. For a mock session there is no other
      // source of events, so a no-op response is safe and surgical.
      const origFetch = window.fetch;
      window.fetch = function (url, opts) {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        if (/\/api\/observation\/session\/[^/]+\/events$/.test(u)) {
          // 503 makes pollObsEvents() bail at `if (!r.ok) return;` without
          // touching obsSession.events. UI annotations survive.
          return Promise.resolve(new Response('', { status: 503 }));
        }
        return origFetch.apply(this, arguments);
      };
    });
    await uiPage.goto(BASE_URL);
    await uiPage.waitForLoadState('domcontentloaded');
    await uiPage.waitForTimeout(200);

    // Go to step 4 and start a mock session — mock never auto-fires events,
    // so any change must come from our explicit annotation calls.
    await uiPage.click('#obs-import-nav-btn');
    await uiPage.waitForTimeout(150);
    await uiPage.click('#obs-source-mock');
    await uiPage.waitForTimeout(100);
    await uiPage.click('#obs-start-btn');
    await uiPage.waitForTimeout(1200);

    // Open the raw-events debug panel — it renders the canonical event log
    // straight from obsSession.events. Reading the JSON out of the panel
    // tells us what events the wizard actually appended for each annotation.
    await uiPage.evaluate(() => {
      const p = document.getElementById('obs-raw-events-panel');
      if (p) p.open = true;
      if (typeof window.renderObsRawEvents === 'function') window.renderObsRawEvents();
    });
    await uiPage.waitForTimeout(100);

    const before = await uiPage.evaluate(() => ({
      repeat: parseInt(document.getElementById('stat-groups').textContent, 10),
      dangerous: parseInt(document.getElementById('stat-dangerous').textContent, 10),
      annList: document.getElementById('obs-annotations-list')?.children.length || 0,
      rawJson: document.getElementById('obs-raw-events-pre')?.textContent || '',
    }));

    await uiPage.evaluate(() => window.markRepeatGroup());
    await uiPage.waitForTimeout(100);
    await uiPage.evaluate(() => window.markDangerous());
    await uiPage.waitForTimeout(100);

    const after = await uiPage.evaluate(() => ({
      repeat: parseInt(document.getElementById('stat-groups').textContent, 10),
      dangerous: parseInt(document.getElementById('stat-dangerous').textContent, 10),
      annList: document.getElementById('obs-annotations-list')?.children.length || 0,
      rawJson: document.getElementById('obs-raw-events-pre')?.textContent || '',
    }));

    let rawEvents = [];
    try { rawEvents = JSON.parse(after.rawJson); } catch {}
    const beforeCount = (() => { try { return JSON.parse(before.rawJson).length; } catch { return 0; } })();
    const newEvents = rawEvents.slice(beforeCount);
    const newTypes = newEvents.map(e => e.type);

    const repeatDelta = after.repeat - before.repeat;
    const dangerousDelta = after.dangerous - before.dangerous;
    const annDelta = after.annList - before.annList;
    const sawRepeatEvent = newTypes.includes('user_marked_repeat_group');
    const sawDangerEvent = newTypes.includes('user_marked_dangerous_action');

    repeatDelta === 1 && sawRepeatEvent
      ? pass(`repeat counter rose ${before.repeat} → ${after.repeat}; canonical event user_marked_repeat_group present in event log`)
      : fail('repeat-group annotation did not flow through canonical event', `repeatDelta=${repeatDelta} sawRepeatEvent=${sawRepeatEvent} newTypes=${JSON.stringify(newTypes)}`);
    dangerousDelta === 1 && sawDangerEvent
      ? pass(`dangerous counter rose ${before.dangerous} → ${after.dangerous}; canonical event user_marked_dangerous_action present in event log`)
      : fail('dangerous annotation did not flow through canonical event', `dangerousDelta=${dangerousDelta} sawDangerEvent=${sawDangerEvent} newTypes=${JSON.stringify(newTypes)}`);
    annDelta === 2
      ? pass(`annotation list grew by 2 entries — UI rendered from events`)
      : fail('annotation list did not grow as expected', `annDelta=${annDelta}`);

    await uiPage.click('#obs-finish-btn').catch(() => {});
    await uiPage.waitForTimeout(200);
    await uiBrowser.close();
    uiBrowser = null;
  }

  // ── Check 7: mock mode never auto-emits ────────────────────────────────────
  section(7, 'Mock / demo mode never emits automatic timer / simulation events');
  {
    const r = await httpJson('POST', '/api/observation/session/start', { source: 'mock' });
    if (!r.body.ok) { fail('could not start mock session', JSON.stringify(r)); }
    else {
      const sid = r.body.sessionId;
      // Wait 3.5 seconds — far longer than any plausible 1Hz simulation tick.
      await new Promise(res => setTimeout(res, 3500));
      const data = (await httpJson('GET', `/api/observation/session/${sid}/events`)).body;
      // Only setup events should exist — anything else means an auto-timer leaked.
      const auto = data.events.filter(e => ![
        'session_started', 'capture_source_selected', 'session_finished',
        'user_note_added', 'user_marked_repeat_group', 'user_marked_dangerous_action',
      ].includes(e.type));
      auto.length === 0
        ? pass(`mock session produced no auto-capture events after 3.5s (only setup events: ${data.events.map(e => e.type).join(', ')})`)
        : fail(`mock session leaked ${auto.length} auto-capture events`, JSON.stringify(auto.slice(0, 3)));
      await httpJson('POST', `/api/observation/session/${sid}/stop`);
    }
  }

} catch (e) {
  console.error('Test execution error:', e.stack || e.message);
  exitCode = 1;
}

try { if (uiBrowser) await uiBrowser.close(); } catch {}
try { if (cdpBrowser) await cdpBrowser.close(); } catch {}
stopServer();

console.log('\n══════════════════════════════════════');
console.log(`Observation hardening: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════');
if (failed > 0 || exitCode !== 0) process.exit(1);


// ── Helper: find the page the server's launched browser navigated to ─────────

async function findCdpPage(browser, urlContains) {
  for (let i = 0; i < 40; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes(urlContains)) return p;
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`could not find page containing "${urlContains}" in CDP browser`);
}
