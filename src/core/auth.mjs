import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import {
  AUTH_DIR,
  AUTH_PROFILES_DIR,
  REPO_ROOT,
  ensureDir,
  exists,
  readJson,
  safeId,
  writeJson,
  authProfileDir,
  authProfileMetaPath,
  authProfileStorageStatePath,
  authProfileUserDataDir,
} from './paths.mjs';

export const AUTH_STATUS = ['missing', 'valid', 'expired', 'unknown'];

const SITE_REGISTRY_PATH = path.join(REPO_ROOT, 'registry', 'auth-sites.json');

function loadSiteRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SITE_REGISTRY_PATH, 'utf8'));
    return Object.fromEntries((Array.isArray(parsed) ? parsed : [])
      .filter(site => site && site.siteId)
      .map(site => [safeId(site.siteId), site]));
  } catch {
    return {};
  }
}

function fileMtime(path) {
  try { return fs.statSync(path).mtime.toISOString(); } catch { return null; }
}

export function listKnownAuthSites() {
  return Object.values(loadSiteRegistry()).map(site => ({ ...site }));
}

export function getKnownAuthSite(siteId) {
  const id = safeId(siteId);
  const registry = loadSiteRegistry();
  return registry[id] ? { ...registry[id] } : null;
}

export function authProfilePaths(siteId) {
  const id = safeId(siteId);
  return {
    siteId: id,
    dir: authProfileDir(id),
    userDataDir: authProfileUserDataDir(id),
    storageStatePath: authProfileStorageStatePath(id),
    metaPath: authProfileMetaPath(id),
  };
}

export function readAuthProfile(siteId) {
  const paths = authProfilePaths(siteId);
  const known = getKnownAuthSite(paths.siteId);
  const meta = exists(paths.metaPath) ? readJson(paths.metaPath) : {};
  const userDataExists = exists(paths.userDataDir);
  const storageStateExists = exists(paths.storageStatePath);
  let status = 'missing';
  if (meta.status && AUTH_STATUS.includes(meta.status)) status = meta.status;
  else if (userDataExists || storageStateExists) status = storageStateExists ? 'valid' : 'unknown';
  return {
    siteId: paths.siteId,
    siteName: meta.siteName || known?.siteName || paths.siteId,
    baseUrl: meta.baseUrl || known?.baseUrl || null,
    authCheckUrl: meta.authCheckUrl || known?.authCheckUrl || meta.baseUrl || known?.baseUrl || null,
    status,
    notes: meta.notes || known?.notes || null,
    authStatePath: paths.storageStatePath,
    userDataDir: paths.userDataDir,
    hasUserDataDir: userDataExists,
    hasStorageState: storageStateExists,
    lastSavedAt: meta.lastSavedAt || fileMtime(paths.storageStatePath) || null,
    lastCheckedAt: meta.lastCheckedAt || null,
    lastCheckedUrl: meta.lastCheckedUrl || null,
    lastCheckReachedUrl: meta.lastCheckReachedUrl || null,
    source: meta.source || (known ? 'site-registry' : 'local'),
  };
}

export function writeAuthProfile(siteId, patch = {}) {
  const current = readAuthProfile(siteId);
  const next = {
    siteId: current.siteId,
    siteName: patch.siteName || current.siteName,
    baseUrl: patch.baseUrl || current.baseUrl || null,
    authCheckUrl: patch.authCheckUrl || current.authCheckUrl || patch.baseUrl || current.baseUrl || null,
    status: AUTH_STATUS.includes(patch.status) ? patch.status : current.status,
    notes: patch.notes || current.notes || null,
    lastSavedAt: patch.lastSavedAt || current.lastSavedAt || null,
    lastCheckedAt: patch.lastCheckedAt || current.lastCheckedAt || null,
    lastCheckedUrl: patch.lastCheckedUrl || current.lastCheckedUrl || null,
    lastCheckReachedUrl: patch.lastCheckReachedUrl || current.lastCheckReachedUrl || null,
    source: patch.source || current.source || 'local',
  };
  writeJson(authProfileMetaPath(current.siteId), next);
  return readAuthProfile(current.siteId);
}

export function ensureAuthProfile(siteId, patch = {}) {
  const paths = authProfilePaths(siteId);
  ensureDir(AUTH_DIR);
  ensureDir(paths.dir);
  ensureDir(paths.userDataDir);
  return writeAuthProfile(siteId, { status: 'missing', ...patch });
}

export function listAuthProfiles() {
  const seen = new Set();
  const profiles = [];
  for (const known of listKnownAuthSites()) {
    seen.add(known.siteId);
    profiles.push(readAuthProfile(known.siteId));
  }
  if (exists(AUTH_PROFILES_DIR)) {
      for (const entry of fs.readdirSync(AUTH_PROFILES_DIR)) {
        if (!seen.has(entry)) profiles.push(readAuthProfile(entry));
      }
  }
  return profiles.sort((a, b) => a.siteId.localeCompare(b.siteId));
}

function mergeCookies(items = []) {
  const byKey = new Map();
  for (const cookie of items) {
    if (!cookie || !cookie.name) continue;
    const key = [cookie.name, cookie.domain || '', cookie.path || ''].join('|');
    byKey.set(key, cookie);
  }
  return [...byKey.values()];
}

function mergeOrigins(states = []) {
  const byOrigin = new Map();
  for (const state of states) {
    for (const originEntry of state?.origins || []) {
      if (!originEntry?.origin) continue;
      const current = byOrigin.get(originEntry.origin) || { origin: originEntry.origin, localStorage: [] };
      const storage = new Map((current.localStorage || []).map(item => [item.name, item]));
      for (const item of originEntry.localStorage || []) {
        if (item?.name) storage.set(item.name, item);
      }
      byOrigin.set(originEntry.origin, { origin: originEntry.origin, localStorage: [...storage.values()] });
    }
  }
  return [...byOrigin.values()];
}

export function mergeAuthStorageStates(siteIds = []) {
  const states = [];
  for (const siteId of siteIds.map(safeId)) {
    const statePath = authProfileStorageStatePath(siteId);
    if (!exists(statePath)) continue;
    try {
      states.push(readJson(statePath));
    } catch {}
  }
  return { cookies: mergeCookies(states.flatMap(state => state.cookies || [])), origins: mergeOrigins(states) };
}

export function resolveWorkflowAuthSites(config = {}) {
  const auth = config.auth || {};
  const requiredSites = Array.isArray(auth.required_sites) ? auth.required_sites : [];
  if (requiredSites.length) {
    return requiredSites
      .filter(site => site && site.siteId)
      .map(site => ({
        siteId: safeId(site.siteId),
        siteName: site.siteName || getKnownAuthSite(site.siteId)?.siteName || site.siteId,
        requiresAuth: site.requiresAuth !== false,
        authCheckUrl: site.authCheckUrl || site.url || getKnownAuthSite(site.siteId)?.authCheckUrl || null,
        url: site.url || null,
      }));
  }
  if (auth.site_id) {
    return [{
      siteId: safeId(auth.site_id),
      siteName: auth.site_name || getKnownAuthSite(auth.site_id)?.siteName || auth.site_id,
      requiresAuth: auth.mode !== 'none',
      authCheckUrl: auth.auth_check_url || auth.base_url || config.targets?.start_url || null,
      url: auth.base_url || config.targets?.start_url || null,
    }];
  }
  return [];
}

export function getMissingWorkflowAuth(config = {}, skippedSiteIds = []) {
  const skipped = new Set((skippedSiteIds || []).map(safeId));
  const requiredSites = resolveWorkflowAuthSites(config).filter(site => site.requiresAuth && !skipped.has(site.siteId));
  return requiredSites
    .map(site => ({ ...site, profile: readAuthProfile(site.siteId) }))
    .filter(site => site.profile.status !== 'valid');
}

export function buildBlockedAuthRequests(config = {}) {
  return getMissingWorkflowAuth(config).map(site => ({
    siteId: site.siteId,
    siteName: site.siteName,
    authCheckUrl: site.authCheckUrl,
    command: `browsy auth save --site ${site.siteId} --url ${site.authCheckUrl || site.url || '<AUTH_URL>'}`,
  }));
}

async function launchPersistentChrome(userDataDir, { headed = true } = {}) {
  const preferred = String(process.env.BROWSY_RECORDING_CHANNEL ?? 'chrome').trim();
  const tryChannels = preferred && preferred !== 'chromium' && preferred !== 'bundled'
    ? [preferred, null]
    : [null];
  let lastError = null;
  for (const channel of tryChannels) {
    try {
      return await chromium.launchPersistentContext(userDataDir, {
        headless: !headed,
        acceptDownloads: true,
        ...(channel ? { channel } : {}),
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('failed to launch persistent Chrome profile');
}

export async function launchBrowserWithPersistentProfile({
  siteId,
  url,
  headed = true,
  siteName,
  baseUrl,
  authCheckUrl,
}) {
  const resolvedSiteId = safeId(siteId);
  const paths = authProfilePaths(resolvedSiteId);
  ensureAuthProfile(resolvedSiteId, { siteName, baseUrl, authCheckUrl, source: 'persistent_profile' });
  // Use a real installed Chrome channel and no anti-detection flags. Sites like
  // Google reject sign-in from a bundled Chromium running with automation flags
  // ("this browser or app may not be secure"); a clean real-Chrome profile is the
  // supported way to let a human sign in once. Falls back to bundled Chromium only
  // if the channel is unavailable.
  const context = await launchPersistentChrome(paths.userDataDir, { headed });
  const page = context.pages()[0] || await context.newPage();
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { context, page, browser: context.browser() };
}

export async function exportPersistentAuthState(siteId, context, patch = {}) {
  const resolvedSiteId = safeId(siteId);
  const storageStatePath = authProfileStorageStatePath(resolvedSiteId);
  await context.storageState({ path: storageStatePath });
  return writeAuthProfile(resolvedSiteId, {
    ...patch,
    status: 'valid',
    lastSavedAt: new Date().toISOString(),
  });
}
