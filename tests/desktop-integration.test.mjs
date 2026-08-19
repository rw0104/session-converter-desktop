import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFile(join(root, ...parts), 'utf8');

test('desktop page is standalone and exposes intentional resource links', async () => {
  const [html, main] = await Promise.all([
    read('src', 'index.html'),
    read('src-tauri', 'src', 'main.rs'),
  ]);

  assert.match(html, /Session Converter/);
  assert.doesNotMatch(html, /系统 WebView \+ Rust|Tauri 2\.11|runtime-summary/);
  assert.match(html, /src="\.\/bridge\.js\?v=0\.1\.6"/);
  assert.match(html, /src="\.\/converter\.js\?v=0\.1\.6"/);
  assert.match(html, /id="check-app-update"/);
  assert.match(html, /id="check-upstream-updates"/);
  assert.match(html, /id="live-check-model"/);
  assert.match(html, /sol（默认）/);
  assert.match(html, /自动匹配（Free 推荐）/);
  assert.match(html, /id="file-drop-zone"/);
  assert.match(html, /拖入 JSON 即可转换/);
  assert.match(html, /部分响应还含 <code>sessionToken<\/code>/);
  assert.doesNotMatch(html, /JSON 包含 accessToken 和 sessionToken/);
  assert.doesNotMatch(html, /add phone|手机绑定验证/);
  assert.match(html, /账号风险验证或 MFA/);
  assert.match(html, /https:\/\/github\.com\/rw0104\/session-converter-desktop/);
  assert.doesNotMatch(html, /pay\.ldxp\.cn|账号采购/);
  assert.doesNotMatch(html, /项目主页|gpt-account-promo|返回兑换页/);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.match(main, /windows_subsystem = "windows"/);
});

test('conversion remains local and desktop-only capabilities are explicit', async () => {
  const [converter, bridge, config, capability] = await Promise.all([
    read('src', 'converter.js'),
    read('src', 'bridge.js'),
    read('src-tauri', 'tauri.conf.json'),
    read('src-tauri', 'capabilities', 'default.json'),
  ]);

  assert.match(converter, /probe_chatgpt_workspace/);
  assert.match(converter, /check_upstream_updates/);
  assert.match(converter, /check_app_update/);
  assert.match(converter, /install_app_update/);
  assert.match(converter, /open_external_url/);
  assert.match(converter, /save_output_file/);
  assert.doesNotMatch(converter, /tauri\.dialog\.save/);
  assert.doesNotMatch(converter, /localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|WebSocket|XMLHttpRequest/i);
  assert.doesNotMatch(bridge, /fetch\s*\(|localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|WebSocket|XMLHttpRequest/i);

  const parsedConfig = JSON.parse(config);
  assert.equal(parsedConfig.app.withGlobalTauri, true);
  assert.equal(parsedConfig.bundle.createUpdaterArtifacts, true);
  assert.match(parsedConfig.plugins.updater.pubkey, /^dW50cnVzdGVk/);
  assert.deepEqual(parsedConfig.plugins.updater.endpoints, [
    'https://github.com/rw0104/session-converter-desktop/releases/latest/download/latest.json',
  ]);
  assert.match(parsedConfig.app.security.csp, /connect-src ipc: http:\/\/ipc\.localhost/);
  assert.match(parsedConfig.app.security.csp, /object-src 'none'/);

  const parsedCapability = JSON.parse(capability);
  assert.deepEqual(parsedCapability.permissions, ['core:default']);
});

test('Rust health checks are pinned to Codex and never accept arbitrary URLs', async () => {
  const [health, shell, cargo] = await Promise.all([
    read('src-tauri', 'src', 'health.rs'),
    read('src-tauri', 'src', 'lib.rs'),
    read('src-tauri', 'Cargo.toml'),
  ]);

  assert.match(health, /https:\/\/chatgpt\.com\/backend-api\/codex/);
  assert.match(health, /codex-tui\/0\.146\.0/);
  assert.match(health, /responses=experimental/);
  assert.match(health, /streamed_error_code/);
  assert.match(health, /requested_model: String/);
  assert.match(health, /requested_model_unavailable/);
  assert.doesNotMatch(health, /url:\s*String|endpoint:\s*String|reqwest::get/);
  assert.match(shell, /MAX_OUTPUT_BYTES: usize = 64 \* 1024 \* 1024/);
  assert.match(shell, /blocking_save_file/);
  assert.match(cargo, /"system-proxy"/);
  assert.doesNotMatch(shell, /fn\s+write_output_file\s*\(path:/);
});

test('upstream and external-link commands only use fixed destinations', async () => {
  const [upstream, shell, appUpdate] = await Promise.all([
    read('src-tauri', 'src', 'upstream.rs'),
    read('src-tauri', 'src', 'lib.rs'),
    read('src-tauri', 'src', 'app_update.rs'),
  ]);

  assert.match(upstream, /https:\/\/api\.github\.com\/repos/);
  assert.match(upstream, /router-for-me\/CLIProxyAPI/);
  assert.match(upstream, /Wei-Shaw\/sub2api/);
  assert.match(upstream, /check_upstream_updates\(\)/);
  assert.match(upstream, /git\/trees/);
  assert.match(upstream, /pinned_blob_sha/);
  assert.doesNotMatch(upstream, /check_upstream_updates\([^)]*(url|repository|branch)/);
  assert.match(shell, /EXTERNAL_HOSTS: \[&str; 2\]/);
  assert.match(shell, /open_external_url\(app: tauri::AppHandle, url: String\)/);
  assert.match(shell, /tauri_plugin_updater::Builder/);
  assert.match(appUpdate, /download_and_install/);
  assert.match(appUpdate, /app\.restart\(\)/);
});

test('upstream schema pins and license provenance travel with the extraction', async () => {
  const [bridge, upstream, license, auditSource] = await Promise.all([
    read('src', 'bridge.js'),
    read('docs', 'UPSTREAM.md'),
    read('LICENSE'),
    read('config', 'upstream-audit.json'),
  ]);
  const audit = JSON.parse(auditSource);

  for (const spec of audit.upstreams) {
    assert.match(bridge, new RegExp(spec.auditedCommit));
  }
  assert.match(upstream, /gtxx3600\/GPTSession2CPAandSub2API/);
  assert.match(license, /MIT License/);
  assert.match(license, /Dehujiaogeli/);
});
