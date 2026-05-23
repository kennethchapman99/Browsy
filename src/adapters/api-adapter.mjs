// API adapter placeholder.
//
// Use this when the target workflow has a stable REST or GraphQL API.
// Implement the same interface as PlaywrightAdapter so generated run.mjs
// files can swap adapters without changing their logic.
//
// To implement: set baseUrl and auth in your workflow.json targets.api section,
// then fill in each method to call the relevant endpoints.

export class ApiAdapter {
  constructor() {
    this._baseUrl = null;
    this._headers = {};
  }

  async open({ baseUrl, auth = {} } = {}) {
    if (!baseUrl) throw new Error('ApiAdapter.open requires baseUrl (set in workflow.json targets.api.base_url)');
    this._baseUrl = baseUrl.replace(/\/$/, '');
    if (auth.token) this._headers['Authorization'] = `Bearer ${auth.token}`;
    if (auth.apiKey) this._headers['X-API-Key'] = auth.apiKey;
  }

  async discover(url) {
    throw new NotImplementedError('ApiAdapter.discover', 'API workflows do not use DOM discovery. Document endpoints in the workflow README instead.');
  }

  async fill(fieldName, value) {
    throw new NotImplementedError('ApiAdapter.fill', 'Use ApiAdapter.submit() to send data once all fields are accumulated.');
  }

  async upload(fieldName, filePath) {
    throw new NotImplementedError('ApiAdapter.upload', 'Implement multipart upload against your specific API endpoint.');
  }

  async safeClick(endpoint, label, policy = {}) {
    throw new NotImplementedError('ApiAdapter.safeClick', 'Use ApiAdapter.post() with explicit endpoint and payload instead.');
  }

  async snapshot() {
    throw new NotImplementedError('ApiAdapter.snapshot', 'API workflows do not produce screenshots.');
  }

  async close() {
    // No persistent connection to close.
  }

  // Convenience: POST to an endpoint.
  async post(path, body, options = {}) {
    const url = this._baseUrl + path;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._headers, ...(options.headers || {}) },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API POST ${path} failed: ${res.status} ${res.statusText}`);
    return await res.json().catch(() => null);
  }

  // Convenience: GET from an endpoint.
  async get(path, options = {}) {
    const url = this._baseUrl + path;
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...this._headers, ...(options.headers || {}) }
    });
    if (!res.ok) throw new Error(`API GET ${path} failed: ${res.status} ${res.statusText}`);
    return await res.json().catch(() => null);
  }
}

class NotImplementedError extends Error {
  constructor(method, hint = '') {
    super(`${method} is not implemented in ApiAdapter. ${hint}`);
    this.name = 'NotImplementedError';
  }
}
