# 独立提取记录

- 源目录：`D:\Demo\kami`
- 源提交：`49bbda5` (`docs: record batch redemption deployment`)
- 提取日期：2026-08-08

## 文件映射

| 原项目来源 | 新仓库 | 处理 |
| --- | --- | --- |
| `public/tools/session-converter/bridge.js` | `src/bridge.js` | 保留纯本地 CPA/sub2api 桥接、ZIP 和自动识别算法 |
| `public/tools/session-converter/converter.js` | `src/converter.js` | 保留 Session 多格式转换和 UI 状态；增加 Tauri 原生保存与 Rust 检测分支 |
| `public/tools/session-converter/index.html` | `src/index.html` | 去除原站点导航和商业推广，改为独立桌面产品文案 |
| `public/tools/session-converter/converter.css` | `src/styles.css` | 保留响应式桌面界面并统一独立品牌 |
| `lib/session-health.mjs` | `src-tauri/src/health.rs` | 将固定用途 Node 中继改写为本地 Rust 命令 |
| `test/vendor-session-converter.test.cjs` | `tests/converter.test.cjs` | 保留完整算法回归测试，路径改为独立仓库 |
| `public/tools/session-converter/LICENSE` | `LICENSE` | 保留 MIT 上游声明并增加桌面仓库贡献者 |
| `public/tools/session-converter/UPSTREAM.md` | `docs/UPSTREAM.md` | 保留上游提交和字段映射依据 |

## 明确排除

- 原项目的兑换、库存、管理后台、数据库和上传逻辑
- 原项目静态服务与 `/api/tools/session-health` 路由
- GPT 账号商业推广入口
- 服务端限流与部署脚本

桌面版没有公开 HTTP 服务，因此原有中继接口的公网限流不再适用；健康检测仍保留前端并发上限、Rust 超时与固定目标限制。
