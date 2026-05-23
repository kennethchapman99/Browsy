/**
 * Argument allowlist validator for POST /api/exec in wizard/server.mjs.
 *
 * Each command has a declared set of allowed --flag names and an optional list
 * of positional subcommands (e.g. "save"|"check" for auth).  Any arg that falls
 * outside these sets is rejected before the child process is spawned.
 *
 * Value patterns are enforced for key types that could otherwise be used to
 * escape the repo root (workflow IDs, run IDs, file paths, URLs).
 *
 * Note: --allow-final-action is intentionally excluded from the `run` command
 * here so the wizard UI can never trigger a live form submission.
 */

// Allowed positional subcommands and --flag keys per command.
const RULES = {
  'validate-request': { subs: null,                       keys: new Set([]) },
  'plan':             { subs: null,                       keys: new Set(['request']) },
  'init':             { subs: null,                       keys: new Set(['id', 'from-request']) },
  'auth':             { subs: new Set(['save', 'check']), keys: new Set(['workflow', 'url', 'headed']) },
  'discover':         { subs: null,                       keys: new Set(['workflow', 'url', 'candidates', 'headed', 'pause']) },
  'discover:all':     { subs: null,                       keys: new Set(['workflow', 'headed']) },
  // allow-final-action deliberately absent — wizard must not enable live submissions
  'run':              { subs: null,                       keys: new Set(['workflow', 'manifest', 'dry-run', 'headed', 'no-pause']) },
  'review':           { subs: null,                       keys: new Set(['workflow', 'run']) },
  'feedback':         { subs: null,                       keys: new Set(['workflow', 'message', 'run', 'notes']) },
  'promote':          { subs: null,                       keys: new Set(['workflow']) },
};

// Safe patterns.
const RE_SAFE_ID    = /^[a-z0-9][a-z0-9\-_]{0,63}$/;
const RE_SAFE_RUNID = /^[0-9]{4}-[0-9T\-:.Z]{4,50}$/;
const RE_SAFE_PATH  = /^[a-zA-Z0-9][a-zA-Z0-9\-_.\/]{0,255}$/;

function checkValue(key, val) {
  // Universal: block null bytes and path traversal in every value.
  if (val.includes('\0') || val.includes('..')) {
    return `value for --${key} contains disallowed pattern`;
  }

  switch (key) {
    case 'workflow':
    case 'id':
      if (!RE_SAFE_ID.test(val))
        return `--${key} must be [a-z0-9-_] (got: ${val})`;
      break;

    case 'run':
      if (!RE_SAFE_RUNID.test(val))
        return `--run must be a timestamp ID (got: ${val})`;
      break;

    case 'url':
      if (!/^https?:\/\//i.test(val))
        return `--url must start with http:// or https:// (got: ${val})`;
      break;

    case 'manifest':
    case 'notes':
    case 'request':
      if (val.startsWith('/'))
        return `--${key} must be a relative path (got: ${val})`;
      if (!RE_SAFE_PATH.test(val))
        return `--${key} path contains invalid characters (got: ${val})`;
      break;

    case 'message':
      if (val.length > 4000)
        return '--message exceeds 4000-char limit';
      break;
  }
  return null;
}

/**
 * Validate that `args` (the raw string array that follows the command) is safe
 * to pass to the Browsy CLI subprocess.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason: string }` on failure.
 */
export function validateExecArgs(command, args) {
  const rules = RULES[command];
  if (!rules) return { ok: false, reason: `no rules registered for command: ${command}` };

  let i = 0;

  // Handle required positional subcommand (auth save|check).
  if (rules.subs !== null) {
    if (!args.length || !rules.subs.has(args[0])) {
      return {
        ok: false,
        reason: `${command} requires subcommand: ${[...rules.subs].join(' | ')} (got: ${args[0] ?? '(none)'})`
      };
    }
    i = 1;
  }

  while (i < args.length) {
    const token = args[i];

    // Every remaining token must be a --flag.
    if (!token.startsWith('--')) {
      return { ok: false, reason: `unexpected positional arg: ${JSON.stringify(token)}` };
    }

    const key = token.slice(2);
    if (!key) return { ok: false, reason: 'empty flag name (--)' };

    if (!rules.keys.has(key)) {
      return { ok: false, reason: `--${key} is not an allowed arg for command: ${command}` };
    }

    // Peek at the next token: if it exists and doesn't start with --, it's the value.
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      const val = args[i + 1];
      const err = checkValue(key, val);
      if (err) return { ok: false, reason: err };
      i += 2;
    } else {
      // Boolean flag — no value token.
      i += 1;
    }
  }

  return { ok: true };
}
