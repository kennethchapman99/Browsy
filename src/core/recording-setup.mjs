import { safeId } from './paths.mjs';

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

export function validateRecordingSetup(input = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['recording setup must be an object'], setup: null };
  }
  if (typeof input.workflowId !== 'string' || !input.workflowId.trim()) {
    errors.push('recordingSetup.workflowId is required');
  }
  if (!Array.isArray(input.tabs) || !input.tabs.length) {
    errors.push('recordingSetup.tabs must be a non-empty array');
  } else {
    input.tabs.forEach((tab, index) => {
      if (!tab || typeof tab !== 'object' || Array.isArray(tab)) {
        errors.push(`recordingSetup.tabs[${index}] must be an object`);
        return;
      }
      if (typeof tab.siteId !== 'string' || !safeId(tab.siteId)) {
        errors.push(`recordingSetup.tabs[${index}].siteId is required`);
      }
      if (typeof tab.url !== 'string' || !isHttpUrl(tab.url)) {
        errors.push(`recordingSetup.tabs[${index}].url must start with http:// or https://`);
      }
      if ('requiresAuth' in tab && typeof tab.requiresAuth !== 'boolean') {
        errors.push(`recordingSetup.tabs[${index}].requiresAuth must be boolean`);
      }
    });
  }
  return { ok: errors.length === 0, errors, setup: errors.length ? null : normalizeRecordingSetup(input) };
}

export function normalizeRecordingSetup(input = {}) {
  const tabs = (input.tabs || []).map(tab => ({
    siteId: safeId(tab.siteId),
    title: String(tab.title || tab.siteId || 'Tab').trim(),
    url: String(tab.url || '').trim(),
    requiresAuth: tab.requiresAuth === true,
    authCheckUrl: String(tab.authCheckUrl || tab.url || '').trim(),
  }));
  return {
    workflowId: String(input.workflowId || '').trim(),
    appId: input.appId ? String(input.appId).trim() : null,
    tabs,
  };
}

export function requiredAuthSitesFromSetup(input = {}) {
  const setup = normalizeRecordingSetup(input);
  return [...new Map(setup.tabs
    .filter(tab => tab.requiresAuth)
    .map(tab => [tab.siteId, { siteId: tab.siteId, title: tab.title, authCheckUrl: tab.authCheckUrl, url: tab.url }]))
    .values()];
}
