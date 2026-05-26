/**
 * Playwright Recorder observation adapter.
 *
 * Captures observation events from a local web page using Playwright.
 * This adapter connects to a fixture page (or a real site with user auth)
 * and extracts structured page data: fields, labels, uploads, buttons,
 * repeated DOM patterns, and dangerous action candidates.
 *
 * Dangerous action heuristic: buttons/links containing keywords like
 * submit, publish, send, delete, charge, purchase, release, upload, confirm.
 *
 * All events carry source: 'playwrightRecorder'.
 */

import { BaseObservationAdapter } from './adapter-interface.mjs';
import { createEvent } from '../../core/observation-events.mjs';

export class PlaywrightRecorderAdapter extends BaseObservationAdapter {
  constructor() {
    super({ source: 'playwrightRecorder', label: 'Playwright Recorder — local automation-grade capture' });
    this.available = true;
    this._browser = null;
    this._page = null;
  }

  async startObservationSession(session) {
    session.events.push(createEvent({ sessionId: session.id, type: 'session_started', source: 'playwrightRecorder' }));
    session.events.push(createEvent({ sessionId: session.id, type: 'capture_source_selected', source: 'playwrightRecorder', payload: { captureSource: 'playwrightRecorder' } }));
    // Future: launch Playwright browser, navigate to start URL
  }

  /**
   * Capture a page snapshot from the currently active Playwright page.
   * Normalizes visible DOM into structured observation data.
   */
  async captureCurrentPageSnapshot(session) {
    if (!this._page) throw new Error('No active Playwright page — call startObservationSession first');

    const snapshot = await this._page.evaluate(() => {
      const url = location.href;
      const title = document.title;
      const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map(h => ({ tag: h.tagName, text: h.textContent?.trim() }));
      const fields = Array.from(document.querySelectorAll('input,select,textarea')).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || null,
        id: el.id || null,
        placeholder: el.getAttribute('placeholder') || null,
        required: el.hasAttribute('required'),
        label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || null,
      }));
      const uploads = fields.filter(f => f.type === 'file');
      const buttons = Array.from(document.querySelectorAll('button,input[type=submit],a[role=button]')).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim() || el.getAttribute('value') || null,
        type: el.getAttribute('type') || null,
      }));
      const dangerousKeywords = /submit|publish|send|delete|charge|purchase|release|upload|confirm/i;
      const dangerousCandidates = buttons.filter(b => b.text && dangerousKeywords.test(b.text));
      return { url, title, headings, fields, uploads, buttons, dangerousCandidates };
    });

    const event = createEvent({
      sessionId: session.id,
      type: 'page_snapshot_captured',
      source: 'playwrightRecorder',
      pageUrl: snapshot.url,
      pageTitle: snapshot.title,
      rawEvidence: snapshot,
    });
    session.events.push(event);

    for (const field of snapshot.fields) {
      session.events.push(createEvent({ sessionId: session.id, type: 'field_detected', source: 'playwrightRecorder', pageUrl: snapshot.url, selector: field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null), rawEvidence: field }));
    }
    for (const btn of snapshot.buttons) {
      session.events.push(createEvent({ sessionId: session.id, type: 'action_detected', source: 'playwrightRecorder', pageUrl: snapshot.url, rawEvidence: btn }));
    }
    for (const dc of snapshot.dangerousCandidates) {
      session.events.push(createEvent({ sessionId: session.id, type: 'dangerous_action_candidate_detected', source: 'playwrightRecorder', pageUrl: snapshot.url, rawEvidence: dc, confidence: 0.75 }));
    }

    return event;
  }

  async recordUserAnnotation(session, annotation) {
    const event = createEvent({ sessionId: session.id, type: 'user_note_added', source: 'playwrightRecorder', userAnnotation: annotation });
    session.events.push(event);
    return event;
  }

  async markCurrentPageAsRepeatGroup(session, note) {
    const event = createEvent({ sessionId: session.id, type: 'user_marked_repeat_group', source: 'playwrightRecorder', userAnnotation: note });
    session.events.push(event);
    return event;
  }

  async markCurrentActionAsDangerous(session, note) {
    const event = createEvent({ sessionId: session.id, type: 'user_marked_dangerous_action', source: 'playwrightRecorder', userAnnotation: note });
    session.events.push(event);
    return event;
  }

  async finishObservationSession(session) {
    if (this._browser) { await this._browser.close(); this._browser = null; this._page = null; }
    session.events.push(createEvent({ sessionId: session.id, type: 'session_finished', source: 'playwrightRecorder' }));
    session.state = 'finished';
    session.finishedAt = Date.now();
  }

  async buildObservationFromCapturedEvents(sessionId, session) {
    const { deriveStatsFromEvents } = await import('../../core/observation-events.mjs');
    const stats = deriveStatsFromEvents(session.events);
    const pageEvents = session.events.filter(e => e.type === 'page_snapshot_captured');
    const fieldEvents = session.events.filter(e => e.type === 'field_detected');
    const repeatEvents = session.events.filter(e => e.type === 'user_marked_repeat_group');
    const dangerousEvents = session.events.filter(e => e.type === 'user_marked_dangerous_action');
    const noteEvents = session.events.filter(e => e.type === 'user_note_added');

    return {
      workflowId: 'observed-workflow',
      captureSource: 'playwrightRecorder',
      captureSourceLabel: 'Playwright Recorder — local automation-grade capture',
      capturedAt: new Date(session.startedAt || Date.now()).toISOString(),
      mode: 'session',
      pages: pageEvents.map((ev, i) => ({
        name: `page_${i + 1}`,
        url: ev.pageUrl || '',
        title: ev.pageTitle || `Page ${i + 1}`,
        fields: (ev.rawEvidence?.fields || []).map(f => ({ id: f.name || f.id || `field_${i}`, label: f.label || f.placeholder || '', inputType: f.type || 'text', required: !!f.required, scope: 'global' })),
        assets: (ev.rawEvidence?.uploads || []).map((u, j) => ({ id: u.name || `upload_${j}`, label: u.label || u.placeholder || 'File upload', inputType: 'file', scope: 'asset' })),
        buttons: (ev.rawEvidence?.buttons || []).map(b => ({ label: b.text, type: b.type || 'button' })),
      })),
      globalFields: fieldEvents.map(ev => ev.rawEvidence).filter(Boolean).map(f => ({ id: f.name || f.id || 'field', label: f.label || f.placeholder || '', inputType: f.type || 'text', required: !!f.required, scope: 'global' })),
      globalAssets: [],
      capturedOutputs: [],
      repeatGroups: repeatEvents.map((ev, i) => ({ id: `group_${i + 1}`, label: ev.userAnnotation || `Group ${i + 1}`, itemLabel: 'item', fields: [], assets: [] })),
      humanCheckpoints: [],
      manualOnlyActions: dangerousEvents.map((ev, i) => ({ id: `manual_${i + 1}`, label: ev.userAnnotation || `Dangerous action ${i + 1}`, reason: 'flagged as dangerous during observation' })),
      annotations: noteEvents.map(ev => ev.userAnnotation).filter(Boolean),
      sessionStats: stats,
      sessionEvents: session.events,
    };
  }
}
