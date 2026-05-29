// Browsy input/completion signals.
//
// One place that answers two questions loudly and consistently:
//   1. "Browsy needs a real human right now."   → emitNeedsInput()
//   2. "Browsy is finished — here is the outcome." → emitDone()
//
// Each signal fans out over up to three channels so it is obvious no matter
// where the operator (or a calling app) is watching:
//
//   • Terminal — a boxed, human-readable banner plus a single greppable,
//     machine-readable line prefixed with SIGNAL_MARKER. Calling apps that
//     spawn Browsy can parse stdout for that line.
//   • Webhook — an optional best-effort JSON POST to a calling app. The URL
//     comes from the explicit `callbackUrl` option or the BROWSY_CALLBACK_URL
//     environment variable. Failures never break a run.
//   • Browser — an on-page overlay injected into a live Playwright page so the
//     signal is visible inside the browser window itself (e.g. an operator
//     staring at a headed checkpoint sees "Browsy needs you" rather than a
//     silent, idle page).

import http from 'http';
import https from 'https';

// Single, stable token a calling app can grep stdout for.
export const SIGNAL_MARKER = '[BROWSY_SIGNAL]';

const KINDS = {
  needs_input: {
    icon: '⏸',
    title: 'BROWSY NEEDS YOU',
    stream: 'stderr', // routed to stderr so it stands out from normal logs
  },
  done: {
    icon: '✅',
    title: 'BROWSY DONE',
    stream: 'stdout',
  },
};

// ── Terminal rendering ───────────────────────────────────────────────────────

function box(lines) {
  const width = Math.max(...lines.map(l => l.length), 0);
  const top = '┌' + '─'.repeat(width + 2) + '┐';
  const bot = '└' + '─'.repeat(width + 2) + '┘';
  const body = lines.map(l => '│ ' + l.padEnd(width) + ' │');
  return [top, ...body, bot].join('\n');
}

function renderBanner(kind, signal) {
  const meta = KINDS[kind];
  const lines = [`${meta.icon}  ${meta.title}`];
  if (signal.reason) lines.push(signal.reason);
  if (signal.suggestedAction) lines.push('→ ' + signal.suggestedAction);
  if (kind === 'done') {
    const parts = [];
    if (signal.status) parts.push('status: ' + signal.status);
    if (typeof signal.filled === 'number') parts.push('filled: ' + signal.filled);
    if (typeof signal.skipped === 'number') parts.push('skipped: ' + signal.skipped);
    if (typeof signal.errors === 'number') parts.push('errors: ' + signal.errors);
    if (parts.length) lines.push(parts.join('   '));
    if (signal.artifactsDir) lines.push('artifacts: ' + signal.artifactsDir);
  }
  if (Array.isArray(signal.blockedActions) && signal.blockedActions.length) {
    lines.push('blocked: ' + signal.blockedActions.join(', '));
  }
  return box(lines);
}

// ── Webhook ──────────────────────────────────────────────────────────────────

// Best-effort JSON POST. Always resolves; never throws. Resolves to
// { ok, status?, error? } so callers may log the outcome if they care.
function postWebhook(url, payload, { timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      resolve({ ok: false, error: `invalid callback URL: ${err.message}` });
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload));
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
        },
        timeout: timeoutMs,
      },
      res => {
        // Drain so the socket can close.
        res.on('data', () => {});
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode }));
      }
    );
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `callback timed out after ${timeoutMs}ms` });
    });
    req.write(body);
    req.end();
  });
}

// ── In-browser overlay ─────────────────────────────────────────────────────────

// Inject (or update) a fixed banner at the top of a live Playwright page so the
// signal is visible inside the browser window. Safe no-op if `page` is falsy or
// evaluation fails (e.g. page already closing). Returns true on success.
export async function showBrowserBanner(page, { kind = 'needs_input', message = '' } = {}) {
  if (!page) return false;
  const meta = KINDS[kind] || KINDS.needs_input;
  const color = kind === 'done' ? '#0a7d28' : '#b35900';
  const text = `${meta.icon}  ${meta.title}${message ? ' — ' + message : ''}`;
  try {
    await page.evaluate(
      ({ text, color }) => {
        const ID = '__browsy_signal_banner';
        let el = document.getElementById(ID);
        if (!el) {
          el = document.createElement('div');
          el.id = ID;
          document.documentElement.appendChild(el);
        }
        el.textContent = text;
        el.setAttribute(
          'style',
          [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
            `background:${color}`, 'color:#fff', 'font:600 15px/1.4 system-ui,sans-serif',
            'padding:10px 16px', 'text-align:center', 'box-shadow:0 2px 8px rgba(0,0,0,.3)',
            'pointer-events:none', 'white-space:pre-wrap',
          ].join(';')
        );
      },
      { text, color }
    );
    return true;
  } catch {
    return false;
  }
}

// Remove the overlay banner if present. Safe no-op on failure.
export async function clearBrowserBanner(page) {
  if (!page) return;
  try {
    await page.evaluate(() => {
      document.getElementById('__browsy_signal_banner')?.remove();
    });
  } catch {
    /* page may be closing — ignore */
  }
}

// ── Core emit ──────────────────────────────────────────────────────────────────

function resolveCallbackUrl(explicit) {
  return explicit || process.env.BROWSY_CALLBACK_URL || null;
}

// Emit a fully-formed signal object across terminal + (optional) webhook.
// `signal` must include a `kind` of 'needs_input' or 'done'.
// Options:
//   callbackUrl — overrides BROWSY_CALLBACK_URL for the webhook channel
//   quiet       — suppress the terminal banner (machine line still printed)
// Returns { webhook } describing the webhook outcome (or null when not sent).
export async function emitSignal(signal, { callbackUrl, quiet = false } = {}) {
  const kind = signal.kind;
  const meta = KINDS[kind];
  if (!meta) throw new Error(`emitSignal: unknown kind "${kind}"`);

  const enriched = { signal: 'browsy', emittedAt: new Date().toISOString(), ...signal };
  const write = meta.stream === 'stderr' ? console.error : console.log;

  if (!quiet) write('\n' + renderBanner(kind, enriched));
  // Machine-readable line — single line, always on the same stream as the banner.
  write(`${SIGNAL_MARKER} ${JSON.stringify(enriched)}`);

  let webhook = null;
  const url = resolveCallbackUrl(callbackUrl);
  if (url) {
    webhook = await postWebhook(url, enriched);
    if (!webhook.ok) {
      console.error(`[WARN] Browsy signal webhook failed: ${webhook.error || 'HTTP ' + webhook.status}`);
    }
  }
  return { webhook };
}

// ── Convenience builders ─────────────────────────────────────────────────────────

// Announce that a real human is required. Optionally paints the live browser page.
export async function emitNeedsInput(
  { reason, workflowId = null, runId = null, blockedActions = [], suggestedAction = null, actionRequests = null, page = null } = {},
  options = {}
) {
  if (page) {
    await showBrowserBanner(page, { kind: 'needs_input', message: reason || 'human action required' });
  }
  return emitSignal(
    { kind: 'needs_input', reason, workflowId, runId, blockedActions, suggestedAction, actionRequests },
    options
  );
}

// Announce that the run finished. Optionally paints the live browser page before
// the caller closes it.
export async function emitDone(
  { status = null, workflowId = null, runId = null, filled, skipped, errors, artifactsDir = null, capturedOutputs = null, page = null } = {},
  options = {}
) {
  if (page) {
    await showBrowserBanner(page, { kind: 'done', message: status || 'finished' });
  }
  return emitSignal(
    { kind: 'done', status, workflowId, runId, filled, skipped, errors, artifactsDir, capturedOutputs },
    options
  );
}
