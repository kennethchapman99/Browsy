/**
 * Browsy Browser Observation Adapter Interface
 *
 * All capture adapters must implement this interface. The UI calls these
 * methods; adapter implementations emit canonical observation events.
 *
 * Capture sources:
 *   chromeExtension    — real-time tab capture via browser extension
 *   playwrightRecorder — local fixture/recorded DOM capture
 *   manualImport       — user pastes or imports observation JSON
 *   atlasAssistedNotes — user manually annotates findings from Atlas/ChatGPT
 *   mock               — developer/demo simulation (clearly labelled, never default)
 */

/**
 * @typedef {object} ObservationSession
 * @property {string}   id
 * @property {string}   source
 * @property {string}   state  — 'connecting' | 'recording' | 'paused' | 'finished'
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {import('../../core/observation-events.mjs').ObservationEvent[]} events
 */

/**
 * @typedef {object} CaptureAdapter
 * @property {string}   source     — one of CAPTURE_SOURCES
 * @property {string}   label      — human-readable status label
 * @property {boolean}  [available]— whether this adapter is usable right now
 *
 * @property {function(ObservationSession): Promise<void>} startObservationSession
 * @property {function(ObservationSession): Promise<import('../../core/observation-events.mjs').ObservationEvent>} captureCurrentPageSnapshot
 * @property {function(ObservationSession, string): Promise<import('../../core/observation-events.mjs').ObservationEvent>} recordUserAnnotation
 * @property {function(ObservationSession, string): Promise<import('../../core/observation-events.mjs').ObservationEvent>} markCurrentPageAsRepeatGroup
 * @property {function(ObservationSession, string): Promise<import('../../core/observation-events.mjs').ObservationEvent>} markCurrentActionAsDangerous
 * @property {function(ObservationSession): Promise<void>} finishObservationSession
 * @property {function(string): Promise<object>} buildObservationFromCapturedEvents
 */

/**
 * Base no-op adapter. Extend to implement a real capture source.
 */
export class BaseObservationAdapter {
  constructor({ source, label }) {
    this.source = source;
    this.label = label;
    this.available = false;
  }

  async startObservationSession(session) {
    throw new Error(`${this.source} adapter: startObservationSession not implemented`);
  }

  async captureCurrentPageSnapshot(session) {
    throw new Error(`${this.source} adapter: captureCurrentPageSnapshot not implemented`);
  }

  async recordUserAnnotation(session, annotation) {
    throw new Error(`${this.source} adapter: recordUserAnnotation not implemented`);
  }

  async markCurrentPageAsRepeatGroup(session, note) {
    throw new Error(`${this.source} adapter: markCurrentPageAsRepeatGroup not implemented`);
  }

  async markCurrentActionAsDangerous(session, note) {
    throw new Error(`${this.source} adapter: markCurrentActionAsDangerous not implemented`);
  }

  async finishObservationSession(session) {
    throw new Error(`${this.source} adapter: finishObservationSession not implemented`);
  }

  async buildObservationFromCapturedEvents(sessionId) {
    throw new Error(`${this.source} adapter: buildObservationFromCapturedEvents not implemented`);
  }
}
