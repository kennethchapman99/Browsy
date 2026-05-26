/**
 * Atlas-assisted notes adapter.
 *
 * Handles the fallback path where the user manually reviews a site using
 * Atlas/ChatGPT and types or dictates their observations.
 *
 * IMPORTANT: This is NOT automatic Atlas integration. Browsy does not receive
 * Atlas tab DOM or events automatically — a local web app cannot depend on
 * undocumented Atlas page-context APIs. This adapter is strictly manual/assistive.
 *
 * All events carry source: 'atlasAssistedNotes'.
 */

import { BaseObservationAdapter } from './adapter-interface.mjs';
import { createEvent } from '../../core/observation-events.mjs';

export class AtlasAssistedNotesAdapter extends BaseObservationAdapter {
  constructor() {
    super({ source: 'atlasAssistedNotes', label: 'Atlas-assisted notes only — manual annotations, not automatic capture' });
    this.available = true;
  }

  async startObservationSession(session) {
    session.events.push(createEvent({ sessionId: session.id, type: 'session_started', source: 'atlasAssistedNotes' }));
    session.events.push(createEvent({ sessionId: session.id, type: 'capture_source_selected', source: 'atlasAssistedNotes', payload: { captureSource: 'atlasAssistedNotes' } }));
  }

  async recordUserAnnotation(session, annotation) {
    const event = createEvent({
      sessionId: session.id,
      type: 'user_note_added',
      source: 'atlasAssistedNotes',
      userAnnotation: annotation,
    });
    session.events.push(event);
    return event;
  }

  async markCurrentPageAsRepeatGroup(session, note) {
    const event = createEvent({ sessionId: session.id, type: 'user_marked_repeat_group', source: 'atlasAssistedNotes', userAnnotation: note });
    session.events.push(event);
    return event;
  }

  async markCurrentActionAsDangerous(session, note) {
    const event = createEvent({ sessionId: session.id, type: 'user_marked_dangerous_action', source: 'atlasAssistedNotes', userAnnotation: note });
    session.events.push(event);
    return event;
  }

  async finishObservationSession(session) {
    session.events.push(createEvent({ sessionId: session.id, type: 'session_finished', source: 'atlasAssistedNotes' }));
    session.state = 'finished';
    session.finishedAt = Date.now();
  }

  async buildObservationFromCapturedEvents(sessionId, session) {
    const repeatEvents = session.events.filter(e => e.type === 'user_marked_repeat_group');
    const dangerousEvents = session.events.filter(e => e.type === 'user_marked_dangerous_action');
    const noteEvents = session.events.filter(e => e.type === 'user_note_added');

    return {
      workflowId: 'observed-workflow',
      captureSource: 'atlasAssistedNotes',
      captureSourceLabel: 'Atlas-assisted notes — manual annotations only, not automatic capture',
      capturedAt: new Date(session.startedAt || Date.now()).toISOString(),
      mode: 'manual',
      pages: [],
      globalFields: [],
      globalAssets: [],
      capturedOutputs: [],
      repeatGroups: repeatEvents.map((ev, i) => ({ id: `group_${i + 1}`, label: ev.userAnnotation || `Group ${i + 1}`, itemLabel: 'item', fields: [], assets: [] })),
      humanCheckpoints: [],
      manualOnlyActions: dangerousEvents.map((ev, i) => ({ id: `manual_${i + 1}`, label: ev.userAnnotation || `Dangerous action ${i + 1}`, reason: 'flagged as dangerous during observation' })),
      annotations: noteEvents.map(ev => ev.userAnnotation).filter(Boolean),
      sessionEvents: session.events,
    };
  }
}
