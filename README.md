# Session Converter Desktop

一个本地优先、跨平台的登录凭证格式转换桌面工具。它从 `renqw2023/VaultKey` 的格式转换模块独立提取，使用 Tauri 2 + Rust + 系统 WebView 封装，不捆绑 Chromium，也不需要常驻 Node.js 后台。

## 支持能力

- ChatGPT Session → sub2api、CPA、Cockpit、9router、Codex、AxonHub、Codex-Manager
- CPA → sub2api
- sub2api → CPA
- 多账号 JSON 导入、文件拖放、自动格式识别、拆分 ZIP、复制与原生保存
- sub2api Agent Identity 凭证识别与 Ed25519 PKCS#8 结构校验
- 可选的 Codex 真实模型检测；仅在用户主动点击后执行

转换算法在 WebView 内存中运行，不调用网络，也不使用 `localStorage`、Cookie、IndexedDB 或数据库。可选模型检测由 Rust 内核直接请求 OpenAI Codex；access token 不写入磁盘或日志。

## 技术栈

- [Tauri 2.11](https://v2.tauri.app/)：原生窗口、系统 WebView 与跨平台打包
- Rust：原生保存、严格范围的 Codex 健康检测
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

产物位于 `target/release/bundle/`。GitHub Actions 也提供 Windows、macOS、Linux 的标签发布工作流。

## 安全边界

- 转换数据只存在于当前窗口内存；关闭或刷新应用后不会恢复。
- 文件输出的路径选择与写入在同一个 Rust 命令内完成，WebView 不能传入任意写入路径。
- 应用使用单实例与窗口状态恢复；重复启动会聚焦现有窗口。
- Rust 写文件命令限制单次输出最大 64 MiB。
- WebView CSP 禁止任意网络连接、内联脚本、对象、frame 和表单提交。
- WebView 不直接持有网络权限；可选检测只能调用固定的 Rust 命令和固定的 OpenAI Codex 地址。
- 只有确认的本地过期或 HTTP 401/402/403 会进入可清理集合；429、5xx、超时和网络故障不会误删。

详见 [架构说明](docs/ARCHITECTURE.md) 与 [提取记录](docs/EXTRACTION.md)。

## 来源与许可

转换逻辑源自 MIT 许可的 [GPTSession2CPAandSub2API](https://github.com/gtxx3600/GPTSession2CPAandSub2API)，并包含 VaultKey 对 CPA/sub2api 双向桥接、Agent Identity 和安全检测的后续实现。固定提交、字段依据和本地改动记录见 [UPSTREAM.md](docs/UPSTREAM.md)。

本项目使用 [MIT License](LICENSE)。
