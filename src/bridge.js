/* Session Converter CPA ↔ sub2api bridge algorithms.
 * Browser-local only; no network.
 * Upstream audit metadata is generated from config/upstream-audit.json.
 */
(() => {
  // BEGIN GENERATED UPSTREAM PINS — scripts/check-upstreams.mjs owns this block.
  const SOURCE_PINS = Object.freeze([
    Object.freeze({
      id: "cliproxyapi",
      label: "CLIProxyAPI",
      branch: "main",
      shortSha: "85d2fadd",
      fullSha: "85d2faddd17e6f4f8675a84ee28b131f702e8eaa",
      date: "2026-08-19",
      repoUrl: "https://github.com/router-for-me/CLIProxyAPI",
      commitUrl: "https://github.com/router-for-me/CLIProxyAPI/commit/85d2faddd17e6f4f8675a84ee28b131f702e8eaa",
    }),
    Object.freeze({
      id: "sub2api",
      label: "sub2api",
      branch: "main",
      shortSha: "1b5dc676",
      fullSha: "1b5dc676a9d35532ac2d88dbbe0ee2638b2ab05f",
      date: "2026-08-20",
      repoUrl: "https://github.com/Wei-Shaw/sub2api",
      commitUrl: "https://github.com/Wei-Shaw/sub2api/commit/1b5dc676a9d35532ac2d88dbbe0ee2638b2ab05f",
    }),
  ]);
  // END GENERATED UPSTREAM PINS

  function formatSourcePinLabel(pin) {
    return `${pin.label} · ${pin.shortSha}`;
  }

  function renderSourcePins(root) {
    let target = root || null;
    if (!target && typeof document !== "undefined" && typeof document.getElementById === "function") {
      target = document.getElementById("source-versions");
    }
    if (!target) return;
    target.innerHTML = SOURCE_PINS.map((pin) => `
      <a
        class="source-version"
        href="${pin.commitUrl}"
        target="_blank"
        rel="noopener noreferrer"
        title="打开 ${pin.label} ${pin.branch} ${pin.fullSha}（${pin.date}）"
        data-source-pin="${pin.id}"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 3v12"></path>
          <circle cx="18" cy="6" r="3"></circle>
          <circle cx="6" cy="18" r="3"></circle>
          <path d="M18 9a9 9 0 0 1-9 9"></path>
        </svg>
        <span>${formatSourcePinLabel(pin)}</span>
      </a>
    `).join("");
  }

  const PROVIDER_TO_PLATFORM = {
    codex: "openai",
    openai: "openai",
    claude: "anthropic",
    anthropic: "anthropic",
    gemini: "gemini",
    "gemini-cli": "gemini",
    antigravity: "antigravity",
    xai: "grok",
  };

  const PLATFORM_TO_PROVIDER = {
    openai: "codex",
    anthropic: "claude",
    antigravity: "antigravity",
    grok: "xai",
  };

  const SUPPORTED_SUB2API_DATA_TYPES = new Set(["sub2api-data", "sub2api-bundle"]);
  const SUPPORTED_SUB2API_DATA_VERSION = 1;
  const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
  const XAI_DEFAULT_SCOPE = "openid profile email offline_access grok-cli:access api:access";
  const XAI_DEFAULT_API_BASE_URL = "https://api.x.ai/v1";
  const XAI_DEFAULT_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
  const XAI_DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
  const DEFAULT_SUB2API_OAUTH_ACCOUNT_FIELDS = Object.freeze({
    priority: 1,
    rate_multiplier: 1,
    auto_pause_on_expired: true,
  });

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function asString(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Number.isInteger(value) ? Math.trunc(value) : value);
    }
    return "";
  }

  function asInt(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return fallback;
  }

  function boolValue(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    if (typeof value === "string") {
      return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
    }
    return false;
  }

  function firstString(obj, keys) {
    if (!obj || typeof obj !== "object") return "";
    for (const key of keys) {
      const value = asString(obj[key]).trim();
      if (value) return value;
    }
    return "";
  }

  function nestedToken(obj) {
    return obj && typeof obj.token === "object" && obj.token !== null ? obj.token : {};
  }

  function stripBOM(text) {
    return String(text || "").replace(/^\uFEFF/, "");
  }

  function sub2APIAccountDefaults(platform) {
    return {
      concurrency: platform === "grok" ? 1 : 10,
      ...DEFAULT_SUB2API_OAUTH_ACCOUNT_FIELDS,
    };
  }

  function extractAccessToken(meta) {
    return firstString(meta, ["access_token", "accessToken"])
      || firstString(nestedToken(meta), ["access_token", "accessToken"]);
  }

  function extractRefreshToken(meta) {
    return firstString(meta, ["refresh_token", "refreshToken"])
      || firstString(nestedToken(meta), ["refresh_token", "refreshToken"]);
  }

  function extractExpiresAt(meta) {
    const direct = firstString(meta, ["expires_at", "expired", "expiry", "expires", "expire"]);
    if (direct) return direct;
    const tokenValue = firstString(nestedToken(meta), ["expires_at", "expired", "expiry", "expires", "expire"]);
    if (tokenValue) return tokenValue;

    const expiresIn = asInt(meta.expires_in, null);
    const timestamp = asInt(meta.timestamp, null);
    if (expiresIn !== null && timestamp !== null) {
      const seconds = timestamp > 1000000000000 ? Math.trunc(timestamp / 1000) : timestamp;
      return new Date((seconds + expiresIn) * 1000).toISOString();
    }
    return "0";
  }

  function providerFromCPA(raw, meta) {
    return firstString(meta, ["type", "provider", "Provider"]).toLowerCase()
      || firstString(raw, ["provider", "Provider", "type"]).toLowerCase();
  }

  function materializeCPARecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const meta = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? { ...raw.metadata }
      : { ...raw };

    for (const key of ["id", "label", "status", "disabled", "priority"]) {
      if (meta[key] === undefined && raw[key] !== undefined) meta[key] = raw[key];
    }
    if (!meta.type) {
      const provider = firstString(raw, ["provider", "Provider"]);
      if (provider) meta.type = provider;
    }
    return meta;
  }

  function addKnownCredential(target, source, key, outKey = key) {
    if (!source || typeof source !== "object" || target[outKey] !== undefined) return;
    const value = source[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) target[outKey] = trimmed;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      target[outKey] = value;
    } else if (typeof value === "boolean") {
      target[outKey] = value;
    }
  }

  function slugifyFilePart(value) {
    const raw = asString(value).trim().toLowerCase();
    const ascii = raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70);
    return ascii || "account";
  }

  function cpaAuthFileName(auth, account, fallback) {
    const provider = slugifyFilePart(auth.type || "auth");
    const identity = slugifyFilePart(auth.email || account.name || fallback || "account");
    return `${provider}-${identity}.json`;
  }

  function sub2apiImportFileName(account, fallback) {
    const platform = slugifyFilePart(account.platform || "platform");
    const identity = slugifyFilePart(account.name || fallback || "account");
    return `sub2api-${platform}-${identity}.json`;
  }

  function uniqueFileName(name, used) {
    const baseName = asString(name).trim() || "auth.json";
    const dot = baseName.toLowerCase().endsWith(".json") ? baseName.length - 5 : baseName.length;
    const base = baseName.slice(0, dot) || "auth";
    const ext = baseName.slice(dot) || ".json";
    let candidate = `${base}${ext}`;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}-${index}${ext}`;
      index += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function convertCPARecord(entry) {
    const issues = [];
    const raw = entry.value;
    const meta = materializeCPARecord(raw);
    if (!meta) return { skipped: true, reason: "记录不是 JSON 对象" };

    const provider = providerFromCPA(raw, meta);
    if (!provider) return { skipped: true, reason: "缺少 type/provider" };

    const platform = PROVIDER_TO_PLATFORM[provider];
    if (!platform) return { skipped: true, reason: `暂不支持 provider: ${provider}` };

    if (boolValue(meta.disabled)) {
      return { skipped: true, reason: "disabled=true 已跳过" };
    }

    const accessToken = extractAccessToken(meta);
    if (!accessToken) return { skipped: true, reason: "缺少 access_token" };

    const refreshToken = extractRefreshToken(meta);
    const expiresAt = extractExpiresAt(meta);
    const email = firstString(meta, ["email", "Email"]);
    const idToken = firstString(meta, ["id_token", "idToken"]);
    const projectId = firstString(meta, ["project_id", "projectId"]);
    const sourceName = entry.name || "pasted-json";
    const subject = firstString(meta, ["sub", "subject"]);
    const name = email || subject || firstString(meta, ["label", "name"]) || `${provider}:${sourceName.replace(/\.json$/i, "")}`;
    const token = nestedToken(meta);

    const credentials = {
      access_token: accessToken,
      expires_at: expiresAt,
    };

    if (refreshToken) credentials.refresh_token = refreshToken;
    if (idToken) credentials.id_token = idToken;
    if (email) credentials.email = email;
    if ((platform === "gemini" || platform === "antigravity") && projectId) credentials.project_id = projectId;

    for (const key of [
      "oauth_type",
      "tier_id",
      "token_type",
      "scope",
      "client_id",
      "client_secret",
      "token_uri",
      "plan_type",
      "subscription_expires_at",
      "chatgpt_account_id",
      "chatgpt_user_id",
      "organization_id",
      "chatgpt_account_is_fedramp",
      "openai_auth_mode",
      "auth_mode",
      // account_codex_import.go protected keys; CPA never emits these today,
      // they are carried for forward compatibility with Agent Identity.
      "agent_runtime_id",
      "agent_private_key",
      "task_id",
      "user_agent",
      "base_url",
      "sub",
      "team_id",
      "subscription_tier",
      "entitlement_status",
      "using_api",
    ]) {
      addKnownCredential(credentials, meta, key);
    }
    for (const key of ["client_id", "client_secret", "token_uri", "scope", "token_type"]) {
      addKnownCredential(credentials, token, key);
    }

    const accountId = firstString(meta, ["account_id", "accountId"]);
    if (accountId) {
      credentials.account_id = accountId;
      if (platform === "openai" && !credentials.chatgpt_account_id) credentials.chatgpt_account_id = accountId;
    }
    if (platform === "gemini" && projectId && !credentials.oauth_type) credentials.oauth_type = "code_assist";
    if (platform === "antigravity" && !projectId) issues.push("antigravity 缺少 project_id，sub2api 可能无法刷新");
    if (platform === "grok") {
      if (!credentials.client_id) credentials.client_id = XAI_DEFAULT_CLIENT_ID;
      if (!credentials.scope) credentials.scope = XAI_DEFAULT_SCOPE;
      if (!credentials.token_type) credentials.token_type = "Bearer";
      credentials.base_url = XAI_DEFAULT_CLI_BASE_URL;
      if (!refreshToken) issues.push("xai 缺少 refresh_token，访问令牌过期后 sub2api 无法刷新");
    }

    const account = {
      name,
      platform,
      type: "oauth",
      credentials,
      ...sub2APIAccountDefaults(platform),
    };
    if (platform === "grok") {
      const extra = {};
      for (const key of ["email", "subscription_tier", "entitlement_status"]) {
        addKnownCredential(extra, credentials, key);
      }
      if (Object.keys(extra).length) account.extra = extra;
    }

    return {
      account,
      provider,
      platform,
      preview: {
        name,
        platform,
        type: "oauth",
        expires: expiresAt,
        status: issues.length ? issues.join("; ") : "可导入",
      },
      issues,
    };
  }

  // sub2api Agent Identity credentials (service.OpenAIAuthModeAgentIdentity).
  // They carry an Ed25519 runtime key instead of an access token, so there is
  // no CodexTokenStorage field to map them onto.
  const OPENAI_AUTH_MODE_AGENT_IDENTITY = "agentidentity";

  function isAgentIdentityCredentials(creds) {
    if (!creds || typeof creds !== "object" || Array.isArray(creds)) return false;
    for (const key of ["agent_identity", "agentIdentity"]) {
      const nested = creds[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) return true;
    }
    const mode = firstString(creds, ["auth_mode", "authMode", "openai_auth_mode", "openaiAuthMode"]);
    if (mode.toLowerCase() === OPENAI_AUTH_MODE_AGENT_IDENTITY) return true;
    return Boolean(firstString(creds, ["agent_runtime_id", "agentRuntimeId"]));
  }

  function convertSubAccount(entry) {
    const account = entry.value;
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      return { skipped: true, reason: "记录不是 sub2api account 对象" };
    }
    const platform = firstString(account, ["platform"]).toLowerCase();
    if (platform === "gemini") {
      return {
        skipped: true,
        reason: "最新版 CLIProxyAPI 已移除 Gemini auth 文件支持，仅保留 CPA 旧文件 -> sub2api 的单向迁移",
      };
    }
    const provider = PLATFORM_TO_PROVIDER[platform];
    if (!provider) return { skipped: true, reason: `暂不支持 platform: ${platform || "empty"}` };

    const type = firstString(account, ["type"]).toLowerCase();
    if (type && type !== "oauth") {
      return { skipped: true, reason: `CPA 仅能还原 OAuth 账号，当前 type=${type}` };
    }

    const creds = account.credentials && typeof account.credentials === "object" ? account.credentials : {};
    if (isAgentIdentityCredentials(creds) || isAgentIdentityCredentials(account)) {
      return {
        skipped: true,
        reason: "Agent Identity 凭据无法转换为 CPA：CodexTokenStorage 无 runtime/private key 字段",
      };
    }
    const accessToken = firstString(creds, ["access_token", "accessToken"]);
    if (!accessToken) return { skipped: true, reason: "credentials 缺少 access_token" };

    const auth = { type: provider };
    const email = firstString(creds, ["email"]) || firstString(account, ["name"]);
    const refreshToken = firstString(creds, ["refresh_token", "refreshToken"]);
    const idToken = firstString(creds, ["id_token", "idToken"]);
    const expiresAt = firstString(creds, ["expires_at", "expired", "expiry", "expires"]);
    const projectId = firstString(creds, ["project_id", "projectId"]);

    if (email) auth.email = email;
    if (provider === "xai") {
      auth.access_token = accessToken;
      if (refreshToken) auth.refresh_token = refreshToken;
      if (idToken) auth.id_token = idToken;
      auth.token_type = firstString(creds, ["token_type"]) || "Bearer";
      if (expiresAt) auth.expired = expiresAt;
      const subject = firstString(creds, ["sub", "subject"]);
      if (subject) auth.sub = subject;
      const baseURL = firstString(creds, ["base_url"]);
      auth.base_url = !baseURL || baseURL === XAI_DEFAULT_CLI_BASE_URL
        ? XAI_DEFAULT_API_BASE_URL
        : baseURL;
      auth.token_endpoint = firstString(creds, ["token_endpoint"]) || XAI_DEFAULT_TOKEN_ENDPOINT;
      auth.auth_kind = "oauth";
      for (const key of ["redirect_uri", "using_api"]) {
        addKnownCredential(auth, creds, key);
      }
      const expiresIn = asInt(creds.expires_in, null);
      if (expiresIn !== null) auth.expires_in = expiresIn;
    } else {
      auth.access_token = accessToken;
      if (refreshToken) auth.refresh_token = refreshToken;
      if (idToken) auth.id_token = idToken;
      if (expiresAt) auth.expired = expiresAt;
      if (provider === "codex") {
        const chatgptAccountId = firstString(creds, ["chatgpt_account_id", "account_id"]);
        if (chatgptAccountId) auth.account_id = chatgptAccountId;
      }
      if (provider === "antigravity" && projectId) auth.project_id = projectId;
      for (const key of [
        "token_type",
        "scope",
        "client_id",
        "plan_type",
        "subscription_expires_at",
        "chatgpt_user_id",
        "organization_id",
        "chatgpt_account_is_fedramp",
        "openai_auth_mode",
        "auth_mode",
      ]) {
        addKnownCredential(auth, creds, key);
      }
    }

    if (account.priority !== undefined) auth.priority = account.priority;
    if (account.disabled !== undefined) auth.disabled = boolValue(account.disabled);
    const notes = firstString(account, ["notes"]);
    if (notes) auth.note = notes;

    return {
      account: auth,
      provider,
      platform,
      fileName: cpaAuthFileName(auth, account, entry.name),
      preview: {
        name: email || provider,
        platform: provider,
        type: "CPA JSON",
        expires: expiresAt || "0",
        status: "可导出",
      },
      issues: [],
    };
  }

  function unwrapSub2APIEnvelope(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw)
      && raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? raw.data
      : raw;
  }

  function validateSub2APIDataHeader(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return "";
    const hasCollections = data.accounts !== undefined || data.proxies !== undefined;
    const hasKnownType = SUPPORTED_SUB2API_DATA_TYPES.has(data.type);
    const requiresFullPayload = hasKnownType || data.version !== undefined || data.exported_at !== undefined
      || (hasCollections && data.type !== undefined);
    if (!requiresFullPayload && !hasCollections) return "";

    if (requiresFullPayload && data.type !== undefined && data.type !== "" && !hasKnownType) {
      return `不支持的 sub2api data type: ${asString(data.type) || typeof data.type}`;
    }
    if (data.version !== undefined && data.version !== 0 && data.version !== SUPPORTED_SUB2API_DATA_VERSION) {
      return `不支持的 sub2api data version: ${asString(data.version) || typeof data.version}`;
    }
    if (data.accounts !== undefined && !Array.isArray(data.accounts)) return "accounts 必须是数组";
    if (data.proxies !== undefined && !Array.isArray(data.proxies)) return "proxies 必须是数组";
    if (requiresFullPayload && !Array.isArray(data.accounts)) return "accounts is required";
    if (requiresFullPayload && !Array.isArray(data.proxies)) return "proxies is required";
    return "";
  }

  function unwrapJSONValue(value, sourceName) {
    const entries = [];
    const push = (item, suffix) => {
      entries.push({ name: suffix ? `${sourceName}:${suffix}` : sourceName, value: item });
    };

    if (Array.isArray(value)) {
      value.forEach((item, index) => push(item, index + 1));
      return entries;
    }

    if (value && typeof value === "object") {
      if (Array.isArray(value.auths)) {
        value.auths.forEach((item, index) => push(item, `auths[${index}]`));
        return entries;
      }
      push(value, "");
    }
    return entries;
  }

  function parseJSONSequence(text, sourceName) {
    const entries = [];
    const errors = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === "{" || ch === "[") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth < 0) {
          errors.push({ source: sourceName, reason: "JSON 括号不匹配" });
          return { entries, errors };
        }
        if (depth === 0 && start >= 0) {
          const chunk = text.slice(start, i + 1);
          try {
            entries.push(...unwrapJSONValue(JSON.parse(chunk), `${sourceName}:${entries.length + 1}`));
          } catch (error) {
            errors.push({ source: sourceName, reason: error.message });
          }
          start = -1;
        }
      }
    }

    if (depth !== 0 || inString) errors.push({ source: sourceName, reason: "JSON 未闭合" });
    return { entries, errors };
  }

  function parseInputText(text, sourceName) {
    const clean = stripBOM(text || "").trim();
    if (!clean) return { entries: [], errors: [] };

    try {
      return { entries: unwrapJSONValue(JSON.parse(clean), sourceName), errors: [] };
    } catch (_) {
      const lineEntries = [];
      let lineModeFailed = false;
      const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length > 1) {
        for (let i = 0; i < lines.length; i += 1) {
          try {
            lineEntries.push(...unwrapJSONValue(JSON.parse(lines[i]), `${sourceName}:${i + 1}`));
          } catch (_) {
            lineModeFailed = true;
            break;
          }
        }
        if (!lineModeFailed && lineEntries.length) return { entries: lineEntries, errors: [] };
      }
    }

    const sequence = parseJSONSequence(clean, sourceName);
    if (sequence.entries.length) return sequence;
    return {
      entries: [],
      errors: [{ source: sourceName, reason: sequence.errors[0]?.reason || "JSON 解析失败" }],
    };
  }

  function expandSub2APIAccountEntries(entries) {
    const accountEntries = [];
    for (const entry of entries) {
      const data = unwrapSub2APIEnvelope(entry.value);
      if (Array.isArray(data && data.accounts)) {
        data.accounts.forEach((account, index) => {
          accountEntries.push({ name: `${entry.name}:accounts[${index}]`, value: account });
        });
      } else if (data && typeof data === "object" && !Array.isArray(data)) {
        accountEntries.push({ name: entry.name, value: data });
      }
    }
    return accountEntries;
  }

  function buildSub2APIImportBody(accounts, exportedAt) {
    return {
      type: "sub2api-data",
      version: 1,
      exported_at: exportedAt,
      proxies: [],
      accounts,
    };
  }

  function buildCpaToSub(entries, now = new Date()) {
    const accounts = [];
    const converted = [];
    const skipped = [];
    const issues = [];
    const sub2apiFiles = [];
    const usedNames = new Set();
    const exportedAt = now.toISOString();

    for (const entry of entries) {
      const result = convertCPARecord(entry);
      if (result.skipped) {
        skipped.push({ sourceName: entry.name, path: "$", reason: result.reason });
        continue;
      }
      accounts.push(result.account);
      for (const issue of result.issues || []) {
        issues.push({ sourceName: entry.name, path: "$", reason: issue });
      }
      converted.push({
        kind: "bridge",
        direction: "cpa-to-sub",
        sourceName: entry.name,
        name: result.account.name,
        email: result.account.credentials?.email || result.account.name,
        expiresAt: result.account.credentials?.expires_at === "0"
          ? undefined
          : result.account.credentials?.expires_at,
        platform: result.platform,
        provider: result.provider,
        sub2apiAccount: result.account,
        // No cross-direction shape: the raw source record must never leak into
        // output documents or downloads (converted content only).
        cpa: null,
        fileName: uniqueFileName(sub2apiImportFileName(result.account, entry.name), usedNames),
      });
    }

    for (const item of converted) {
      sub2apiFiles.push({
        name: item.fileName,
        data: buildSub2APIImportBody([item.sub2apiAccount], exportedAt),
      });
    }

    return {
      converted,
      skipped: [...skipped, ...issues],
      output: buildSub2APIImportBody(accounts, exportedAt),
      downloadKind: "json",
      fileName: "sub2api-import.json",
      cpaFiles: [],
      sub2apiFiles,
      accountCount: accounts.length,
    };
  }

  function buildSubToCpa(entries, now = new Date()) {
    const accounts = [];
    const converted = [];
    const skipped = [];
    const cpaFiles = [];
    const usedNames = new Set();
    let headerSkipped = 0;
    const validEntries = [];

    for (const entry of entries) {
      const data = unwrapSub2APIEnvelope(entry.value);
      const headerError = validateSub2APIDataHeader(data);
      if (headerError) {
        skipped.push({ sourceName: entry.name, path: "$", reason: headerError });
        headerSkipped += 1;
        continue;
      }
      validEntries.push(entry);
    }

    const accountEntries = expandSub2APIAccountEntries(validEntries);
    for (const entry of accountEntries) {
      const result = convertSubAccount(entry);
      if (result.skipped) {
        skipped.push({ sourceName: entry.name, path: "$", reason: result.reason });
        continue;
      }
      accounts.push(result.account);
      const fileName = uniqueFileName(result.fileName, usedNames);
      cpaFiles.push({ name: fileName, data: result.account });
      converted.push({
        kind: "bridge",
        direction: "sub-to-cpa",
        sourceName: entry.name,
        name: result.preview.name,
        email: result.account.email || result.preview.name,
        expiresAt: result.account.expired === "0" ? undefined : result.account.expired,
        platform: result.platform,
        provider: result.provider,
        // No cross-direction shape: the raw source account must never leak into
        // output documents or downloads (converted content only).
        sub2apiAccount: null,
        cpa: result.account,
        fileName,
      });
    }

    const output = {
      type: "cliproxyapi-auth-list",
      version: 1,
      exported_at: now.toISOString(),
      note: "合并 JSON 清单；auths 包含全部转换结果。需要 CLIProxyAPI 原生单账号文件时可另选拆分 ZIP。",
      auths: accounts,
    };

    return {
      converted,
      skipped,
      output,
      downloadKind: "json",
      fileName: accounts.length > 1 ? "cliproxyapi-auth-list.json" : (cpaFiles[0]?.name || "codex-account.json"),
      cpaFiles,
      sub2apiFiles: [],
      accountCount: accounts.length,
      totalRecords: accountEntries.length + headerSkipped,
    };
  }

  function convertBridgeText(text, direction, sourceName = "pasted-json") {
    const parsed = parseInputText(text, sourceName);
    const baseSkipped = parsed.errors.map((item) => ({
      sourceName: item.source,
      path: "$",
      reason: item.reason,
    }));
    if (!parsed.entries.length && baseSkipped.length) {
      return {
        converted: [],
        skipped: baseSkipped,
        output: null,
        downloadKind: "json",
        fileName: direction === "sub-to-cpa" ? "cliproxyapi-auth-list.json" : "sub2api-import.json",
        cpaFiles: [],
        sub2apiFiles: [],
        accountCount: 0,
      };
    }

    const result = direction === "sub-to-cpa"
      ? buildSubToCpa(parsed.entries)
      : buildCpaToSub(parsed.entries);
    result.skipped = [...baseSkipped, ...result.skipped];
    return result;
  }

  function convertBridgeFiles(filePayloads, direction) {
    const entries = [];
    const skipped = [];
    for (const file of filePayloads) {
      const parsed = parseInputText(file.text, file.name);
      entries.push(...parsed.entries);
      for (const error of parsed.errors) {
        skipped.push({ sourceName: error.source, path: "$", reason: error.reason });
      }
    }
    const result = direction === "sub-to-cpa"
      ? buildSubToCpa(entries)
      : buildCpaToSub(entries);
    result.skipped = [...skipped, ...result.skipped];
    return result;
  }

  function u16(value) {
    const bytes = new Uint8Array(2);
    bytes[0] = value & 0xff;
    bytes[1] = (value >>> 8) & 0xff;
    return bytes;
  }

  function u32(value) {
    const bytes = new Uint8Array(4);
    bytes[0] = value & 0xff;
    bytes[1] = (value >>> 8) & 0xff;
    bytes[2] = (value >>> 16) & 0xff;
    bytes[3] = (value >>> 24) & 0xff;
    return bytes;
  }

  function concatBytes(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = typeof file.content === "string"
        ? encoder.encode(file.content)
        : encoder.encode(JSON.stringify(file.data, null, 2));
      const crc = crc32(dataBytes);
      const local = concatBytes(
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(dataBytes.length),
        u32(dataBytes.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
        dataBytes,
      );
      localParts.push(local);

      const central = concatBytes(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(dataBytes.length),
        u32(dataBytes.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      );
      centralParts.push(central);
      offset += local.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = concatBytes(
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(centralSize),
      u32(offset),
      u16(0),
    );
    return concatBytes(...localParts, ...centralParts, end);
  }

  function buildZipFromCpaFiles(cpaFiles) {
    return buildZip(cpaFiles.map((file) => ({
      name: file.name,
      data: file.data,
    })));
  }

  function buildZipFromSub2apiFiles(sub2apiFiles) {
    return buildZip(sub2apiFiles.map((file) => ({
      name: file.name,
      data: file.data,
    })));
  }

  function looksLikeCpaAuth(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const meta = materializeCPARecord(value);
    if (!meta) return false;
    const provider = providerFromCPA(value, meta);
    if (!provider || !PROVIDER_TO_PLATFORM[provider]) return false;
    return Boolean(extractAccessToken(meta));
  }

  function looksLikeSub2apiAccount(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const platform = firstString(value, ["platform"]).toLowerCase();
    if (!platform || !PLATFORM_TO_PROVIDER[platform]) return false;
    const type = firstString(value, ["type"]).toLowerCase();
    if (type && type !== "oauth" && type !== "api_key") return false;
    const creds = value.credentials && typeof value.credentials === "object" ? value.credentials : null;
    if (!creds) return false;
    // Agent Identity accounts carry no access token; recognise them so mode
    // auto-detection does not mistake them for a raw session payload.
    if (isAgentIdentityCredentials(creds)) return true;
    return Boolean(firstString(creds, ["access_token", "accessToken", "api_key", "apiKey"]));
  }

  function looksLikeSessionObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const token = firstString(value, ["accessToken"])
      || firstString(value.tokens || {}, ["accessToken", "access_token"])
      || firstString(value.token || {}, ["accessToken", "access_token"])
      || firstString(value.credentials || {}, ["accessToken"]);
    if (!token) return false;
    // Prefer camelCase session shape over CPA snake_case auth files.
    if (value.user || value.sessionToken || value.session_token || value.authProvider || value.auth_provider) {
      return true;
    }
    if (value.accessToken && !value.type && !value.platform) return true;
    return false;
  }

  // Single-entry counterpart of detectInputMode: names the pipeline an already
  // parsed JSON entry should run through. Used by the per-entry auto pipeline
  // so mixed-format imports and pastes convert in one pass.
  function classifyEntryMode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = unwrapSub2APIEnvelope(value);
    if (
      SUPPORTED_SUB2API_DATA_TYPES.has(data?.type)
      || (
        Array.isArray(data?.accounts)
        && (data?.version !== undefined || data?.exported_at !== undefined || data?.proxies !== undefined)
      )
    ) {
      return "sub-to-cpa";
    }
    if (data?.type === "cliproxyapi-auth-list" && Array.isArray(data?.auths)) {
      return "cpa-to-sub";
    }
    if (looksLikeSessionObject(value)) return "session";
    if (looksLikeCpaAuth(value)) return "cpa-to-sub";
    if (looksLikeSub2apiAccount(value)) return "sub-to-cpa";
    return null;
  }

  function scoreEntries(entries) {
    let session = 0;
    let cpa = 0;
    let sub = 0;
    for (const entry of entries) {
      const value = entry.value;
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) continue;

      if (SUPPORTED_SUB2API_DATA_TYPES.has(value.type) || (
        Array.isArray(value.accounts)
        && (value.version !== undefined || value.exported_at !== undefined || value.proxies !== undefined)
      )) {
        sub += 3;
        continue;
      }
      if (value.type === "cliproxyapi-auth-list" && Array.isArray(value.auths)) {
        cpa += 3;
        continue;
      }
      if (looksLikeSessionObject(value)) {
        session += 2;
        continue;
      }
      if (looksLikeCpaAuth(value)) {
        cpa += 2;
        continue;
      }
      if (looksLikeSub2apiAccount(value)) {
        sub += 2;
      }
    }
    return { session, cpa, sub };
  }

  function detectInputMode(text) {
    const parsed = parseInputText(text, "detect");
    if (!parsed.entries.length) return null;

    // Expand nested auths / arrays already flattened by unwrapJSONValue.
    const scores = scoreEntries(parsed.entries);
    const best = Math.max(scores.session, scores.cpa, scores.sub);
    if (best <= 0) return null;
    // Tie-break: more specific bridge formats win over generic session.
    if (scores.sub === best && scores.sub > scores.cpa && scores.sub > scores.session) return "sub-to-cpa";
    if (scores.cpa === best && scores.cpa > scores.session) return "cpa-to-sub";
    if (scores.session === best) return "session";
    if (scores.sub === best) return "sub-to-cpa";
    if (scores.cpa === best) return "cpa-to-sub";
    return null;
  }

  const samples = {
    "cpa-to-sub": `[
  {
    "type": "codex",
    "email": "alpha@example.com",
    "access_token": "at",
    "refresh_token": "rt",
    "id_token": "idt",
    "account_id": "chatgpt-account-id",
    "expired": "2099-01-01T00:00:00Z"
  },
  {
    "type": "claude",
    "email": "beta@example.com",
    "access_token": "at2",
    "refresh_token": "rt2",
    "id_token": "idt2",
    "expired": "2099-01-01T00:00:00Z"
  },
  {
    "type": "xai",
    "email": "grok@example.com",
    "sub": "xai-user-id",
    "access_token": "xat",
    "refresh_token": "xrt",
    "id_token": "xidt",
    "token_type": "Bearer",
    "expired": "2099-01-01T00:00:00Z",
    "base_url": "https://api.x.ai/v1",
    "token_endpoint": "https://auth.x.ai/oauth2/token",
    "auth_kind": "oauth"
  },
  {
    "type": "antigravity",
    "email": "ag@example.com",
    "project_id": "agproj",
    "access_token": "agat",
    "refresh_token": "agrt",
    "expired": "2099-01-01T00:00:00Z"
  }
]`,
    "sub-to-cpa": `{
  "type": "sub2api-data",
  "version": 1,
  "exported_at": "2026-07-14T00:00:00Z",
  "proxies": [],
  "accounts": [
    {
      "name": "alpha@example.com",
      "platform": "openai",
      "type": "oauth",
      "concurrency": 10,
      "priority": 1,
      "rate_multiplier": 1,
      "auto_pause_on_expired": true,
      "credentials": {
        "access_token": "at",
        "refresh_token": "rt",
        "id_token": "idt",
        "email": "alpha@example.com",
        "chatgpt_account_id": "chatgpt-account-id",
        "expires_at": "2099-01-01T00:00:00Z"
      }
    },
    {
      "name": "beta@example.com",
      "platform": "anthropic",
      "type": "oauth",
      "concurrency": 10,
      "priority": 1,
      "rate_multiplier": 1,
      "auto_pause_on_expired": true,
      "credentials": {
        "access_token": "at2",
        "refresh_token": "rt2",
        "id_token": "idt2",
        "email": "beta@example.com",
        "expires_at": "2099-01-01T00:00:00Z"
      }
    },
    {
      "name": "grok@example.com",
      "platform": "grok",
      "type": "oauth",
      "concurrency": 1,
      "priority": 1,
      "rate_multiplier": 1,
      "auto_pause_on_expired": true,
      "credentials": {
        "access_token": "xat",
        "refresh_token": "xrt",
        "id_token": "xidt",
        "token_type": "Bearer",
        "email": "grok@example.com",
        "sub": "xai-user-id",
        "expires_at": "2099-01-01T00:00:00Z",
        "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
        "scope": "openid profile email offline_access grok-cli:access api:access",
        "base_url": "https://cli-chat-proxy.grok.com/v1"
      }
    },
    {
      "name": "ag@example.com",
      "platform": "antigravity",
      "type": "oauth",
      "concurrency": 10,
      "priority": 1,
      "rate_multiplier": 1,
      "auto_pause_on_expired": true,
      "credentials": {
        "access_token": "agat",
        "refresh_token": "agrt",
        "email": "ag@example.com",
        "project_id": "agproj",
        "expires_at": "2099-01-01T00:00:00Z"
      }
    }
  ]
}`,
  };

  globalThis.SessionConverterBridge = {
    SOURCE_PINS,
    formatSourcePinLabel,
    renderSourcePins,
    PROVIDER_TO_PLATFORM,
    PLATFORM_TO_PROVIDER,
    convertBridgeText,
    convertBridgeFiles,
    convertCPARecord,
    convertSubAccount,
    buildZipFromCpaFiles,
    buildZipFromSub2apiFiles,
    buildSub2APIImportBody,
    detectInputMode,
    classifyEntryMode,
    looksLikeCpaAuth,
    looksLikeSub2apiAccount,
    looksLikeSessionObject,
    samples,
    parseInputText,
  };

  if (typeof document !== "undefined") {
    renderSourcePins();
  }
})();
