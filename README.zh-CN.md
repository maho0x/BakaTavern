# BakaTavern

更轻、更快、更省心的 SillyTavern 重写版。和 SillyTavern 数据双向兼容：角色卡、聊天记录、预设、世界书都能直接导入，也能导出回去继续用。

> 状态：开发中。聊天（里程碑 M1）、提示词引擎对齐（M2）以及群聊、STscript、前端卡兼容层（M3）已基本完成；官方插件（记忆、向量检索、生图、语音等）和桌面/手机应用在后续里程碑中补齐，见文末路线图。

## 为什么重写

SillyTavern 功能强，但包袱重：前端是几 MB 的 jQuery 代码，聊天每保存一次就重写整个文件，锁屏或切后台时正在生成的回复会丢，开多个标签页设置会互相覆盖。BakaTavern 保留 ST 的玩法和数据格式，换掉底层：

- **一个文件就能跑**：Rust 服务端 + SQLite，网页界面打包在同一个可执行文件里。Docker 镜像 19.8 MB，启动到可用约 0.1 秒，空闲内存约 2 MiB（`docker stats` 实测）。
- **回复不会丢**：生成在服务端进行。手机锁屏、关掉页面、刷新都不影响，回来时回复会自动出现；在另一台设备打开同一个聊天，还能实时看到正在生成的内容。
- **提示词和 ST 一致**：同样的角色卡、预设、世界书，发给模型的请求和 SillyTavern 1.19 逐字节相同（见下文「与 SillyTavern 的一致性」）。
- **密钥更安全**：API 密钥加密保存在服务端，网页永远拿不到明文；每个密钥只会发往你允许的地址。
- **多端同步**：多个标签页、多台设备之间实时同步，不会互相覆盖。

## 现在能用的功能

- 导入角色卡：PNG（V1/V2/V3）、JSON、CHARX，以及卡内嵌的世界书；编辑卡片的主要字段和备选开场白。
- 聊天：流式输出、切换回复（swipe）、续写、帮我写回复（代写）、编辑、删除、隐藏消息、从某条消息开分支或存检查点（消息上的旗标直接打开，也能回到主聊天）、停止并保留已生成的内容、思维链折叠显示、每条消息的 token 数。
- 提示词查看器：每次生成发出的提示词按部分列出 token 数（角色描述、世界书、聊天记录、示例对话……），以及用到的世界书条目和完整原文。
- 连接配置档：把连接、模型、预设、模板、分词器、停止串等存成一个配置档，一键切换；SillyTavern 的配置档迁移过来就能用。
- 附件：发送消息时可附加图片、视频、音频和文本文件（也可粘贴或拖入）；支持的模型会直接收到图片等内容，文件内容放在消息前面。从 SillyTavern 迁移时聊天里的附件也会一起搬过来。
- 工具调用：模型可以调用插件注册的工具，调用结果记录在聊天里并自动继续生成，格式和 SillyTavern 一致。
- 分词器：和 SillyTavern 相同的分词器（OpenAI 系列、Llama、Claude、Gemma、Qwen、DeepSeek 等，以及后端自带的分词器），在后台线程计算；logit bias 列表和文本补全的禁用 token。
- 提示词：对话补全（Chat Completion）预设，兼容 ST 的 Prompt Manager 结构；文本补全（Text Completion）的上下文模板（故事串）、指令模板、系统提示词，内置 SillyTavern 的全部默认模板和采样预设；作者注释、角色注释、人设描述的各种插入位置；世界书（关键词、正则、常驻、递归、包含组、黏性/冷却/延迟、预算等）和全屏世界书编辑器；正则脚本（全局、角色卡、预设）；宏（Macros 2.0 语法）。
- 对话补全服务商：OpenAI、Claude、Gemini（AI Studio）、OpenRouter、DeepSeek、Mistral、xAI、Cohere、自定义 OpenAI 兼容接口等 20 多家。
- 文本补全后端：KoboldCpp、llama.cpp、Ollama、Text Generation WebUI、TabbyAPI、vLLM、Aphrodite、通用 OpenAI 兼容接口，以及 OpenRouter、Featherless、InfermaticAI、TogetherAI、DreamGen、Mancer、HuggingFace；每个后端只显示它支持的采样参数（DRY、XTC、动态温度、Mirostat、采样顺序、禁用词等）。
- 导入导出：ST 聊天记录（JSONL）导入再导出内容不变；预设、世界书、角色卡可导出为 ST 格式；从网址导入 Chub、JanitorAI、RisuRealm、Pygmalion、AICharacterCards、Perchance 的角色卡和 Chub 的世界书（经服务端下载，填网址或 ID 即可）。
- 群聊：激活策略（自然、列表、池化、手动）、切换卡与合并卡两种生成模式、前后缀、静音成员、自动模式；群聊文件与 SillyTavern 互相导入导出，提示词同样与 ST 1.19 一致。
- STscript：190 多条命令（变量、流程控制、消息、生成、世界书、群成员、人设、标签、检查点、作者注释、模板与预设等），在输入框里以 `/` 开头即可运行；解析与核心命令的行为和 SillyTavern 1.19 逐条对照测试。
- 快速回复（QR）：按钮栏、右键菜单、自动执行（启动、发送、收到回复、切换聊天、生成前、世界书触发等），全局/聊天/角色三级绑定，与 ST 的 QR 文件互相导入导出。
- 前端卡（酒馆助手兼容）：消息里的 HTML 代码块渲染成页面，默认在沙箱中运行，通过酒馆助手的函数（变量、楼层消息、斜杠命令、生成、事件、世界书、正则、全局对象等）读写聊天；支持角色卡、预设和全局的酒馆助手脚本与脚本按钮。可按角色开启「信任模式」（不加沙箱）。
- 插件：插件是一个 JavaScript 模块，安装时列出所需权限（读写聊天、调用模型、修改提示词、命令和宏、工具、网络、界面），可以注册命令、宏、提示词注入与钩子、工具、消息菜单项和设置区；关闭时它注册的一切都会撤掉。接口见 `packages/plugin-api`。
- 资料库：跨所有聊天的全文搜索（中文也可以，点结果直接跳到那条消息）、标签文件夹、多选后批量收藏/加标签/删除、主页显示最近的聊天和收藏。
- 界面：简体中文 / English，日间 / 夜间主题，可导入 SillyTavern 主题（配色、字号、宽度等），聊天背景图（全局或单个聊天，SillyTavern 的 backgrounds 文件夹可迁移），手机和电脑自适应。

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

提示词查看器记录的提示词默认保留 30 天，可在 `config.toml` 的 `[limits]` 里用 `prompt_log_days` 调整（0 为一直保留）。

**分词器**：计算 token 用的是和 SillyTavern 相同的分词器。OpenAI 系列的分词器内置；Llama、Claude、Gemma、Qwen、DeepSeek 等模型的分词器文件在第一次用到时从 GitHub 下载（走上面设置的代理），保存在 `data/cache/tokenizers`。访问 GitHub 不方便时，可以在 `config.toml` 的 `[tokenizers]` 里设置 `mirror`（下载地址前缀），或者手动把文件放进这个目录；设置 `download = false` 则不再下载，缺文件时改用估算。

## 从 SillyTavern 迁移

**整个搬过来**：在「设置 → 从 SillyTavern 迁移」上传 SillyTavern 数据的备份 zip（`data/default-user` 文件夹打包即可），或者在服务器上运行：

```bash
bakatavern import-st /path/to/SillyTavern            # ST 安装目录、data/<用户> 目录或备份 zip
bakatavern import-st backup.zip --secrets            # 同时导入 API 密钥（默认不导入）
```

角色卡、聊天记录、世界书、各类预设（对话补全、文本补全、指令、上下文、系统提示词、思维链模板）、人设及头像、标签都会迁移过来；SillyTavern 的设置（正则脚本、全局世界书、作者注释默认值、停止串、思维链、连接与模型等）会在下次打开网页时自动应用。重复导入不会产生重复数据。群聊、背景、主题、快速回复等会在后续版本支持，导入报告会列出跳过了哪些。

**随时可以回去**：「导出给 SillyTavern」会把全部数据打包成 SillyTavern 的数据文件夹，解压到 SillyTavern 的 `data/default-user` 即可。单个角色卡、聊天记录、预设和世界书也可以分别导入导出。

## 与 SillyTavern 的一致性

`tools/st-diff` 会把同一组场景分别交给 SillyTavern 1.19（在 Docker 里运行）和 BakaTavern，比较两边最终发给模型的请求。当前 110 个场景全部完全一致：

- 对话补全 74 个：角色卡字段、示例对话、人设（含按深度插入）、角色系统提示词覆盖与 `{{original}}`、历史后指令、作者注释、世界书（关键词匹配、递归、包含组、黏性/冷却/延迟、过滤器、预算、各种插入位置）、正则脚本、续写（含预填充）、代写、swipe、思维链回传、后处理方式、按模型分词器计数的上下文裁剪、logit bias 列表、附加的图片/视频/文件、工具调用（提供的工具和历史中的调用，覆盖 7 家服务商的格式），以及 20 多家服务商各自的请求格式。
- 文本补全 36 个：无指令模式和 ChatML、Llama 3、Mistral、Alpaca、Gemma、DeepSeek 等指令模板，故事串插入聊天、世界书与锚点、上下文预算裁剪（估算和真实分词器两种）、续写/代写/swipe、系统提示词与后置指令、用户占位消息、首末序列、「回复开头」、示例对话的保留与去除、经后端分词器处理的禁用 token 和 logit bias、附加文件，以及 15 种后端各自的请求体（KoboldCpp、llama.cpp、Ollama、vLLM、Aphrodite、TabbyAPI、OpenRouter 等）。

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

- **M2 提示词引擎对齐**（基本完成）：完整的世界书编辑器、正则、对话补全服务商、文本补全后端和模板、从 SillyTavern 整库迁移、全部分词器与 logit bias、连接配置档、提示词查看器、检查点、附件与多模态、工具调用、从网址导入角色卡。还差 Vertex AI、Azure OpenAI、Workers AI 三个服务商，以及 PDF/Word 附件的文字提取。
- **M3 群聊、脚本与前端卡**（基本完成）：群聊、STscript 与快速回复（QR）、变量、插件 API v1、酒馆助手（前端卡）兼容层（安全模式与信任模式、核心函数、脚本库）、全文搜索、背景、主题导入、标签文件夹、批量编辑、主页。直接操作 SillyTavern 页面元素（如 `window.parent.$('#chat')`）的老卡无法运行，信任模式只是去掉沙箱（页面与本应用同源，可用浏览器存储等）；SillyTavern 的第三方扩展不兼容。
- **M4 官方插件**：记忆/总结、向量检索与资料库、生图、语音合成与识别、翻译、联网搜索等。
- **M5 多平台**：Windows / macOS / Linux 桌面版与 Android 应用（Tauri 2）、多用户。
- **M6 长尾**：NovelAI、AI Horde、更多语言等。

## 许可证

[AGPL-3.0](LICENSE)，与 SillyTavern 相同。
