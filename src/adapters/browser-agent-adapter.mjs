// Browser-agent adapter placeholder.
//
// This is reserved for future integration with AI-driven browser control
// frameworks such as Stagehand, Skyvern, Browser Use, or OpenClaw.
//
// Use this adapter for workflows that are too dynamic for CSS selectors —
// e.g. CAPTCHAs, dynamically-generated forms, or complex multi-step flows
// that require human-like recovery.
//
// Interface is identical to PlaywrightAdapter so run.mjs files remain
// adapter-agnostic. Swap "new PlaywrightAdapter()" → "new BrowserAgentAdapter()"
// when the integration is ready.
//
// CAUTION: Browser-agent adapters are more expensive, slower, and less
// deterministic than Playwright. Prefer PlaywrightAdapter unless selectors
// are truly unreliable.

export class BrowserAgentAdapter {
  constructor() {
    this._provider = null;
    this._session = null;
  }

  async open({ provider = 'stagehand', apiKey, headed = true } = {}) {
    this._provider = provider;
    throw new NotImplementedError(
      'BrowserAgentAdapter.open',
      `Provider "${provider}" is not yet integrated. ` +
      'To add support: install the provider SDK, implement each method below, ' +
      'and replace this throw with initialization logic.'
    );
  }

  async discover(url) {
    throw new NotImplementedError('BrowserAgentAdapter.discover', 'Use natural-language instructions with act() instead.');
  }

  async fill(selector, value) {
    throw new NotImplementedError('BrowserAgentAdapter.fill', 'Use act() with a natural-language instruction.');
  }

  async upload(selector, filePath) {
    throw new NotImplementedError('BrowserAgentAdapter.upload', 'Use act() with a natural-language instruction.');
  }

  async safeClick(selector, label, policy = {}) {
    throw new NotImplementedError('BrowserAgentAdapter.safeClick', 'Use act() with a natural-language instruction.');
  }

  async snapshot(runDir, name) {
    throw new NotImplementedError('BrowserAgentAdapter.snapshot', 'Use the provider screenshot method when available.');
  }

  async close() {
    if (this._session) {
      try { await this._session.close(); } catch {}
      this._session = null;
    }
  }

  // Placeholder: instruct the agent to perform an action described in natural language.
  // Replace with provider-specific call (e.g. stagehand.act({ action: instruction })).
  async act(instruction) {
    throw new NotImplementedError(
      'BrowserAgentAdapter.act',
      `Instruction: "${instruction}". Implement using your chosen provider SDK.`
    );
  }

  // Placeholder: instruct the agent to extract data from the current page.
  async extract(instruction) {
    throw new NotImplementedError('BrowserAgentAdapter.extract');
  }
}

class NotImplementedError extends Error {
  constructor(method, hint = '') {
    super(`${method} is not yet implemented. ${hint}`);
    this.name = 'NotImplementedError';
  }
}
