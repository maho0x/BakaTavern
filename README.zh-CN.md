# BakaTavern

更轻、更快、更省心的 SillyTavern 重写版。和 SillyTavern 数据双向兼容：角色卡、聊天记录、预设、世界书都能直接导入，也能导出回去继续用。

> 状态：开发中。现在已经能完整地聊天（里程碑 M1），群聊、STscript、前端卡兼容层、各类插件在后续里程碑中陆续补齐，见文末路线图。

## 为什么重写

SillyTavern 功能强，但包袱重：前端是几 MB 的 jQuery 代码，聊天每保存一次就重写整个文件，锁屏或切后台时正在生成的回复会丢，开多个标签页设置会互相覆盖。BakaTavern 保留 ST 的玩法和数据格式，换掉底层：

- **一个文件就能跑**：Rust 服务端 + SQLite，网页界面打包在同一个可执行文件里。Docker 镜像 19.8 MB，启动到可用约 0.1 秒，空闲内存约 2 MiB（`docker stats` 实测）。
- **回复不会丢**：生成在服务端进行。手机锁屏、关掉页面、刷新都不影响，回来时回复会自动出现；在另一台设备打开同一个聊天，还能实时看到正在生成的内容。
- **提示词和 ST 一致**：同样的角色卡、预设、世界书，发给模型的请求和 SillyTavern 1.19 逐字节相同（见下文「与 SillyTavern 的一致性」）。
- **密钥更安全**：API 密钥加密保存在服务端，网页永远拿不到明文；每个密钥只会发往你允许的地址。
- **多端同步**：多个标签页、多台设备之间实时同步，不会互相覆盖。

## 现在能用的功能

- 导入角色卡：PNG（V1/V2/V3）、JSON、CHARX，以及卡内嵌的世界书；编辑卡片的主要字段和备选开场白。
- 聊天：流式输出、切换回复（swipe）、续写、帮我写回复（代写）、编辑、删除、隐藏消息、从某条消息开分支、停止并保留已生成的内容、思维链折叠显示。
- 提示词：对话补全（Chat Completion）预设，兼容 ST 的 Prompt Manager 结构；作者注释、角色注释、人设描述的各种插入位置；世界书（关键词、正则、常驻、递归、包含组、黏性/冷却/延迟、预算等）；宏（Macros 2.0 语法）。
- 服务商：OpenAI、Claude、Gemini（AI Studio）、OpenRouter、DeepSeek、自定义 OpenAI 兼容接口等约 20 家。
- 导入导出：ST 聊天记录（JSONL）导入再导出内容不变；预设、世界书、角色卡可导出为 ST 格式。
- 界面：简体中文 / English，日间 / 夜间主题，手机和电脑自适应。

## 快速开始

### Docker

```bash
docker build -t bakatavern .
docker run -d --name bakatavern -p 8800:8800 -v bakatavern:/data \
  -e BT_PASSWORD=换成你的密码 bakatavern
```

然后打开 `http://<服务器地址>:8800`。从别的设备访问时必须设置密码，否则服务会拒绝启动。

### 从源码运行

需要 Node.js 22.18 以上（用 `corepack enable` 启用 pnpm）和 Rust（版本由 `rust-toolchain.toml` 指定，rustup 会自动安装）。

```bash
pnpm install
pnpm build                      # 构建网页并编译 release 版服务端
./target/release/bakatavern serve
```

默认只监听本机 `http://127.0.0.1:8800`，本机访问不需要登录。

### 手机（Termux）

下载 `aarch64-linux-android` 版本，解压后在 Termux 里运行 `./bakatavern serve`，再用手机浏览器打开 `http://127.0.0.1:8800`。

## 配置

数据（数据库、图片、配置文件）都在数据目录里，默认是当前目录下的 `data/`，可用 `--data-dir` 或 `BT_DATA_DIR` 指定。首次启动会生成带注释的 `data/config.toml`。环境变量会覆盖配置文件：

| 变量                  | 作用                                                        |
| --------------------- | ----------------------------------------------------------- |
| `BT_DATA_DIR`         | 数据目录                                                    |
| `BT_HOST` / `BT_PORT` | 监听地址和端口（默认 `127.0.0.1:8800`）                     |
| `BT_PASSWORD`         | 启动时设置登录密码                                          |
| `BT_AUTH_MODE`        | `auto`（本机免登录，其他情况需要密码）/ `none` / `password` |
| `BT_PROXY`            | 访问模型 API 时使用的代理，支持 `http://` 和 `socks5://`    |
| `BT_ALLOW_PRIVATE`    | 是否允许访问内网地址（本地模型需要，默认允许）              |
| `BT_LOG`              | 日志级别，例如 `debug`                                      |

修改密码：`bakatavern passwd`；清除密码：`bakatavern passwd --clear`。

## 从 SillyTavern 迁移

在界面里直接导入角色卡、聊天记录（`.jsonl`）、对话补全预设和世界书即可，导出的文件可以放回 SillyTavern 使用。一次性迁移整个 ST 数据目录的命令（`bakatavern import-st`）计划在 M2 提供。

## 与 SillyTavern 的一致性

`tools/st-diff` 会把同一组场景分别交给 SillyTavern 1.19（在 Docker 里运行）和 BakaTavern，比较两边最终发给模型的请求。当前 15 个场景完全一致，覆盖：角色卡字段、示例对话、人设（含按深度插入）、角色系统提示词覆盖与 `{{original}}`、历史后指令、作者注释、世界书（全局/角色、常驻/关键词/按深度、递归）、续写（含预填充）、代写、swipe、名字写入正文、合并系统消息、隐藏消息，以及 Claude（系统提示词、预填充、续写预填充）和 Gemini（系统指令）。

ST 的请求录制一次后保存在 `tools/st-diff/baseline/`，平时跑 `pnpm test` 就会对照检查，不需要 Docker。

## 开发

```bash
pnpm dev:server          # 服务端（http://127.0.0.1:8800）
pnpm dev                 # 网页开发服务器（http://127.0.0.1:5173，/api 转发到服务端）
pnpm mock-llm            # 模拟模型服务（http://127.0.0.1:5055/v1），无需真实 API 密钥

pnpm test                # 全部单元测试（TS + Rust），含与 SillyTavern 的一致性对照
pnpm typecheck && pnpm lint
pnpm e2e                 # 浏览器端到端测试（先 pnpm --filter @bakatavern/web build && cargo build -p bt-cli）
pnpm st-diff:record      # 重新录制 SillyTavern 的请求（需要 Docker）
```

目录结构、架构约定和贡献规则见 [CLAUDE.md](CLAUDE.md)。

## 路线图

- **M2 提示词引擎对齐**：完整的世界书编辑器、文本补全（Text Completion）后端和模板、正则、全部分词器、连接配置档、提示词查看器、附件与多模态、工具调用、整库迁移，差分场景扩充到 40 个以上。
- **M3 群聊、脚本与前端卡**：群聊、STscript 与快速回复（QR）、插件 API、酒馆助手（前端卡）兼容层。
- **M4 官方插件**：记忆/总结、向量检索与资料库、生图、语音合成与识别、翻译、联网搜索等。
- **M5 多平台**：Windows / macOS / Linux 桌面版与 Android 应用（Tauri 2）、多用户。
- **M6 长尾**：NovelAI、AI Horde、更多语言等。

## 许可证

[AGPL-3.0](LICENSE)，与 SillyTavern 相同。
