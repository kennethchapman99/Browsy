import fs from 'fs';
import { join } from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';

const PROFILES_DIR = join(REGISTRY_DIR, 'session-profiles');

export function registerProfile({ profileId, description = '', authFile = null }) {
  if (!profileId || typeof profileId !== 'string' || !profileId.trim()) {
    throw new Error('profileId is required');
  }
  ensureDir(PROFILES_DIR);
  const filePath = join(PROFILES_DIR, profileId + '.json');
  const now = new Date().toISOString();
  const existing = exists(filePath) ? readJson(filePath) : null;
  const record = {
    profileId,
    description,
    authFile: authFile || null,
    registeredAt: existing?.registeredAt || now,
    updatedAt: now,
  };
  writeJson(filePath, record);
  return record;
}

export function getProfile(profileId) {
  const filePath = join(PROFILES_DIR, profileId + '.json');
  return exists(filePath) ? readJson(filePath) : null;
}

export function resolveAuthFile(profileId) {
  const profile = getProfile(profileId);
  return profile?.authFile || null;
}

export function listProfiles() {
  ensureDir(PROFILES_DIR);
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(PROFILES_DIR, f)))
    .sort((a, b) => a.profileId.localeCompare(b.profileId));
}
