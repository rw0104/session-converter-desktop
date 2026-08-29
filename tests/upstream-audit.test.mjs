import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  compareAuditToSnapshot,
  findOpenAuditIssue,
  renderSourcePinsBlock,
  updateBridgePins,
} from '../scripts/check-upstreams.mjs';

const sha = (character) => character.repeat(40);
const spec = {
  id: 'example',
  label: 'Example',
  repository: 'owner/repo',
  branch: 'main',
  auditedCommit: sha('a'),
  auditedDate: '2026-08-08',
  files: [
    { path: 'auth/token.go', blobSha: sha('b') },
    { path: 'models/list.go', blobSha: sha('c') },
  ],
};
const commit = (commitSha) => ({
  sha: commitSha,
  commit: { committer: { date: '2026-08-09T00:00:00Z' } },
});

test('repository HEAD changes do not report an algorithm change when relevant blobs match', () => {
  const result = compareAuditToSnapshot(spec, commit(sha('d')), [
    { path: 'README.md', type: 'blob', sha: sha('e') },
    { path: 'auth/token.go', type: 'blob', sha: sha('b') },
    { path: 'models/list.go', type: 'blob', sha: sha('c') },
  ]);
  assert.equal(result.status, 'metadata_only');
  assert.equal(result.changedFiles.length, 0);
});

test('changed and missing relevant blobs require an algorithm review', () => {
  const result = compareAuditToSnapshot(spec, commit(sha('d')), [
    { path: 'auth/token.go', type: 'blob', sha: sha('f') },
  ]);
  assert.equal(result.status, 'algorithm_changed');
  assert.deepEqual(result.changedFiles.map((file) => file.status), ['changed', 'missing']);
});

test('an existing open review is reused when the same upstream HEAD advances', () => {
  const result = { label: 'CLIProxyAPI' };
  const issues = [
    { number: 7, title: 'Algorithm mapping review: CLIProxyAPI 0a14eb70' },
    { number: 8, title: 'Algorithm mapping review: sub2api abcdef12' },
  ];
  assert.equal(findOpenAuditIssue(issues, result)?.number, 7);
  assert.equal(findOpenAuditIssue(issues, { label: 'Another upstream' }), null);
});

test('generated browser badges are sourced from audit metadata', async () => {
  const audit = { upstreams: [spec] };
  const block = renderSourcePinsBlock(audit);
  assert.match(block, new RegExp(spec.auditedCommit));
  const bridge = await readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const updated = updateBridgePins(bridge, audit);
  assert.match(updated, /owner\/repo\/commit\/aaaaaaaa/);
});

test('checked-in browser badges exactly match the current audit configuration', async () => {
  const [auditSource, bridge] = await Promise.all([
    readFile(new URL('../config/upstream-audit.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/bridge.js', import.meta.url), 'utf8'),
  ]);
  const audit = JSON.parse(auditSource);
  assert.equal(updateBridgePins(bridge, audit), bridge);
});
