#!/usr/bin/env node
/**
 * Capture a Playwright observation session against the realistic-upload
 * fixture and write a sanitized golden event log to:
 *
 *   docs/fixtures/observation-realistic-upload-events.json
 *
 * The script:
 *   1. Spawns wizard/server.mjs (BROWSY_OBS_HEADLESS=1, BROWSY_OBS_CDP_PORT=9323).
 *   2. Starts a playwrightRecorder session against the local fixture URL.
 *   3. Drives the page via CDP through the realistic flow:
 *        Stage 1 — release metadata + cover-art file selection
 *        Stage 2 — track 1 audio + add another track + track 2 + required
 *                  confirmation checkboxes
 *        Stage 3 — review (NEVER clicks Submit & Publish Release)
 *   4. Fetches the canonical event list from /api/observation/session/:id/events.
 *   5. Sanitizes the events:
 *        - sessionId / event id placeholders ("session-realistic-upload", "evt-<n>")
 *        - timestamps replaced with monotonically-increasing offsets
 *          ("+0", "+1", …) so the file is git-stable.
 *        - pageUrl strings are normalized to drop host:port (the test always
 *          runs against localhost:3333).
 *        - rawEvidence.value for file inputs collapses to "<file: cover.png>"
 *          style placeholders — never a local FS path.
 *   6. Writes the sanitized log + a tiny header to the golden file.
 *
 * Re-run this script only when the capture pipeline changes and you need a
 * fresh golden. Day-to-day, the test reads the committed file.
 *
 * IMPORTANT — Safety:
 *   - The fixture serves the page locally; no real DistroKid endpoint is hit.
 *   - The script DOES NOT click "Submit & Publish Release".
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
const CDP_PORT = 9323;
const BASE_URL = `http://localhost:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/fixtures/observation-realistic-upload/release.html`;
const GOLDEN_PATH = path.join(REPO_ROOT, 'docs', 'fixtures', 'observation-realistic-upload-events.json');

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
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/`, { timeout: 1500 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

let serverProcess = null;
async function startServer() {
  if (await isServerRunning()) {
    throw new Error(`port ${PORT} already in use — stop the running wizard and retry`);
  }
  // Defaults for golden-capture mode:
  //   - headless on (no UI flicker during CI)
  //   - screenshots OFF (keeps the golden git-stable — paths under
  //     output/observations/_sessions/<rand>/ would otherwise leak into
  //     the canonical event log)
  //   - DOM snapshots OFF (same reason)
  // An operator running this script intentionally to refresh the golden
  // can override via BROWSY_OBS_CAPTURE_SCREENSHOTS=1 / BROWSY_OBS_CAPTURE_DOM=1.
  serverProcess = spawn('node', ['wizard/server.mjs'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      BROWSY_OBS_CAPTURE_SCREENSHOTS: '0',
      BROWSY_OBS_CAPTURE_DOM: '0',
      ...process.env,
      BROWSY_OBS_HEADLESS: '1',
      BROWSY_OBS_CDP_PORT: String(CDP_PORT),
    },
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

// ── Sanitize the captured events so the golden file is stable + path-safe ──
function sanitize(events) {
  let nextEvtId = 1;
  const baseTs = 0; // we use synthetic offsets so two captures diff-clean
  const sanitized = events.map((ev, i) => {
    const clone = JSON.parse(JSON.stringify(ev));
    clone.sessionId = 'session-realistic-upload';
    clone.id = `evt-${String(nextEvtId++).padStart(3, '0')}`;
    clone.timestamp = `+${i}`;
    if (typeof clone.pageUrl === 'string') {
      // Drop "http://localhost:PORT" prefix — the path is the stable bit.
      clone.pageUrl = clone.pageUrl.replace(/^https?:\/\/[^/]+/, '');
    }
    if (clone.rawEvidence && typeof clone.rawEvidence === 'object') {
      const raw = clone.rawEvidence;
      // For file inputs, keep ONLY the filename ("<file: cover.png>"). Strip
      // any path component if it somehow leaked.
      if (typeof raw.value === 'string' && raw.value.startsWith('<file:')) {
        const m = raw.value.match(/<file:\s*([^>]+?)\s*>/);
        if (m) {
          const base = path.basename(m[1]);
          raw.value = `<file: ${base}>`;
        }
      }
    }
    return clone;
  });
  return sanitized;
}

// ── Drive the fixture: stage 1 → stage 2 → stage 3, stop short of publish ──
async function driveRealisticUpload(page, tmpCoverPath, tmpAudioPath) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(400); // let initial scan flush

  // Stage 1 — Release metadata
  await page.fill('#release-title', 'Tiny Robot Parade EP');
  await page.waitForTimeout(80);
  await page.fill('#primary-artist', 'The Tiny Robots');
  await page.waitForTimeout(80);
  await page.fill('#release-date', '2026-06-01');
  await page.waitForTimeout(80);
  await page.selectOption('#genre', 'electronic');
  await page.waitForTimeout(80);
  await page.fill('#label-email', 'ops@label.example');
  await page.waitForTimeout(80);
  await page.setInputFiles('#cover-art', tmpCoverPath);
  await page.waitForTimeout(150);

  await page.click('#btn-to-tracks');
  await page.waitForTimeout(200);

  // Stage 2 — Tracks
  await page.fill('#track-title-1', 'Spin Up Spin Down');
  await page.waitForTimeout(80);
  await page.fill('#track-isrc-1', 'US-XYZ-26-00001');
  await page.waitForTimeout(80);
  await page.setInputFiles('#track-audio-1', tmpAudioPath);
  await page.waitForTimeout(120);

  await page.click('#btn-add-track');
  await page.waitForTimeout(200);

  await page.fill('#track-title-2', 'Bolts and Lullabies');
  await page.waitForTimeout(80);
  await page.fill('#track-isrc-2', 'US-XYZ-26-00002');
  await page.waitForTimeout(80);
  await page.setInputFiles('#track-audio-2', tmpAudioPath);
  await page.waitForTimeout(120);

  // Required confirmations
  await page.check('#chk-rights');
  await page.waitForTimeout(80);
  await page.check('#chk-terms');
  await page.waitForTimeout(80);

  await page.click('#btn-to-review');
  await page.waitForTimeout(250);

  // Stage 3 — Review. We deliberately do NOT click Submit & Publish Release.
  // The dangerous-action candidate should already be flagged by initial scan.
}

async function main() {
  console.log('Booting wizard server…');
  await startServer();

  // Temp files we can hand to file inputs without leaking real assets.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-capture-'));
  const coverPath = path.join(tmpDir, 'cover.png');
  const audioPath = path.join(tmpDir, 'track.wav');
  fs.writeFileSync(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  fs.writeFileSync(audioPath, Buffer.from('RIFF....WAVE'));

  let cdpBrowser = null;
  let sessionId;
  try {
    console.log('Starting Playwright observation session…');
    const startResp = await httpJson('POST', '/api/observation/session/start', {
      source: 'playwrightRecorder',
      startUrl: FIXTURE_URL,
      workflowId: 'observation-realistic-upload',
    });
    if (startResp.status !== 200 || !startResp.body.ok) {
      throw new Error('session start failed: ' + JSON.stringify(startResp));
    }
    sessionId = startResp.body.sessionId;
    console.log(`  sessionId=${sessionId}`);

    cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    const page = await (async () => {
      for (let i = 0; i < 30; i++) {
        for (const ctx of cdpBrowser.contexts()) {
          for (const p of ctx.pages()) if (p.url().startsWith(BASE_URL)) return p;
        }
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error('could not find observed page over CDP');
    })();

    console.log('Driving fixture stages…');
    await driveRealisticUpload(page, coverPath, audioPath);

    console.log('Fetching captured events…');
    const eventsResp = await httpJson('GET', `/api/observation/session/${sessionId}/events`);
    const events = eventsResp.body.events || [];
    console.log(`  ${events.length} canonical events`);

    console.log('Stopping session…');
    await httpJson('POST', `/api/observation/session/${sessionId}/stop`);

    const sanitized = sanitize(events);
    const goldenDoc = {
      $note: 'Sanitized golden event log captured from observation-realistic-upload fixture. ' +
        'Re-generate with: node scripts/capture-observation-realistic-upload.mjs',
      $source: {
        fixture: 'fixtures/observation-realistic-upload/release.html',
        captureSource: 'playwrightRecorder',
        sessionId: 'session-realistic-upload',
        flow: 'metadata → tracks (×2) → review. Submit & Publish Release intentionally NOT clicked.',
      },
      events: sanitized,
    };
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(goldenDoc, null, 2) + '\n', 'utf8');
    console.log(`\nWrote ${path.relative(REPO_ROOT, GOLDEN_PATH)}`);
    console.log(`  ${sanitized.length} events sanitized`);
  } finally {
    try { if (cdpBrowser) await cdpBrowser.close(); } catch {}
    stopServer();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(e => { console.error('capture failed:', e.stack || e.message); stopServer(); process.exit(1); });
