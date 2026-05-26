/**
 * Manual import observation adapter.
 *
 * Handles the "Advanced: import observation JSON" path.
 * The user pastes or loads a pre-written observation JSON.
 * All events emitted by this adapter carry source: 'manualImport'.
 *
 * This adapter wraps the existing /api/observation/preview and /api/observation/import
 * server endpoints. It does not attempt live browser capture.
 */

import { BaseObservationAdapter } from './adapter-interface.mjs';
import { createEvent } from '../../core/observation-events.mjs';

export class ManualImportAdapter extends BaseObservationAdapter {
  constructor() {
    super({ source: 'manualImport', label: 'Manual / import mode' });
    this.available = true;
  }

  async startObservationSession(session) {
    session.events.push(createEvent({ sessionId: session.id, type: 'session_started', source: 'manualImport' }));
    session.events.push(createEvent({ sessionId: session.id, type: 'capture_source_selected', source: 'manualImport', payload: { captureSource: 'manualImport' } }));
  }

  /**
   * Record that an observation JSON was imported.
   * The raw JSON is attached as rawEvidence so it's traceable.
   */
  async recordImportedObservation(session, observationJson) {
    const event = createEvent({
      sessionId: session.id,
      type: 'page_snapshot_captured',
      source: 'manualImport',
      rawEvidence: observationJson,
      payload: { importedAt: new Date().toISOString() },
    });
    session.events.push(event);
    return event;
  }

  async finishObservationSession(session) {
    session.events.push(createEvent({ sessionId: session.id, type: 'session_finished', source: 'manualImport' }));
    session.state = 'finished';
    session.finishedAt = Date.now();
  }

  async buildObservationFromCapturedEvents(sessionId, session, parsedObservation) {
    return {
      ...parsedObservation,
      captureSource: 'manualImport',
      captureSourceLabel: 'Manual import — observation JSON provided by user',
      sessionEvents: session.events,
    };
  }
}
