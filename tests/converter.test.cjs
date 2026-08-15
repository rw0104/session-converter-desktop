#!/usr/bin/env node

// Derived from gtxx3600/GPTSession2CPAandSub2API at
// a097eb155bb7bdf6cbbc26f1e4e75e120ab3163c (MIT License).

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createFakeElement(selector, options = {}) {
  const classes = new Set();

  return {
    selector,
    attributes: {},
    dataset: options.dataset || {},
    disabled: false,
    files: [],
    hidden: false,
    innerHTML: "",
    listeners: {},
    style: {},
    textContent: "",
    value: "",
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
          return;
        }
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    append() {},
    click() {
      this.listeners.click?.({ target: this });
    },
    remove() {},
    select() {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

function loadPageScript(overrides = {}) {
  const bridgePath = path.join(__dirname, "..", "src", "bridge.js");
  const scriptPath = path.join(__dirname, "..", "src", "converter.js");
  const bridgeScript = fs.readFileSync(bridgePath, "utf8");
  const script = fs.readFileSync(scriptPath, "utf8");

  const elements = new Map();
  const formatButtons = ["sub2api", "cpa", "cockpit", "9router", "codex", "axonhub", "codexmanager"].map((format) =>
    createFakeElement(`[data-format="${format}"]`, { dataset: { format } })
  );
  const modeButtons = ["session", "cpa-to-sub", "sub-to-cpa"].map((mode) =>
    createFakeElement(`[data-mode="${mode}"]`, { dataset: { mode } })
  );

  const document = {
    body: createFakeElement("body"),
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    createElement(selector) {
      return createFakeElement(selector);
    },
    execCommand() {
      return true;
    },
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createFakeElement(selector));
      }
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      if (selector === "[data-format]") return formatButtons;
      if (selector === "[data-mode]") return modeButtons;
      return [];
    },
  };

  const context = {
    AbortController,
    Array,
    Blob,
    Boolean,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    URL: {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    Uint8Array,
    Uint32Array,
    atob,
    btoa,
    clearTimeout,
    console,
    document,
    fetch: overrides.fetch || (async () => ({ status: 200 })),
    isFinite: Number.isFinite,
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    parseInt: Number.parseInt,
    setTimeout: overrides.setTimeout || setTimeout,
    __TAURI__: overrides.tauri,
    globalThis: {},
  };
  context.globalThis = context;

  vm.runInNewContext(bridgeScript, context, { filename: "public/tools/session-converter/bridge.js" });
  vm.runInNewContext(script, context, { filename: "public/tools/session-converter/converter.js" });

  return { elements, formatButtons, modeButtons, context };
}

async function testDesktopExternalLinksUseRustAllowlistedCommand() {
  const calls = [];
  const { context } = loadPageScript({
    tauri: {
      core: {
        async invoke(command, args) {
          calls.push({ command, args });
          return null;
        },
      },
    },
  });
  let prevented = false;
  const link = { href: "https://github.com/rw0104/session-converter-desktop" };
  context.document.listeners.click({
    target: { closest: () => link },
    preventDefault() { prevented = true; },
  });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.equal(calls[0].command, "open_external_url");
  assert.equal(calls[0].args.url, "https://github.com/rw0104/session-converter-desktop");
}

async function testDroppedJsonConvertsImmediately() {
  const { elements, context } = loadPageScript();
  let prevented = false;
  const file = {
    name: "session.json",
    async text() {
      return JSON.stringify({
        user: { email: "drop@example.com" },
        account: { id: "account-drop", planType: "plus" },
        accessToken: jwtWithPayload({ exp: 4_102_444_800 }),
      });
    },
  };

  await context.document.listeners.drop({
    dataTransfer: { files: [file] },
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.match(elements.get("#output").value, /drop@example\.com/);
  assert.match(elements.get("#input-status").textContent, /读取 1 个文件/);
}

async function testDesktopUpstreamCheckReportsAuditedPins() {
  const calls = [];
  const { elements } = loadPageScript({
    tauri: {
      core: {
        async invoke(command) {
          calls.push(command);
          if (command === "check_upstream_updates") {
            return [
              { label: "CLIProxyAPI", status: "current", files: [{ status: "current" }, { status: "current" }, { status: "current" }, { status: "current" }] },
              { label: "sub2api", status: "current", files: [{ status: "current" }, { status: "current" }] },
            ];
          }
          throw new Error(`unexpected command: ${command}`);
        },
      },
    },
  });
  await dispatchAsync(elements.get("#check-upstream-updates"), "click");
  assert.equal(elements.get("#check-upstream-updates").disabled, false);
  assert.equal(elements.get("#check-upstream-updates").textContent, "检查算法");
  assert.deepEqual(calls, ["check_upstream_updates"]);
  assert.match(elements.get("#upstream-check-status").textContent, /6 个相关文件 blob SHA/);
}

async function testSignedAppUpdateRequiresConfirmationThenInstalls() {
  const calls = [];
  const { elements } = loadPageScript({
    tauri: {
      core: {
        async invoke(command) {
          calls.push(command);
          if (command === "check_app_update") {
            return { available: true, currentVersion: "0.1.3", version: "0.1.4" };
          }
          if (command === "install_app_update") return null;
          throw new Error(`unexpected command: ${command}`);
        },
      },
    },
  });

  const button = elements.get("#check-app-update");
  await dispatchAsync(button, "click");
  assert.equal(button.textContent, "更新并重启");
  assert.match(elements.get("#app-update-status").textContent, /签名版 v0\.1\.4/);

  await dispatchAsync(button, "click");
  assert.equal(calls.at(-1), "install_app_update");
  assert.equal(button.disabled, true);
  assert.match(elements.get("#app-update-status").textContent, /正在重启/);
}

function dispatch(element, type) {
  assert.equal(typeof element.listeners[type], "function", `missing ${type} listener on ${element.selector}`);
  element.listeners[type]({ target: element });
}

async function dispatchAsync(element, type) {
  assert.equal(typeof element.listeners[type], "function", `missing ${type} listener on ${element.selector}`);
  await element.listeners[type]({ target: element });
}

function jwtWithPayload(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function testSub2apiAccountUsesAccessTokenExpiry() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    accessToken: jwtWithPayload({
      exp: 1780473960,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "chatgpt-account-1",
        chatgpt_user_id: "user-1",
        chatgpt_plan_type: "plus",
        poid: "org-1",
      },
    }),
  });
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  const account = document.accounts[0];

  assert.equal(document.type, "sub2api-data");
  assert.equal(document.version, 1);
  assert.equal(document.expires_at, undefined);
  assert.equal(document.auto_pause_on_expired, undefined);
  assert.deepEqual(document.proxies, []);
  assert.equal(document.accounts.length, 1);
  assert.equal(account.platform, "openai");
  assert.equal(account.type, "oauth");
  assert.equal(account.concurrency, 10);
  assert.equal(account.priority, 1);
  assert.equal(account.rate_multiplier, 1);
  assert.equal(account.auto_pause_on_expired, true);
  assert.equal(account.expires_at, undefined);
  assert.equal(account.credentials.chatgpt_account_id, "chatgpt-account-1");
  assert.equal(account.credentials.chatgpt_user_id, "user-1");
  assert.equal(account.credentials.plan_type, "plus");
  assert.equal(account.credentials.organization_id, "org-1");
  assert.equal(account.credentials.expires_at, new Date(1780473960 * 1000).toISOString());
  assert.equal(account.credentials.client_id, undefined);
  assert.equal(account.credentials.id_token.split(".").length, 3);
}

function testCurrentChatGptSessionWorksWithoutSessionToken() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = JSON.stringify({
    user: { id: "user-current", email: "current@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
    account: { id: "account-current", planType: "plus" },
    accessToken: jwtWithPayload({ exp: 1780473960 }),
    authProvider: "openai",
  });
  dispatch(input, "input");

  const account = JSON.parse(output.value).accounts[0];
  assert.equal(account.credentials.chatgpt_account_id, "account-current");
  assert.equal(account.credentials.chatgpt_user_id, "user-current");
  assert.equal(account.credentials.plan_type, "plus");
  assert.equal(account.credentials.expires_at, new Date(1780473960 * 1000).toISOString());
  assert.equal(account.extra.session_expires_at, "2099-01-01T00:00:00.000Z");
  assert.equal(account.extra.session_token_present, undefined);
}

function testSub2apiAccountsUseTheirOwnAccessTokenExpiry() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = JSON.stringify([
    {
      email: "late@example.com",
      accessToken: jwtWithPayload({
        exp: 1780473960,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "chatgpt-account-late",
        },
      }),
    },
    {
      email: "early@example.com",
      accessToken: jwtWithPayload({
        exp: 1780000000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "chatgpt-account-early",
        },
      }),
    },
  ]);
  dispatch(input, "input");

  const document = JSON.parse(output.value);

  assert.equal(document.type, "sub2api-data");
  assert.equal(document.version, 1);
  assert.equal(document.expires_at, undefined);
  assert.equal(document.auto_pause_on_expired, undefined);
  assert.equal(document.accounts.length, 2);
  assert.equal(document.accounts[0].credentials.expires_at, new Date(1780473960 * 1000).toISOString());
  assert.equal(document.accounts[0].auto_pause_on_expired, true);
  assert.equal(document.accounts[1].credentials.expires_at, new Date(1780000000 * 1000).toISOString());
  assert.equal(document.accounts[1].auto_pause_on_expired, true);
}

function testSub2apiAccountWithRefreshTokenKeepsTokenExpiryAndClientId() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");
  const futureExp = Math.floor(Date.now() / 1000) + 3600;

  input.value = JSON.stringify({
    user: {
      email: "refreshable@example.com",
    },
    accessToken: jwtWithPayload({
      exp: futureExp,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "chatgpt-account-refreshable",
      },
    }),
    refreshToken: "real-refresh-token",
    idToken: jwtWithPayload({
      email: "refreshable@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "chatgpt-account-refreshable",
      },
    }),
    expiresAt: "2099-06-01T00:00:00.000Z",
  });
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  const account = document.accounts[0];

  assert.equal(document.type, "sub2api-data");
  assert.equal(document.version, 1);
  assert.equal(account.expires_at, undefined);
  assert.equal(account.auto_pause_on_expired, true);
  assert.equal(account.credentials.refresh_token, "real-refresh-token");
  assert.equal(account.credentials.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(account.credentials.expires_at, new Date(futureExp * 1000).toISOString());
  assert.ok(account.credentials.expires_in > 0);
  assert.equal(account.credentials.id_token.split(".").length, 3);
  assert.equal(account.extra.id_token_synthetic, undefined);
}

function testCpaOutputMatchesCodexTokenStorageCore() {
  const { elements, formatButtons } = loadPageScript();
  const cpaButton = formatButtons.find((button) => button.dataset.format === "cpa");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(cpaButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: jwtWithPayload({
      exp: 1780473960,
      email: "mark@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "00000000-0000-4000-9000-000000000000",
        chatgpt_user_id: "user-test",
        chatgpt_plan_type: "plus",
      },
    }),
    refreshToken: "real-refresh-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const cpa = JSON.parse(output.value);

  assert.equal(cpa.type, "codex");
  assert.equal(cpa.access_token.split(".").length, 3);
  assert.equal(cpa.refresh_token, "real-refresh-token");
  assert.equal(cpa.account_id, "00000000-0000-4000-9000-000000000000");
  assert.equal(cpa.email, "mark@example.com");
  assert.equal(cpa.expired, new Date(1780473960 * 1000).toISOString());
  assert.match(cpa.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(cpa.id_token.split(".").length, 3);
  assert.equal(cpa.id_token_synthetic, true);
  assert.equal(cpa.chatgpt_user_id, "user-test");
  assert.equal(cpa.plan_type, "plus");
}

function testSyntheticIdTokenHasCodexParseableJwtFormat() {
  const { elements, formatButtons } = loadPageScript();
  const cpaButton = formatButtons.find((button) => button.dataset.format === "cpa");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(cpaButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const cpa = JSON.parse(output.value);
  const parts = cpa.id_token.split(".");

  assert.equal(cpa.id_token_synthetic, true);
  assert.equal(parts.length, 3);
  assert.ok(
    parts.every((part) => part.length > 0),
    "synthetic id_token must use non-empty header, payload, and signature segments"
  );

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.equal(payload.email, "mark@example.com");
  assert.equal(payload["https://api.openai.com/auth"].chatgpt_account_id, "00000000-0000-4000-9000-000000000000");
}

function testAxonHubAuthJsonUsesPlaceholderRefreshTokenWhenMissing() {
  const { elements, formatButtons } = loadPageScript();
  const axonHubButton = formatButtons.find((button) => button.dataset.format === "axonhub");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(axonHubButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.auth_mode, "chatgpt");
  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "__missing_refresh_token__");
  assert.equal(authJson.tokens.id_token.split(".").length, 3);
  assert.equal(authJson.last_refresh, "2026-08-06T13:29:36.155Z");
  assert.equal(authJson.axonhub_refresh_token_placeholder, true);
  assert.equal(authJson.axonhub_note, "refresh_token is a placeholder; access_token works only until it expires.");
}

function testAxonHubAuthJsonPreservesRealRefreshToken() {
  const { elements, formatButtons } = loadPageScript();
  const axonHubButton = formatButtons.find((button) => button.dataset.format === "axonhub");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(axonHubButton, "click");
  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    refreshToken: "real-refresh-token",
    idToken: "real.header.signature",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.tokens.refresh_token, "real-refresh-token");
  assert.equal(authJson.tokens.id_token, "real.header.signature");
  assert.equal(authJson.axonhub_refresh_token_placeholder, undefined);
  assert.equal(authJson.axonhub_note, undefined);
}

function testCodexAuthJsonMatchesNativeShapeWhenMissingRefreshToken() {
  const { elements, formatButtons } = loadPageScript();
  const codexButton = formatButtons.find((button) => button.dataset.format === "codex");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.auth_mode, "chatgpt");
  assert.equal(authJson.OPENAI_API_KEY, null);
  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "");
  assert.equal(authJson.tokens.id_token.split(".").length, 3);
  assert.equal(authJson.tokens.account_id, "00000000-0000-4000-9000-000000000000");
  assert.match(authJson.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
}

function testCodexAuthJsonPreservesRealRefreshTokenAndIdToken() {
  const { elements, formatButtons } = loadPageScript();
  const codexButton = formatButtons.find((button) => button.dataset.format === "codex");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexButton, "click");
  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    accessToken: "access-token",
    refreshToken: "real-refresh-token",
    idToken: "real.header.signature",
    tokens: {
      account_id: "chatgpt-account-1",
    },
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.auth_mode, "chatgpt");
  assert.equal(authJson.OPENAI_API_KEY, null);
  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "real-refresh-token");
  assert.equal(authJson.tokens.id_token, "real.header.signature");
  assert.equal(authJson.tokens.account_id, "chatgpt-account-1");
}

function testCodexManagerAuthJsonUsesEmptyRefreshTokenWhenMissing() {
  const { elements, formatButtons } = loadPageScript();
  const codexManagerButton = formatButtons.find((button) => button.dataset.format === "codexmanager");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexManagerButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "");
  assert.equal(authJson.tokens.id_token, "");
  assert.equal(authJson.tokens.account_id, "00000000-0000-4000-9000-000000000000");
  assert.equal(authJson.meta.label, "mark@example.com");
  assert.equal(authJson.meta.note, "Imported from ChatGPT session");
}

function testCodexManagerAuthJsonPreservesRealRefreshAndMetadata() {
  const { elements, formatButtons } = loadPageScript();
  const codexManagerButton = formatButtons.find((button) => button.dataset.format === "codexmanager");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexManagerButton, "click");
  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    accessToken: "access-token",
    refreshToken: "real-refresh-token",
    idToken: "real.header.signature",
    workspaceId: "workspace-1",
    chatgptAccountId: "chatgpt-account-1",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.tokens.refresh_token, "real-refresh-token");
  assert.equal(authJson.tokens.id_token, "real.header.signature");
  assert.equal(authJson.tokens.chatgpt_account_id, "chatgpt-account-1");
  assert.equal(authJson.meta.workspace_id, "workspace-1");
  assert.equal(authJson.meta.chatgpt_account_id, "chatgpt-account-1");
}

async function testLiveCheckOnlyRemovesConfirmedUnauthorizedAccounts() {
  const invalidToken = jwtWithPayload({ exp: 4102444800, email: "invalid@example.com" });
  const validToken = jwtWithPayload({ exp: 4102444800, email: "valid@example.com" });
  const calls = [];
  const { elements } = loadPageScript({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { status: options.headers.Authorization === `Bearer ${invalidToken}` ? 401 : 200 };
    },
  });
  const input = elements.get("#session-input");
  const output = elements.get("#output");
  const liveCheck = elements.get("#live-check-button");
  const removeDead = elements.get("#remove-dead-button");

  input.value = JSON.stringify([
    { user: { email: "invalid@example.com" }, accessToken: invalidToken },
    { user: { email: "valid@example.com" }, accessToken: validToken },
  ]);
  dispatch(input, "input");
  await dispatchAsync(liveCheck, "click");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/tools/session-health");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(removeDead.disabled, false);
  assert.match(elements.get("#live-check-body").innerHTML, /HTTP 401 身份凭证无效/);
  assert.match(elements.get("#live-check-body").innerHTML, /HTTP 200 可用/);

  dispatch(removeDead, "click");
  const cleaned = JSON.parse(output.value);
  const serialized = JSON.stringify(cleaned);
  assert.doesNotMatch(serialized, /invalid@example\.com/);
  assert.match(serialized, /valid@example\.com/);
}

async function testLiveCheckKeepsRateLimitedAccounts() {
  let calls = 0;
  const immediateRetryTimer = (callback, delay) => {
    if (delay < 10_000) queueMicrotask(callback);
    return 1;
  };
  const { elements } = loadPageScript({
    fetch: async () => {
      calls += 1;
      return { status: 429 };
    },
    setTimeout: immediateRetryTimer,
  });
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = JSON.stringify({
    user: { email: "limited@example.com" },
    accessToken: jwtWithPayload({ exp: 4102444800 }),
  });
  dispatch(input, "input");
  await dispatchAsync(elements.get("#live-check-button"), "click");

  assert.equal(calls, 3);
  assert.equal(elements.get("#remove-dead-button").disabled, true);
  assert.match(elements.get("#live-check-body").innerHTML, /HTTP 429 限流/);
  assert.equal(elements.get("#live-check-status").classList.contains("is-warning"), true);
  assert.match(output.value, /limited@example\.com/);
}

async function testUnavailableSelectedModelDoesNotRemoveFreeAccount() {
  const calls = [];
  const { elements } = loadPageScript({
    tauri: {
      core: {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "probe_chatgpt_workspace") {
            return {
              status: 200,
              available: null,
              stage: "models",
              code: "requested_model_unavailable",
              model: "sol",
              availableModels: ["gpt-free-model"],
            };
          }
          throw new Error(`unexpected command: ${command}`);
        },
      },
    },
  });
  const input = elements.get("#session-input");
  elements.get("#live-check-model").value = "sol";
  input.value = JSON.stringify({
    user: { email: "free@example.com" },
    accessToken: jwtWithPayload({ exp: 4102444800 }),
  });
  dispatch(input, "input");
  await dispatchAsync(elements.get("#live-check-button"), "click");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.requestedModel, "sol");
  assert.match(elements.get("#live-check-body").innerHTML, /账号未提供模型 sol/);
  assert.equal(elements.get("#remove-dead-button").disabled, true);
  assert.match(elements.get("#output").value, /free@example\.com/);
}

async function testLiveCheckRejectsWorkspaceDeniedAccounts() {
  const calls = [];
  const { elements } = loadPageScript({
    fetch: async (_url, options) => {
      calls.push(options);
      const status = options.headers["ChatGPT-Account-Id"] === "workspace-402" ? 402 : 403;
      return {
        status,
        async json() {
          return {
            probe: {
              status,
              code: status === 402 ? "deactivated_workspace" : "forbidden",
              model: "gpt-5.4",
            },
          };
        },
      };
    },
  });
  const input = elements.get("#session-input");
  const output = elements.get("#output");
  const removeDead = elements.get("#remove-dead-button");

  input.value = JSON.stringify([
    {
      user: { email: "removed@example.com" },
      account_id: "workspace-402",
      accessToken: jwtWithPayload({ exp: 4102444800 }),
    },
    {
      user: { email: "forbidden@example.com" },
      account_id: "workspace-403",
      accessToken: jwtWithPayload({ exp: 4102444800 }),
    },
  ]);
  dispatch(input, "input");
  await dispatchAsync(elements.get("#live-check-button"), "click");

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((options) => options.headers["ChatGPT-Account-Id"]), ["workspace-402", "workspace-403"]);
  assert.equal(removeDead.disabled, false);
  assert.match(elements.get("#live-check-body").innerHTML, /HTTP 402 工作区已停用/);
  assert.match(elements.get("#live-check-body").innerHTML, /HTTP 403 无权访问团队空间/);
  assert.match(elements.get("#live-check-status").textContent, /不可用 2 个/);
  assert.equal(elements.get("#live-check-status").classList.contains("is-error"), true);

  dispatch(removeDead, "click");
  assert.doesNotMatch(output.value, /removed@example\.com/);
  assert.doesNotMatch(output.value, /forbidden@example\.com/);
}

async function testExpiredJwtIsClassifiedLocallyWithoutNetworkRequest() {
  let calls = 0;
  const { elements } = loadPageScript({
    fetch: async () => {
      calls += 1;
      return { status: 200 };
    },
  });
  const input = elements.get("#session-input");
  input.value = JSON.stringify({
    user: { email: "expired@example.com" },
    accessToken: jwtWithPayload({ exp: 1 }),
  });
  dispatch(input, "input");
  await dispatchAsync(elements.get("#live-check-button"), "click");

  assert.equal(calls, 0);
  assert.equal(elements.get("#remove-dead-button").disabled, false);
  assert.match(elements.get("#live-check-body").innerHTML, /JWT 已过期/);
}

function testCpaToSub2apiBridgeSupportsMultiProvider() {
  const { elements, modeButtons } = loadPageScript();
  const modeButton = modeButtons.find((button) => button.dataset.mode === "cpa-to-sub");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(modeButton, "click");
  input.value = JSON.stringify([
    {
      type: "codex",
      email: "alpha@example.com",
      access_token: "at",
      refresh_token: "rt",
      id_token: "idt",
      account_id: "chatgpt-account-id",
      expired: "2099-01-01T00:00:00Z",
    },
    {
      type: "claude",
      email: "beta@example.com",
      access_token: "at2",
      refresh_token: "rt2",
      expired: "2099-01-01T00:00:00Z",
    },
    {
      type: "xai",
      email: "grok@example.com",
      access_token: "xat",
      refresh_token: "xrt",
      expired: "2099-01-01T00:00:00Z",
    },
    {
      type: "antigravity",
      email: "ag@example.com",
      project_id: "agproj",
      access_token: "agat",
      refresh_token: "agrt",
      expired: "2099-01-01T00:00:00Z",
    },
  ]);
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  assert.equal(document.type, "sub2api-data");
  assert.equal(document.version, 1);
  assert.equal(document.accounts.length, 4);
  assert.deepEqual(document.accounts.map((item) => item.platform), ["openai", "anthropic", "grok", "antigravity"]);
  assert.equal(document.accounts[0].credentials.chatgpt_account_id, "chatgpt-account-id");
  assert.equal(document.accounts[2].concurrency, 1);
  assert.equal(document.accounts[2].credentials.client_id, "b1a00492-073a-47ea-816f-4c329264a828");
  assert.equal(document.accounts[3].credentials.project_id, "agproj");
}

function testSub2apiToCpaBridgeOffersMergedJsonAndSplitZip() {
  const { elements, modeButtons, context } = loadPageScript();
  const modeButton = modeButtons.find((button) => button.dataset.mode === "sub-to-cpa");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(modeButton, "click");
  input.value = JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: "2026-07-14T00:00:00Z",
    proxies: [],
    accounts: [
      {
        name: "alpha@example.com",
        platform: "openai",
        type: "oauth",
        credentials: {
          access_token: "at",
          refresh_token: "rt",
          email: "alpha@example.com",
          chatgpt_account_id: "acc-1",
          expires_at: "2099-01-01T00:00:00Z",
        },
      },
      {
        name: "beta@example.com",
        platform: "anthropic",
        type: "oauth",
        credentials: {
          access_token: "at2",
          refresh_token: "rt2",
          email: "beta@example.com",
          expires_at: "2099-01-01T00:00:00Z",
        },
      },
    ],
  });
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  assert.equal(document.type, "cliproxyapi-auth-list");
  assert.equal(document.version, 1);
  assert.equal(document.auths.length, 2);
  assert.equal(document.auths[0].type, "codex");
  assert.equal(document.auths[0].account_id, "acc-1");
  assert.equal(document.auths[1].type, "claude");
  assert.match(document.note, /合并 JSON/);
  assert.equal(elements.get("#download-output").textContent, "下载 JSON");
  assert.equal(elements.get("#download-split").hidden, false);
  assert.equal(elements.get("#download-split").disabled, false);
  assert.match(elements.get("#download-split").textContent, /拆分 ZIP（2）/);
  assert.match(elements.get("#output-subtitle").textContent, /合并 JSON/);

  const zip = context.SessionConverterBridge.buildZipFromCpaFiles([
    { name: "codex-alpha.json", data: document.auths[0] },
    { name: "claude-beta.json", data: document.auths[1] },
  ]);
  assert.ok(zip instanceof Uint8Array);
  assert.ok(zip.length > 64);
  // Local file header signature PK\x03\x04
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
}

function testDetectInputModeForBridgeFormats() {
  const { context } = loadPageScript();
  const { detectInputMode } = context.SessionConverterBridge;

  assert.equal(detectInputMode(JSON.stringify({
    type: "codex",
    email: "a@example.com",
    access_token: "at",
    account_id: "acc",
  })), "cpa-to-sub");

  assert.equal(detectInputMode(JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: "2026-07-14T00:00:00Z",
    proxies: [],
    accounts: [{
      name: "a@example.com",
      platform: "openai",
      type: "oauth",
      credentials: { access_token: "at", email: "a@example.com" },
    }],
  })), "sub-to-cpa");

  assert.equal(detectInputMode(JSON.stringify({
    user: { email: "s@example.com" },
    accessToken: "session-token-value",
    account: { id: "acc" },
  })), "session");
}

function testAutoDetectSwitchesModeOnPaste() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");
  const auto = elements.get("#auto-detect-mode");
  auto.checked = true;
  auto.listeners.change?.({ target: auto });

  input.value = JSON.stringify({
    type: "claude",
    email: "beta@example.com",
    access_token: "at2",
    refresh_token: "rt2",
    expired: "2099-01-01T00:00:00Z",
  });
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  assert.equal(document.type, "sub2api-data");
  assert.equal(document.accounts[0].platform, "anthropic");
  assert.match(elements.get("#input-status").textContent, /自动识别/);
}

function testSub2apiSplitZipBuildsMultipleFiles() {
  const { elements, modeButtons, context } = loadPageScript();
  const modeButton = modeButtons.find((button) => button.dataset.mode === "cpa-to-sub");
  const input = elements.get("#session-input");
  const splitButton = elements.get("#download-split");

  // Pin mode so auto-detect does not fight the click.
  const auto = elements.get("#auto-detect-mode");
  auto.checked = false;
  auto.listeners.change?.({ target: auto });
  dispatch(modeButton, "click");

  input.value = JSON.stringify([
    {
      type: "codex",
      email: "one@example.com",
      access_token: "at1",
      account_id: "acc-1",
      expired: "2099-01-01T00:00:00Z",
    },
    {
      type: "codex",
      email: "two@example.com",
      access_token: "at2",
      account_id: "acc-2",
      expired: "2099-01-01T00:00:00Z",
    },
  ]);
  dispatch(input, "input");

  assert.equal(splitButton.hidden, false);
  assert.equal(splitButton.disabled, false);
  assert.match(splitButton.textContent, /拆分 ZIP（2）/);

  // Access internal state via rebuild: bridge files should zip cleanly.
  const zip = context.SessionConverterBridge.buildZipFromSub2apiFiles([
    { name: "a.json", data: { type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: "a" }] } },
    { name: "b.json", data: { type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: "b" }] } },
  ]);
  assert.ok(zip instanceof Uint8Array);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
}

function testSourcePinsMatchHeaderBadges() {
  const { context } = loadPageScript();
  const pins = context.SessionConverterBridge.SOURCE_PINS;
  assert.equal(pins.length, 2);
  assert.equal(pins[0].label, "CLIProxyAPI");
  assert.equal(pins[0].branch, "main");
  assert.equal(pins[0].shortSha, "2e6b1d83");
  assert.equal(pins[0].date, "2026-08-08");
  assert.match(pins[0].commitUrl, /2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/);
  assert.equal(pins[1].label, "sub2api");
  assert.equal(pins[1].shortSha, "cc67b1ac");
  assert.equal(pins[1].date, "2026-08-08");
  assert.equal(
    context.SessionConverterBridge.formatSourcePinLabel(pins[0]),
    "CLIProxyAPI · 2e6b1d83",
  );
  assert.equal(
    context.SessionConverterBridge.formatSourcePinLabel(pins[1]),
    "sub2api · cc67b1ac",
  );
}

function testBridgeRoundTripCodexAccount() {
  const { elements, modeButtons } = loadPageScript();
  const toSub = modeButtons.find((button) => button.dataset.mode === "cpa-to-sub");
  const toCpa = modeButtons.find((button) => button.dataset.mode === "sub-to-cpa");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(toSub, "click");
  input.value = JSON.stringify({
    type: "codex",
    email: "round@example.com",
    access_token: "access-round",
    refresh_token: "refresh-round",
    id_token: "id-round",
    account_id: "acc-round",
    expired: "2099-06-01T00:00:00Z",
  });
  dispatch(input, "input");
  const subDoc = JSON.parse(output.value);

  dispatch(toCpa, "click");
  input.value = JSON.stringify(subDoc);
  dispatch(input, "input");
  const cpaDoc = JSON.parse(output.value);
  const auth = cpaDoc.type === "cliproxyapi-auth-list" ? cpaDoc.auths[0] : cpaDoc;

  assert.equal(auth.type, "codex");
  assert.equal(auth.access_token, "access-round");
  assert.equal(auth.refresh_token, "refresh-round");
  assert.equal(auth.account_id, "acc-round");
  assert.equal(auth.email, "round@example.com");
}

// A real PKCS#8 Ed25519 key, so the structural DER check is exercised against
// what Go's x509.ParsePKCS8PrivateKey would accept.
function ed25519PrivateKeyBase64() {
  return crypto
    .generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "der" })
    .toString("base64");
}

function agentIdentityFields(overrides = {}) {
  return {
    agent_runtime_id: "runtime-1",
    agent_private_key: ed25519PrivateKeyBase64(),
    task_id: "task-1",
    account_id: "chatgpt-account-1",
    chatgpt_user_id: "user-1",
    email: "agent@example.com",
    plan_type: "plus",
    chatgpt_account_is_fedramp: true,
    ...overrides,
  };
}

function testAgentIdentityNestedObjectMatchesUpstreamImport() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");
  const fields = agentIdentityFields();

  input.value = JSON.stringify({ user: { email: "agent@example.com" }, agent_identity: fields });
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  const account = document.accounts[0];

  assert.equal(document.accounts.length, 1);
  assert.equal(account.platform, "openai");
  assert.equal(account.type, "oauth");
  assert.equal(account.concurrency, 10);
  assert.equal(account.priority, 1);
  assert.equal(account.rate_multiplier, 1);
  // resolveCodexImportExpiry returns nil for agent identity: neither field is written.
  assert.equal(account.auto_pause_on_expired, undefined);
  assert.equal(account.credentials.expires_at, undefined);
  assert.equal(account.credentials.auth_mode, "agentIdentity");
  assert.equal(account.credentials.agent_runtime_id, "runtime-1");
  assert.equal(account.credentials.agent_private_key, fields.agent_private_key);
  assert.equal(account.credentials.task_id, "task-1");
  assert.equal(account.credentials.chatgpt_account_id, "chatgpt-account-1");
  assert.equal(account.credentials.chatgpt_user_id, "user-1");
  assert.equal(account.credentials.chatgpt_account_is_fedramp, true);
  assert.equal(account.credentials.email, "agent@example.com");
  assert.equal(account.credentials.plan_type, "plus");
  assert.equal(account.credentials.access_token, undefined);
  assert.equal(account.extra.source, "agent_identity");
  assert.equal(account.extra.identity_key, "account:chatgpt-account-1");
  assert.equal(elements.get("#stat-errors").textContent, "0");
}

function testAgentIdentityFlatCamelCaseKeepsFalseFedrampAndWarnsOnMissingTask() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");
  const privateKey = ed25519PrivateKeyBase64();

  input.value = JSON.stringify({
    authMode: "AgentIdentity",
    agentRuntimeId: "runtime-2",
    agentPrivateKey: privateKey,
    accountId: "chatgpt-account-2",
    chatgptUserId: "user-2",
    chatgptAccountIsFedramp: "false",
  });
  dispatch(input, "input");

  const account = JSON.parse(output.value).accounts[0];

  assert.equal(account.credentials.agent_runtime_id, "runtime-2");
  assert.equal(account.credentials.agent_private_key, privateKey);
  assert.equal(account.credentials.chatgpt_account_id, "chatgpt-account-2");
  assert.equal(account.credentials.chatgpt_user_id, "user-2");
  // false must survive: upstream always writes the fedramp flag.
  assert.equal(account.credentials.chatgpt_account_is_fedramp, false);
  assert.equal(account.credentials.task_id, undefined);
  assert.match(elements.get("#issues").innerHTML, /未包含 task_id/);
  assert.match(elements.get("#issues").innerHTML, /issue-warning/);
}

function testAgentIdentityRejectsIncompleteRecords() {
  const cases = [
    ["agent_runtime_id", /缺少必要字段/],
    ["agent_private_key", /缺少必要字段/],
    ["account_id", /缺少必要字段/],
    ["chatgpt_user_id", /缺少必要字段/],
  ];

  for (const [missing, expected] of cases) {
    const { elements } = loadPageScript();
    const input = elements.get("#session-input");
    const fields = agentIdentityFields();
    delete fields[missing];

    input.value = JSON.stringify({ agent_identity: fields });
    dispatch(input, "input");

    assert.equal(elements.get("#output").value, "", `expected no output when ${missing} is missing`);
    assert.match(elements.get("#issues").innerHTML, expected, `missing ${missing}`);
  }

  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  input.value = JSON.stringify({
    agent_identity: agentIdentityFields({ agent_private_key: Buffer.from("not-a-key").toString("base64") }),
  });
  dispatch(input, "input");

  assert.equal(elements.get("#output").value, "");
  assert.match(elements.get("#issues").innerHTML, /private key 格式无效/);
}

function testAgentIdentityIsDroppedFromCodexTokenStorageFormats() {
  for (const format of ["cpa", "cockpit", "9router", "codex", "axonhub", "codexmanager"]) {
    const { elements, formatButtons } = loadPageScript();
    const input = elements.get("#session-input");

    dispatch(formatButtons.find((button) => button.dataset.format === format), "click");
    input.value = JSON.stringify({ agent_identity: agentIdentityFields() });
    dispatch(input, "input");

    assert.equal(elements.get("#output").value, "", `${format} must not emit a partial auth file`);
    assert.equal(elements.get("#copy-output").disabled, true);
    assert.match(elements.get("#output-subtitle").textContent, /已跳过 1 个 Agent Identity 账号/);
  }
}

async function testAgentIdentityNeverReachesTheProbeRelay() {
  let calls = 0;
  const { elements } = loadPageScript({
    fetch: async () => {
      calls += 1;
      return { status: 200 };
    },
  });
  const input = elements.get("#session-input");

  input.value = JSON.stringify({ agent_identity: agentIdentityFields() });
  dispatch(input, "input");
  await dispatchAsync(elements.get("#live-check-button"), "click");

  // The Ed25519 private key must never leave the browser.
  assert.equal(calls, 0);
  assert.doesNotMatch(elements.get("#live-check-body").innerHTML, /agent-private/i);
}

function testSub2apiAgentIdentityAccountCannotConvertToCpa() {
  const { elements, modeButtons, context } = loadPageScript();
  const input = elements.get("#session-input");
  const account = {
    name: "agent@example.com",
    platform: "openai",
    type: "oauth",
    credentials: {
      auth_mode: "agentIdentity",
      agent_runtime_id: "runtime-1",
      agent_private_key: ed25519PrivateKeyBase64(),
      chatgpt_account_id: "chatgpt-account-1",
      chatgpt_user_id: "user-1",
    },
  };

  assert.equal(context.SessionConverterBridge.looksLikeSub2apiAccount(account), true);

  dispatch(modeButtons.find((button) => button.dataset.mode === "sub-to-cpa"), "click");
  input.value = JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [account] });
  dispatch(input, "input");

  assert.equal(elements.get("#output").value, "");
  assert.match(elements.get("#issues").innerHTML, /Agent Identity 凭据无法转换为 CPA/);
}

function settleTicks(count = 2) {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left -= 1;
      if (left <= 0) resolve();
      else setImmediate(tick);
    };
    setImmediate(tick);
  });
}

function enableAutoDetect(elements) {
  const auto = elements.get("#auto-detect-mode");
  auto.checked = true;
  auto.listeners.change?.({ target: auto });
  return auto;
}

async function importFiles(files) {
  const page = loadPageScript();
  enableAutoDetect(page.elements);
  const fileInput = page.elements.get("#file-input");
  fileInput.files = files;
  fileInput.listeners.change({ target: fileInput });
  await settleTicks();
  return page;
}

// Mixed-format batches must be recognized per file and converted in one pass
// instead of forcing every file through a single detected mode.
async function testAutoDetectMixedFilesConvertsEachFormat() {
  const { elements, modeButtons } = await importFiles([
    {
      name: "session.json",
      async text() {
        return JSON.stringify({
          user: { email: "sess@example.com" },
          account: { id: "acc-s", planType: "plus" },
          accessToken: "session-at",
          sessionToken: "st",
        });
      },
    },
    {
      name: "cpa.json",
      async text() {
        return JSON.stringify({ type: "codex", email: "cpa@example.com", access_token: "at1", account_id: "acc-1" });
      },
    },
    {
      name: "sub.json",
      async text() {
        return JSON.stringify({
          type: "sub2api-data",
          version: 1,
          proxies: [],
          accounts: [{
            name: "sub@example.com",
            platform: "anthropic",
            type: "oauth",
            credentials: { access_token: "at2", email: "sub@example.com" },
          }],
        });
      },
    },
  ]);

  assert.match(elements.get("#input-status").textContent, /已自动识别 3 种输入格式/);
  assert.equal(elements.get("#stat-count").textContent, "3");
  assert.equal(elements.get("#stat-errors").textContent, "0");
  assert.equal(elements.get("#session-input").value.includes("sess@example.com"), true);

  // 1/1/1 tie: sub-to-cpa wins. The merged CPA list only contains converted
  // content: the CPA file has no counterpart in this direction, so it is
  // reported instead of leaking the raw source file into the output.
  assert.equal(
    modeButtons.find((button) => button.dataset.mode === "sub-to-cpa").attributes["aria-pressed"],
    "true",
  );
  const document = JSON.parse(elements.get("#output").value);
  assert.equal(document.type, "cliproxyapi-auth-list");
  assert.deepEqual(
    document.auths.map((auth) => auth.email),
    ["sess@example.com", "sub@example.com"],
  );
  assert.match(elements.get("#output-subtitle").textContent, /另有 1 个账号无对应输出字段/);
}

// Regression: after importing bridge-format files the input box holds joined
// raw payloads; manually clicking "Session → 多格式" used to throw
// JSON 解析失败 and wipe the correctly recognized accounts.
async function testManualModeSwitchAfterBridgeImportKeepsResults() {
  const { elements, modeButtons, formatButtons } = loadPageScript();
  enableAutoDetect(elements);
  const fileInput = elements.get("#file-input");
  fileInput.files = [
    {
      name: "one.json",
      async text() {
        return JSON.stringify({ type: "codex", email: "one@example.com", access_token: "at1", account_id: "acc-1" });
      },
    },
    {
      name: "two.json",
      async text() {
        return JSON.stringify({ type: "codex", email: "two@example.com", access_token: "at2", account_id: "acc-2" });
      },
    },
  ];
  fileInput.listeners.change({ target: fileInput });
  await settleTicks();

  assert.equal(elements.get("#stat-count").textContent, "2");
  assert.match(elements.get("#input-status").textContent, /已自动识别为「CPA → sub2api」/);

  dispatch(modeButtons.find((button) => button.dataset.mode === "session"), "click");

  assert.doesNotMatch(elements.get("#input-status").textContent, /JSON 解析失败/);
  assert.equal(elements.get("#stat-count").textContent, "2");
  assert.match(elements.get("#input-status").textContent, /解析完成：2 个账号/);

  dispatch(formatButtons.find((button) => button.dataset.format === "cpa"), "click");
  const cpaDoc = JSON.parse(elements.get("#output").value);
  assert.equal(Array.isArray(cpaDoc), true);
  assert.equal(cpaDoc.length, 2);
  assert.equal(cpaDoc[0].email, "one@example.com");
  assert.equal(cpaDoc[0].access_token, "at1");
}

// Session mode must accept JSON lines / concatenated payloads so re-parsing
// the input box after an import never fails.
function testSessionModeParsesJsonLinesWithoutThrowing() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = [
    JSON.stringify({ user: { email: "a@example.com" }, accessToken: "at-a" }),
    JSON.stringify({ user: { email: "b@example.com" }, accessToken: "at-b" }),
  ].join("\n");
  dispatch(input, "input");

  assert.equal(elements.get("#stat-count").textContent, "2");
  assert.equal(elements.get("#stat-errors").textContent, "0");
  const document = JSON.parse(output.value);
  assert.equal(document.accounts.length, 2);
  assert.equal(document.accounts[0].credentials.access_token, "at-a");
}

// Mixed-format pastes are also detected per entry and converted together.
function testAutoDetectMixedPasteConvertsEachFormat() {
  const { elements, modeButtons } = loadPageScript();
  enableAutoDetect(elements);
  const input = elements.get("#session-input");

  input.value = [
    JSON.stringify({ type: "codex", email: "cpa@example.com", access_token: "at1", account_id: "acc-1" }),
    JSON.stringify({ user: { email: "sess@example.com" }, accessToken: "session-at" }),
  ].join("\n");
  dispatch(input, "input");

  assert.equal(elements.get("#stat-count").textContent, "2");
  assert.equal(elements.get("#stat-errors").textContent, "0");
  assert.match(elements.get("#input-status").textContent, /已自动识别 2 种输入格式/);
  assert.equal(
    modeButtons.find((button) => button.dataset.mode === "cpa-to-sub").attributes["aria-pressed"],
    "true",
  );
  const document = JSON.parse(elements.get("#output").value);
  assert.equal(document.type, "sub2api-data");
  assert.deepEqual(
    document.accounts.map((account) => account.credentials.email),
    ["cpa@example.com", "sess@example.com"],
  );
}

// "下载 JSON" must never contain pre-conversion content: neither right after
// a mixed import, nor after manually switching mode/format.
async function testDownloadsContainConvertedContentOnly() {
  const saved = [];
  const { elements, modeButtons, formatButtons } = loadPageScript({
    tauri: {
      core: {
        async invoke(command, args) {
          if (command === "save_output_file") {
            saved.push({ name: args.suggestedName, text: Buffer.from(args.bytes).toString("utf8") });
            return "C:\\fake\\" + args.suggestedName;
          }
          return null;
        },
      },
    },
  });
  enableAutoDetect(elements);
  const fileInput = elements.get("#file-input");
  fileInput.files = [
    {
      name: "cpa.json",
      async text() {
        return JSON.stringify({ type: "codex", email: "cpa@example.com", access_token: "raw-cpa-token", account_id: "acc-1" });
      },
    },
    {
      name: "sub.json",
      async text() {
        return JSON.stringify({
          type: "sub2api-data",
          version: 1,
          proxies: [],
          accounts: [{
            name: "sub@example.com",
            platform: "anthropic",
            type: "oauth",
            credentials: { access_token: "sub-token", email: "sub@example.com" },
          }],
        });
      },
    },
  ];
  fileInput.listeners.change({ target: fileInput });
  await settleTicks();

  // sub-to-cpa wins the tie; single cpaFile download = the converted auth.
  elements.get("#download-output").listeners.click({ target: elements.get("#download-output") });
  await settleTicks();

  assert.equal(saved.length, 1);
  const convertedAuth = JSON.parse(saved[0].text);
  assert.equal(convertedAuth.type, "claude");
  assert.equal(convertedAuth.access_token, "sub-token");
  assert.doesNotMatch(saved[0].text, /raw-cpa-token/);
  assert.match(elements.get("#output-subtitle").textContent, /另有 1 个账号无对应输出字段/);

  // Manual switch to "Session → 多格式" then CPA: the download is the
  // session-pipeline conversion (has last_refresh/id_token), not the raw file.
  dispatch(modeButtons.find((button) => button.dataset.mode === "session"), "click");
  dispatch(formatButtons.find((button) => button.dataset.format === "cpa"), "click");
  elements.get("#download-output").listeners.click({ target: elements.get("#download-output") });
  await settleTicks();

  assert.equal(saved.length, 2);
  const cpaDocs = JSON.parse(saved[1].text);
  assert.equal(Array.isArray(cpaDocs), true);
  assert.equal(cpaDocs.length, 2);
  assert.equal(cpaDocs[0].access_token, "raw-cpa-token");
  assert.equal(typeof cpaDocs[0].last_refresh, "string");
  assert.equal(typeof cpaDocs[0].id_token, "string");
}

async function main() {
  await testDesktopExternalLinksUseRustAllowlistedCommand();
  await testDroppedJsonConvertsImmediately();
  await testDesktopUpstreamCheckReportsAuditedPins();
  await testSignedAppUpdateRequiresConfirmationThenInstalls();
  testSub2apiAccountUsesAccessTokenExpiry();
  testCurrentChatGptSessionWorksWithoutSessionToken();
  testSub2apiAccountsUseTheirOwnAccessTokenExpiry();
  testSub2apiAccountWithRefreshTokenKeepsTokenExpiryAndClientId();
  testCpaOutputMatchesCodexTokenStorageCore();
  testSyntheticIdTokenHasCodexParseableJwtFormat();
  testAxonHubAuthJsonUsesPlaceholderRefreshTokenWhenMissing();
  testAxonHubAuthJsonPreservesRealRefreshToken();
  testCodexAuthJsonMatchesNativeShapeWhenMissingRefreshToken();
  testCodexAuthJsonPreservesRealRefreshTokenAndIdToken();
  testCodexManagerAuthJsonUsesEmptyRefreshTokenWhenMissing();
  testCodexManagerAuthJsonPreservesRealRefreshAndMetadata();
  testCpaToSub2apiBridgeSupportsMultiProvider();
  testSub2apiToCpaBridgeOffersMergedJsonAndSplitZip();
  testDetectInputModeForBridgeFormats();
  testAutoDetectSwitchesModeOnPaste();
  testSub2apiSplitZipBuildsMultipleFiles();
  testSourcePinsMatchHeaderBadges();
  testBridgeRoundTripCodexAccount();
  testAgentIdentityNestedObjectMatchesUpstreamImport();
  testAgentIdentityFlatCamelCaseKeepsFalseFedrampAndWarnsOnMissingTask();
  testAgentIdentityRejectsIncompleteRecords();
  testAgentIdentityIsDroppedFromCodexTokenStorageFormats();
  testSub2apiAgentIdentityAccountCannotConvertToCpa();
  testSessionModeParsesJsonLinesWithoutThrowing();
  testAutoDetectMixedPasteConvertsEachFormat();
  await testAutoDetectMixedFilesConvertsEachFormat();
  await testManualModeSwitchAfterBridgeImportKeepsResults();
  await testDownloadsContainConvertedContentOnly();
  await testAgentIdentityNeverReachesTheProbeRelay();
  await testLiveCheckOnlyRemovesConfirmedUnauthorizedAccounts();
  await testLiveCheckKeepsRateLimitedAccounts();
  await testUnavailableSelectedModelDoesNotRemoveFreeAccount();
  await testLiveCheckRejectsWorkspaceDeniedAccounts();
  await testExpiredJwtIsClassifiedLocallyWithoutNetworkRequest();
  console.log("convert-session tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
