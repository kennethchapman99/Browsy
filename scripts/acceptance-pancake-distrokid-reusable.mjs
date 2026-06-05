#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { runReplay } from '../src/registry/replay-executor.mjs';
import { resolveTemplate } from '../src/core/runtime-vars.mjs';

const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const seen = [];
const AUDIO_FIXTURE_DIR = path.join(process.cwd(), 'artifacts', 'test-runs', 'acceptance-pancake-distrokid-reusable', 'fixtures');

fs.mkdirSync(AUDIO_FIXTURE_DIR, { recursive: true });
const audioFixtures = ['track-1.wav', 'track-2.wav', 'track-3.wav'].map((name, index) => {
  const filePath = path.join(AUDIO_FIXTURE_DIR, name);
  fs.writeFileSync(filePath, `fake-audio-${index + 1}`);
  return filePath;
});

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/capture') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      res.writeHead(204);
      res.end();
    });
    return;
  }
  const albumId = req.url.match(/^\/releases\/album\/([^/?#]+)/)?.[1] || 'unknown';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html>
    <html><body>
      <h1>DistroKid-like album form ${albumId}</h1>
      <input id="album-title" aria-label="Album title">
      <input id="artist-name" aria-label="Artist name">
      <input id="release-date" aria-label="Release date">
      <input id="track-count" aria-label="Number of songs">
      <input id="track-audio-1" aria-label="Track 1 audio" type="file">
      <input id="track-audio-2" aria-label="Track 2 audio" type="file">
      <input id="track-audio-3" aria-label="Track 3 audio" type="file">
      <script>
        for (const el of document.querySelectorAll('input')) {
          el.addEventListener('input', () => fetch('/capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ albumId: ${JSON.stringify(albumId)}, field: el.id, value: el.value })
          }));
        }
      </script>
    </body></html>`);
});

function pass(label) {
  console.log(`PASS ${label}`);
}

await new Promise(resolve => server.listen(PORT, resolve));
try {
  const workflowVersion = {
    appId: 'pancake-robot',
    workflowId: 'distrokid-album-submit',
    packageWorkflowId: 'distrokid-album-submit',
    tabs: [{ id: 'distrokidUpload', urlTemplate: `${BASE}/releases/album/{releaseId}` }],
    recordedSteps: [
      { id: 'open_album', type: 'navigate', tabId: 'distrokidUpload', url: `${BASE}/releases/album/{releaseId}` },
      { id: 'fill_title', type: 'fill', tabId: 'distrokidUpload', selector: '#album-title', binding: 'album.title', value: '{{payload.album.title}}' },
      { id: 'fill_artist', type: 'fill', tabId: 'distrokidUpload', selector: '#artist-name', binding: 'album.artistName', value: '{{payload.album.artistName}}' },
      { id: 'fill_date', type: 'fill', tabId: 'distrokidUpload', selector: '#release-date', binding: 'album.releaseDate', value: '{{payload.album.releaseDate}}' },
      { id: 'fill_track_count', type: 'fill', tabId: 'distrokidUpload', selector: '#track-count', binding: 'tracks.length', value: '{{payload.tracks.length}}' },
      { id: 'checkpoint', type: 'approve', label: 'Stop before final submit', requiresApproval: true },
    ],
    expectedOutputs: [],
    humanApprovalCheckpoints: [{ id: 'beforeFinalSubmit', label: 'Stop before final submit' }],
  };

  const releases = [
    { releaseId: 'ALBUM_A', album: { title: 'Stack of Pancakes', artistName: 'Pancake Robot', releaseDate: '2026-09-01' }, tracks: [{ title: 'One' }] },
    { releaseId: 'ALBUM_B', album: { title: 'Maple Circuits', artistName: 'Pancake Robot feat. Syrup CPU', releaseDate: '2026-10-15' }, tracks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] },
  ];

  assert.equal(resolveTemplate(`${BASE}/releases/album/{releaseId}`, releases[0]), `${BASE}/releases/album/ALBUM_A`);
  assert.equal(resolveTemplate(`${BASE}/releases/album/{{releaseId}}`, releases[1]), `${BASE}/releases/album/ALBUM_B`);
  assert.equal(resolveTemplate(`${BASE}/releases/album/{album.id}`, releases[0]), `${BASE}/releases/album/ALBUM_A`);
  assert.equal(resolveTemplate(`${BASE}/releases/album/{{album.releaseId}}`, releases[1]), `${BASE}/releases/album/ALBUM_B`);
  pass('releaseId URL templates and aliases resolve with single and double braces');

  for (const [index, payload] of releases.entries()) {
    const result = await runReplay({
      runId: `pancake-distrokid-reuse-${index}`,
      workflowVersion,
      payload,
      mode: 'preview',
      options: { headless: true, settleMs: 100, timeoutMs: 10000, stopOnStepFailure: true },
      runDir: path.join(process.cwd(), 'artifacts', 'test-runs', 'acceptance-pancake-distrokid-reusable', `release-${index}`),
    });
    assert.equal(result.ok, true, JSON.stringify(result.failedSteps || []));
    assert.equal(result.status, 'replay_passed');
    assert.ok(result.logs.some(log => log.type === 'replay_started' && log.variableResolution?.tabs?.[0]?.resolvedUrl === `${BASE}/releases/album/${payload.releaseId}`));
    assert.ok(result.logs.some(log => log.type === 'replay_result' && log.status === 'replay_passed'));
  }
  pass('same recording replays against two releases');

  const byAlbum = Object.groupBy(seen, row => row.albumId);
  assert.ok(byAlbum.ALBUM_A.some(row => row.field === 'album-title' && row.value === 'Stack of Pancakes'));
  assert.ok(byAlbum.ALBUM_A.some(row => row.field === 'track-count' && row.value === '1'));
  assert.ok(byAlbum.ALBUM_B.some(row => row.field === 'album-title' && row.value === 'Maple Circuits'));
  assert.ok(byAlbum.ALBUM_B.some(row => row.field === 'artist-name' && row.value === 'Pancake Robot feat. Syrup CPU'));
  assert.ok(byAlbum.ALBUM_B.some(row => row.field === 'track-count' && row.value === '3'));
  pass('runtime payload values drive title, artist, date, and dynamic track count');

  const uploadWorkflowVersion = {
    ...workflowVersion,
    recordedSteps: [
      { id: 'open_album', type: 'navigate', tabId: 'distrokidUpload', url: `${BASE}/releases/album/{releaseId}` },
      { id: 'upload_track_1', type: 'uploadFile', tabId: 'distrokidUpload', selector: '#track-audio-1', binding: 'tracks[0].audioPath', file: '{{payload.tracks[0].audioPath}}' },
      { id: 'upload_track_2', type: 'uploadFile', tabId: 'distrokidUpload', selector: '#track-audio-2', binding: 'tracks[1].audioPath', file: '{{payload.tracks[1].audioPath}}' },
      { id: 'upload_track_3', type: 'uploadFile', tabId: 'distrokidUpload', selector: '#track-audio-3', binding: 'tracks[2].audioPath', file: '{{payload.tracks[2].audioPath}}' },
      { id: 'checkpoint', type: 'approve', label: 'Stop before final submit', requiresApproval: true },
    ],
  };
  const uploadPayload = {
    releaseId: 'ALBUM_AUDIO',
    album: { title: 'Audio Paths', artistName: 'Pancake Robot', releaseDate: '2026-11-01' },
    tracks: [
      { title: 'One', audioPath: audioFixtures[0] },
      { title: 'Two', audioPath: audioFixtures[1] },
      { title: 'Three', audioPath: audioFixtures[2] },
    ],
  };
  const uploadResult = await runReplay({
    runId: 'pancake-distrokid-audio-paths',
    workflowVersion: uploadWorkflowVersion,
    payload: uploadPayload,
    mode: 'preview',
    options: { headless: true, settleMs: 100, timeoutMs: 10000, stopOnStepFailure: true },
    runDir: path.join(process.cwd(), 'artifacts', 'test-runs', 'acceptance-pancake-distrokid-reusable', 'audio-paths'),
  });
  assert.equal(uploadResult.ok, true, JSON.stringify(uploadResult.failedSteps || []));
  const uploadedFiles = uploadResult.uploaded_files || uploadResult.uploadedFiles || [];
  assert.deepEqual(
    uploadedFiles.map(file => file.path),
    audioFixtures
  );
  assert.deepEqual(
    uploadedFiles.map(file => file.role),
    ['tracks[0].audioPath', 'tracks[1].audioPath', 'tracks[2].audioPath']
  );
  pass('runtime receives and uploads every track audioPath for a three-track Pancake payload');

  const missingAudioResult = await runReplay({
    runId: 'pancake-distrokid-missing-audio-path',
    workflowVersion: uploadWorkflowVersion,
    payload: {
      releaseId: 'ALBUM_AUDIO_MISSING',
      album: { title: 'Missing Audio', artistName: 'Pancake Robot', releaseDate: '2026-11-15' },
      tracks: [
        { title: 'One', audioPath: audioFixtures[0] },
        { title: 'Two' },
        { title: 'Three', audioPath: audioFixtures[2] },
      ],
    },
    mode: 'preview',
    options: { headless: true, settleMs: 100, timeoutMs: 10000, stopOnStepFailure: true },
    runDir: path.join(process.cwd(), 'artifacts', 'test-runs', 'acceptance-pancake-distrokid-reusable', 'missing-audio-path'),
  });
  assert.equal(missingAudioResult.ok, false);
  assert.equal(missingAudioResult.status, 'preflight_failed');
  assert.match(missingAudioResult.failedSteps[0].error, /tracks\[1\]\.audioPath/);
  assert.ok(missingAudioResult.logs.some(log => log.type === 'replay_started'));
  assert.ok(missingAudioResult.logs.some(log => log.type === 'replay_result' && log.status === 'preflight_failed'));
  pass('replay preflight blocks missing track audioPath with an actionable error');

  const hardcoded = JSON.stringify(workflowVersion.recordedSteps);
  for (const forbidden of ['ALBUM_A', 'ALBUM_B', 'Stack of Pancakes', 'Maple Circuits', '2026-09-01', '2026-10-15']) {
    assert.equal(hardcoded.includes(forbidden), false, `${forbidden} leaked into recorded steps`);
  }
  pass('recorded workflow contains no release-specific values');
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log('Summary: reusable Pancake/DistroKid workflow acceptance passed');
