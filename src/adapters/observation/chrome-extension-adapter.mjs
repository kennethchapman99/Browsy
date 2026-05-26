/**
 * Chrome Extension observation adapter — STUB.
 *
 * This adapter is a placeholder for future real browser capture via a
 * local Browsy Chrome extension. It is NOT implemented yet and is NOT
 * available to end users.
 *
 * When the extension is built, it should:
 *   - Capture active tab DOM snapshots
 *   - Detect click/input/change events
 *   - Extract field metadata (label, type, required, selector)
 *   - Detect button/action metadata
 *   - Detect upload controls
 *   - Identify repeat group candidates from repeated DOM patterns
 *   - POST normalized events to POST /api/observation/events
 *
 * The server-side /api/observation/events endpoint is defined in wizard/server.mjs
 * and accepts events in the canonical observation event schema.
 *
 * TODO: implement extension manifest, content script, and background service worker.
 */

import { BaseObservationAdapter } from './adapter-interface.mjs';

export class ChromeExtensionAdapter extends BaseObservationAdapter {
  constructor() {
    super({ source: 'chromeExtension', label: 'Chrome Extension — not yet available' });
    this.available = false;
  }

  async startObservationSession(_session) {
    throw new Error('Chrome Extension capture is not yet implemented. Use Demo/mock or Import JSON for now.');
  }

  async captureCurrentPageSnapshot(_session) {
    throw new Error('Chrome Extension capture is not yet implemented.');
  }

  async recordUserAnnotation(_session, _annotation) {
    throw new Error('Chrome Extension capture is not yet implemented.');
  }

  async markCurrentPageAsRepeatGroup(_session, _note) {
    throw new Error('Chrome Extension capture is not yet implemented.');
  }

  async markCurrentActionAsDangerous(_session, _note) {
    throw new Error('Chrome Extension capture is not yet implemented.');
  }

  async finishObservationSession(_session) {
    throw new Error('Chrome Extension capture is not yet implemented.');
  }

  async buildObservationFromCapturedEvents(_sessionId) {
    throw new Error('Chrome Extension capture is not yet implemented.');
  }
}
