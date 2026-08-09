#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const auditPath = join(root, 'config', 'upstream-audit.json');
const bridgePath = join(root, 'src', 'bridge.js');
const apiBase = 'https://api.github.com';

const isSha = (value) => /^[0-9a-f]{40}$/i.test(String(value || ''));

export function compareAuditToSnapshot(spec, commit, treeEntries) {
  const blobs = new Map(
    treeEntries
      .filter((entry) => entry.type === 'blob' && isSha(entry.sha))
      .map((entry) => [entry.path, entry.sha]),
  );
  const files = spec.files.map((file) => {
    const latestBlobSha = blobs.get(file.path) || null;
    return {
      path: file.path,
      pinnedBlobSha: file.blobSha,
      latestBlobSha,
      status: !latestBlobSha
        ? 'missing'
        : latestBlobSha.toLowerCase() === file.blobSha.toLowerCase()
          ? 'current'
          : 'changed',
    };
  });
  const changedFiles = files.filter((file) => file.status !== 'current');
  return {
    id: spec.id,
    label: spec.label,
    repository: spec.repository,
    auditedCommit: spec.auditedCommit,
    latestCommit: commit.sha,
    latestDate: commit.commit.committer.date,
    files,
    changedFiles,
    status: changedFiles.length
      ? 'algorithm_changed'
      : commit.sha.toLowerCase() === spec.auditedCommit.toLowerCase()
        ? 'current'
        : 'metadata_only',
  };
}

export function renderSourcePinsBlock(audit) {
  const objects = audit.upstreams.map((spec) => [
    '    Object.freeze({',
    `      id: ${JSON.stringify(spec.id)},`,
    `      label: ${JSON.stringify(spec.label)},`,
    `      branch: ${JSON.stringify(spec.branch)},`,
    `      shortSha: ${JSON.stringify(spec.auditedCommit.slice(0, 8))},`,
    `      fullSha: ${JSON.stringify(spec.auditedCommit)},`,
    `      date: ${JSON.stringify(spec.auditedDate)},`,
    `      repoUrl: ${JSON.stringify(`https://github.com/${spec.repository}`)},`,
    `      commitUrl: ${JSON.stringify(`https://github.com/${spec.repository}/commit/${spec.auditedCommit}`)},`,
    '    }),',
  ].join('\n')).join('\n');
  return [
    '  // BEGIN GENERATED UPSTREAM PINS — scripts/check-upstreams.mjs owns this block.',
    '  const SOURCE_PINS = Object.freeze([',
    objects,
    '  ]);',
    '  // END GENERATED UPSTREAM PINS',
  ].join('\n');
}

export function updateBridgePins(source, audit) {
  const pattern = /  \/\/ BEGIN GENERATED UPSTREAM PINS[^\n]*\n[\s\S]*?  \/\/ END GENERATED UPSTREAM PINS/;
  if (!pattern.test(source)) throw new Error('bridge.js generated pin block not found');
  return source.replace(pattern, renderSourcePinsBlock(audit));
}

async function githubJson(path, token, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'session-converter-upstream-audit/0.1.4',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path} returned HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function fetchSnapshot(spec, token) {
  const commit = await githubJson(`/repos/${spec.repository}/commits/${spec.branch}`, token);
  if (!isSha(commit?.sha) || !isSha(commit?.commit?.tree?.sha)) {
    throw new Error(`${spec.repository} returned an invalid commit`);
  }
  const tree = await githubJson(`/repos/${spec.repository}/git/trees/${commit.commit.tree.sha}?recursive=1`, token);
  if (tree?.truncated || !Array.isArray(tree?.tree)) {
    throw new Error(`${spec.repository} returned a truncated or invalid tree`);
  }
  return compareAuditToSnapshot(spec, commit, tree.tree);
}

async function ensureAuditIssue(repository, result, token) {
  if (!token || !repository) return;
  try {
    await githubJson(`/repos/${repository}/labels`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'upstream-audit', color: '0969da', description: 'Upstream algorithm mapping needs review' }),
    });
  } catch (error) {
    if (!String(error.message).includes('HTTP 422')) throw error;
  }
  const title = `Algorithm mapping review: ${result.label} ${result.latestCommit.slice(0, 8)}`;
  const openIssues = await githubJson(`/repos/${repository}/issues?state=open&labels=upstream-audit&per_page=100`, token);
  if (openIssues.some((issue) => issue.title === title)) return;
  const rows = result.changedFiles.map((file) =>
    `- \`${file.path}\`: \`${file.pinnedBlobSha || 'missing'}\` → \`${file.latestBlobSha || 'missing'}\``,
  ).join('\n');
  await githubJson(`/repos/${repository}/issues`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      labels: ['upstream-audit'],
      body: [
        'The scheduled upstream audit detected changes in files that affect credential mapping or model verification.',
        '',
        `Upstream: https://github.com/${result.repository}/commit/${result.latestCommit}`,
        '',
        rows,
        '',
        'Do not update the embedded blob pins until the mapping diff, conversion fixtures, and live-model probe tests pass. Then publish a signed desktop release.',
      ].join('\n'),
    }),
  });
}

async function main() {
  const write = process.argv.includes('--write');
  const githubMode = process.argv.includes('--github');
  const token = process.env.GITHUB_TOKEN || '';
  const targetRepository = process.env.GITHUB_REPOSITORY || '';
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  if (audit.schemaVersion !== 1 || !Array.isArray(audit.upstreams) || audit.upstreams.length !== 2) {
    throw new Error('invalid upstream audit configuration');
  }
  const results = [];
  for (const spec of audit.upstreams) results.push(await fetchSnapshot(spec, token));

  const changed = results.filter((result) => result.status === 'algorithm_changed');
  const metadataOnly = results.filter((result) => result.status === 'metadata_only');
  let metadataChanged = false;
  for (const result of metadataOnly) {
    const spec = audit.upstreams.find((item) => item.id === result.id);
    spec.auditedCommit = result.latestCommit;
    spec.auditedDate = result.latestDate.slice(0, 10);
    metadataChanged = true;
  }
  if (metadataChanged) audit.updatedAt = new Date().toISOString().slice(0, 10);

  if (write && metadataChanged) {
    await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
    const bridge = await readFile(bridgePath, 'utf8');
    await writeFile(bridgePath, updateBridgePins(bridge, audit), 'utf8');
  }
  if (githubMode) {
    for (const result of changed) await ensureAuditIssue(targetRepository, result, token);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `metadata_changed=${metadataChanged}\nalgorithm_changed=${changed.length > 0}\n`, 'utf8');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((result) => `| ${result.label} | ${result.latestCommit.slice(0, 8)} | ${result.status} | ${result.changedFiles.length} |`).join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Upstream algorithm audit\n\n| Upstream | HEAD | Result | Changed files |\n| --- | --- | --- | ---: |\n${rows}\n`, 'utf8');
  }
  for (const result of results) {
    console.log(`${result.label}: ${result.status} (${result.latestCommit.slice(0, 8)}), changed files: ${result.changedFiles.length}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
