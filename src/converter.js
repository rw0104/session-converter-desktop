      (() => {
        const OUTPUT_LABELS = {
          sub2api: "sub2api",
          cpa: "CPA",
          cockpit: "Cockpit",
          "9router": "9router",
          codex: "Codex",
          axonhub: "AxonHub",
          codexmanager: "Codex-Manager",
        };

        const bridge = globalThis.VaultKeySessionBridge;
        if (!bridge) {
          throw new Error("VaultKeySessionBridge is missing; load bridge.js before converter.js");
        }

        const tauri = globalThis.__TAURI__ || null;
        const isDesktopRuntime = Boolean(tauri?.core?.invoke);

        const MODE_LABELS = {
          session: "Session → 多格式",
          "cpa-to-sub": "CPA → sub2api",
          "sub-to-cpa": "sub2api → CPA",
        };

        const state = {
          mode: "session",
          format: "sub2api",
          sessions: [],
          converted: [],
          skipped: [],
          warnings: [],
          liveChecks: [],
          liveCheckRunId: 0,
          liveChecking: false,
          liveCheckControllers: new Set(),
          outputText: "",
          downloadKind: "json",
          downloadFileName: "",
          cpaFiles: [],
          sub2apiFiles: [],
          bridgeOutput: null,
          autoDetectMode: true,
          lastAutoMode: null,
        };

        const elements = {
          accountBody: document.querySelector("#account-body"),
          autoDetectMode: document.querySelector("#auto-detect-mode"),
          bridgeGuide: document.querySelector("#bridge-guide"),
          bridgeGuideBody: document.querySelector("#bridge-guide-body"),
          bridgeGuideTitle: document.querySelector("#bridge-guide-title"),
          clearInput: document.querySelector("#clear-input"),
          copyOutput: document.querySelector("#copy-output"),
          cpaNotice: document.querySelector("#cpa-notice"),
          downloadOutput: document.querySelector("#download-output"),
          downloadSplit: document.querySelector("#download-split"),
          fileInput: document.querySelector("#file-input"),
          formatButtons: Array.from(document.querySelectorAll("[data-format]")),
          formatGroup: document.querySelector("#format-group"),
          input: document.querySelector("#session-input"),
          inputHint: document.querySelector("#input-hint"),
          inputStatus: document.querySelector("#input-status"),
          inputTitle: document.querySelector("#input-title"),
          issues: document.querySelector("#issues"),
          loadExample: document.querySelector("#load-example"),
          liveCheckBody: document.querySelector("#live-check-body"),
          liveCheckButton: document.querySelector("#live-check-button"),
          liveCheckConcurrency: document.querySelector("#live-check-concurrency"),
          liveCheckStatus: document.querySelector("#live-check-status"),
          modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
          modeHint: document.querySelector("#mode-hint"),
          removeDeadButton: document.querySelector("#remove-dead-button"),
          downloadCleanButton: document.querySelector("#download-clean-button"),
          output: document.querySelector("#output"),
          outputStatus: document.querySelector("#output-status"),
          outputSubtitle: document.querySelector("#output-subtitle"),
          upstreamCheckButton: document.querySelector("#check-upstream-updates"),
          upstreamCheckStatus: document.querySelector("#upstream-check-status"),
          pickFiles: document.querySelector("#pick-files"),
          sessionGuide: document.querySelector("#session-guide"),
          statCount: document.querySelector("#stat-count"),
          statErrors: document.querySelector("#stat-errors"),
          statFormat: document.querySelector("#stat-format"),
        };

        const exampleSession = {
          user: {
            id: "user-example",
            email: "mark@example.com",
          },
          expires: "2026-08-06T14:29:36.155Z",
          account: {
            id: "00000000-0000-4000-9000-000000000000",
            planType: "plus",
          },
          accessToken: "paste-real-access-token-here",
          sessionToken: "paste-real-session-token-here",
          authProvider: "openai",
        };

        const AXONHUB_PLACEHOLDER_REFRESH_TOKEN = "__missing_refresh_token__";
        // Account schema pins: bridge.SOURCE_PINS (shown in page header badges).
        const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
        const SUB2API_DATA_TYPE = "sub2api-data";
        const SUB2API_DATA_VERSION = 1;
        const SUB2API_OAUTH_ACCOUNT_DEFAULTS = Object.freeze({
          concurrency: 10,
          priority: 1,
          rate_multiplier: 1,
          auto_pause_on_expired: true,
        });
        // sub2api Agent Identity credential mode. The stored value is camelCase
        // upstream (service.OpenAIAuthModeAgentIdentity).
        const OPENAI_AUTH_MODE_AGENT_IDENTITY = "agentIdentity";
        const AGENT_IDENTITY_MISSING_TASK_WARNING = "未包含 task_id，首次请求会使用现有 runtime 注册新 task";
        // resolveCodexImportExpiry returns a nil auto-pause flag for Agent
        // Identity, so the field is omitted rather than written as false.
        const SUB2API_AGENT_IDENTITY_ACCOUNT_DEFAULTS = Object.freeze(Object.fromEntries(
          Object.entries(SUB2API_OAUTH_ACCOUNT_DEFAULTS).filter(([key]) => key !== "auto_pause_on_expired"),
        ));
        // DER for AlgorithmIdentifier SEQUENCE { OID 1.3.101.112 } (Ed25519).
        const ED25519_PKCS8_ALGORITHM_DER = Object.freeze([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]);
        // Session output formats backed by CLIProxyAPI CodexTokenStorage and
        // friends; Agent Identity records have no counterpart in any of them.
        const SESSION_FORMAT_KEYS = Object.freeze({
          cpa: "cpa",
          cockpit: "cockpit",
          "9router": "nineRouter",
          codex: "codexAuthJson",
          axonhub: "axonHub",
          codexmanager: "codexManager",
        });

        function isPlainObject(value) {
          return Boolean(value) && typeof value === "object" && !Array.isArray(value);
        }

        function firstNonEmpty(...values) {
          for (const value of values) {
            if (typeof value === "string" && value.trim() !== "") {
              return value.trim();
            }
          }
          return undefined;
        }

        function escapeHtml(value) {
          return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
        }

        function decodeBase64Url(value) {
          const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
          const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
          const binary = atob(padded);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          return new TextDecoder().decode(bytes);
        }

        function bytesToBase64Url(bytes) {
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        }

        function encodeBase64UrlJson(value) {
          return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
        }

        function decodeBase64ToBytes(value) {
          if (typeof value !== "string") {
            return undefined;
          }

          const trimmed = value.trim();
          if (trimmed === "" || /[^A-Za-z0-9+/=]/.test(trimmed)) {
            return undefined;
          }

          try {
            const binary = atob(trimmed);
            return Uint8Array.from(binary, (char) => char.charCodeAt(0));
          } catch {
            return undefined;
          }
        }

        function readDerTlv(bytes, offset) {
          if (offset + 2 > bytes.length) {
            return undefined;
          }

          const tag = bytes[offset];
          let cursor = offset + 1;
          let length = bytes[cursor];
          cursor += 1;

          if (length & 0x80) {
            // Long form; an Ed25519 key never needs more than two length bytes.
            const count = length & 0x7f;
            if (count === 0 || count > 2 || cursor + count > bytes.length) {
              return undefined;
            }

            length = 0;
            for (let index = 0; index < count; index += 1) {
              length = (length << 8) | bytes[cursor + index];
            }
            cursor += count;
          }

          if (cursor + length > bytes.length) {
            return undefined;
          }

          return { tag, start: cursor, end: cursor + length };
        }

        // Structural equivalent of sub2api ValidateOpenAIAgentIdentityPrivateKey
        // (base64 -> x509.ParsePKCS8PrivateKey -> ed25519.PrivateKey). Kept
        // synchronous and offline; never returns or logs key material.
        function isEd25519Pkcs8PrivateKey(value) {
          const bytes = decodeBase64ToBytes(value);
          if (!bytes) {
            return false;
          }

          const root = readDerTlv(bytes, 0);
          if (!root || root.tag !== 0x30 || root.end !== bytes.length) {
            return false;
          }

          const version = readDerTlv(bytes, root.start);
          if (!version || version.tag !== 0x02) {
            return false;
          }
          if (version.end - version.start !== 1 || bytes[version.start] !== 0x00) {
            return false;
          }

          const algorithm = readDerTlv(bytes, version.end);
          if (!algorithm || algorithm.tag !== 0x30) {
            return false;
          }
          const algorithmBytes = bytes.subarray(version.end, algorithm.end);
          if (algorithmBytes.length !== ED25519_PKCS8_ALGORITHM_DER.length) {
            return false;
          }
          for (let index = 0; index < algorithmBytes.length; index += 1) {
            if (algorithmBytes[index] !== ED25519_PKCS8_ALGORITHM_DER[index]) {
              return false;
            }
          }

          // privateKey OCTET STRING wraps CurvePrivateKey ::= OCTET STRING (32).
          // Optional attributes / public key after it are ignored, as in Go.
          const privateKey = readDerTlv(bytes, algorithm.end);
          if (!privateKey || privateKey.tag !== 0x04) {
            return false;
          }
          const seed = readDerTlv(bytes, privateKey.start);
          if (!seed || seed.tag !== 0x04 || seed.end !== privateKey.end) {
            return false;
          }

          return seed.end - seed.start === 32;
        }

        // Mirrors strconv.ParseBool over the values firstCodexBool accepts.
        function parseAgentIdentityBool(...values) {
          for (const value of values) {
            if (typeof value === "boolean") {
              return value;
            }
            if (typeof value === "string") {
              const normalized = value.trim();
              if (/^(1|t|T|TRUE|true|True)$/.test(normalized)) return true;
              if (/^(0|f|F|FALSE|false|False)$/.test(normalized)) return false;
            }
          }
          return false;
        }

        // account_codex_import.go: an `agent_identity` object wins; otherwise a
        // flat record tagged auth_mode=agentIdentity is its own field source.
        // `credentials` is also accepted because that is the shape sub2api
        // exports, and the rest of convertSession already reads through it.
        function readAgentIdentitySource(record) {
          for (const candidate of [record, record?.credentials]) {
            if (!isPlainObject(candidate)) {
              continue;
            }
            for (const key of ["agent_identity", "agentIdentity"]) {
              if (isPlainObject(candidate[key])) {
                return candidate[key];
              }
            }
            const mode = firstNonEmpty(candidate.auth_mode, candidate.authMode);
            if (mode && mode.toLowerCase() === OPENAI_AUTH_MODE_AGENT_IDENTITY.toLowerCase()) {
              return candidate;
            }
          }
          return undefined;
        }

        function parseJwtPayload(token) {
          if (typeof token !== "string" || token.trim() === "") {
            return undefined;
          }

          const segments = token.split(".");
          if (segments.length < 2) {
            return undefined;
          }

          try {
            return JSON.parse(decodeBase64Url(segments[1]));
          } catch {
            return undefined;
          }
        }

        function getOpenAIAuthSection(payload) {
          if (!isPlainObject(payload)) {
            return {};
          }

          const auth = payload["https://api.openai.com/auth"];
          return isPlainObject(auth) ? auth : {};
        }

        function getOpenAIProfileSection(payload) {
          if (!isPlainObject(payload)) {
            return {};
          }

          const profile = payload["https://api.openai.com/profile"];
          return isPlainObject(profile) ? profile : {};
        }

        function getDefaultOrganizationId(authSection) {
          if (!isPlainObject(authSection)) {
            return undefined;
          }

          const poid = firstNonEmpty(authSection.poid, authSection.organization_id);
          if (poid) {
            return poid;
          }

          const organizations = Array.isArray(authSection.organizations) ? authSection.organizations : [];
          const defaultOrg = organizations.find((item) => isPlainObject(item) && item.is_default)
            || organizations.find((item) => isPlainObject(item) && firstNonEmpty(item.id));
          return firstNonEmpty(defaultOrg?.id);
        }

        function normalizeTimestamp(value) {
          if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value.toISOString();
          }

          if (typeof value === "number" && Number.isFinite(value)) {
            const milliseconds = value > 1e11 ? value : value * 1000;
            const date = new Date(milliseconds);
            return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
          }

          if (typeof value !== "string" || value.trim() === "") {
            return undefined;
          }

          const date = new Date(value);
          return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
        }

        function timestampFromUnixSeconds(value) {
          const numeric = Number(value);
          if (!Number.isFinite(numeric)) {
            return undefined;
          }

          const date = new Date(numeric * 1000);
          return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
        }

        function unixSecondsFromJwtExp(value) {
          const numeric = Number(value);
          if (!Number.isFinite(numeric) || numeric <= 0) {
            return undefined;
          }

          return Math.trunc(numeric);
        }

        function epochSecondsFromValue(value) {
          if (value === undefined || value === null || value === "") {
            return 0;
          }

          const numeric = Number(value);
          if (Number.isFinite(numeric)) {
            return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric);
          }

          const parsed = Date.parse(String(value));
          return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
        }

        function buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt) {
          if (!accountId) {
            return undefined;
          }

          const now = Math.trunc(Date.now() / 1000);
          const authInfo = { chatgpt_account_id: accountId };
          const expires = epochSecondsFromValue(expiresAt) || now + 90 * 24 * 60 * 60;

          if (planType) {
            authInfo.chatgpt_plan_type = planType;
          }

          if (userId) {
            authInfo.chatgpt_user_id = userId;
            authInfo.user_id = userId;
          }

          const payload = {
            iat: now,
            exp: expires,
            "https://api.openai.com/auth": authInfo,
          };

          if (email) {
            payload.email = email;
          }

          return `${encodeBase64UrlJson({ alg: "none", typ: "JWT", cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.synthetic`;
        }

        function getExpiresIn(expiresAt, now = new Date()) {
          if (!expiresAt) {
            return undefined;
          }

          const expiresMs = new Date(expiresAt).getTime();
          if (Number.isNaN(expiresMs)) {
            return undefined;
          }

          return Math.max(0, Math.floor((expiresMs - now.getTime()) / 1000));
        }

        function getAxonHubLastRefresh(expiresAt, now = new Date()) {
          const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
          if (Number.isNaN(expiresMs)) {
            return normalizeTimestamp(now);
          }

          return new Date(expiresMs - 60 * 60 * 1000).toISOString();
        }

        function stripUnavailable(value) {
          if (Array.isArray(value)) {
            return value.map(stripUnavailable).filter((item) => item !== undefined);
          }

          if (isPlainObject(value)) {
            const entries = Object.entries(value)
              .map(([key, item]) => [key, stripUnavailable(item)])
              .filter(([, item]) => item !== undefined);
            return entries.length ? Object.fromEntries(entries) : undefined;
          }

          if (value === undefined || value === null || value === "") {
            return undefined;
          }

          return value;
        }

        function toEmailKey(email) {
          if (typeof email !== "string") {
            return undefined;
          }

          return email
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
        }

        function sanitizeFileToken(value, fallback = "chatgpt-session") {
          const base = firstNonEmpty(value, fallback) || fallback;
          return base
            .replace(/\.[^.]+$/u, "")
            .replace(/[\\/:*?"<>|]+/g, "-")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase()
            .slice(0, 80) || fallback;
        }

        function getTimestampToken(date = new Date()) {
          const pad = (value) => String(value).padStart(2, "0");
          return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate()),
          ].join("-") + "_" + [
            pad(date.getHours()),
            pad(date.getMinutes()),
            pad(date.getSeconds()),
          ].join("-");
        }

        function formatDisplayDate(value) {
          if (!value) {
            return "";
          }

          const date = new Date(value);
          if (Number.isNaN(date.getTime())) {
            return value;
          }

          const pad = (item) => String(item).padStart(2, "0");
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        }

        function collectSessionLikeObjects(value, sourceName = "pasted-json") {
          const found = [];
          const visited = new WeakSet();

          function visit(item, path) {
            if (!isPlainObject(item) && !Array.isArray(item)) {
              return;
            }

            if (isPlainObject(item)) {
              if (visited.has(item)) {
                return;
              }
              visited.add(item);

              // Agent Identity records carry no access token, so they are
              // claimed before the token check or the walk would skip them.
              if (readAgentIdentitySource(item)) {
                found.push({ value: item, sourceName, path });
                return;
              }

              const token = firstNonEmpty(
                item.accessToken,
                item.access_token,
                item.tokens?.accessToken,
                item.tokens?.access_token,
                item.token?.accessToken,
                item.token?.access_token,
                item.credentials?.accessToken,
                item.credentials?.access_token,
              );
              const hasIdentity = isPlainObject(item.user) || firstNonEmpty(
                item.email,
                item.name,
                item.label,
                item.meta?.label,
                item.tokens?.accountId,
                item.tokens?.account_id,
                item.tokens?.chatgptAccountId,
                item.tokens?.chatgpt_account_id,
                item.providerSpecificData?.chatgptAccountId,
                item.providerSpecificData?.chatgpt_account_id,
                item.id,
              );
              if (token && hasIdentity) {
                found.push({ value: item, sourceName, path });
                return;
              }

              for (const [key, child] of Object.entries(item)) {
                if (key === "accessToken" || key === "access_token" || key === "sessionToken") {
                  continue;
                }
                visit(child, `${path}.${key}`);
              }
              return;
            }

            item.forEach((child, index) => visit(child, `${path}[${index}]`));
          }

          visit(value, "$");
          return found;
        }

        function parseInputDocuments(text) {
          if (typeof text !== "string" || text.trim() === "") {
            return [];
          }

          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            throw new Error(`JSON 解析失败：${error.message}`);
          }

          return collectSessionLikeObjects(parsed);
        }

        // sub2api account_codex_import.go: Agent Identity carries no OAuth
        // access token, so it is resolved before the accessToken requirement.
        function convertAgentIdentitySession(source, options = {}) {
          const runtimeId = firstNonEmpty(source.agent_runtime_id, source.agentRuntimeId);
          const privateKey = firstNonEmpty(source.agent_private_key, source.agentPrivateKey);
          const accountId = firstNonEmpty(source.account_id, source.accountId);
          const userId = firstNonEmpty(source.chatgpt_user_id, source.chatgptUserId);
          if (!runtimeId || !privateKey || !accountId || !userId) {
            throw new Error("agent identity 缺少必要字段");
          }
          if (!isEd25519Pkcs8PrivateKey(privateKey)) {
            throw new Error("agent identity private key 格式无效");
          }

          const taskId = firstNonEmpty(source.task_id, source.taskId);
          const email = firstNonEmpty(source.email);
          const planType = firstNonEmpty(source.plan_type, source.planType);
          const isFedramp = parseAgentIdentityBool(
            source.chatgpt_account_is_fedramp,
            source.chatgptAccountIsFedramp,
          );
          const exportedAt = normalizeTimestamp(options.now || new Date());
          const sourceName = firstNonEmpty(options.sourceName, "pasted-json");
          const name = firstNonEmpty(email, sourceName, "ChatGPT Account");

          // Field set mirrors the upstream import: fedramp is always written,
          // and no expires_at exists because there is no token lifetime.
          const credentials = {
            auth_mode: OPENAI_AUTH_MODE_AGENT_IDENTITY,
            agent_runtime_id: runtimeId,
            agent_private_key: privateKey,
            chatgpt_account_id: accountId,
            chatgpt_user_id: userId,
            chatgpt_account_is_fedramp: isFedramp,
            ...(taskId ? { task_id: taskId } : {}),
            ...(email ? { email } : {}),
            ...(planType ? { plan_type: planType } : {}),
          };

          const sub2apiAccount = stripUnavailable({
            name,
            platform: "openai",
            type: "oauth",
            ...SUB2API_AGENT_IDENTITY_ACCOUNT_DEFAULTS,
            credentials,
            extra: {
              email,
              email_key: toEmailKey(email),
              name,
              source: "agent_identity",
              last_refresh: exportedAt,
              // buildCodexAgentIdentityKeys: account id only, never user/runtime.
              identity_key: `account:${accountId}`,
            },
          });

          return {
            sourceName,
            sourcePath: options.sourcePath,
            email,
            name,
            agentIdentity: true,
            warnings: taskId ? [] : [AGENT_IDENTITY_MISSING_TASK_WARNING],
            sub2apiAccount,
          };
        }

        function convertSession(record, options = {}) {
          if (!isPlainObject(record)) {
            throw new Error("session 不是 JSON 对象");
          }

          const agentIdentitySource = readAgentIdentitySource(record);
          if (agentIdentitySource) {
            return convertAgentIdentitySession(agentIdentitySource, options);
          }

          const accessToken = firstNonEmpty(
            record.accessToken,
            record.access_token,
            record.tokens?.accessToken,
            record.tokens?.access_token,
            record.token?.accessToken,
            record.token?.access_token,
            record.credentials?.accessToken,
            record.credentials?.access_token,
          );
          if (!accessToken) {
            throw new Error("缺少 accessToken");
          }
          const sessionToken = firstNonEmpty(
            record.sessionToken,
            record.session_token,
            record.tokens?.sessionToken,
            record.tokens?.session_token,
            record.token?.sessionToken,
            record.token?.session_token,
            record.credentials?.session_token,
          );
          const refreshToken = firstNonEmpty(
            record.refreshToken,
            record.refresh_token,
            record.tokens?.refreshToken,
            record.tokens?.refresh_token,
            record.token?.refreshToken,
            record.token?.refresh_token,
            record.credentials?.refresh_token,
          );
          const inputIdToken = firstNonEmpty(
            record.idToken,
            record.id_token,
            record.tokens?.idToken,
            record.tokens?.id_token,
            record.token?.idToken,
            record.token?.id_token,
            record.credentials?.id_token,
          );

          const payload = parseJwtPayload(accessToken);
          const idPayload = parseJwtPayload(inputIdToken);
          const auth = getOpenAIAuthSection(payload);
          const idAuth = getOpenAIAuthSection(idPayload);
          const profile = getOpenAIProfileSection(payload);
          // Token expiry from access JWT or explicit token fields (not session cookie expires).
          const accessTokenExpiresAt = unixSecondsFromJwtExp(payload?.exp);
          const tokenExpiresAt = firstNonEmpty(
            payload ? timestampFromUnixSeconds(payload.exp) : undefined,
            normalizeTimestamp(record.tokens?.expires_at),
            normalizeTimestamp(record.tokens?.expiresAt),
            normalizeTimestamp(record.expiresAt),
            normalizeTimestamp(record.expired),
            normalizeTimestamp(record.expires_at),
            normalizeTimestamp(record.credentials?.expires_at),
          );
          // Session cookie expiry is separate; keep for non-sub2api formats / extras only.
          const sessionExpiresAt = normalizeTimestamp(record.expires);
          const expiresAt = firstNonEmpty(tokenExpiresAt, sessionExpiresAt);
          const email = firstNonEmpty(
            record.user?.email,
            record.email,
            record.meta?.label,
            record.label,
            record.credentials?.email,
            record.providerSpecificData?.email,
            profile.email,
            idPayload?.email,
            payload?.email,
          );
          const accountId = firstNonEmpty(
            record.chatgptAccountId,
            record.chatgpt_account_id,
            record.meta?.chatgptAccountId,
            record.meta?.chatgpt_account_id,
            record.tokens?.chatgptAccountId,
            record.tokens?.chatgpt_account_id,
            record.providerSpecificData?.chatgptAccountId,
            record.providerSpecificData?.chatgpt_account_id,
            record.credentials?.chatgpt_account_id,
            auth.chatgpt_account_id,
            idAuth.chatgpt_account_id,
            record.account?.id,
            record.account_id,
            record.tokens?.accountId,
            record.tokens?.account_id,
            record.credentials?.account_id,
            record.provider === "codex" ? record.id : undefined,
          );
          const chatgptAccountId = firstNonEmpty(
            accountId,
            record.chatgptAccountId,
            record.chatgpt_account_id,
            record.meta?.chatgptAccountId,
            record.meta?.chatgpt_account_id,
            record.tokens?.chatgptAccountId,
            record.tokens?.chatgpt_account_id,
            record.providerSpecificData?.chatgptAccountId,
            record.providerSpecificData?.chatgpt_account_id,
            record.credentials?.chatgpt_account_id,
            auth.chatgpt_account_id,
            idAuth.chatgpt_account_id,
          );
          const workspaceId = firstNonEmpty(
            record.account?.workspaceId,
            record.account?.workspace_id,
            record.workspaceId,
            record.workspace_id,
            record.meta?.workspaceId,
            record.meta?.workspace_id,
            record.providerSpecificData?.workspaceId,
            record.providerSpecificData?.workspace_id,
            record.credentials?.workspace_id,
            payload?.workspace_id,
            idPayload?.workspace_id,
          );
          const userId = firstNonEmpty(
            record.user?.id,
            record.user_id,
            record.chatgptUserId,
            record.chatgpt_user_id,
            record.providerSpecificData?.chatgptUserId,
            record.providerSpecificData?.chatgpt_user_id,
            record.credentials?.chatgpt_user_id,
            auth.chatgpt_user_id,
            auth.user_id,
            idAuth.chatgpt_user_id,
            idAuth.user_id,
            payload?.sub,
            idPayload?.sub,
          );
          const planType = firstNonEmpty(
            record.account?.planType,
            record.account?.plan_type,
            record.planType,
            record.plan_type,
            record.providerSpecificData?.chatgptPlanType,
            record.providerSpecificData?.chatgpt_plan_type,
            record.credentials?.plan_type,
            auth.chatgpt_plan_type,
            idAuth.chatgpt_plan_type,
          );
          const organizationId = firstNonEmpty(
            record.organization_id,
            record.organizationId,
            record.org_id,
            record.orgId,
            record.credentials?.organization_id,
            getDefaultOrganizationId(auth),
            getDefaultOrganizationId(idAuth),
          );
          const openaiAuthMode = firstNonEmpty(
            record.openai_auth_mode,
            record.auth_mode,
            record.credentials?.openai_auth_mode,
            record.credentials?.auth_mode,
          );
          const chatgptAccountIsFedramp = (() => {
            for (const value of [record.chatgpt_account_is_fedramp, record.credentials?.chatgpt_account_is_fedramp]) {
              if (value === true || value === "true" || value === "1") return true;
              if (value === false || value === "false" || value === "0") return false;
            }
            return undefined;
          })();
          const exportedAt = normalizeTimestamp(options.now || new Date());
          const expiresIn = getExpiresIn(tokenExpiresAt, options.now || new Date());
          const sourceName = firstNonEmpty(options.sourceName, "pasted-json");
          const sourceType = record.provider === "codex" && record.authType === "oauth" ? "9router" : "chatgpt_web_session";
          const name = firstNonEmpty(email, sourceName, "ChatGPT Account");
          const syntheticIdToken = !inputIdToken
            ? buildSyntheticCodexIdToken(email, accountId, planType, userId, tokenExpiresAt || sessionExpiresAt)
            : undefined;
          const idToken = firstNonEmpty(inputIdToken, syntheticIdToken);

          // CLIProxyAPI CodexTokenStorage core + useful import extras.
          const cpa = Object.fromEntries(Object.entries({
            type: "codex",
            id_token: idToken,
            access_token: accessToken,
            refresh_token: refreshToken || "",
            account_id: accountId,
            last_refresh: exportedAt,
            email,
            expired: tokenExpiresAt || undefined,
            // Compatibility extras kept for tooling that still reads them.
            chatgpt_account_id: accountId,
            name,
            plan_type: planType,
            chatgpt_plan_type: planType,
            chatgpt_user_id: userId,
            organization_id: organizationId,
            id_token_synthetic: Boolean(syntheticIdToken) || undefined,
            session_token: sessionToken,
            disabled: Boolean(record.disabled) || undefined,
          }).filter(([, value]) => value !== undefined && value !== null));

          const cockpit = {
            type: "codex",
            id_token: idToken,
            access_token: accessToken,
            refresh_token: refreshToken || "",
            account_id: accountId,
            last_refresh: exportedAt,
            email,
            expired: tokenExpiresAt || expiresAt,
            account_note: firstNonEmpty(record.account_note, record.accountInfo, record.account_info, record.note, record.notes, record.remark),
          };

          // sub2api OpenAI OAuth account: credentials match account_codex_import + cvt.
          const sub2apiCredentials = stripUnavailable({
            access_token: accessToken,
            refresh_token: refreshToken,
            client_id: refreshToken ? OPENAI_CODEX_CLIENT_ID : undefined,
            id_token: idToken,
            email,
            chatgpt_account_id: chatgptAccountId || accountId,
            chatgpt_user_id: userId,
            organization_id: organizationId,
            plan_type: planType,
            expires_at: tokenExpiresAt,
            expires_in: expiresIn,
            openai_auth_mode: openaiAuthMode,
            auth_mode: openaiAuthMode,
            chatgpt_account_is_fedramp: chatgptAccountIsFedramp,
          });
          const sub2apiAccount = stripUnavailable({
            name: firstNonEmpty(name, email, sourceName, "ChatGPT Account"),
            platform: "openai",
            type: "oauth",
            ...SUB2API_OAUTH_ACCOUNT_DEFAULTS,
            credentials: sub2apiCredentials,
            extra: {
              email,
              email_key: toEmailKey(email),
              name,
              auth_provider: firstNonEmpty(record.authProvider, record.auth_provider),
              source: sourceType,
              last_refresh: exportedAt,
              session_expires_at: sessionExpiresAt,
              id_token_synthetic: Boolean(syntheticIdToken) || undefined,
              session_token_present: sessionToken ? true : undefined,
            },
          });
          const priority = Number.isFinite(Number(record.priority)) ? Number(record.priority) : 9;
          const isActive = typeof record.isActive === "boolean" ? record.isActive : !Boolean(record.disabled);
          const createdAt = normalizeTimestamp(record.createdAt) || exportedAt;
          const updatedAt = normalizeTimestamp(record.updatedAt) || exportedAt;
          const nineRouter = stripUnavailable({
            accessToken,
            refreshToken,
            expiresAt: tokenExpiresAt || expiresAt,
            testStatus: firstNonEmpty(record.testStatus, record.test_status, "active"),
            expiresIn,
            providerSpecificData: {
              chatgptAccountId: accountId,
              chatgptPlanType: planType,
            },
            id: accountId,
            provider: "codex",
            authType: "oauth",
            name,
            email,
            priority,
            isActive,
            createdAt,
            updatedAt,
          });
          const axonHubRefreshToken = refreshToken || AXONHUB_PLACEHOLDER_REFRESH_TOKEN;
          const codexAuthJson = {
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              id_token: idToken,
              access_token: accessToken,
              refresh_token: refreshToken || "",
              account_id: accountId,
            },
            last_refresh: exportedAt,
          };
          const axonHub = stripUnavailable({
            auth_mode: "chatgpt",
            last_refresh: getAxonHubLastRefresh(tokenExpiresAt || expiresAt, options.now || new Date()),
            tokens: {
              access_token: accessToken,
              refresh_token: axonHubRefreshToken,
              id_token: idToken,
            },
            axonhub_refresh_token_placeholder: refreshToken ? undefined : true,
            axonhub_note: refreshToken ? undefined : "refresh_token is a placeholder; access_token works only until it expires.",
          });
          const codexManagerTokenHints = Object.fromEntries(Object.entries({
            account_id: accountId,
            chatgpt_account_id: chatgptAccountId,
          }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
          const codexManagerMeta = Object.fromEntries(Object.entries({
            label: firstNonEmpty(name, email, sourceName, "ChatGPT Account"),
            workspace_id: workspaceId,
            chatgpt_account_id: chatgptAccountId,
            note: "Imported from ChatGPT session",
          }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
          const codexManager = {
            tokens: {
              access_token: accessToken,
              refresh_token: refreshToken || "",
              id_token: inputIdToken || "",
              ...codexManagerTokenHints,
            },
            meta: codexManagerMeta,
          };

          return {
            sourceName,
            sourcePath: options.sourcePath,
            email,
            name,
            expiresAt: tokenExpiresAt || expiresAt,
            accessTokenExpiresAt,
            cpa,
            cockpit,
            nineRouter,
            codexAuthJson,
            axonHub,
            codexManager,
            sub2apiAccount,
          };
        }

        function buildSub2apiDocument(converted, now = new Date()) {
          return {
            type: SUB2API_DATA_TYPE,
            version: SUB2API_DATA_VERSION,
            exported_at: normalizeTimestamp(now),
            proxies: [],
            accounts: converted.map((item) => item.sub2apiAccount),
          };
        }

        function buildOutputDocument(convertedItems = state.converted) {
          if (state.mode !== "session") {
            return state.bridgeOutput;
          }

          const now = new Date();
          if (state.format === "sub2api") {
            return buildSub2apiDocument(convertedItems, now);
          }

          const formatKey = SESSION_FORMAT_KEYS[state.format];
          if (formatKey) {
            const items = itemsForSessionFormat(convertedItems, state.format);
            if (!items.length) {
              return null;
            }
            return items.length === 1
              ? items[0][formatKey]
              : items.map((item) => item[formatKey]);
          }

          return buildSub2apiDocument(convertedItems, now);
        }

        // Agent Identity records exist only in sub2api; CodexTokenStorage has no
        // runtime / private-key fields, so CPA-family formats drop them instead
        // of emitting an auth file with the credentials missing.
        function itemsForSessionFormat(convertedItems, format) {
          const key = SESSION_FORMAT_KEYS[format];
          if (!key) {
            return convertedItems;
          }
          return convertedItems.filter((item) => item[key] !== undefined);
        }

        function applyBridgeResult(result) {
          state.sessions = [];
          state.converted = result.converted || [];
          state.skipped = result.skipped || [];
          state.warnings = [];
          state.bridgeOutput = result.output;
          state.downloadKind = result.downloadKind || "json";
          state.downloadFileName = result.fileName || "";
          state.cpaFiles = result.cpaFiles || [];
          state.sub2apiFiles = result.sub2apiFiles || [];
          state.format = state.mode === "sub-to-cpa" ? "cpa" : "sub2api";
          resetLiveChecks();
          updateOutput();
        }

        function clearBridgeArtifacts() {
          state.bridgeOutput = null;
          state.downloadKind = "json";
          state.downloadFileName = "";
          state.cpaFiles = [];
          state.sub2apiFiles = [];
        }

        function isLiveCheckable(item) {
          if (!item) return false;
          // Agent Identity holds an Ed25519 private key and no access token; it
          // must never reach the probe relay.
          if (item.agentIdentity) return false;
          if (item.kind === "bridge") {
            return item.platform === "openai" || item.provider === "codex" || item.cpa?.type === "codex";
          }
          return true;
        }

        function buildSessionSub2apiFiles(convertedItems = state.converted, now = new Date()) {
          const exportedAt = normalizeTimestamp(now);
          const usedNames = new Set();
          return convertedItems.map((item, index) => {
            const account = item.sub2apiAccount;
            const fallback = item.email || item.name || `account-${index + 1}`;
            const platform = sanitizeFileToken(account?.platform || "openai");
            const identity = sanitizeFileToken(fallback);
            let name = `sub2api-${platform}-${identity}.json`;
            let suffix = 2;
            while (usedNames.has(name.toLowerCase())) {
              name = `sub2api-${platform}-${identity}-${suffix}.json`;
              suffix += 1;
            }
            usedNames.add(name.toLowerCase());
            return {
              name,
              data: bridge.buildSub2APIImportBody([account], exportedAt),
            };
          }).filter((file) => file.data?.accounts?.[0]);
        }

        function refreshSub2apiSplitFiles() {
          if (state.mode === "cpa-to-sub") {
            // Already filled by bridge result / rebuildBridgeArtifactsFromConverted.
            return;
          }
          if (state.mode === "session" && state.format === "sub2api" && state.converted.length) {
            state.sub2apiFiles = buildSessionSub2apiFiles(state.converted);
            return;
          }
          if (state.mode === "session") {
            state.sub2apiFiles = [];
          }
        }

        function canDownloadSub2apiSplitZip() {
          refreshSub2apiSplitFiles();
          return state.sub2apiFiles.length > 1;
        }

        function splitExportDetails() {
          if (state.mode === "sub-to-cpa" && state.cpaFiles.length > 1) {
            return { kind: "cpa", count: state.cpaFiles.length };
          }
          if (canDownloadSub2apiSplitZip()) {
            return { kind: "sub2api", count: state.sub2apiFiles.length };
          }
          return null;
        }

        function maybeAutoDetectMode(text) {
          if (!state.autoDetectMode || !text.trim()) {
            state.lastAutoMode = null;
            return null;
          }
          const detected = bridge.detectInputMode(text);
          if (!detected || detected === state.mode) {
            state.lastAutoMode = detected || state.lastAutoMode;
            return null;
          }
          state.mode = detected;
          if (detected === "cpa-to-sub") state.format = "sub2api";
          if (detected === "sub-to-cpa") state.format = "cpa";
          state.lastAutoMode = detected;
          updateModeChrome();
          return detected;
        }

        function convertFromText(text) {
          if (state.mode !== "session") {
            applyBridgeResult(bridge.convertBridgeText(text, state.mode, "pasted-json"));
            return;
          }

          const sources = parseInputDocuments(text);
          const converted = [];
          const skipped = [];
          const warnings = [];
          const now = new Date();

          sources.forEach((item, index) => {
            try {
              const result = convertSession(item.value, {
                now,
                sourceName: item.sourceName,
                sourcePath: item.path || `$[${index}]`,
              });
              converted.push(result);
              for (const warning of result.warnings || []) {
                warnings.push({ sourceName: item.sourceName, path: item.path, reason: warning });
              }
            } catch (error) {
              skipped.push({
                sourceName: item.sourceName,
                path: item.path,
                reason: error instanceof Error ? error.message : "无法转换",
              });
            }
          });

          if (!sources.length) {
            skipped.push({
              sourceName: "pasted-json",
              path: "$",
              reason: "未找到包含 accessToken 和 user/email 的 session 对象",
            });
          }

          state.converted = converted;
          state.skipped = skipped;
          state.warnings = warnings;
          state.sessions = sources;
          clearBridgeArtifacts();
          refreshSub2apiSplitFiles();
          resetLiveChecks();
          updateOutput();
        }

        function setStatus(element, text, tone = "") {
          element.textContent = text;
          element.classList.toggle("is-ok", tone === "ok");
          element.classList.toggle("is-error", tone === "error");
          element.classList.toggle("is-warning", tone === "warning");
        }

        async function checkUpstreamUpdates() {
          if (!elements.upstreamCheckButton || !elements.upstreamCheckStatus) return;
          if (!isDesktopRuntime) {
            setStatus(elements.upstreamCheckStatus, "请在桌面版中检查上游更新。", "warning");
            return;
          }
          elements.upstreamCheckButton.disabled = true;
          elements.upstreamCheckButton.textContent = "检查中…";
          setStatus(elements.upstreamCheckStatus, "正在连接两个固定 GitHub 上游…");
          try {
            const checks = await tauri.core.invoke("check_upstream_updates");
            const updates = checks.filter((item) => item.status === "update_available");
            const unknown = checks.filter((item) => item.status === "unknown");
            if (updates.length) {
              const summary = updates
                .map((item) => `${item.label} ${String(item.latestSha || "").slice(0, 8)}`)
                .join("、");
              setStatus(elements.upstreamCheckStatus, `发现 ${updates.length} 个上游更新：${summary}。需复核映射后发布新版。`, "warning");
            } else if (unknown.length) {
              setStatus(elements.upstreamCheckStatus, `${unknown.length} 个上游暂时无法检查；未自动更改任何代码。`, "warning");
            } else {
              setStatus(elements.upstreamCheckStatus, "两个上游均与当前审计提交一致。", "ok");
            }
          } catch (error) {
            setStatus(elements.upstreamCheckStatus, `检查失败：${error instanceof Error ? error.message : String(error)}`, "error");
          } finally {
            elements.upstreamCheckButton.disabled = false;
            elements.upstreamCheckButton.textContent = "检查更新";
          }
        }

        function resetLiveChecks() {
          state.liveCheckRunId += 1;
          state.liveChecking = false;
          state.liveCheckControllers.forEach((controller) => controller.abort());
          state.liveCheckControllers.clear();
          state.liveChecks = state.converted.map(() => ({
            status: "pending",
            reason: "待检测",
          }));
        }

        function ensureLiveChecks() {
          if (state.liveChecks.length !== state.converted.length) {
            state.liveChecks = state.converted.map(() => ({
              status: "pending",
              reason: "待检测",
            }));
          }
        }

        function liveCheckTone(status) {
          if (status === "alive") return "is-alive";
          if (status === "dead") return "is-dead";
          if (status === "checking") return "is-checking";
          return "";
        }

        function liveCheckLabel(result) {
          if (!result) return "待检测";
          if (result.status === "alive") return result.reason || "可用";
          if (result.status === "dead") return result.reason || "不可用 / 过期";
          if (result.status === "checking") return "检测中";
          if (result.status === "unknown") return result.reason || "未知";
          return result.reason || "待检测";
        }

        function getDeadLiveCheckIndexes() {
          ensureLiveChecks();
          const indexes = [];
          state.liveChecks.forEach((item, index) => {
            if (item.status === "dead") indexes.push(index);
          });
          return indexes;
        }

        function getCleanConvertedAfterLiveCheck() {
          const deadIndexes = new Set(getDeadLiveCheckIndexes());
          return state.converted.filter((_item, index) => !deadIndexes.has(index));
        }

        function renderLiveChecks() {
          ensureLiveChecks();
          const deadCount = getDeadLiveCheckIndexes().length;
          elements.liveCheckButton.disabled = state.liveChecking || !state.converted.length;
          elements.removeDeadButton.disabled = state.liveChecking || deadCount === 0;
          elements.downloadCleanButton.disabled = state.liveChecking || !state.converted.length;

          if (!state.converted.length) {
            elements.liveCheckBody.innerHTML = '<tr><td colspan="3" class="empty">暂无可测账号。</td></tr>';
            setStatus(elements.liveCheckStatus, "等待可测账号。");
            return;
          }

          elements.liveCheckBody.innerHTML = state.converted.map((item, index) => {
            const result = state.liveChecks[index] || { status: "pending", reason: "待检测" };
            return `
              <tr>
                <td><div class="cell-clip" title="${escapeHtml(item.email)}">${escapeHtml(item.email || item.name || "-")}</div></td>
                <td><div class="cell-clip" title="${escapeHtml(item.expiresAt)}">${escapeHtml(formatDisplayDate(item.expiresAt) || "-")}</div></td>
                <td><span class="live-check-result ${liveCheckTone(result.status)}">${escapeHtml(liveCheckLabel(result))}</span></td>
              </tr>
            `;
          }).join("");

          if (!state.liveChecking && state.liveChecks.every((item) => item.status === "pending")) {
            setStatus(elements.liveCheckStatus, `已识别 ${state.converted.length} 个可测账号，尚未发起网络请求。`);
          }
        }

        function classifyLiveCheckHttpStatus(status, probe = null) {
          if (status >= 200 && status < 300) {
            const model = String(probe?.model || "").trim();
            return { status: "alive", reason: model ? `${model} 实际调用可用` : `HTTP ${status} 可用` };
          }
          if (status === 401) {
            return { status: "dead", reason: "HTTP 401 身份凭证无效" };
          }
          if (status === 402) {
            return {
              status: "dead",
              reason: probe?.code === "deactivated_workspace"
                ? "HTTP 402 工作区已停用"
                : "HTTP 402 团队空间不可用",
            };
          }
          if (status === 403) {
            return { status: "dead", reason: "HTTP 403 无权访问团队空间" };
          }
          if (status === 429) {
            return { status: "unknown", reason: "HTTP 429 限流" };
          }
          if (status >= 500) {
            return { status: "unknown", reason: `HTTP ${status} 上游异常` };
          }
          return { status: "unknown", reason: `HTTP ${status}` };
        }

        async function probeChatgptModel(item) {
          if (!isLiveCheckable(item)) {
            return { status: "unknown", reason: "非 OpenAI/Codex 账号，跳过模型检测" };
          }

          const accessToken = firstNonEmpty(
            item?.sub2apiAccount?.credentials?.access_token,
            item?.cpa?.access_token,
            item?.nineRouter?.accessToken,
          );
          if (!accessToken) {
            return { status: "dead", reason: "缺少 access_token" };
          }

          const exp = unixSecondsFromJwtExp(parseJwtPayload(accessToken)?.exp);
          if (exp && exp <= Math.trunc(Date.now() / 1000)) {
            return { status: "dead", reason: "JWT 已过期" };
          }

          const accountIdCandidate = firstNonEmpty(
            item?.sub2apiAccount?.credentials?.chatgpt_account_id,
            item?.cpa?.chatgpt_account_id,
            item?.cpa?.account_id,
            item?.nineRouter?.providerSpecificData?.chatgptAccountId,
            item?.codexAuthJson?.tokens?.account_id,
            item?.codexManager?.tokens?.chatgpt_account_id,
          );
          const accountId = /^[A-Za-z0-9_-]{1,128}$/.test(String(accountIdCandidate || "").trim())
            ? String(accountIdCandidate).trim()
            : "";
          const headers = {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
          };

          if (isDesktopRuntime) {
            let lastResult = { status: "unknown", reason: "未请求" };
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                const probe = await tauri.core.invoke("probe_chatgpt_workspace", {
                  accessToken,
                  accountId,
                });
                const effectiveStatus = Number(probe?.status || 0);
                const result = effectiveStatus === 0
                  ? {
                      status: "unknown",
                      reason: probe?.code === "timeout" ? "上游请求超时" : "上游网络请求失败",
                    }
                  : classifyLiveCheckHttpStatus(effectiveStatus, probe);
                if (result.status !== "unknown" || ![429, 500, 502, 503, 504].includes(effectiveStatus) || attempt === 2) {
                  return result;
                }
                lastResult = result;
              } catch {
                lastResult = { status: "unknown", reason: "桌面检测内核调用失败" };
                if (attempt === 2) return lastResult;
              }
              await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
            }
            return lastResult;
          }

          let lastResult = { status: "unknown", reason: "未请求" };
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const controller = new AbortController();
            state.liveCheckControllers.add(controller);
            const timer = setTimeout(() => controller.abort(), 15_000);
            try {
              const response = await fetch("/api/tools/session-health", {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
                headers,
                signal: controller.signal,
              });
              let payload = null;
              if (typeof response.json === "function") {
                try {
                  payload = await response.json();
                } catch {}
              }
              const probe = payload?.probe || null;
              const effectiveStatus = Number(probe?.status) > 0 ? Number(probe.status) : response.status;
              const result = probe?.status === 0
                ? {
                    status: "unknown",
                    reason: probe.code === "timeout" ? "上游请求超时" : "上游网络请求失败",
                  }
                : classifyLiveCheckHttpStatus(effectiveStatus, probe);
              if (result.status !== "unknown" || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
                return result;
              }
              lastResult = result;
            } catch (error) {
              lastResult = {
                status: "unknown",
                reason: error?.name === "AbortError" ? "请求超时" : "网络请求失败",
              };
              if (attempt === 2) return lastResult;
            } finally {
              clearTimeout(timer);
              state.liveCheckControllers.delete(controller);
            }
            await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
          }
          return lastResult;
        }

        async function runLiveCheck() {
          if (state.liveChecking || !state.converted.length) return;

          ensureLiveChecks();
          const runId = state.liveCheckRunId + 1;
          state.liveCheckRunId = runId;
          state.liveChecking = true;
          state.liveChecks = state.converted.map(() => ({ status: "pending", reason: "排队中" }));
          renderLiveChecks();
          setStatus(elements.liveCheckStatus, `开始检测 ${state.converted.length} 个账号。`);

          const concurrency = Math.max(1, Math.min(20, Number(elements.liveCheckConcurrency.value) || 5));
          elements.liveCheckConcurrency.value = String(concurrency);
          const queue = state.converted.map((item, index) => ({ item, index }));
          let completed = 0;

          async function worker() {
            while (queue.length && state.liveCheckRunId === runId) {
              const next = queue.shift();
              if (!next) return;
              state.liveChecks[next.index] = { status: "checking", reason: "检测中" };
              renderLiveChecks();
              const result = await probeChatgptModel(next.item);
              if (state.liveCheckRunId !== runId) return;
              state.liveChecks[next.index] = result;
              completed += 1;
              renderLiveChecks();
              setStatus(elements.liveCheckStatus, `检测中：${completed}/${state.converted.length}`);
            }
          }

          await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
          if (state.liveCheckRunId !== runId) return;

          state.liveChecking = false;
          renderLiveChecks();
          const alive = state.liveChecks.filter((item) => item.status === "alive").length;
          const dead = state.liveChecks.filter((item) => item.status === "dead").length;
          const unknown = state.liveChecks.filter((item) => item.status === "unknown").length;
          setStatus(elements.liveCheckStatus, `检测完成：可用 ${alive} 个，不可用 ${dead} 个，未知 ${unknown} 个。`, dead ? "error" : unknown ? "warning" : "ok");
        }

        function downloadJsonDocument(documentValue, fileName) {
          const text = JSON.stringify(documentValue, null, 2);
          downloadBlob(new Blob([text], { type: "application/json;charset=utf-8" }), fileName);
        }

        function downloadCleanOutput() {
          if (!state.converted.length) return;
          const cleaned = getCleanConvertedAfterLiveCheck();
          if (!cleaned.length) {
            setStatus(elements.liveCheckStatus, "清理后没有可下载账号。", "error");
            return;
          }
          const removedCount = state.converted.length - cleaned.length;
          if (state.mode === "sub-to-cpa") {
            const files = cleaned.filter((item) => item.cpa).map((item) => ({
              name: item.fileName || "codex-account.json",
              data: item.cpa,
            }));
            if (files.length > 1) {
              downloadJsonDocument({
                type: "cliproxyapi-auth-list",
                version: 1,
                exported_at: new Date().toISOString(),
                note: "清理后的合并 JSON 清单；auths 包含全部保留账号。",
                auths: files.map((file) => file.data),
              }, `cliproxyapi-auth-list.clean.${getTimestampToken()}.json`);
            } else if (files.length === 1) {
              downloadBlob(
                new Blob([JSON.stringify(files[0].data, null, 2)], { type: "application/json;charset=utf-8" }),
                files[0].name.replace(/\.json$/i, ".clean.json"),
              );
            }
          } else if (state.mode === "cpa-to-sub") {
            const accounts = cleaned.map((item) => item.sub2apiAccount).filter(Boolean);
            downloadJsonDocument(bridge.buildSub2APIImportBody(accounts, new Date().toISOString()), `sub2api-import.clean.${getTimestampToken()}.json`);
          } else {
            const first = cleaned[0];
            const base = sanitizeFileToken(first?.email || first?.name || state.format);
            const fileName = `${base}.${state.format}.clean.${getTimestampToken()}.json`;
            downloadJsonDocument(buildOutputDocument(cleaned), fileName);
          }
          setStatus(elements.liveCheckStatus, `已下载清理后的结果，移除 ${removedCount} 个不可用 / 过期账号。`, "ok");
        }

        function rebuildBridgeArtifactsFromConverted() {
          if (state.mode === "session") return;
          const now = new Date().toISOString();
          if (state.mode === "cpa-to-sub") {
            const accounts = state.converted.map((item) => item.sub2apiAccount).filter(Boolean);
            state.bridgeOutput = bridge.buildSub2APIImportBody(accounts, now);
            state.downloadKind = "json";
            state.downloadFileName = "sub2api-import.json";
            state.cpaFiles = [];
            state.sub2apiFiles = accounts.map((account, index) => ({
              name: state.converted[index]?.fileName || `sub2api-account-${index + 1}.json`,
              data: bridge.buildSub2APIImportBody([account], now),
            }));
            return;
          }

          const auths = state.converted.map((item) => item.cpa).filter(Boolean);
          state.cpaFiles = state.converted
            .filter((item) => item.cpa)
            .map((item) => ({ name: item.fileName || "codex-account.json", data: item.cpa }));
          state.bridgeOutput = {
            type: "cliproxyapi-auth-list",
            version: 1,
            exported_at: now,
            note: "合并 JSON 清单；auths 包含全部转换结果。需要 CLIProxyAPI 原生单账号文件时可另选拆分 ZIP。",
            auths,
          };
          state.downloadKind = "json";
          state.downloadFileName = auths.length > 1
            ? "cliproxyapi-auth-list.json"
            : (state.cpaFiles[0]?.name || "codex-account.json");
          state.sub2apiFiles = [];
        }

        function removeDeadAccountsFromOutput() {
          const deadIndexes = new Set(getDeadLiveCheckIndexes());
          if (!deadIndexes.size) {
            setStatus(elements.liveCheckStatus, "当前没有可删除的不可用 / 过期账号。");
            return;
          }
          state.converted = state.converted.filter((_item, index) => !deadIndexes.has(index));
          state.liveChecks = state.liveChecks.filter((_item, index) => !deadIndexes.has(index));
          rebuildBridgeArtifactsFromConverted();
          updateOutput();
          setStatus(elements.liveCheckStatus, `已从转换结果删除 ${deadIndexes.size} 个不可用 / 过期账号。`, "ok");
        }

        function updateModeChrome() {
          const isSession = state.mode === "session";
          elements.modeButtons.forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
          });
          elements.formatButtons.forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.format === state.format));
          });
          elements.formatGroup?.classList.toggle("is-locked", !isSession);
          if (elements.sessionGuide) elements.sessionGuide.hidden = !isSession;
          if (elements.bridgeGuide) elements.bridgeGuide.hidden = isSession;

          if (isSession) {
            if (elements.inputTitle) elements.inputTitle.textContent = "Session JSON";
            if (elements.inputHint) elements.inputHint.textContent = "粘贴 ChatGPT Web session，或拖入一个或多个 JSON 文件。";
            if (elements.modeHint) elements.modeHint.textContent = "粘贴 ChatGPT session，导出为 CPA / sub2api 等目标格式。";
            elements.input.placeholder = '{"user":{"email":"mark@example.com"},"expires":"2026-08-06T14:29:36.155Z","account":{"id":"...","planType":"plus"},"accessToken":"...","sessionToken":"..."}';
          } else if (state.mode === "cpa-to-sub") {
            if (elements.inputTitle) elements.inputTitle.textContent = "CPA Auth JSON";
            if (elements.inputHint) elements.inputHint.textContent = "粘贴 CLIProxyAPI auth 文件内容，或拖入多个 auth JSON。支持 codex / claude / xai / antigravity。";
            if (elements.modeHint) elements.modeHint.textContent = "CPA 账号 → sub2api-data 导入包（含 claude / xai / antigravity）。";
            if (elements.bridgeGuideTitle) elements.bridgeGuideTitle.textContent = "CPA → sub2api";
            if (elements.bridgeGuideBody) {
              elements.bridgeGuideBody.textContent = "输入 CLIProxyAPI 的 auth JSON（可数组、auths 列表或多文件）。输出 sub2api-data 信封，字段对齐最新导入算法。";
            }
            elements.input.placeholder = '[{"type":"codex","email":"...","access_token":"...","account_id":"...","expired":"..."}]';
          } else {
            if (elements.inputTitle) elements.inputTitle.textContent = "sub2api 导出 JSON";
            if (elements.inputHint) elements.inputHint.textContent = "粘贴 sub2api-data / accounts 数组，或拖入导出文件。多账号可下载合并 JSON 或拆分 ZIP。";
            if (elements.modeHint) elements.modeHint.textContent = "sub2api 账号 → CLIProxyAPI auth；合并与拆分由你选择。";
            if (elements.bridgeGuideTitle) elements.bridgeGuideTitle.textContent = "sub2api → CPA";
            if (elements.bridgeGuideBody) {
              elements.bridgeGuideBody.textContent = "输入 type=sub2api-data 的导出包或单个 account。gemini 仅支持历史单向迁移；openai / anthropic / grok / antigravity 可还原为 CPA。";
            }
            elements.input.placeholder = '{"type":"sub2api-data","version":1,"exported_at":"...","proxies":[],"accounts":[...]}';
          }
        }

        function updateOutput() {
          const hasConverted = state.converted.length > 0;
          let outputText = "";
          const documentValue = hasConverted ? buildOutputDocument() : null;

          if (documentValue != null) {
            outputText = JSON.stringify(documentValue, null, 2);
          }

          state.outputText = outputText;
          elements.output.value = outputText;
          elements.copyOutput.disabled = !outputText;
          elements.downloadOutput.disabled = !outputText;
          elements.statCount.textContent = String(state.converted.length);
          elements.statErrors.textContent = String(state.skipped.length);

          const splitDetails = splitExportDetails();
          const canSplitSub2api = splitDetails?.kind === "sub2api";
          if (elements.downloadSplit) {
            elements.downloadSplit.hidden = !splitDetails;
            elements.downloadSplit.disabled = !splitDetails;
            elements.downloadSplit.textContent = splitDetails
              ? `拆分 ZIP（${splitDetails.count}）`
              : "拆分 ZIP";
          }

          if (state.mode === "session") {
            const unsupportedCount = state.converted.length - itemsForSessionFormat(state.converted, state.format).length;
            const unsupportedNote = unsupportedCount
              ? `已跳过 ${unsupportedCount} 个 Agent Identity 账号：该格式无对应字段，仅 sub2api 支持。`
              : "";
            elements.statFormat.textContent = OUTPUT_LABELS[state.format];
            elements.outputSubtitle.textContent = (canSplitSub2api && state.format === "sub2api"
              ? `当前输出为合并 sub2api-data；可用「拆分 ZIP」按账号导出 ${state.sub2apiFiles.length} 个文件。`
              : `当前输出为 ${OUTPUT_LABELS[state.format]} 导入 JSON。`) + (unsupportedNote ? ` ${unsupportedNote}` : "");
            elements.downloadOutput.textContent = "下载 JSON";
            elements.cpaNotice.style.display = ["cpa", "cockpit", "codex", "axonhub", "codexmanager"].includes(state.format) ? "block" : "none";
          } else if (state.mode === "cpa-to-sub") {
            elements.statFormat.textContent = "sub2api";
            elements.outputSubtitle.textContent = canSplitSub2api
              ? `当前输出为合并 sub2api-data；可用「拆分 ZIP」按账号导出 ${state.sub2apiFiles.length} 个导入文件。`
              : "当前输出为 sub2api-data 导入 JSON。";
            elements.downloadOutput.textContent = "下载 JSON";
            elements.cpaNotice.style.display = "none";
          } else {
            elements.statFormat.textContent = "CPA";
            elements.outputSubtitle.textContent = splitDetails?.kind === "cpa"
              ? `当前输出为包含 ${state.cpaFiles.length} 个账号的合并 JSON；也可选择「拆分 ZIP」导出原生 auth 文件。`
              : "当前输出为单个 CLIProxyAPI auth JSON。";
            elements.downloadOutput.textContent = "下载 JSON";
            elements.cpaNotice.style.display = "block";
          }

          renderAccounts();
          renderIssues();
          renderLiveChecks();

          if (outputText) {
            setStatus(elements.outputStatus, `已生成 ${state.converted.length} 个账号。`, "ok");
          } else {
            setStatus(elements.outputStatus, "暂无输出。", state.skipped.length ? "error" : "");
          }
        }

        function renderAccounts() {
          if (!state.converted.length) {
            elements.accountBody.innerHTML = '<tr><td colspan="4" class="empty">暂无可转换账号。</td></tr>';
            return;
          }

          elements.accountBody.innerHTML = state.converted.map((item) => {
            const source = item.kind === "bridge"
              ? `${item.provider || item.platform || "bridge"} · ${item.sourceName || "input"}`
              : (item.sourceName || "pasted-json");
            return `
            <tr>
              <td><div class="cell-clip" title="${escapeHtml(item.name)}">${escapeHtml(item.name || "-")}</div></td>
              <td><div class="cell-clip" title="${escapeHtml(item.email)}">${escapeHtml(item.email || "-")}</div></td>
              <td><div class="cell-clip" title="${escapeHtml(item.expiresAt)}">${escapeHtml(formatDisplayDate(item.expiresAt) || "-")}</div></td>
              <td><div class="cell-clip" title="${escapeHtml(source)}">${escapeHtml(source)}</div></td>
            </tr>
          `;
          }).join("");
        }

        function renderIssues() {
          if (!state.skipped.length && !state.warnings.length) {
            elements.issues.classList.remove("is-visible");
            elements.issues.textContent = "";
            return;
          }

          const line = (item, className) => `<div${className ? ` class="${className}"` : ""}>${escapeHtml(item.sourceName || "input")} ${escapeHtml(item.path || "")}: ${escapeHtml(item.reason)}</div>`;
          elements.issues.classList.add("is-visible");
          elements.issues.innerHTML = [
            ...state.skipped.map((item) => line(item, "")),
            ...state.warnings.map((item) => line(item, "issue-warning")),
          ].join("");
        }

        function scheduleConvert() {
          const text = elements.input.value;
          if (!text.trim()) {
            state.converted = [];
            state.skipped = [];
            state.warnings = [];
            state.sessions = [];
            state.lastAutoMode = null;
            clearBridgeArtifacts();
            resetLiveChecks();
            updateOutput();
            setStatus(elements.inputStatus, "等待输入。");
            return;
          }

          try {
            const autoSwitched = maybeAutoDetectMode(text);
            convertFromText(text);
            if (state.converted.length) {
              const autoNote = autoSwitched
                ? `已自动识别为「${MODE_LABELS[autoSwitched]}」。`
                : "";
              setStatus(
                elements.inputStatus,
                `${autoNote}解析完成：${state.converted.length} 个账号，跳过 ${state.skipped.length} 项。`.trim(),
                "ok",
              );
            } else {
              setStatus(elements.inputStatus, "没有可转换账号。", "error");
            }
          } catch (error) {
            state.converted = [];
            state.skipped = [{
              sourceName: "pasted-json",
              path: "$",
              reason: error instanceof Error ? error.message : "JSON 解析失败",
            }];
            state.outputText = "";
            clearBridgeArtifacts();
            resetLiveChecks();
            updateOutput();
            setStatus(elements.inputStatus, error instanceof Error ? error.message : "JSON 解析失败", "error");
          }
        }

        async function downloadBlob(blob, fileName) {
          if (isDesktopRuntime) {
            try {
              const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
              const savedPath = await tauri.core.invoke("save_output_file", {
                suggestedName: fileName,
                bytes,
              });
              if (!savedPath) return null;
              setStatus(elements.outputStatus, `已保存到 ${savedPath}`, "ok");
              return savedPath;
            } catch (error) {
              setStatus(elements.outputStatus, error instanceof Error ? error.message : String(error), "error");
              return null;
            }
          }

          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = fileName;
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          return fileName;
        }

        function downloadOutput() {
          if (!state.outputText) {
            return;
          }

          if (state.mode === "sub-to-cpa" && state.cpaFiles.length === 1) {
            downloadBlob(
              new Blob([JSON.stringify(state.cpaFiles[0].data, null, 2)], { type: "application/json;charset=utf-8" }),
              state.cpaFiles[0].name || state.downloadFileName || "codex-account.json",
            );
            return;
          }

          const first = state.converted[0];
          const base = sanitizeFileToken(first?.email || first?.name || state.format);
          const fileName = state.mode === "cpa-to-sub"
            ? (state.downloadFileName || `sub2api-import.${getTimestampToken()}.json`)
            : state.mode === "sub-to-cpa"
              ? (state.downloadFileName || `cliproxyapi-auth-list.${getTimestampToken()}.json`)
            : `${base}.${state.format}.${getTimestampToken()}.json`;
          downloadBlob(new Blob([state.outputText], { type: "application/json;charset=utf-8" }), fileName);
        }

        function downloadSplitZip() {
          const details = splitExportDetails();
          if (!details) {
            setStatus(elements.outputStatus, "当前没有可拆分的多个账号。", "error");
            return;
          }
          const isCpa = details.kind === "cpa";
          const zipBytes = isCpa
            ? bridge.buildZipFromCpaFiles(state.cpaFiles)
            : bridge.buildZipFromSub2apiFiles(state.sub2apiFiles);
          const fileName = isCpa
            ? `cliproxyapi-auth-files.split.${getTimestampToken()}.zip`
            : `sub2api-accounts.split.${getTimestampToken()}.zip`;
          downloadBlob(new Blob([zipBytes], { type: "application/zip" }), fileName);
          setStatus(elements.outputStatus, `已下载拆分 ZIP（${details.count} 个${isCpa ? " CPA auth" : " sub2api 导入"}文件）。`, "ok");
        }

        async function copyOutput() {
          if (!state.outputText) {
            return;
          }

          try {
            await navigator.clipboard.writeText(state.outputText);
            setStatus(elements.outputStatus, "已复制到剪贴板。", "ok");
          } catch {
            elements.output.select();
            document.execCommand("copy");
            setStatus(elements.outputStatus, "已复制到剪贴板。", "ok");
          }
        }

        async function readFiles(files) {
          const jsonFiles = Array.from(files).filter((file) => file.name.toLowerCase().endsWith(".json"));
          if (!jsonFiles.length) {
            setStatus(elements.inputStatus, "没有选择 JSON 文件。", "error");
            return;
          }

          const payloads = [];
          for (const file of jsonFiles) {
            payloads.push({
              name: file.webkitRelativePath || file.name,
              text: await file.text(),
            });
          }
          const joinedText = payloads.length === 1
            ? payloads[0].text
            : payloads.map((item) => item.text).join("\n");
          elements.input.value = joinedText;
          const autoSwitched = maybeAutoDetectMode(joinedText);

          if (state.mode !== "session") {
            applyBridgeResult(bridge.convertBridgeFiles(payloads, state.mode));
            const autoNote = autoSwitched ? `已自动识别为「${MODE_LABELS[autoSwitched]}」。` : "";
            setStatus(
              elements.inputStatus,
              `${autoNote}读取 ${jsonFiles.length} 个文件，生成 ${state.converted.length} 个账号，跳过 ${state.skipped.length} 项。`.trim(),
              state.converted.length ? "ok" : "error",
            );
            return;
          }

          const documents = [];
          const skipped = [];

          for (const file of jsonFiles) {
            try {
              const text = await file.text();
              const parsed = JSON.parse(text);
              const found = collectSessionLikeObjects(parsed, file.webkitRelativePath || file.name);
              if (!found.length) {
                skipped.push({
                  sourceName: file.webkitRelativePath || file.name,
                  path: "$",
                  reason: "未找到包含 accessToken 和 user/email 的 session 对象",
                });
              }
              documents.push(...found);
            } catch (error) {
              skipped.push({
                sourceName: file.webkitRelativePath || file.name,
                path: "$",
                reason: error instanceof Error ? error.message : "无法读取文件",
              });
            }
          }

          const now = new Date();
          const converted = [];
          const convertSkipped = [...skipped];
          documents.forEach((item) => {
            try {
              converted.push(convertSession(item.value, {
                now,
                sourceName: item.sourceName,
                sourcePath: item.path,
              }));
            } catch (error) {
              convertSkipped.push({
                sourceName: item.sourceName,
                path: item.path,
                reason: error instanceof Error ? error.message : "无法转换",
              });
            }
          });

          state.sessions = documents;
          state.converted = converted;
          state.skipped = convertSkipped;
          clearBridgeArtifacts();
          resetLiveChecks();
          elements.input.value = documents.length === 1
            ? JSON.stringify(documents[0].value, null, 2)
            : JSON.stringify(documents.map((item) => item.value), null, 2);
          updateOutput();
          setStatus(elements.inputStatus, `读取 ${jsonFiles.length} 个文件，生成 ${converted.length} 个账号，跳过 ${convertSkipped.length} 项。`, converted.length ? "ok" : "error");
        }

        function setMode(mode, options = {}) {
          const { fromAuto = false } = options;
          if (!MODE_LABELS[mode]) {
            updateModeChrome();
            return;
          }
          // Manual mode click disables auto-detect so the choice sticks.
          if (!fromAuto && elements.autoDetectMode) {
            state.autoDetectMode = false;
            elements.autoDetectMode.checked = false;
          }
          if (state.mode === mode) {
            updateModeChrome();
            if (!fromAuto) scheduleConvert();
            return;
          }
          state.mode = mode;
          if (mode === "cpa-to-sub") state.format = "sub2api";
          if (mode === "sub-to-cpa") state.format = "cpa";
          updateModeChrome();
          if (!fromAuto) scheduleConvert();
        }

        elements.modeButtons.forEach((button) => {
          button.addEventListener("click", () => setMode(button.dataset.mode));
        });

        elements.formatButtons.forEach((button) => {
          button.addEventListener("click", () => {
            if (state.mode !== "session") return;
            state.format = button.dataset.format;
            elements.formatButtons.forEach((item) => {
              item.setAttribute("aria-pressed", String(item === button));
            });
            refreshSub2apiSplitFiles();
            updateOutput();
          });
        });

        if (elements.autoDetectMode) {
          elements.autoDetectMode.addEventListener("change", () => {
            state.autoDetectMode = Boolean(elements.autoDetectMode.checked);
            if (state.autoDetectMode) scheduleConvert();
          });
        }

        elements.input.addEventListener("input", scheduleConvert);
        elements.copyOutput.addEventListener("click", copyOutput);
        elements.downloadOutput.addEventListener("click", downloadOutput);
        elements.downloadSplit?.addEventListener("click", downloadSplitZip);
        elements.upstreamCheckButton?.addEventListener("click", checkUpstreamUpdates);
        elements.liveCheckButton.addEventListener("click", runLiveCheck);
        elements.removeDeadButton.addEventListener("click", removeDeadAccountsFromOutput);
        elements.downloadCleanButton.addEventListener("click", downloadCleanOutput);
        elements.pickFiles.addEventListener("click", () => elements.fileInput.click());
        elements.fileInput.addEventListener("change", (event) => {
          readFiles(event.target.files);
          event.target.value = "";
        });

        elements.clearInput.addEventListener("click", () => {
          elements.input.value = "";
          // Clearing re-enables auto-detect for the next paste.
          state.autoDetectMode = true;
          if (elements.autoDetectMode) elements.autoDetectMode.checked = true;
          scheduleConvert();
        });

        elements.loadExample.addEventListener("click", () => {
          if (state.mode === "session") {
            elements.input.value = JSON.stringify(exampleSession, null, 2);
          } else {
            elements.input.value = bridge.samples[state.mode] || "";
          }
          scheduleConvert();
        });

        if (elements.autoDetectMode) {
          state.autoDetectMode = Boolean(elements.autoDetectMode.checked);
        }

        document.addEventListener?.("click", (event) => {
          const link = event.target?.closest?.("a[href]");
          if (!isDesktopRuntime || !link || !/^https:\/\//i.test(link.href)) {
            return;
          }
          event.preventDefault();
          tauri.core.invoke("open_external_url", { url: link.href }).catch((error) => {
            setStatus(elements.outputStatus, `无法打开系统浏览器：${error instanceof Error ? error.message : String(error)}`, "error");
          });
        });

        document.addEventListener?.("dragover", (event) => {
          if (!event.dataTransfer?.types?.includes("Files")) return;
          event.preventDefault();
          document.body.classList.add("is-file-dragging");
          event.dataTransfer.dropEffect = "copy";
        });
        document.addEventListener?.("dragleave", (event) => {
          if (!event.relatedTarget) document.body.classList.remove("is-file-dragging");
        });
        document.addEventListener?.("drop", (event) => {
          if (!event.dataTransfer?.files?.length) return;
          event.preventDefault();
          document.body.classList.remove("is-file-dragging");
          readFiles(event.dataTransfer.files);
        });
        updateModeChrome();
        updateOutput();
      })();
