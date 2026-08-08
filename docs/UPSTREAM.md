# GPTSession2CPAandSub2API 上游记录

- 上游仓库：<https://github.com/gtxx3600/GPTSession2CPAandSub2API>
- 固定提交：`a097eb155bb7bdf6cbbc26f1e4e75e120ab3163c`
- 导入日期：2026-07-16
- 许可证：MIT，完整文本见同目录 `LICENSE`

## 账户导出算法钉（P0，2026-08-08 复核）

转换器的 **sub2api / CPA 账户字段** 已对齐下列仓库的导入/存储核心算法（只抽取 schema 与字段规则，不嵌入完整服务代码），对照实现参考 [cvt.okcode.cc.cd](https://cvt.okcode.cc.cd/) / [semyin/cvt](https://github.com/semyin/cvt)：

| 目标格式 | 源仓库 | 钉死提交 | 日期 | 核心依据 |
| --- | --- | --- | --- | --- |
| CPA | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `197f520426374e514218ed155933ac546c98d345`（短：`197f5204`） | 2026-08-08 | `internal/auth/codex/token.go`（`CodexTokenStorage`）、`jwt_parser.go` |
| sub2api | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) | `cc67b1aca1d3b590609abef2fcd3a6ca31c5c651`（短：`cc67b1ac`） | 2026-08-08 | `backend/internal/handler/admin/account_codex_import.go`、`backend/internal/pkg/openai/oauth.go`（`ClientID`） |

页面顶部「算法与软件更新」由 `bridge.js` 的 **`SOURCE_PINS`** 渲染（HTML 含首屏静态回退）。桌面版会比较固定仓库 `main` 最新提交与这些审计钉，同时检查本仓库正式 Release。算法上游源码不会被直接下载或执行；只有完成映射复核并发布的签名安装包可以在应用内更新。两仓更新后：

1. diff 上表对应文件；
2. 改映射算法；
3. 更新 `SOURCE_PINS`、Rust `upstream.rs` 固定 SHA 与本表；
4. 同步缓存版本号并执行回归测试。

P0 行为要点：

- sub2api 根对象使用 `type: "sub2api-data"`、`version: 1`、`proxies`、`accounts`。
- OpenAI OAuth 账户默认 `concurrency: 10`、`priority: 1`、`rate_multiplier: 1`、`auto_pause_on_expired: true`。
- 有 `refresh_token` 时写入官方 `client_id = app_EMoamEEZ73f0CkXaXp7hrann`。
- `credentials` 写入 `access_token`、可选 `id_token` / `refresh_token`、`chatgpt_account_id`、`chatgpt_user_id`、`organization_id`、`plan_type`；令牌过期写在 `credentials.expires_at`（优先 access JWT `exp`），不再因存在 refresh 而清空。
- CPA 输出以 `CodexTokenStorage` 核心字段为准：`type/id_token/access_token/refresh_token/account_id/last_refresh/email/expired`；并保留兼容扩展字段。
- session cookie 的 `expires` 仅记入 `extra.session_expires_at`，不当作 access token 过期时间。

## Agent Identity 凭据（2026-07-26 重新对齐）

本次按上表新提交逐文件复核，结论：

- `gtxx3600/GPTSession2CPAandSub2API` 的 `a097eb15` 仍是 HEAD，无漂移；
- CLIProxyAPI 的 `internal/auth/codex/token.go` 与 `jwt_parser.go` 在 `42a00a2a → 197f5204` 之间 blob SHA 完全相同，CPA 映射无需改动；
- sub2api 的 `account_codex_import.go` 与 `pkg/openai/oauth.go` 在 `2730c1c4 → cc67b1ac` 之间 blob SHA 完全相同，导入字段与 ClientID 无漂移；
- sub2api 的 `account_codex_import.go` 新增 **Agent Identity** 凭据模式，`backend/internal/pkg/openai/oauth.go` 的 `ClientID` 未变（旧记录里的路径 `pkg/openai/oauth.go` 写错，已修正）。

Agent Identity 行为要点（对齐 `2730c1c4`）：

- 识别：`agent_identity` / `agentIdentity` 为对象时以该对象为字段来源；否则 `auth_mode` / `authMode` 大小写不敏感等于 `agentIdentity` 时以记录本身为来源。字段抽取 snake_case 优先、camelCase 兜底。
- 必填 `agent_runtime_id`、`agent_private_key`、`account_id`、`chatgpt_user_id`，缺任一报「agent identity 缺少必要字段」。
- 私钥采用**结构化 DER 校验**（同步、离线、无依赖）替代上游 `x509.ParsePKCS8PrivateKey`：校验 PKCS#8 外层 SEQUENCE、`INTEGER 0`、Ed25519 OID `1.3.101.112`、内层 `OCTET STRING` 长度 32；只返回布尔，不回显密钥内容。非法报「agent identity private key 格式无效」。
- `credentials` 写入 `auth_mode = "agentIdentity"`（驼峰值）、`agent_runtime_id`、`agent_private_key`、`chatgpt_account_id`、`chatgpt_user_id`、`chatgpt_account_is_fedramp`（**恒写入，含 `false`**）；`task_id` / `email` / `plan_type` 仅非空时写入。
- 对应上游 `resolveCodexImportExpiry` 返回全 nil：**不写 `expires_at`**，`auto_pause_on_expired` **保持缺省（omit，而非 `false`）**。
- 无 `task_id` 时提示「未包含 task_id，首次请求会使用现有 runtime 注册新 task」。
- `extra.identity_key` 取 `account:<account_id>`（对齐 `buildCodexAgentIdentityKeys`，不含 user / runtime）。
- 输出格式：**仅 sub2api**。CPA / Cockpit / 9router / Codex / AxonHub / Codex-Manager 无对应字段，直接跳过该账号并在界面标注，不产出残缺 auth 文件。
- sub2api → CPA 方向明确拒绝：`CodexTokenStorage` 无 runtime / private key 字段。桥接凭据白名单同步补齐上游 protected 键 `agent_runtime_id`、`agent_private_key`、`task_id`。
- 该类记录**不参与实际模型检测**：无 access token 且持有 Ed25519 私钥，永不进入 `/api/tools/session-health` 请求路径。

## 双向桥接（P1，2026-07-24）

实现文件：`public/tools/session-converter/bridge.js`（纯本地算法，无网络）。

- 模式 `CPA → sub2api`：CLIProxyAPI auth JSON / 数组 / `auths[]` → `sub2api-data`。
- 模式 `sub2api → CPA`：`sub2api-data` / account 对象 → CPA auth；多账号主输出为含 `auths` 的合并 JSON，并可选择拆分 ZIP（每账号一个原生文件）。
- 提供商映射：`codex/openai ↔ openai`、`claude/anthropic ↔ anthropic`、`xai ↔ grok`、`antigravity ↔ antigravity`；Gemini 仅保留 CPA→sub2api 单向历史迁移。
- 对照实现仍对齐上表钉死提交与 [cvt.okcode.cc.cd](https://cvt.okcode.cc.cd/) 字段规则。

## 本地整合修改

- 从上游 `docs/index.html` 导入功能实现。
- 把内联样式和脚本拆分为 `converter.css` 与 `converter.js`，以适配严格的 Content Security Policy。
- 增加独立桌面导航、隐私说明和上游署名。
- 移除与格式转换无关的第三方频道推广。
- 增加本地扩展“实际模型检测与清理”：用户主动点击后，浏览器调用同源固定接口 `/api/tools/session-health`；服务端按官方 Codex 链路读取模型列表并发送最小 Responses 请求。记录包含空间 ID 时发送 `ChatGPT-Account-ID`，HTTP 401、402、403 与本地过期进入可清理集合；此功能不属于上游固定提交。
- 服务端为该路径设置严格 CSP，`connect-src` 只允许 `'self'`；检测接口不接收任意 URL、模型或请求体，不持久化 access token，并设置来源限流和全局并发限制。
- 不使用 localStorage、sessionStorage、IndexedDB 或 Cookie，页面刷新后不恢复凭证或测活结果。
- 2026-07-24：按上表钉死提交对齐 sub2api/CPA 账户导出字段（P0）。
- 2026-07-26：重新对齐上游至 CLIProxyAPI `42a00a2a` / sub2api `2730c1c4`，实现 sub2api Agent Identity 凭据模式（见上节）。
- 2026-07-26：按 CLIProxyAPI `42a00a2a` 的 `cmd/fetch_codex_models/main.go` 与 `internal/runtime/executor/codex_executor_request.go` 校正模型检测请求头（`lib/session-health.mjs`）：
  - 补 `User-Agent: codex_cli_rs/<client_version> (Mac OS ...)`。此前未设，运行时默认发出 `User-Agent: node`；上游明确注明剥离调用方 UA 是为了减少 Cloudflare 1010 拦截，而拦截返回 403 会被本模块判成账号不可用并进入可清理集合，属误删风险。
  - `/responses` 补 `Session_id`（上游仅在 UA 含 `Mac OS` 时下发，models 列表不发）。
  - 去掉非上游的 `version` 请求头（上游 models 拉取器不发，executor 只透传调用方传入值）。
  - 请求体不再发 `parallel_tool_calls`：上游 `normalizeCodexParallelToolCallsForTools` 在 `tools` 为空时删除该字段。
  - 已核对无需改动：base URL、`GET /models?client_version=`、`POST /responses`、`stream: true`、`instructions: ""`、`Originator: codex_cli_rs`、`Chatgpt-Account-Id`、模型按 `visibility === "list"` 挑选。

- 2026-08-08：重新复核并钉到 CLIProxyAPI `197f5204` / sub2api `cc67b1ac`。账户 schema 文件无内容变化；Codex 检测身份更新为配套的 `codex-tui/0.146.0`、`Originator: codex-tui`、`Version: 0.146.0`，Responses 请求补 `OpenAI-Beta: responses=experimental`。
- 2026-08-08：检测开始读取最多 256 KiB 的 SSE 响应并识别流内错误。明确停用/鉴权错误才标记不可用；`server_is_overloaded`、限流、网络错误和 5xx 保持未知，避免误清理。
- 2026-08-08：原始 Session 转换上游仍为 `a097eb15`，没有新提交。本项目继续以 access JWT `exp` 为 token 到期依据，`sessionToken` 为可选字段，Session Cookie `expires` 只存入 `extra.session_expires_at`。

本地检测只筛除确认 401、402、403 或本地确认过期的转换项，不改写其余输出字段。真实模型检测会产生极少量模型用量。后续升级必须重新核对 CLIProxyAPI / sub2api 账户 schema 与官方 Codex 请求协议，并执行安全审计、上游测试和桌面应用回归测试。
