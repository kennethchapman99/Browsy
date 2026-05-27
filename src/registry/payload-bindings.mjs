// Generic payload binding helpers for registry-run workflow packages.
//
// Keeps app-facing payloads decoupled from the internal canonical_payload shape
// expected by reusable workflow packages. This module is intentionally generic:
// callers define payloadBindings/fileBindings in workflow metadata; Browsy only
// applies those declarations.

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function splitPath(path) {
  return String(path || '').split('.').filter(Boolean);
}

function hasArrayToken(path) {
  return String(path || '').includes('[]');
}

function getValue(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const part of splitPath(path)) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setValue(obj, path, value) {
  const parts = splitPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const last = i === parts.length - 1;
    if (last) {
      cur[part] = value;
    } else {
      if (!isObject(cur[part])) cur[part] = {};
      cur = cur[part];
    }
  }
  return obj;
}

function normalizeArrayBinding(payload, sourcePath, targetPath, out) {
  const sourceParts = splitPath(sourcePath);
  const targetParts = splitPath(targetPath);
  const sIdx = sourceParts.findIndex(p => p.endsWith('[]'));
  const tIdx = targetParts.findIndex(p => p.endsWith('[]'));
  if (sIdx < 0 || tIdx < 0) return false;

  const sourceArrayPath = sourceParts.slice(0, sIdx).concat(sourceParts[sIdx].replace('[]', '')).join('.');
  const targetArrayPath = targetParts.slice(0, tIdx).concat(targetParts[tIdx].replace('[]', '')).join('.');
  const sourceRest = sourceParts.slice(sIdx + 1).join('.');
  const targetRest = targetParts.slice(tIdx + 1).join('.');
  const items = getValue(payload, sourceArrayPath);
  if (!Array.isArray(items)) return true;

  const targetItems = getValue(out, targetArrayPath) || [];
  for (let i = 0; i < items.length; i++) {
    if (!isObject(targetItems[i])) targetItems[i] = {};
    const value = sourceRest ? getValue(items[i], sourceRest) : items[i];
    if (value !== undefined) {
      if (targetRest) setValue(targetItems[i], targetRest, value);
      else targetItems[i] = value;
    }
  }
  setValue(out, targetArrayPath, targetItems);
  return true;
}

export function applyPayloadBindings(payload = {}, payloadBindings = {}) {
  if (!isObject(payloadBindings) || !Object.keys(payloadBindings).length) return { ...payload };
  const out = {};
  for (const [sourcePath, targetPath] of Object.entries(payloadBindings)) {
    if (!sourcePath || !targetPath) continue;
    if (hasArrayToken(sourcePath) || hasArrayToken(targetPath)) {
      normalizeArrayBinding(payload, sourcePath, targetPath, out);
      continue;
    }
    const value = getValue(payload, sourcePath);
    if (value !== undefined) setValue(out, targetPath, value);
  }
  return out;
}

export function buildAssetsFromFileBindings(payload = {}, fileBindings = []) {
  if (!Array.isArray(fileBindings)) return [];
  const assets = [];
  for (const binding of fileBindings) {
    if (!binding || typeof binding !== 'object') continue;
    const payloadPath = binding.payloadPath || binding.path || binding.source?.path || binding.sourcePath;
    const role = binding.assetRole || binding.role || binding.bindingId || binding.id || payloadPath;
    if (!payloadPath || !role) continue;

    if (hasArrayToken(payloadPath)) {
      const parts = splitPath(payloadPath);
      const idx = parts.findIndex(p => p.endsWith('[]'));
      const arrayPath = parts.slice(0, idx).concat(parts[idx].replace('[]', '')).join('.');
      const rest = parts.slice(idx + 1).join('.');
      const items = getValue(payload, arrayPath);
      if (!Array.isArray(items)) continue;
      for (let i = 0; i < items.length; i++) {
        const value = rest ? getValue(items[i], rest) : items[i];
        if (value) {
          assets.push({
            role,
            path: value,
            index: i,
            itemIndex: i,
            repeatGroupId: binding.repeatGroupId || binding.repeat_group_id || null,
            target: binding.target || null,
          });
        }
      }
    } else {
      const value = getValue(payload, payloadPath);
      if (value) {
        assets.push({ role, path: value, target: binding.target || null });
      }
    }
  }
  return assets;
}

export function normalizePayloadForWorkflow(payload = {}, workflowVersion = {}) {
  const payloadBindings = workflowVersion.payloadBindings || {};
  const fileBindings = workflowVersion.fileBindings || workflowVersion.fileUploadBindings || [];
  const canonicalPayload = applyPayloadBindings(payload, payloadBindings);
  const boundAssets = buildAssetsFromFileBindings(payload, fileBindings);
  return { canonicalPayload, boundAssets };
}
