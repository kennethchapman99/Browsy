/**
 * Mock / Demo observation adapter.
 *
 * Generates a simulated observation session for development and testing.
 * This adapter NEVER represents real browser capture.
 * All events and counts produced by this adapter are labelled source: 'mock'.
 *
 * IMPORTANT: UI must clearly communicate "Demo mode — no real website is being observed"
 * whenever this adapter is active. Never present mock data as real capture.
 */

import { BaseObservationAdapter } from './adapter-interface.mjs';
import { createEvent, deriveStatsFromEvents } from '../../core/observation-events.mjs';

const DEMO_PAGES = [
  { url: 'https://example.com/step-1', title: '[Demo] Step 1', fieldCount: 3, buttonCount: 1 },
  { url: 'https://example.com/step-2', title: '[Demo] Step 2', fieldCount: 2, buttonCount: 2 },
];

export class MockObservationAdapter extends BaseObservationAdapter {
  constructor() {
    super({ source: 'mock', label: 'Demo mode — no real website is being observed' });
    this.available = true;
  }

  async startObservationSession(session) {
    session.events.push(createEvent({ sessionId: session.id, type: 'session_started', source: 'mock' }));
    session.events.push(createEvent({ sessionId: session.id, type: 'capture_source_selected', source: 'mock', payload: { captureSource: 'mock' } }));
  }

  async captureCurrentPageSnapshot(session) {
    const page = DEMO_PAGES[session.events.filter(e => e.type === 'page_snapshot_captured').length % DEMO_PAGES.length];
    const event = createEvent({
      sessionId: session.id,
      type: 'page_snapshot_captured',
      source: 'mock',
      pageUrl: page.url,
      pageTitle: page.title,
      payload: { fieldCount: page.fieldCount, buttonCount: page.buttonCount },
    });
    session.events.push(event);
    return event;
  }

  async recordUserAnnotation(session, annotation) {
    const event = createEvent({ sessionId: session.id, type: 'user_note_added', source: 'mock', userAnnotation: annotation });
    session.events.push(event);
    return event;
  }

  async markCurrentPageAsRepeatGroup(session, note) {
    const event = createEvent({ sessionId: session.id, type: 'user_marked_repeat_group', source: 'mock', userAnnotation: note });
    session.events.push(event);
    return event;
  }

  async markCurrentActionAsDangerous(session, note) {
    const event = createEvent({ sessionId: session.id, type: 'user_marked_dangerous_action', source: 'mock', userAnnotation: note });
    session.events.push(event);
    return event;
  }

  async finishObservationSession(session) {
    session.events.push(createEvent({ sessionId: session.id, type: 'session_finished', source: 'mock' }));
    session.state = 'finished';
    session.finishedAt = Date.now();
  }

  async buildObservationFromCapturedEvents(sessionId, session) {
    const stats = deriveStatsFromEvents(session.events);
    const repeatEvents = session.events.filter(e => e.type === 'user_marked_repeat_group');
    const dangerousEvents = session.events.filter(e => e.type === 'user_marked_dangerous_action');
    const noteEvents = session.events.filter(e => e.type === 'user_note_added');
    const pageEvents = session.events.filter(e => e.type === 'page_snapshot_captured');

    return {
      workflowId: 'observed-workflow',
      title: 'observed-workflow',
      captureSource: 'mock',
      captureSourceLabel: 'Demo mode — simulated session, not real capture',
      capturedAt: new Date(session.startedAt || Date.now()).toISOString(),
      mode: 'demo',
      pages: pageEvents.map((ev, i) => ({
        name: `page_${i + 1}`,
        url: ev.pageUrl || '',
        title: ev.pageTitle || `[Demo] Page ${i + 1}`,
        fields: [],
        assets: [],
        buttons: [],
      })),
      globalFields: [],
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
