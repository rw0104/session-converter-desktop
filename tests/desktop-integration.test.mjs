import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFile(join(root, ...parts), 'utf8');

test('desktop page is standalone and contains no VaultKey commerce integration', async () => {
  const html = await read('src', 'index.html');

  assert.match(html, /Session Converter/);
  assert.match(html, /系统 WebView · Rust 内核/);
  assert.match(html, /src="\.\/bridge\.js"/);
  assert.match(html, /src="\.\/converter\.js"/);
  assert.doesNotMatch(html, /pay\.ldxp\.cn|返回兑换页|VaultKey · 凭证格式转换/);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
});

test('conversion remains local and desktop-only capabilities are explicit', async () => {
  const [converter, bridge, config, capability] = await Promise.all([
    read('src', 'converter.js'),
    read('src', 'bridge.js'),
    read('src-tauri', 'tauri.conf.json'),
    read('src-tauri', 'capabilities', 'default.json'),
  ]);

  assert.match(converter, /probe_chatgpt_workspace/);
  assert.match(converter, /save_output_file/);
  assert.doesNotMatch(converter, /tauri\.dialog\.save/);
  assert.doesNotMatch(converter, /localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|WebSocket|XMLHttpRequest/i);
  assert.doesNotMatch(bridge, /fetch\s*\(|localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|WebSocket|XMLHttpRequest/i);

  const parsedConfig = JSON.parse(config);
  assert.equal(parsedConfig.app.withGlobalTauri, true);
  assert.match(parsedConfig.app.security.csp, /connect-src ipc: http:\/\/ipc\.localhost/);
  assert.match(parsedConfig.app.security.csp, /object-src 'none'/);

  const parsedCapability = JSON.parse(capability);
  assert.deepEqual(parsedCapability.permissions, [
    'core:default',
    'opener:allow-open-url',
  ]);
});

test('Rust health checks are pinned to Codex and never accept arbitrary URLs', async () => {
  const [health, shell] = await Promise.all([
    read('src-tauri', 'src', 'health.rs'),
    read('src-tauri', 'src', 'lib.rs'),
  ]);

  assert.match(health, /https:\/\/chatgpt\.com\/backend-api\/codex/);
  assert.match(health, /probe_chatgpt_workspace\(access_token: String, account_id: String\)/);
  assert.doesNotMatch(health, /url:\s*String|endpoint:\s*String|reqwest::get/);
  assert.match(shell, /MAX_OUTPUT_BYTES: usize = 64 \* 1024 \* 1024/);
  assert.match(shell, /blocking_save_file/);
  assert.doesNotMatch(shell, /fn\s+write_output_file\s*\(path:/);
});

test('upstream schema pins and license provenance travel with the extraction', async () => {
  const [bridge, upstream, license] = await Promise.all([
    read('src', 'bridge.js'),
    read('docs', 'UPSTREAM.md'),
    read('LICENSE'),
  ]);

  assert.match(bridge, /42a00a2a6521b867c27f7ad096d08699db8e6d19/);
  assert.match(bridge, /2730c1c43b29be003925b033f3f9e645e726bb8c/);
  assert.match(upstream, /gtxx3600\/GPTSession2CPAandSub2API/);
  assert.match(license, /MIT License/);
  assert.match(license, /Dehujiaogeli/);
});
