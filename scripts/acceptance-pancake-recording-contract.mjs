#!/usr/bin/env node
// Acceptance: generic multi-tab album-recording contract for external callers.
//
// This test intentionally keeps Pancake Robot/DistroKid concepts in acceptance
// only. Core runtime behavior is generic: payload bindings, file bindings,
// repeat groups, auth requirements, and contract exposure.

import { registerApp } from '../src/registry/app-registry.mjs';
import { registerWorkflow, getWorkflowVersion } from '../src/registry/workflow-registry.mjs';
import { buildWorkflowContract } from '../src/registry/run-result.mjs';
import { normalizePayloadForWorkflow } from '../src/registry/payload-bindings.mjs';

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`);
    passed++;
  } else {
    console.error(`FAIL ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

const ts = Date.now();
const appId = `pancake-contract-${ts}`;
const workflowId = `distrokid-album-submit-${ts}`;
const workflowObjectId = `${appId}.${workflowId}`;

const externalPayload = {
  releaseTitle: 'Example Album',
  artistName: 'Pancake Robot',
  releaseDate: '2026-08-01',
  label: 'Figment Factory',
  primaryGenre: "Children's Music",
  genre: "Children's Music",
  artworkPath: '/tmp/browsy-acceptance/cover.png',
  tracks: [
    {
      title: 'Track One',
      audioPath: '/tmp/browsy-acceptance/01.wav',
      lyrics: 'Lyrics one',
      explicit: false,
      instrumental: false,
      isAiGenerated: true,
      aiDisclosure: { aiGate: 'true', aiLyrics: 'true', aiMusic: 'true' },
    },
    {
      title: 'Track Two',
      audioPath: '/tmp/browsy-acceptance/02.wav',
      lyrics: 'Lyrics two',
      explicit: false,
      instrumental: true,
      isAiGenerated: true,
      aiDisclosure: { aiGate: 'true', aiLyrics: 'true', aiMusic: 'true' },
    },
  ],
};

const payloadBindings = {
  releaseTitle: 'album.title',
  artistName: 'album.artistName',
  releaseDate: 'album.releaseDate',
  label: 'album.recordLabel',
  primaryGenre: 'album.genrePrimary',
  'tracks[].title': 'tracks[].trackTitle',
  'tracks[].lyrics': 'tracks[].lyrics',
  'tracks[].explicit': 'tracks[].explicit',
  'tracks[].instrumental': 'tracks[].instrumental',
  'tracks[].isAiGenerated': 'tracks[].isAiGenerated',
  'tracks[].aiDisclosure': 'tracks[].aiDisclosure',
};

const fileBindings = [
  {
    bindingId: 'album_artwork',
    assetRole: 'album_artwork',
    payloadPath: 'artworkPath',
    source: { tabId: 'source-app', type: 'payload_path', path: 'artworkPath' },
    target: { tabId: 'target-distributor', type: 'file_input', selector: '#album-artwork' },
    required: true,
  },
  {
    bindingId: 'track_audio',
    assetRole: 'track_audio',
    repeatGroupId: 'tracks',
    payloadPath: 'tracks[].audioPath',
    source: { type: 'payload_path', pathTemplate: 'tracks[].audioPath' },
    target: { tabId: 'target-distributor', type: 'file_input', selectorTemplate: '[data-track-index="{{index}}"] input[type="file"]' },
    required: true,
  },
];

const repeatGroups = [
  {
    id: 'tracks',
    itemLabel: 'track',
    createAction: { selector: '#add-track', action: 'click' },
    itemSelector: '[data-track-row]',
    itemFields: {
      title: { selector: '[data-field="track-title"]', payloadPath: 'tracks[].title' },
      lyrics: { selector: '[data-field="track-lyrics"]', payloadPath: 'tracks[].lyrics' },
      explicit: { selector: '[data-field="track-explicit"]', payloadPath: 'tracks[].explicit' },
      instrumental: { selector: '[data-field="track-instrumental"]', payloadPath: 'tracks[].instrumental' },
    },
    itemAssets: {
      audioPath: { selector: '[data-field="track-audio"]', payloadPath: 'tracks[].audioPath' },
    },
  },
];

const normalized = normalizePayloadForWorkflow(externalPayload, { payloadBindings, fileBindings });

assert('releaseTitle maps to canonical album.title', normalized.canonicalPayload.album?.title === 'Example Album');
assert('primaryGenre maps to canonical album.genrePrimary', normalized.canonicalPayload.album?.genrePrimary === "Children's Music");
assert('track titles map to canonical tracks[].trackTitle', normalized.canonicalPayload.tracks?.[1]?.trackTitle === 'Track Two');
assert('track AI disclosure maps per item', normalized.canonicalPayload.tracks?.[0]?.aiDisclosure?.aiMusic === 'true');
assert('album artwork asset is bound', normalized.boundAssets.some(a => a.role === 'album_artwork' && a.path.endsWith('cover.png')));
assert('one audio asset per track is bound', normalized.boundAssets.filter(a => a.role === 'track_audio').length === 2);

registerApp({ appId, appName: 'Pancake Contract Test App' });
registerWorkflow({
  appId,
  workflowId,
  version: '1.0.0',
  name: 'External album submit contract test',
  inputSchema: {
    type: 'object',
    required: ['releaseTitle', 'artistName', 'releaseDate', 'artworkPath', 'tracks'],
    properties: {
      releaseTitle: { type: 'string' },
      artistName: { type: 'string' },
      releaseDate: { type: 'string' },
      label: { type: 'string' },
      primaryGenre: { type: 'string' },
      artworkPath: { type: 'string' },
      tracks: { type: 'array', minItems: 1 },
    },
  },
  supportedModes: ['preview', 'live', 'dry_run'],
  tabs: [
    { tabId: 'source-app', role: 'source', startUrl: 'http://localhost:3737/releases/example', requiresAuth: false },
    { tabId: 'target-distributor', role: 'target', startUrl: 'https://example-distributor.invalid/new', requiresAuth: true, authProfileId: 'target-distributor' },
  ],
  auth: [{ tabId: 'target-distributor', mode: 'human_required_if_not_authenticated', authProfileId: 'target-distributor' }],
  humanApprovalCheckpoints: [{ id: 'before-final-submit', status: 'waiting_for_approval_to_submit' }],
  payloadBindings,
  examplePayload: externalPayload,
  fileBindings,
  repeatGroups,
  recordedSteps: [
    { type: 'click', tabId: 'source-app', selector: '#download-artwork' },
    { type: 'uploadFile', tabId: 'target-distributor', selector: '#album-artwork', path: '{{payload.artworkPath}}' },
  ],
  replaySettings: { leaveBrowserOpen: true, requireHumanApproval: true },
});

const wv = getWorkflowVersion(workflowObjectId, '1.0.0');
const contract = buildWorkflowContract(wv, { baseUrl: 'http://localhost:3001' });

assert('contract has stable workflowRef', contract.workflowRef === `${workflowObjectId}@1.0.0`);
assert('contract exposes canonical run endpoint', contract.runEndpoint === `POST http://localhost:3001/api/apps/${appId}/workflows/${workflowId}/runs`);
assert('contract exposes external required payload fields', contract.requiredPayloadFields.includes('releaseTitle') && contract.requiredPayloadFields.includes('tracks'));
assert('contract preserves multi-tab roles', contract.tabs.length === 2 && contract.tabs.some(t => t.role === 'source') && contract.tabs.some(t => t.role === 'target'));
assert('contract preserves auth requirements', contract.auth.length === 1 && contract.auth[0].mode === 'human_required_if_not_authenticated');
assert('contract preserves payload bindings', contract.payloadBindings.releaseTitle === 'album.title');
assert('contract preserves file bindings', contract.fileBindings.length === 2);
assert('contract preserves repeat group metadata', contract.repeatGroups.length === 1 && contract.repeatGroups[0].id === 'tracks');
assert('contract example body uses external caller shape', contract.exampleHTTPBody.payload.releaseTitle === 'Example Album' && contract.exampleHTTPBody.payload.tracks[0].audioPath.endsWith('01.wav'));

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
