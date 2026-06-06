import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { OUTPUT_DIR } from '../src/core/paths.mjs';
import {
  getRecordingContract,
  importRecordingSession,
  startRecordingSession,
  stopRecordingSession,
  validateRecordingSessionForLaunch,
} from '../src/registry/recording-registry.mjs';

const samplePayload = {
  releaseId: 'album-context',
  albumId: 'album-context',
  album: {
    id: 'album-context',
    releaseId: 'album-context',
    title: 'Context Album',
    artistName: 'Context Artist',
    releaseDate: '2026-09-01',
    language: 'English',
    primaryGenre: 'Hip Hop/Rap',
    secondaryGenre: '',
    coverArtPath: '/tmp/context-cover.png',
  },
  tracks: [
    { index: 1, title: 'Track One', audioPath: '/tmp/track-one.wav', explicit: false, isrc: '', lyrics: '', songwriterCredits: {}, aiDisclosure: {} },
  ],
  derived: { numberOfSongs: 1 },
};

const inputSchema = {
  type: 'object',
  required: ['releaseId', 'album', 'tracks'],
  properties: {
    releaseId: { type: 'string' },
    albumId: { type: 'string' },
    album: { type: 'object', required: ['title', 'artistName', 'releaseDate', 'coverArtPath'], properties: { id: { type: 'string' }, releaseId: { type: 'string' }, title: { type: 'string' }, artistName: { type: 'string' }, releaseDate: { type: 'string' }, coverArtPath: { type: 'string' } } },
    tracks: { type: 'array', items: { type: 'object', required: ['title', 'audioPath'], properties: { title: { type: 'string' }, audioPath: { type: 'string' }, explicit: { type: 'boolean' } } } },
  },
};

const baseRequest = {
  appId: 'pancake-robot',
  appName: 'Pancake Robot',
  sourceApp: 'pancake-robot',
  workflowRef: 'pancake-robot.distrokid-album-submit',
  workflowId: 'distrokid-album-submit',
  workflowName: 'DistroKid Album Submit',
  targetUrl: 'https://distrokid.com/new/',
  releaseId: 'album-context',
  packageId: 'package-context',
  inputSchema,
  requiredAssets: [
    { path: 'album.coverArtPath', type: 'file', required: true },
    { path: 'tracks[].audioPath', type: 'file', required: true },
  ],
  samplePayload,
  derivedVariables: { numberOfSongs: 'tracks.length', 'derived.numberOfSongs': 'tracks.length' },
  bindingHints: [
    { path: 'album.releaseDate' },
    { path: 'album.coverArtPath' },
    { path: 'tracks.length' },
    { path: 'tracks[].audioPath' },
  ],
  recordingSetup: {
    authProfileId: 'distrokid',
    tabs: [{ id: 'distrokidUpload', title: 'DistroKid Upload', url: 'https://distrokid.com/new/', siteId: 'distrokid', requiresAuth: true, role: 'target' }],
  },
  fileBindings: [
    { id: 'coverArtPath', source: 'payload.album.coverArtPath', binding: 'album.coverArtPath', required: true },
    { id: 'trackAudioFiles', source: 'payload.tracks[].audioPath', binding: 'tracks[].audioPath', required: true },
  ],
  humanCheckpoints: [{ id: 'beforeFinalSubmit', label: 'Stop before final submit' }],
  completionPolicy: {
    action: 'wait_for_human_submission',
    notes: 'Capture DistroKid draft/public URLs when visible, then stop before final submit.',
    closeBrowser: false,
    requireApprovalBeforeSubmit: true,
  },
  writebackTargets: [{ source: 'distrokidDraftUrl', destination: 'album.distrokidDraftUrl', required: false }],
};

function mustThrow(message, fn, pattern) {
  try {
    fn();
    assert.fail(message);
  } catch (error) {
    assert.match(error.message, pattern);
  }
}

function pass(label) {
  console.log(`PASS ${label}`);
}

mustThrow('missing targetUrl rejected', () => startRecordingSession({ ...baseRequest, workflowId: 'distrokid-album-submit-no-default', workflowRef: 'pancake-robot.distrokid-album-submit-no-default', targetUrl: '', recordingSetup: { tabs: [] } }), /targetUrl is required/);
pass('startRecording requires targetUrl');

mustThrow('about:blank rejected', () => startRecordingSession({ ...baseRequest, targetUrl: 'about:blank', recordingSetup: { tabs: [{ id: 'blank', url: 'about:blank' }] } }), /about:blank/);
pass('startRecording rejects about:blank');

mustThrow('missing inputSchema rejected', () => startRecordingSession({ ...baseRequest, workflowId: 'distrokid-album-submit-no-default', workflowRef: 'pancake-robot.distrokid-album-submit-no-default', inputSchema: null, payloadSchema: null }), /inputSchema is required/);
pass('startRecording requires inputSchema for Pancake DistroKid');

mustThrow('missing releaseDate rejected', () => startRecordingSession({ ...baseRequest, workflowId: 'distrokid-album-submit-no-default', workflowRef: 'pancake-robot.distrokid-album-submit-no-default', samplePayload: { ...samplePayload, album: { ...samplePayload.album, releaseDate: '' } } }), /releaseDate/);
pass('startRecording requires samplePayload.album.releaseDate');

const defaultedSession = startRecordingSession({
  appId: 'pancake-robot',
  appName: 'Pancake Robot',
  workflowId: 'distrokid-album-submit',
}, { baseUrl: 'http://localhost:3001' });
assert.equal(defaultedSession.samplePayload.releaseId, 'ALBUM_MPK9H71S_RTCM');
assert.equal(defaultedSession.samplePayload.albumId, 'ALBUM_MPK9H71S_RTCM');
assert.equal(defaultedSession.samplePayload.album.id, 'ALBUM_MPK9H71S_RTCM');
assert.equal(defaultedSession.samplePayload.album.releaseId, 'ALBUM_MPK9H71S_RTCM');
assert.ok(defaultedSession.payloadSchema.required.includes('releaseId'));
assert.ok(defaultedSession.bindingHints.some(hint => hint.path === 'releaseId'));
assert.ok(defaultedSession.bindingHints.some(hint => hint.path === 'tracks[].audioPath'));
assert.equal(defaultedSession.recordingSetup.tabs[0].urlTemplate, 'http://localhost:3737/releases/album/{album.id}');
assert.equal(defaultedSession.recordingSetup.tabs[0].url, 'http://localhost:3737/releases/album/ALBUM_MPK9H71S_RTCM');
assert.equal(defaultedSession.callbackUrl, 'http://localhost:3737/releases/album/ALBUM_MPK9H71S_RTCM/magic-release/ingest-result');
assert.equal(defaultedSession.callbackUrlTemplate, 'http://localhost:3737/releases/album/{album.id}/magic-release/ingest-result');
assert.equal(defaultedSession.fileBindings[0].binding, 'album.coverArtPath');
pass('Pancake Robot defaults hydrate releaseId, aliases, callback, file bindings, and source URL template');

const session = startRecordingSession(baseRequest, { baseUrl: 'http://localhost:3001' });
assert.equal(session.inputSchema.required[0], 'releaseId');
assert.equal(session.releaseId, 'album-context');
assert.equal(session.samplePayload.releaseId, 'album-context');
assert.equal(session.samplePayload.album.releaseDate, '2026-09-01');
assert.ok(session.bindingHints.some(hint => hint.path === 'tracks[].audioPath'));
pass('startRecording accepts and persists releaseId/inputSchema/samplePayload/bindingHints');

const sessionPath = path.join(OUTPUT_DIR, 'recordings', session.recordingSessionId, 'session.json');
const rawSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
assert.equal(rawSession.samplePayload.album.releaseDate, '2026-09-01');
assert.equal(rawSession.samplePayload.album.id, 'album-context');
assert.equal(rawSession.fileBindings[0].binding, 'album.coverArtPath');
pass('recording context persisted on disk');

const observation = {
  schemaVersion: 'browsy.observation.v1',
  workflowId: 'distrokid-album-submit',
  title: 'DistroKid Album Submit',
  workflowContext: rawSession,
  recordingSetup: baseRequest.recordingSetup,
  pages: [{ id: 'distrokidUpload', purpose: 'DistroKid Upload', url: 'https://distrokid.com/new/' }],
  fields: [
    { id: 'releaseDate', label: 'Release date', inputType: 'text', selectorHint: '#release-date', binding: 'album.releaseDate', required: true },
    { id: 'numberOfSongs', label: 'Number of songs', inputType: 'text', selectorHint: '#num-songs', binding: 'tracks.length', required: true },
    { id: 'trackTitle', label: 'Track title', inputType: 'text', selectorHint: '#track-title-1', binding: 'tracks[].title', required: true },
    { id: 'explicit', label: 'Explicit', inputType: 'checkbox', selectorHint: '#explicit-1', binding: 'tracks[].explicit', required: true },
  ],
  fields_extra: [],
  capturedOutputs: [],
  humanCheckpoints: [{ id: 'beforeFinalSubmit', label: 'Stop before final submit', beforeAction: 'finalSubmit' }],
};
observation.fields.push(
  { id: 'coverArtUpload', label: 'Cover art', inputType: 'file', scope: 'asset', selectorHint: '#cover-art', binding: 'album.coverArtPath', required: true },
  { id: 'trackAudioUpload', label: 'Track audio', inputType: 'file', scope: 'asset', selectorHint: '#track-audio-1', binding: 'tracks[].audioPath', required: true },
);

stopRecordingSession(session.recordingSessionId, { observation });
const imported = importRecordingSession(session.recordingSessionId, { overwrite: true, packageKind: 'local', appId: 'pancake-robot', appName: 'Pancake Robot', version: '1.0.0', autoRegisterApp: true });
const contract = imported.contract || getRecordingContract(session.recordingSessionId);

assert.ok(contract.recordedSteps.some(step => step.binding === 'album.releaseDate'));
assert.ok(contract.recordedSteps.some(step => step.binding === 'tracks.length'));
assert.ok(contract.recordedSteps.some(step => step.binding === 'tracks[].title'));
assert.ok(contract.fileUploadBindings.some(binding => binding.source === 'payload.album.coverArtPath' || binding.binding === 'album.coverArtPath'));
assert.ok(contract.fileUploadBindings.some(binding => binding.source === 'payload.tracks[].audioPath' || binding.binding === 'tracks[].audioPath'));
assert.ok(contract.tabs.length > 0);
assert.ok(contract.recordedSteps.length > 0);
assert.ok(contract.fileUploadBindings.length > 0);
assert.ok(contract.humanApprovalCheckpoints.length > 0);
assert.equal(contract.sourceAppId, 'pancake-robot');
assert.equal(contract.sourceWorkflowId, 'distrokid-album-submit');
assert.ok(contract.sourcePayloadSchema?.properties?.releaseId);
assert.ok(contract.sourceFieldMappings.some(mapping => mapping.path === 'tracks[].audioPath'));
assert.ok(contract.tabUrlTemplates.some(tab => tab.urlTemplate === 'https://distrokid.com/new/'));
assert.equal(contract.authProfileRef, 'distrokid');
assert.equal(contract.completionPolicy?.action, 'wait_for_human_submission');
assert.ok(contract.writebackTargets.some(target => target.destination === 'album.distrokidDraftUrl'));
pass('contract represents variable-bound fields, source metadata, uploads, repeated tracks, and readiness counts');

const unresolvedSession = startRecordingSession({
  ...baseRequest,
  releaseId: '',
  workflowId: 'distrokid-album-submit-no-default',
  workflowRef: 'pancake-robot.distrokid-album-submit-no-default',
  samplePayload: { ...samplePayload, releaseId: '', albumId: '', album: { ...samplePayload.album, id: '', releaseId: '' } },
  recordingSetup: { tabs: [{ id: 'source', url: 'http://localhost:3737/releases/album/{releaseId}' }] },
});
mustThrow('unresolved release URL blocked with available variables', () => validateRecordingSessionForLaunch(unresolvedSession.recordingSessionId), /releaseId|Available variables/);
pass('unresolved releaseId URL template blocks launch before about:blank fallback');

const emptySession = startRecordingSession({ ...baseRequest, workflowId: 'distrokid-album-submit-empty', workflowRef: 'pancake-robot.distrokid-album-submit-empty' }, { baseUrl: 'http://localhost:3001' });
stopRecordingSession(emptySession.recordingSessionId, {});
const emptyImported = importRecordingSession(emptySession.recordingSessionId, { overwrite: true, packageKind: 'local', appId: 'pancake-robot', appName: 'Pancake Robot', version: '1.0.1', autoRegisterApp: true });
assert.equal(emptyImported.contract.recordedSteps.length, 0);
pass('0-step imported recordings remain 0-step contracts');

console.log('Summary: pancake recording context acceptance passed');
