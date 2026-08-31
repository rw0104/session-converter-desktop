# Session Converter Desktop

一个本地优先、跨平台的登录凭证格式转换桌面工具。转换模块从现有项目中独立提取，使用 Tauri 2 + Rust + 系统 WebView 封装，不捆绑 Chromium，也不需要常驻 Node.js 后台。

## 支持能力

- ChatGPT Session → sub2api、CPA、Cockpit、9router、Codex、AxonHub、Codex-Manager
- CPA → sub2api
- sub2api → CPA
- 多账号 JSON 导入、单个或批量文件拖入即转换、自动格式识别、合并 JSON、可选拆分 ZIP、复制与原生保存
- sub2api Agent Identity 凭证识别与 Ed25519 PKCS#8 结构校验
- 可选的 Codex 真实模型检测；仅在用户主动点击后执行
- 同时检测两个固定算法上游和本软件正式版本；签名新版可在应用内安装并自动重启
- 项目和 Session 获取链接通过系统默认浏览器打开

转换算法在 WebView 内存中运行，不调用网络，也不使用 `localStorage`、Cookie、IndexedDB 或数据库。可选模型检测由 Rust 内核直接请求 OpenAI Codex；access token 不写入磁盘或日志。

## 技术栈

- [Tauri 2.11](https://v2.tauri.app/)：原生窗口、系统 WebView 与跨平台打包
- Rust：原生保存、系统默认浏览器、固定上游检查、签名软件更新、严格范围的 Codex 健康检测
- Vanilla JavaScript：转换核心和界面，无前端运行时依赖
- Node.js：只用于开发脚本与算法测试，不随应用分发

支持 Windows、macOS 和 Linux。Linux 使用 WebKitGTK；Windows 使用 WebView2；macOS 使用 WKWebView。

## 开发

要求：Node.js 20+、Rust stable，以及对应平台的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

```bash
npm install
npm test
npm run dev
```

完整构建：

```bash
npm run build
```

产物位于 `target/release/bundle/`。推送 `v*` 标签后，GitHub Actions 会创建正式 Release，并附带 Windows、macOS、Linux 安装包与 Tauri 签名更新清单。

## Web 版（GitHub Pages）

推送 `main` 会触发 `.github/workflows/pages.yml`，将 `src/` 中的静态 HTML、CSS 和 JavaScript 发布到 GitHub Pages。首次启用时，在仓库 `Settings → Pages → Build and deployment → Source` 选择 `GitHub Actions`。

Web 版保留浏览器本地的 JSON 读取、格式转换、复制、JSON/ZIP 下载能力；输入不会上传，也不会写入浏览器存储。实际模型检测、软件自动更新和上游算法检查依赖 Tauri/Rust，仅在桌面版提供。需要这些能力时请使用对应平台的桌面安装包。

默认项目站点地址为 `https://<owner>.github.io/session-converter-desktop/`；仓库使用相对资源路径，因此无需为项目站点额外配置前端 base path。

## 安全边界

- 转换数据只存在于当前窗口内存；关闭或刷新应用后不会恢复。
- 文件输出的路径选择与写入在同一个 Rust 命令内完成，WebView 不能传入任意写入路径。
- 应用使用单实例与窗口状态恢复；重复启动会聚焦现有窗口。
- Rust 写文件命令限制单次输出最大 64 MiB。
- WebView CSP 禁止任意网络连接、内联脚本、对象、frame 和表单提交。
- WebView 不直接持有网络权限；可选检测只能调用固定的 Rust 命令和固定的 OpenAI Codex 地址。
- 外部链接由 Rust 执行 HTTPS 与主机白名单校验；WebView 不能直接调用 opener 插件。
- 上游更新检查不接收任意 URL，只访问 CLIProxyAPI 与 sub2api 的固定 GitHub API 地址。
- 软件更新只接受 `rw0104/session-converter-desktop` 正式 Release 中由内置公钥验证通过的安装包；上游源码变化本身不会被下载或执行。
- 只有确认的本地过期或 HTTP 401/402/403 会进入可清理集合；429、5xx、超时和网络故障不会误删。

详见 [架构说明](docs/ARCHITECTURE.md) 与 [提取记录](docs/EXTRACTION.md)。

## 来源与许可

转换逻辑源自 MIT 许可的 [GPTSession2CPAandSub2API](https://github.com/gtxx3600/GPTSession2CPAandSub2API)，并包含 CPA/sub2api 双向桥接、Agent Identity 和安全检测的后续实现。固定提交、字段依据和本地改动记录见 [UPSTREAM.md](docs/UPSTREAM.md)。

本项目使用 [MIT License](LICENSE)。
