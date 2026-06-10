#!/usr/bin/env node
/**
 * Acceptance test: input/completion signals
 *
 * Verifies that Browsy makes it obvious when it needs a human and when it is
 * done, across all three channels:
 *
 *   1  emitDone prints a human banner to stdout
 *   2  emitDone prints a single machine-readable SIGNAL_MARKER line
 *   3  the machine line parses as JSON with kind:"done" and the given status
 *   4  emitNeedsInput routes its banner + machine line to stderr
 *   5  the needs_input machine line carries reason + blockedActions
 *   6  a webhook POST is delivered to an explicit callbackUrl with the payload
 *   7  the BROWSY_CALLBACK_URL env var is used when no explicit URL is passed
 *   8  showBrowserBanner injects a visible overlay into a live Playwright page
 *   9  clearBrowserBanner removes the overlay
 *
 * Usage:
 *   node scripts/acceptance-input-completion-signals.mjs
 */

import http from 'http';
import {
  emitDone,
  emitNeedsInput,
  showBrowserBanner,
  clearBrowserBanner,
  SIGNAL_MARKER,
} from '../src/core/signals.mjs';

let passed = 0, failed = 0, skipped = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function skip(label, detail = '') {
  console.log('SKIP  ' + label + (detail ? '\n      ' + detail : ''));
  skipped++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// Capture console output around a function without losing the real streams.
async function capture(fn) {
  const out = [], err = [];
  const realLog = console.log, realErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

function machineLine(text) {
  const line = text.split('\n').find(l => l.startsWith(SIGNAL_MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(SIGNAL_MARKER.length).trim());
  } catch {
    return null;
  }
}

// Start a one-shot webhook receiver. Resolves with the parsed body it receives.
function webhookReceiver() {
  let resolveBody;
  const received = new Promise(r => { resolveBody = r; });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      try { resolveBody(JSON.parse(body)); } catch { resolveBody(null); }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/hook`, received, close: () => server.close() });
    });
  });
}

// ── Checks 1-3: done signal on stdout ────────────────────────────────────────
section(1, 'done signal → stdout banner + machine line');
{
  const { out, err } = await capture(() =>
    emitDone({ status: 'dry_run_passed', workflowId: 'demo', filled: 3, skipped: 1, errors: 0 })
  );
  if (/BROWSY DONE/.test(out)) pass('emitDone prints a human banner to stdout');
  else fail('emitDone prints a human banner to stdout', out);

  const line = machineLine(out);
  if (line) pass('emitDone prints a machine-readable SIGNAL_MARKER line');
  else fail('emitDone prints a machine-readable SIGNAL_MARKER line', out);

  if (line && line.kind === 'done' && line.status === 'dry_run_passed' && line.signal === 'browsy') {
    pass('machine line parses as JSON with kind:"done" and the given status');
  } else {
    fail('machine line parses as JSON with kind:"done" and the given status', JSON.stringify(line));
  }
  if (err.trim()) fail('done signal must not write to stderr', err);
}

// ── Checks 4-5: needs_input signal on stderr ─────────────────────────────────
section(2, 'needs_input signal → stderr banner + machine line');
{
  const { out, err } = await capture(() =>
    emitNeedsInput({ reason: 'Review before final submit', blockedActions: ['Submit', 'Release'] })
  );
  if (/BROWSY NEEDS YOU/.test(err)) pass('emitNeedsInput routes its banner to stderr');
  else fail('emitNeedsInput routes its banner to stderr', err);

  const line = machineLine(err);
  if (line && line.kind === 'needs_input' && line.reason === 'Review before final submit'
      && Array.isArray(line.blockedActions) && line.blockedActions.includes('Release')) {
    pass('needs_input machine line carries reason + blockedActions');
  } else {
    fail('needs_input machine line carries reason + blockedActions', JSON.stringify(line));
  }
  if (out.trim()) fail('needs_input signal must not write to stdout', out);
}

// ── Check 6: explicit webhook delivery ───────────────────────────────────────
section(3, 'webhook delivery (explicit callbackUrl)');
{
  const hook = await webhookReceiver();
  await capture(() =>
    emitDone({ status: 'live_run_completed', workflowId: 'demo' }, { callbackUrl: hook.url })
  );
  const body = await Promise.race([
    hook.received,
    new Promise(r => setTimeout(() => r('timeout'), 4000)),
  ]);
  hook.close();
  if (body && body !== 'timeout' && body.kind === 'done' && body.status === 'live_run_completed') {
    pass('webhook POST delivered to explicit callbackUrl with the payload');
  } else {
    fail('webhook POST delivered to explicit callbackUrl with the payload', JSON.stringify(body));
  }
}

// ── Check 7: BROWSY_CALLBACK_URL env fallback ────────────────────────────────
section(4, 'webhook delivery (BROWSY_CALLBACK_URL env)');
{
  const hook = await webhookReceiver();
  const prev = process.env.BROWSY_CALLBACK_URL;
  process.env.BROWSY_CALLBACK_URL = hook.url;
  try {
    await capture(() => emitNeedsInput({ reason: 'env-routed' }));
    const body = await Promise.race([
      hook.received,
      new Promise(r => setTimeout(() => r('timeout'), 4000)),
    ]);
    if (body && body !== 'timeout' && body.kind === 'needs_input' && body.reason === 'env-routed') {
      pass('BROWSY_CALLBACK_URL env var is used when no explicit URL is passed');
    } else {
      fail('BROWSY_CALLBACK_URL env var is used when no explicit URL is passed', JSON.stringify(body));
    }
  } finally {
    hook.close();
    if (prev === undefined) delete process.env.BROWSY_CALLBACK_URL;
    else process.env.BROWSY_CALLBACK_URL = prev;
  }
}

// ── Checks 8-9: in-browser overlay ───────────────────────────────────────────
section(5, 'in-browser overlay injection');
{
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    chromium = null;
  }
  if (!chromium) {
    skip('playwright unavailable — browser overlay checks skipped', 'run `npx playwright install` to exercise these');
  } else {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('data:text/html,<html><body><h1>fixture</h1></body></html>');
      await showBrowserBanner(page, { kind: 'needs_input', message: 'do the thing' });
      const text = await page.locator('#__browsy_signal_banner').textContent();
      if (text && /BROWSY NEEDS YOU/.test(text) && /do the thing/.test(text)) {
        pass('showBrowserBanner injects a visible overlay into the page');
      } else {
        fail('showBrowserBanner injects a visible overlay into the page', String(text));
      }
      await clearBrowserBanner(page);
      const count = await page.locator('#__browsy_signal_banner').count();
      if (count === 0) pass('clearBrowserBanner removes the overlay');
      else fail('clearBrowserBanner removes the overlay', `still ${count} present`);
    } finally {
      await browser.close();
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Signals acceptance: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);
