import fs from 'fs';
import { join } from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';

const APPS_DIR = join(REGISTRY_DIR, 'apps');

export function registerApp({ appId, name, description = '' }) {
  if (!appId || !/^[a-z0-9][a-z0-9-]*$/.test(appId)) {
    throw new Error(`appId must be lowercase alphanumeric with hyphens, got "${appId}"`);
  }
  if (!name || typeof name !== 'string') throw new Error('name is required');

  ensureDir(APPS_DIR);
  const filePath = join(APPS_DIR, appId + '.json');
  const now = new Date().toISOString();
  const existing = exists(filePath) ? readJson(filePath) : null;
  const record = {
    appId,
    name,
    description,
    registeredAt: existing?.registeredAt || now,
    updatedAt: now,
  };
  writeJson(filePath, record);
  return record;
}

export function getApp(appId) {
  const filePath = join(APPS_DIR, appId + '.json');
  return exists(filePath) ? readJson(filePath) : null;
}

export function listApps() {
  ensureDir(APPS_DIR);
  return fs.readdirSync(APPS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(APPS_DIR, f)))
    .sort((a, b) => a.appId.localeCompare(b.appId));
}
