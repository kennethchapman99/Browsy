export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') continue;
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const raw = token.slice(2);
    if (raw.includes('=')) {
      const [key, ...rest] = raw.split('=');
      out[key] = rest.join('=');
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[raw] = true;
    } else {
      out[raw] = next;
      i += 1;
    }
  }
  return out;
}

export function requireArg(args, name, hint = '') {
  if (!args[name]) {
    const suffix = hint ? '\n' + hint : '';
    throw new Error('Missing required --' + name + suffix);
  }
  return args[name];
}

export function boolArg(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (value === true) return true;
  if (value === false) return false;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}
