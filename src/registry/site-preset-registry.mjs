import fs from 'fs';
import path from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';

export const SITE_PRESETS_DIR = path.join(REGISTRY_DIR, 'site-presets');

export function listSitePresets() {
  if (!exists(SITE_PRESETS_DIR)) return [];
  return fs.readdirSync(SITE_PRESETS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => readSitePreset(path.basename(name, '.json')))
    .filter(Boolean)
    .sort((a, b) => String(a.siteId).localeCompare(String(b.siteId)));
}

export function getSitePreset(siteId) {
  return readSitePreset(siteId);
}

export function upsertSitePreset(input = {}) {
  const siteId = safeId(input.siteId || input.id || input.title || input.url || 'site');
  if (!input.url) throw new Error('site preset url is required');
  const now = new Date().toISOString();
  const existing = readSitePreset(siteId) || {};
  const preset = {
    schemaVersion: 'browsy.site-preset.v1',
    siteId,
    title: input.title || existing.title || siteId,
    url: input.url,
    requiresAuth: input.requiresAuth === true || existing.requiresAuth === true,
    authProfileId: input.authProfileId || existing.authProfileId || null,
    authCheckUrl: input.authCheckUrl || existing.authCheckUrl || input.url,
    sourceAppId: input.sourceAppId || existing.sourceAppId || null,
    sourceWorkflowId: input.sourceWorkflowId || existing.sourceWorkflowId || null,
    updatedAt: now,
    createdAt: existing.createdAt || now,
  };
  writeJson(sitePresetPath(siteId), preset);
  return preset;
}

export function upsertSitePresetsFromRecordingSetup(recordingSetup = {}, context = {}) {
  const authProfileId = recordingSetup.authProfileId || recordingSetup.authGroupId || recordingSetup.ssoProfileId || null;
  const presets = [];
  for (const tab of Array.isArray(recordingSetup.tabs) ? recordingSetup.tabs : []) {
    if (!tab?.url || isPlaceholderUrl(tab.url)) continue;
    presets.push(upsertSitePreset({
      siteId: tab.siteId || tab.id || tab.title,
      title: tab.title || tab.id || tab.siteId,
      url: tab.url,
      requiresAuth: tab.requiresAuth === true,
      authProfileId: tab.authProfileId || authProfileId,
      authCheckUrl: tab.authCheckUrl || tab.url,
      sourceAppId: context.appId || null,
      sourceWorkflowId: context.workflowId || null,
    }));
  }
  return presets;
}

function readSitePreset(siteId) {
  const filePath = sitePresetPath(siteId);
  if (!exists(filePath)) return null;
  try { return readJson(filePath); } catch { return null; }
}

function sitePresetPath(siteId) {
  ensureDir(SITE_PRESETS_DIR);
  return path.join(SITE_PRESETS_DIR, `${safeId(siteId)}.json`);
}

function safeId(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

function isPlaceholderUrl(url = '') {
  const value = String(url || '').trim();
  return !value || /PASTE_|YOUR_|_HERE/i.test(value) || !(value.startsWith('http://') || value.startsWith('https://') || value.startsWith('about:') || value.startsWith('data:'));
}
