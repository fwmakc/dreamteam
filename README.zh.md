<!-- 中文版 · English: README.md · Русский: README.ru.md -->

# 🎬 Dream Team — 与 AI 智能体团队聊天

[![ci](https://github.com/fwmakc/dreamteam/actions/workflows/ci.yml/badge.svg)](https://github.com/fwmakc/dreamteam/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dreamteam)](https://www.npmjs.com/package/dreamteam) [![node](https://img.shields.io/node/v/dreamteam)](https://www.npmjs.com/package/dreamteam)

[English](README.md) · [Русский](README.ru.md) · **中文**

在这里，你面对的不是单个 AI，而是一支虚拟团队：每个成员都有自己的名字、角色、性格和文字颜色。你的消息发给主持人-协调者，由它决定由哪些成员回答（通常 1–3 人，而不是全员一起）。智能体们看得见彼此的发言，会争论、会互相接续思路。可以用 `@名字` 点名特定成员。每场谈话都会保存。

两套外壳，一个内核：终端 TUI 和本地网页 GUI（`dreamteam serve`）。

界面与本文档提供三种语言：英语、俄语和中文（`README.md`、`README.ru.md`、`README.zh.md`）。界面语言在首次启动（向导）时选择，之后随时可用 `/settings set ui=en`（`ru`、`zh`，或 `~/.dreamteam/lang/<id>.json` 中自定义语言的 id）更改。

团队属于这台机器：它住在主目录（`~/.dreamteam/agents/`）里，被所有项目共享。初始为空 —— 迎接你的是**会议室经理**：按需召集成员、为某人开启工具、配置项目和服务器。某场谈话里究竟由谁回答，由聊天名单决定 —— 即会话文件里的 `participants` 列表：空列表表示你召来的所有人都会回答（`/add`、`/out`，或请经理“把 Elena 叫进来”）。

## 快速开始

需要 Node.js ≥ 18.17。

```bash
npm install -g dreamteam   # 或者：git clone + npm install + npm link
cd my-project              # 在项目文件夹里工作
dreamteam
```

检查安装：`dreamteam -v` — 版本号，`dreamteam -h` — 启动模式帮助（TUI、`serve`）。

首次启动时向导会带你完成设置（见“首次启动向导”）：选择界面语言和服务商，输入 API 密钥（输入隐藏），并自我介绍 —— 随之创建 `~/.dreamteam`（家目录：设置与团队）和 `./.dreamteam`（项目：hosts.json、mails.json、messengers.json 注册表以及谈话记录）。之后就是你和会议室经理的对话：直接告诉它你需要什么。

没有配置密钥时，应用以 **mock 模式**运行 —— 智能体给出预置回答，可以先用它熟悉界面和机制。密钥由向导输入，或之后在服务商卡片里填写（`~/.dreamteam/models/` 的 `"apiKey"` 字段）。

## 两层结构：家目录与项目

应用是全局的（像任何 CLI 一样），但数据分为几层：

| 层 | 位置 | 存放内容 |
|---|---|---|
| **package** | 安装文件夹 | 应用代码 —— 只读，什么都不写 |
| **home** | `~/.dreamteam` | 所有全局内容：带模型密钥的服务商（`models/`）、设置（`settings.json`）、你的资料（`user.json`）、**整个团队** —— 智能体（`agents/`）、经理（`manager.json`）、工具（`tools/`）、日程（`schedule.json`）、共享记忆（`memory.json`），外加已知项目注册表（`projects.json`）。团队模拟器属于机器：配置一次，任何项目通用 |
| **project** | `<项目文件夹>/.dreamteam` | 这个项目的全部内容：`hosts.json`（ssh 服务器）、项目的邮件与机器人（`mails.json`、`messengers.json` —— 项目机密，绝不放进智能体卡片）、谈话（`sessions/`、`transcripts/`）。智能体的工作文件写入项目文件夹（inbox 等） |

工具的工作文件夹**始终是应用启动时所在的文件夹**：在项目文件夹里运行 `dreamteam`，团队就在这个项目上工作。任何地方都不用配置路径 —— 在仓库里启动，团队就在仓库上干活。

可以不退出应用切换项目：`/project open <路径或名字>` 会更换工作文件夹、谈话列表和项目注册表（服务器、邮件、机器人）—— 团队、服务商和共享记忆跟着你走。总览：`/project`（当前项目及其服务器、已知项目），`/project add <路径>` 把新路径加入注册表，`/project remove <名字>` 遗忘它（当前项目不能这样移除）。网页外壳里有“项目”面板：点条目切换，分节旁的“＋”按钮打开带路径输入框的表单。也可以请经理切换项目。

各层可被环境变量 `DT_HOME` 和 `DT_PROJECT` 覆盖 —— 探针和隔离就是这样工作的（把 `.dreamteam/` 加进项目的 `.gitignore`：创建时向导会提醒你）。

## 首次启动向导

如果没有家目录（`~/.dreamteam`），向导会依次询问：

1. **界面语言** —— 第一个问题，向导本身已经会用它：开箱即用 `ru`、`en`、`zh`，加上来自 `~/.dreamteam/lang/<id>.json` 的自定义语言（见“设置”）。之后用 `/settings set ui=<id>` 更改。
2. **服务商** —— 从适配器列表选择（`mock` 无需密钥即可试用）。
3. **API 密钥** —— 输入隐藏（不显示、也不进终端日志）；密钥直接保存到 `models/` 的服务商卡片里（`"apiKey"` 字段）并立即生效。
4. **如何向团队介绍你** —— 名字、角色、几句介绍（可跳过）。

之后两层都以最小文件和清晰的初始提示创建：家目录获得五人初始团队（分析师、秘书、开发者、设计师、文案）和运行在所选服务商上的经理，外加自定义语言的 `lang/` 架子。名单在 `agents/` 里编辑，或通过与经理对话编辑。如果项目文件夹是 git 仓库而 `.gitignore` 里没有 `.dreamteam/`，向导会建议加上。重复运行向导不会破坏任何东西：已存在的文件原样保留。在非交互模式（管道）下向导会诚实地拒绝运行 —— 设置需要真实终端。

## 第一场对话：礼宾经理

新谈话总是一对一始于会议室经理 —— 它会立刻打招呼并说明自己能做什么。它是唯一参与者时，你的所有发言都指向它，不需要 `@`。

```
You > bring in Gleb and Marina
  ✓ Gleb (id "gleb", role "Head of architecture and code") added to the team
  💾 Gleb joined the chat.
You > enable shell and files for Gleb
  ✓ gleb: tool "shell" enabled
You > let's set up the shop project: server prod — deploy@203.0.113.10
  ✓ project "shop" added (servers: prod)
You > alright Gleb, look at the structure and propose a refactoring plan
  💾 Gleb: …
```

经理是唯一修改配置的角色，而且只能通过与它的对话（没有旁门左道 —— 只有规范操作）。它的系统提示词包含实时状态：带工具的团队名单、聊天名单、谈话列表、带服务器的项目注册表以及斜杠命令列表。经理不能写 `tools/` 里的文件 —— 该动作在它的协议里根本不存在。

## 接入 API

### 工作方式

- **模型密钥** —— 直接放在 `~/.dreamteam/models/` 的服务商卡片里（`"apiKey"` 字段；GigaChat 也可以改用 `"clientId"`/`"clientSecret"` 对）。
- **serve 设置** —— `~/.dreamteam/.env`（`TOKEN`、`PORT`、`HOST`；项目文件夹里的 `.env` 刻意不读 —— 变量只有单一来源）。这些是具体机器的设置：不会进入 `/home export` 归档。向导在新机器上首次启动时会创建 `.env`；经 `/home import` 迁移来的家目录不带该文件 —— 没有它 serve 只是监听 `127.0.0.1`；要外部访问，就按包里的样例（`scaffold/home/env.example`）创建 `.env` 并填入 `TOKEN`（见“外部访问”）。
- **API 描述** —— 同一个 `models/`：哪个适配器、URL、模型和密钥。
- 应用通过统一的 `LLMProvider` 接口与 LLM 通信（`src/models/types.ts`）。具体协议藏在适配器里：

| 适配器 | 适用 API |
|---|---|
| `openai-compatible` | Z.ai (GLM)、OpenAI、OpenRouter、DeepSeek、Ollama、LM Studio… |
| `anthropic` | Claude |
| `gigachat` | Sber GigaChat（内置完整 OAuth 令牌周期） |
| `mock` | 无密钥工作 |

换机器 —— `/home export` 和 `/home import`：设置、团队和服务商连同卡片密钥一起迁移，无需重新输入；当前项目的谈话也在同一个归档里并按 id 合并（重名的替换）。归档里有密钥 —— 无论在云端还是别处，都当密码保管。

### Z.ai (GLM)

1. 在 Z.ai 开放平台控制台（API 密钥分区）获取 API 密钥。
2. 填入 `~/.dreamteam/models/` 的服务商卡片：
   ```json
   "apiKey": "your-key"
   ```
3. 默认服务商已在其中选好（`"default"`）。模型就在旁边改（`model` 字段）。

**关于密钥类型。** 例如 Z.ai 有两个不同的端点：

| 端点 | 适用密钥 |
|---|---|
| `https://api.z.ai/api/paas/v4` | 普通按量计费 API（按 token 付费） |
| `https://api.z.ai/api/coding/paas/v4` | **GLM Coding Plan** 订阅的密钥 |

Coding Plan 密钥用在普通端点会报错 `429: Insufficient balance or no resource package` —— 这是正常的：订阅对余额不可见。如果有订阅，请在该 `openai` 服务商的 `baseUrl` 里设置 coding 端点。订阅可用的模型列表：`GET https://api.z.ai/api/coding/paas/v4/models`。

### 冒烟实测：`npm run smoke:live`

对着真实（非 mock）服务商的快速检查：经理的实时回答、经理确实按请求创建智能体、带 `files` 的智能体确实写出文件。家目录是真实的（密钥和 `models/`），项目是临时沙箱 —— 真实项目里什么都不会变。密封探针（`npm run probe`）绝不触碰真实 API —— 免费且确定。

### 提示缓存（同样的对话，更少的 tokens）

对话每轮在历史尾部增长，服务商可以复用前缀缓存 — 相同的 tokens 不会按全价计费两次。

- **Z.ai (GLM)、OpenAI、DeepSeek…**（`openai-compatible` 适配器）— 自动前缀缓存，无需开启。应用在流式模式下请求 usage 统计并报告命中。
- **Anthropic (Claude)** — 显式缓存标记，默认开启：两个断点（system 提示词与历史末尾）让本轮前缀成为下一轮的缓存命中。可在服务商卡片中用 `"cache": false` 关闭。
- 命中会在日志中显示：«1 240 из 1 500 входных токенов — из кэша промпта」。历史压缩（约 24 条消息）与记忆反思（约每 12 条一次）会重写前缀并重置缓存 — 这是有意为之。

### Anthropic (Claude)

来自 Anthropic 控制台的密钥放进 `claude` 服务商卡片（`~/.dreamteam/models/`）：

```json
"apiKey": "your-key"
```

然后在聊天里：`/model claude`（或改 `models/` 里的 `"default"`）。

### Sber GigaChat

适配器自己就做好了人们通常要搭代理服务才有的全套事情：用 API 密钥换取 `access_token`、缓存它、提前刷新（过期前一分钟）、扛住突发的 401（静默刷新 + 重试），并挂上俄罗斯 TLS 证书。

1. 在 GigaChat 控制台获取 API 密钥（developers.sber.ru → GigaChat API）。
2. 填入 `~/.dreamteam/models/` 的 `gigachat` 服务商卡片：
   ```json
   "apiKey": "your-console-key"
   ```
   （控制台密钥已经是现成的 Basic 字符串；如果你拿到的是 client_id/secret 对，改设 `"clientId"` 和 `"clientSecret"`。）
3. 按 GigaChat 说明下载数字部根证书，放到 `caCertPath` 指定的路径（默认 `certs/russian_trusted_root_ca.pem`）。快速验证可改设 `"insecureTLS": true`（不安全，仅用于测试）。
4. 在聊天里：`/model gigachat`。

每个智能体都可以跑在独立服务商上 —— 在 `~/.dreamteam/agents/` 里给它一个 `"model": "<服务商 id>"` 字段。可以组一支混合模型队伍（比如 Marina 用 Claude，Dmitry 用 GLM）。

## 操作：命令 = rpc

控制方式由**操作清单**（`src/core/operations.ts`）描述。规范操作名 —— `group.verb` —— 在三个界面上一致：

- 文本命令：`/group verb arguments`（组总览就是 `/group`）；
- WebSocket rpc 方法：同名作为字符串（GUI 用按钮调用，脚本直接调用）；
- `/help` 文本与自动补全：从同一份列表派生。

没有别名或缩写：一个名字 —— 一个操作。

| 操作 | 命令 | 动作 |
|---|---|---|
| `session.new` | `/session new` | 新会话：与经理一对一 |
| `sessions.list` | `/sessions` | 会话列表（最新在上，当前标注） |
| `session.open <number>` | `/session open 2` | 从列表打开会话 |
| `session.delete <number>` | `/session delete 2` | 删除会话（不能是当前的） |
| `session.rename [name]` | `/session rename Morning standup` | 重命名当前会话；不填名字经理自己起 |
| `session.history [N]` | `/session history 20` | 当前会话的历史（或最后 N 条） |
| `session.export [number]` | `/session export 2` | 会话打包为 zip（不带编号 — 当前会话） |
| `session.import <file>` | `/session import dt-session-….zip` | 从归档恢复会话（作为新会话并入） |
| `home.export` | `/home export` | 搬家用的家目录快照：设置、带密钥的服务商、团队记忆、日程和全部会话（不含 .env —— 属于机器的东西）；像密码一样保管 |
| `home.import <file>` | `/home import dt-home-….zip` | 从归档展开家目录（含密钥）；会话按 id 合并，会话日期保留 |
| `chat.add <name\|number>` | `/chat add Lawyer` | 把成员叫进当前谈话 |
| `chat.remove <name\|number>` | `/chat remove Lawyer` | 请出谈话（发言保留在历史里） |
| `team.list` | `/team` | 团队名单：角色、工具、谁在聊天 |
| `team.add <id> <Name> [role]` | `/team add lawyer Lawyer law` | 新成员（默认值同经理） |
| `team.update <id> field=value…` | `/team update lawyer role=sourcream` | 编辑：name, role, emoji, color, description, prompt, provider, temperature |
| `team.delete <id…>` | `/team delete lawyer, keks` | 删除成员：逗号或空格分隔的列表 |
| `team.grant <agent> <tool>` | `/team grant lawyer files` | 启用工具：files, shell, ssh, look, image 或 tools/ 里自定义的 |
| `provider.list` | `/model` | 服务商及其状态 |
| `model.set <id>` | `/model set glm` | 更换主力服务商 |
| `model.add <id> field=value…` | `/model add glm adapter=openai-compatible …` | 新服务商（adapter 必填） |
| `model.update <id> field=value…` | `/model update glm model=glm-4.6` | 编辑现有卡片（adapter, model, baseUrl, apiKey, maxTokens, temperature） |
| `model.delete <id>` | `/model delete glm` | 删除服务商；默认的不能删 —— 先 `/model set` 换一个 |
| `profile.show` / `profile.set` | `/profile set Name; role; about you` | 团队如何看你（user.json） |
| `memory.show [who\|shared]` | `/memory show Lawyer` | 某成员记得什么；`shared` — 共享记忆 |
| `project.list` | `/project` | 当前项目：服务器（hosts.json）和已知项目 |
| `project.open <path\|name>` | `/project open ../other` | 切换项目：工作文件夹与会话；名字来自 `/project` 总览 |
| `project.add <path>` | `/project add ../other` | 只记住项目到注册表，不切换 |
| `project.remove <name>` | `/project remove other` | 遗忘项目（当前项目不能这样移除） |
| `project.host.add <name=host>` | `/project host add backup=deploy@10.0.0.2` | 当前项目里的服务器；主机格式 [user@]host[:port] |
| `project.host.delete <name>` | `/project host delete backup` | 从当前项目移除服务器 |
| `mail.list` | `/mail` | 邮箱注册表（mails.json） |
| `mail.add <name> field=value…` | `/mail add work user=… password=… imap=… smtp=…` | 邮箱写入 mails.json；端口和 `tlsNoVerify` 可选 |
| `mail.remove <name>` | `/mail remove work` | 移除邮箱 |
| `messenger.list` | `/messenger` | 机器人（messengers.json） |
| `messenger.add <telegram\|max> <token>` | `/messenger add telegram 123456:ABC…` | 机器人令牌写入 messengers.json |
| `messenger.remove <telegram\|max>` | `/messenger remove max` | 移除机器人 |
| `schedule.list` | `/schedule` | serve 自动按间隔运行的任务 |
| `schedule.add <task> [minutes]` | `/schedule add "standup" 60` | 新任务；间隔默认 10 分钟 |
| `schedule.toggle <id>` / `schedule.delete <id>` | `/schedule toggle task-…` | 暂停/恢复与删除任务 |
| `settings.show` / `settings.set field=value…` | `/settings set maxTurns=2` | 设置（自下一轮生效） |
| `manager.show` / `manager.set field=value…` | `/manager set model=glm` | 会议室经理：服务商、温度、名字 |
| `auto.on [N]` / `auto.off` | `/auto on 5`, `/auto off` | 自主模式：智能体自行决定，最多 N 步 |
| `/help` | `/help` | 操作帮助（同一份清单） |
| `/exit` | `/exit` | 退出（仅终端） |

命令属于内核：网页外壳里同一套命令通过同一个输入框工作（或经面板按钮），终端只是多了彩色视图。

启动时应用会继续上一场谈话；如果上一场是空的（或这是首次启动）—— 经理会自己打招呼。

**会话命名。** 名字取自第一条消息，第一次回答之后经理会为会话起个简短标题（基于首条消息）。随时可以重命名：`/session rename <新名字>` —— 或者请经理：“给这场谈话起个名字” —— 它会用简短摘要，如果会话还没压缩过，就用第一条和最后一条消息。

**命令提示。** 以 `/` 开头输入 —— 输入行上方出现命令列表（每条带简短说明）；随着输入过滤。**Tab** 补全命令，带参数的命令还会提示并补全参数：`/session open` 和 `/session delete` 提示会话编号（带标题），`/chat add` 和 `/chat remove` 提示成员名，`/memory` 提示 `who|shared`，`/model set` 提示服务商 id。

@提及同理：在消息中间输入 `@` —— 输入行上方弹出当前聊天成员和 `@session` 的面板（各带角色）。输入即过滤，**上下方向键**移动选择（循环），**Enter** 或 **Tab** 插入选中名字，**Esc** 关闭面板并保留已输入的 `@片段`。大小写无关，俄语 е/ё 也不区分。`@session` 后加空格会提示带标题的会话编号。

**`!` 是 `@` 的完全同义词**（任何键盘布局、任何语言下都是 Shift+1）：`!Katya, look at the mockup`、`!manager, bring Gleb in`、`!session 2` —— 一切照旧，包括提示面板。

**聊天名单。** 新谈话（`/session new` 和第一场）总是一对一始于经理：它是礼宾 —— 让它叫你需要的人。之后名单随时可变：`/chat add <名字或编号>` — 召唤，`/chat remove <名字或编号>` — 请出（其发言和记忆保留在历史里）；经理也可以按请求这样做。聊天事件 —— “Gleb 加入聊天”、“Katya 离开聊天” —— 以经理一行进入谈话的统一时间线（终端、网页聊天和保存的历史都是如此），而不是单独的日志。如果最后一名成员被请出，经理会留下 —— 作战室不能没有团队。当前名单在 `/team` 和 `/session` 可见。关闭谈话的摘要在后台并入团队共享记忆，无需等待。

**多行消息。** 消息内换行：`\` + Enter（任何终端都行）或 **Ctrl+Enter** / **Alt+Enter**。输入未结束时提示符变成 `… `；空行是段落分隔；普通 **Enter** 发送消息，**双击 Enter** 或 `.` 按原样结束输入。行尾 `\\` 是字面反斜杠。从剪贴板多行粘贴（Windows Terminal 里 Ctrl+V、Shift+Ins、右键）也会粘成一条消息而不是发出第一行；如果粘贴以换行结尾，之后再按一次 Enter。

**中断。** 团队回答期间（主持人在思考或智能体在输入）可用 **Esc** 或 **Ctrl+C** 停止本轮 —— 对模型的请求被取消，本轮其余成员不再被叫，应用立刻回到提示符。已经出现的回答保留在历史里。空提示符下 Ctrl+C 照旧退出应用。

## 网页外壳：`dreamteam serve`

同样的事 —— 在浏览器里：

```bash
dreamteam serve         # 或：npm run serve；端口取 PORT，默认 8080
dreamteam serve --open  # + 在浏览器中打开网页外壳
```

本地服务器启动：`http://127.0.0.1:8080` 提供 `gui/` 的网页外壳（纯 HTML/JS/CSS，无需构建）并通过 WebSocket 与之通信。默认只监听 127.0.0.1 —— 机器外部看不到服务器。端口和地址由 `PORT` 和 `HOST` 变量设置 —— 可以放进 `~/.dreamteam/.env`：全局重装和切换项目后设置仍在。**注意：** `HOST=0.0.0.0` 会把服务器暴露到网络 —— API 没有鉴权，只在自己的网络里这样做。谈话、团队和配置与终端共享 `--open` 标志让 serve 自己打开浏览器；首次启动时向导会提议在桌面创建「Dream Team」快捷方式 — 它运行的就是这条命令（Windows、Linux、macOS 上行为一致）。：可以在 TUI 工作，再到浏览器继续。

- 左侧 —— 谈话（点击切换，“＋”新建）、团队名单（点击成员召唤/请出聊天）、服务商（点击设为智能体的默认）和项目（点击切换项目，分节旁“＋” —— 带路径输入框的表单）；
- 网页界面没有双击：右键条目打开“编辑”和“删除”菜单（谈话多一项“重命名”）；删除总要经过“确定删除这条记录？”确认 —— “是”/“否”；
- 中间 —— 同样的聊天：回答流式输出、经理行（包括聊天事件 —— 加入/离开）、工具结果、`@session` 摘要附件；
- 工具的“是否允许？”问题显示为 ✓/✗ 按钮；5 分钟无回答按拒绝计 —— 一轮永远不会永久卡住；
- “⏹ 中止”停止本轮，如同终端里的 Esc。

**外部访问。** 如果服务器暴露在外（`HOST` 不是 127.0.0.1），保护是令牌：`~/.dreamteam/.env` 里的 `TOKEN` 变量。向导在新机器首次启动时会创建它；家目录迁到别的机器后 `.env` 不会跟过去 —— 按样例（`scaffold/home/env.example`）创建文件并手动生成令牌：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

连接时外壳会问一次令牌并记在浏览器里；顶栏的**退出登录**按钮在该设备上忘记令牌。令牌是“服务器密码”级别的访问：智能体拥有 shell 和文件，所以只应在 HTTPS（带证书的代理）后或自己的 VPN 内暴露。

终端斜杠命令在网页外壳里通过同一个输入框工作：以 `/` 开头的文本作为命令进入内核（不会画成用户气泡），报告留在聊天下方的日志里 —— 只有命令报告和错误进日志，聊天事件在统一时间线里。自动补全与终端相同：`@` 打开提及面板（经理、聊天成员、session —— 方向键/Tab/Enter/Esc），`/` 显示带说明和参数提示的命令列表，Tab 补全。提示字典由内核随 state 快照下发。

两套外壳一个内核：服务器（`src/serve.ts`）是 `src/core/engine.ts` 之上的第二个 Presenter —— 网页版没有单独的“大脑”。协议是 WebSocket `/ws` 上的 JSON（事件与 rpc 全列表见 serve.ts 文件头），因此你可以用自己的外壳替换网页版。

## 设置：~/.dreamteam/settings.json

应用通用设置 —— `~/.dreamteam/settings.json`（文件必需 —— 没有它应用不会启动）：界面语言、谈话语言、屏幕和智能体的工具限制。

```json
{
  "width": 100,
  "ui": "en",
  "language": "english",
  "margin": 2,
  "screen": true,
  "runTimeoutMs": 180000,
  "maxOutputChars": 4000
}
```

- `ui` — 界面语言：内置 `ru`、`en`、`zh`，或 `~/.dreamteam/lang/<id>.json` 里自定义语言的 id（文件格式 `{ "name": "Deutsch", "translations": { … } }`；id 即不含 `.json` 的文件名，`_` 开头的文件被忽略）。在首次启动向导中选择，用 `/settings set ui=en` 更改。界面和三份 README（`README.md`、`README.ru.md`、`README.zh.md`）提供英语、俄语和中文。刻意不翻译：智能体与经理的系统提示词（回答语言由 `language` 决定）、命令参数名（语法的一部分）、配置诊断（fail-fast 层）。
- `maxTurns` — 每轮最多回答人数（默认 3；0 — 不限，由主持人决定谁答、答几人）。会进入主持人的提示词：“从 1 到 N 中挑选”。
- `language` — 团队交谈使用的语言（默认：俄语）。它会原样进入系统提示词 —— “严格用以下语言回答：……” —— 所以任何写法都行：`russian`、`ru-RU`、`english`、`中文`。每轮都会重读该语言：改动无需重启即生效。
- `width` — 逻辑屏幕宽度，40 到 500 的整数。所有输出（智能体回答、横幅、帮助）都按这个宽度折行，而不是整个终端宽度：文本不会在宽窗口里拉满。终端更窄时，宽度会被压到终端宽度。
- `margin` — 屏幕边缘留白，0 到 10 的整数（默认 2）：内容左右缩进书写，聊天面板从顶部缩进之下开始，输入区与底边隔两个空行。
- `screen` — 全屏模式（默认 `true`）。`false` 恢复旧的“线性”readline 界面 —— 比如用于管道和特殊终端（非 TTY 启动本来就会自动切过去）。
- `runTimeoutMs` — 命令超时（`run` 和 `ssh` 块，默认 180000 = 3 分钟）；挂起的进程连同子进程一起被中断。
- `maxOutputChars` — 命令输出裁剪到的字符数（默认 4000）。

**全屏的工作方式**（终端的备用缓冲 —— 退出后终端恢复启动前的样子）：

```
┌──────────────────────────────┐
│                              │
│  聊天面板（回滚区）           │  ← 历史与回答流式输出
│                              │
├──────────────────────────────┤
│  5 行提示                    │  ← 命令、@ 面板、状态/转轮
├──────────────────────────────┤
│  You > 输入                  │  ← 输入区，折行时向上生长
│                              │
│  （两个空行）                │  ← 与底边的间距
└──────────────────────────────┘
```

聊天在自己的面板里滚动 —— 提示、输入和状态始终待在原地。按单词折行而不是按字符；超长单词按字符截断。输入区同样：按单词折行，光标跨行移动（↑/↓ 留给历史，移动用 ←/→/Home/End）。调整终端尺寸会即时重建各区域。

**回滚区。** 启动时面板立即显示上一场谈话的尾部 —— 带成员的签名色；要看更早的内容，用**鼠标滚轮**或 **PgUp/PgDn**（整页）向上滚。**Ctrl+PgUp** 跳到历史最开头，**Ctrl+PgDn** 回到最新消息。向上滚动时新回答不会把视图拉到底 —— 视图保持“钉住”，底部提示行出现计数：“↑ 历史：上面还有 N 页”。滚回底部 —— 视图回到最新消息，流式输出恢复实时。滚轮依赖终端的鼠标模式：开启期间，某些终端里用鼠标选文本需要按住 **Shift**。

**文本选择。** 聊天历史里用鼠标选择片段：按下左键、拖动、松开 —— 无色文本进入剪贴板（Windows 走 `clip`，其他平台走 OSC 52），状态行闪烁“✓ 已复制到剪贴板”。

**输入区**（正在输入的消息）里的键盘选择与普通编辑器一样：**Shift+方向键**（←/→/↑/↓ — 按字符和软折行行）、**Ctrl+Shift+←/→**（按词）和 **Shift+Home/Shift+End**（到输入的开头/结尾）。输入替换所选，Backspace/Delete/Ctrl+W 删除所选，←/→/Home/End 把所选塌缩到一端，↑/↓ 取消所选，**Ctrl+C** 复制（选择保留），**Esc** 取消。输入区为空时，Shift+方向键选择聊天历史（第一下抓住最后可见行，然后逐行并自动滚动；Shift+Home/End — 光标所在行的开头/结尾）。两处都没有选择时，Ctrl+C 照旧 —— 中断本轮/退出。

**正在流式输出的回答**不会被裁成一行：智能体未完成的流会折行并占据面板底部几行（从五行到整个面板高度 —— 取更短者），紧贴输入区。流式期间对那些“活”行同样可以选择 —— 鼠标和空输入下的 Shift+方向键都行；回答结束进入历史后选择即被丢弃（行还在原地，只是成了普通历史）。向上翻历史时看不到实时流 —— 它在“屏外”结束，视图回到最新消息时再出现。

**提示行**（输入区上方 5 行）：输入 `/` 时的命令列表、`@提及` 面板（它可以继续长高，盖过聊天），最底一行是状态：“Yana 正在输入…”转轮、智能体动作的确认问题（`y/n`），以及历史翻起时的“↑ 历史：上面还有 N 页”计数。

**输入编辑键：** ↑/↓ — 消息历史（草稿保留），Ctrl+U — 清行，Ctrl+W 或 Alt+Backspace — 清词，←/→/Home/End — 光标，Ctrl+←/→ — 按词，Delete — 删除光标后字符，空行上 Ctrl+D — 退出。剪贴板粘贴把换行粘成空格（多行粘贴不会分片发出）。光标不会把表情或其他复合字符切半。

## 工具：智能体写文件、跑命令

默认团队只会讨论。但可以给智能体真实的动作权限 —— `~/.dreamteam/agents/` 里的 `"tools"` 字段。形式统一 —— 卡片对象：工具名 → 它的设置（对象；`null` 或 `{}` — 默认设置）：

```json
"tools": { "files": {}, "shell": null }
```

- `files` — 智能体可以创建和覆盖文件；
- `shell` — 智能体可以通过**系统 shell** 在这台电脑上运行命令：Windows 上是 cmd.exe（`dir`、`type`、`findstr`），Linux/macOS 上是 `/bin/sh`（`ls`、`cat`、`grep`）。智能体的速查表里明确写明所处环境，因此不会在 Windows 下写 bash 命令。Git 有单独的工具；
- `git` — 仓库工作作为独立工具（``git status``、``git commit -m "…"``），不走本地 shell：只读 —— 静默放行，改写 —— 按卡片规则或提问（仓库由卡片的 `"repo"` 字段固定，否则是项目工作文件夹）；
- `arch` — **zip / tar / tar.gz** 归档，不依赖外部程序 —— 纯 Node，Windows 和 Linux 表现一致（``arch pack out.zip src/``、``arch unpack archive.zip``、``arch list archive.zip``）。防护：拒绝 zip-slip 和归档内符号链接；按卡片限制条目数与总大小（`maxEntries`、`maxTotalBytes`）防归档炸弹；机密和 `.dreamteam` 永不打包。刻意不支持 rar/7z；
- `ssh` — 智能体可以在**已配置的服务器**上运行命令（见下文），无需本地控制台：`"tools": { "files": {}, "ssh": null }` —— 而且这种智能体的 `run` 块会被自动拒绝；
- `look` — 智能体可以“看”图（视觉模型），`image` — 生成/重绘图片（见“视觉与图片”）；
- `docs`、`ocr`、`web`、`mail`、`telegram`、`max` — 文档、扫描件、网页、邮件和即时通讯（见下文“文档、扫描件、网页与通讯”）；这些工具的机密放在家目录文件里，不进智能体卡片。

工具也可以通过经理开启：“给 Gleb 开 shell” —— 它会把卡片写进 `agents/`（之后也能编辑：“给 Gleb 开 docker compose 权限”）。

**工作方式。** 智能体在回答里插入动作块，应用先检查结构性权限（该智能体是否启用了此工具、项目/服务器是否匹配），然后由**工具自己**决定 —— 它必需的 `check()` 方法返回三种裁决之一：

- `allow` — 静默放行，不提问；
- `ask` — 向你展示确认：

  ```
  ⚙ Command: 💾 Gleb: [shop] docker compose up -d
      y — run · n — deny
  ```

  `y` — 执行，`n` — 拒绝（智能体会知道被拒，并提出别的方案）；
- `deny` — 直接拒绝，不提问。

内置默认：`files` 静默放行工作文件夹内的路径，越界则提问；`look` 和 `image` 总是放行；`shell` 和 `ssh` 对每条命令都提问，直到工具卡片定义了规则（见下文“工具卡片”）。结果作为“⚙ tools”的消息返回给智能体，它继续工作 —— 就这样一步一步，“程序员”真的在写文件，“运维”真的在跑 `docker ps` 并阅读输出而不是编造。每次回答最多三个“动作 → 结果 → 继续”循环。发生的一切都留在历史里：`/session history` 把动作显示为“⚙ tools”条目。

**工作文件夹即启动文件夹。** 智能体在应用启动所在的文件夹工作（以及通过其 `"workspace"` 字段分配的子文件夹 —— 相对启动文件夹的路径）。文件只写在那里，命令只在那里跑。

**服务器注册表。** `.dreamteam/hosts.json` — 当前项目的 ssh 服务器（文件由骨架创建）。项目即应用启动的文件夹；服务器用命令 `/project host add prod=deploy@203.0.113.10`、通过经理（“添加 prod 服务器 —— deploy@203.0.113.10”）或手动添加；用 `/project host delete prod` 移除：

```json
{
  "prod": {
    "user": "deploy", "host": "203.0.113.10", "port": 22,
    "dir": "/var/www/app", "password": "…"
  },
  "router": { "user": "admin", "host": "192.168.1.1" }
}
```

扁平字典：服务器名 → 连接，每条必有 `host` 字段。块里按名字引用服务器（`ssh prod uptime`）；也认识 `project:prod` 长格式。

`agents/` 里给智能体分配项目并开启工具：

```json
"tools": { "files": {}, "ssh": null }, "projects": ["project"]
```

项目只有一个 —— 当前文件夹，标签是 `project`；`projects` 字段让智能体够得到它的服务器。带着别人标签的动作在确认前就被拒绝。权限在 `/team` 可见。

**走 ssh 的服务器。** `ssh prod` 块（或 `ssh project:prod`）正文带命令时，由这台电脑的常规 ssh 客户端执行：`ssh deploy@203.0.113.10 "command"` —— 超时、输出裁剪和 Esc 都与本地命令一致。默认 `BatchMode=yes`：只用密钥，没有密钥命令立刻失败而不是挂住。

主机还可以有两个字段：

- `dir` — 服务器上的项目文件夹。连接后一切从它开始：命令以 `cd '<dir>' && pwd && <command>` 发往服务器 —— cd 失败（没有该文件夹）命令就不会启动，pwd 在输出里确认文件夹。ssh 工具的路径检查也从这个文件夹起算：绝对路径、`..` 或 `~` 越界 —— 连接前就给出带理由的拒绝；
- `password` — 用密码代替密钥。常规 ssh 不从配置读密码，所以命令经 `sshpass -e` 执行（密码在环境变量里，不进进程列表）；PATH 上没有 sshpass —— 明确拒绝。密码以明文放在配置里：这是你的机器，但要心里有数。最好不要在经理对话里口述密码 —— 手动写进 `hosts.json`。

文件交换 —— 同样的块：`put local remote` 或 `get remote local` 正文交给常规 `scp`。本地一侧必须在工作文件夹内，远端一侧 — 在主机 `dir` 内；默认传输要问你 `y/n`，卡片规则（`"allow": ["put *"]`）可以静默放行。

**工具卡片。** `tools` 字段只能是卡片对象：工具自己读取卡片内容，应用不看里面；空对象或 `null` — 默认设置：

```json
"tools": {
  "files": {},
  "shell": {
    "allow": ["git *", "npm run *", "docker compose *", "ls"],
    "deny": ["git push *", "rm *"]
  },
  "git": { "repo": "C:/dev/shop" }
}
```

`git` 卡片（内置工具）：`repo` — 固定仓库（否则用动作的工作文件夹），`allow`/`deny` — 与 `shell` 相同的命令规则（只读 —— `status`、`log`、`diff`… —— 静默放行且无需卡片），`timeoutMs`（默认 120 000）和 `maxOutput`（字符数，默认 4000）。

`shell` 和 `ssh` 规则（一旦设置，完全取代默认）：链（`&&`、`;`、`|`、`&`、换行）被解析成单独的命令；`deny` 禁止链中任何位置的命令；`allow` 只有当链中每条命令都按整词以允许的前缀开头时才静默放行（`git` 匹配 `git status`，不匹配 `gitify`；`*` — 任意后缀，只能作最后一个词）；带替换的命令（`$`、`(`、`)`、`<`、`>`、`` ` ``）永不静默放行 —— 只能提问。既不匹配 `allow` 也不匹配 `deny` 的，作为普通 `y/n` 问题展示给你。

**默认策略**（空卡片或 `null`）— `git` 工具与工作文件夹围栏的组合，同 `files`：

- 只读命令静默放行：Linux 上的 `shell` 是 `ls`、`cat`、`grep`…，Windows 上 — `dir`、`type`、`findstr`；`ssh` — `uptime`、`df`、`systemctl status`…（`find`/`systemctl` 的改写标志不在默认之内）；
- 变量替换（`$VAR` 和 `%VAR%` —— 泄漏环境机密也会被抓到）— 提问；
- 工作文件夹之外的路径 — 不再是提问而是**带理由的拒绝**：`shell` 检查路径参数是否在文件夹内（`cat ../secret` — 拒绝）；`ssh` 上机器跑不掉，相对路径算“自己的”，绝对路径、`..` 和 `~` — 出走的路（`cat /etc/passwd` — 拒绝）；
- 机密（`.env`、`*.pem`、`*.key`、`id_rsa`…）即使在文件夹内也永不静默读取 — 拒绝；
- 其余 — 普通 `y/n` 提问。

这些都不藏在代码里：每个内置工具都有**必需的默认配置** —— 代码旁的 `src/tools/<tool>/default.json`。里面既有只读命令白名单（`shell` 带平台集合 `"allow"`/`"allowWin32"`，`ssh`、`git`），也有出厂设置（`arch` 限制、`ocr` 语言、`docs` 用的 `soffice` 桥地址、空的 `web` 白名单）。智能体的空卡片意为“取 default.json”；带字段的卡片完全取代它。默认文件损坏会让工具构建失败并给出明确错误 —— 与卡片损坏相同。

**命令工具的分工。** `run`、`git` 和 `ssh` 是命令行的三个入口，各有领域，智能体的速查表里写得明明白白：本地命令行 — `run`（除 git 和服务器外的一切），仓库工作 — 只用 `git` 块（经 `run` 跑 git 命令永不静默放行 —— 智能体会收到人工问题并换用对的工具），服务器命令 — 只用 `ssh` 块。

**文件掩码**（`ssh` 和 `files` 工具上的 `"masks"`）— 工作文件夹围栏之上的又一层：gitignore 语法的掩码列表。不带 `!` 的掩码是禁令，带 `!` — 放行；最后匹配者胜，没有匹配 — 放行。掩码拒绝会带着理由到达智能体，且不被 `allow` 规则绕过：规则决定要不要问人，掩码决定什么永不允许。

```json
"ssh":   { "masks": ["*", "!logs/**", "!tmp/**"] },
"files": { "masks": ["*.env", "*.pem", "*.key", "id_rsa*", "secrets/**"] }
```

语法：`*` — 名字内的任意字符，`?` — 恰好一个，`**` — 任意层数的文件夹（`src/**/*.ts`）；不带斜杠的掩码（`*.log`）在任意深度匹配文件；目录掩码（`secrets`）连同内容一起锁住。`files` 的相对路径从工作文件夹起算，`ssh` — 从主机 `dir` 起算（put/get 时掩码对两侧 — 本地和服务器 — 都生效）。

内置工具的卡片是严格的：未知字段 — 构建工具时明确报错，而不是悄悄失效的规则（`shell` 允许 `allow` 和 `deny`；`ssh` — `allow`、`deny` 和 `masks`；`files` — `masks`；其余工具没有设置）。default.json 受同样的管控。

**自定义工具。** 把文件放进家目录的 `~/.dreamteam/tools/` — 文件名成为工具名，代码无需重启即被加载：

```ts
// ~/.dreamteam/tools/my.ts
import type { Tool, ToolConfig } from 'dreamteam/src/tools-api.js';

export default (config: ToolConfig): Tool => ({
  desc: 'what it is and how to use it — goes into the agent cheat sheet',
  check: (body) => (body.startsWith('dangerous') ? 'ask' : 'allow'),
  run: async (body, ctx) => {
    // the action; the result is a string, an error — throw Error
    return 'done';
  },
});
```

契约：`desc` — 给智能体速查表的字符串；`check(body)` — **唯一的校验点**，返回 `'allow' | 'ask' | 'deny'`，拒绝可以带理由 —— `{ deny: 'reason' }` 会进入“⚙ tools”报告，智能体会改写请求而不是盲目乱试；`run(body, ctx)` — 动作。`ctx` 里工具能看到动作的工作文件夹和项目，`ctx.run` — 走完整管道跑命令（带你的 `y/n`），`ctx.http` — HTTP 请求，`ctx.confirm` — 对人的实时提问。内置工具名（`files`、`shell`、`ssh`、`look`、`image`）不可占用。下载的工具代码责任自负，与任何 npm 包一样：它以你的用户权限运行。（`dreamteam/src/tools-api.js` 导入路径用于 npm 全局安装；在仓库克隆里工作时用相对路径 `'../src/tools-api.js'`。）

**现成工具：git**（随包附带）。`git` 块正文或块行带子命令（`git shop:log --oneline`）；仓库 — 动作的工作文件夹（智能体的子文件夹）或卡片 `repo` 固定的那个。

```json
"git": {
  "allow": ["add *", "commit *", "checkout *"],
  "deny": ["push *"],
  "repo": "C:/dev/shop"
}
```

无规则时的默认策略：只读命令（列表在 `src/tools/git/default.json`：`status`、`log`、`diff`、`show`、`blame`、无参数的 `branch`…）静默放行 —— 链中也一样；一切改写型命令（`commit`、`push`、`reset`、`stash pop`…）和任何替换 — 提问。设置 `allow`/`deny` — 规则像 `shell` 一样工作并完全取代默认。其他设置：`timeoutMs`（默认 120000）和 `maxOutput`（字符，4000）；未知字段 — 报错。`git` 直接运行（spawn，不经 cmd.exe），参数按数组传递，所以块正文里的引号是参数引号，不是 shell 语法。给智能体在其 `tools` 里加 `"git": {}` 字段即可启用。

**安全：**

- 文件只写**在工作文件夹内** — 应用启动文件夹或分配给智能体的子文件夹（其卡片里的 `workspace`）；
- 每个动作都过工具的 `check()`：允许 — 静默，可疑 — 必须你的 `y/n`；拒绝（`deny`）带着理由到达智能体 — 它明白原因并构造妥当的后续请求；刻意不做“本会话其余时间放行”：允许什么写在卡片里，随时可以去看；
- 权限在确认前检查：别人的项目（包括其服务器）— 自动拒绝；
- 命令有 `runTimeoutMs` 超时（默认 3 分钟）— 挂起的进程连同子进程一起中断；输出裁剪到 `maxOutputChars`（默认 4000 字符）；
- 中断本轮（Esc）也会取消正在运行的命令。

mock 模式下带工具的智能体会演示：写出 `demo-agent.txt` 并运行 `echo` — 无需 API 密钥即可检查整个循环。Windows 上命令输出可能出现乱码西里尔文 — cmd.exe 按控制台编码（cp866）打印；命令本身工作正常。

## 文档、扫描件、网页与通讯：docs, ocr, web, mail, telegram, max

六个内置工具负责典型差事：“这是合同 — 把所有相关方提取出来”、“这是护照扫描件 — 识别、做成 excel、用 MAX 和邮件发给我”。通过智能体 `tools` 里的卡片启用，全部走常规动作块和你的 `y/n`：

```json
"tools": { "files": {}, "docs": {}, "ocr": {}, "web": {}, "mail": {}, "max": {} }
```

**docs — 文档：读与写。** `docs` 块：

- `read file` — 文档文本：pdf、docx、xlsx（工作表 → markdown 表格）、csv、txt/html/odt/ods/rtf；
- `tables file [csv] [sheet]` — xlsx/csv 表格：回答是 markdown 或 csv 行，`sheet` — 工作表名或编号；
- `write file.xlsx` — 块正文：带表头和分隔行的 markdown 表格 `| a | b |` — 保存为真正的 xlsx；`.md`/`.csv`/`.html`/`.json` — 按扩展名；
- `append file.docx` — 把段落（块正文）追加到已有文档末尾；
- `convert pdf file.doc` — 格式转码。原生路径：docx↔pdf/html/txt、xlsx↔csv/html、csv↔xlsx。其余（`.doc`、`.xls`、`.rtf`、`.odt`…）— 走 LibreOffice 桥：`cd docker && docker compose --profile soffice up -d --build`（端口 8200），工具卡片里设 `"soffice": "http://127.0.0.1:8200"`。

**ocr — 从扫描件提取文字和表格。** `ocr` 块（tesseract，rus+eng）：

- `text scan.png [pages]` — 识别文本：图片、pdf 页（`2` 或 `2-5`）或 docx 内的图片；
- `tables scan.pdf 1-3 [csv]` — 表格：按坐标聚类单词，回答是 markdown 表格或 csv。

首次启动时模型下载到 `~/.dreamteam/cache/tesseract`（离线机器 — 把 `rus.traineddata` 放在旁边并在卡片里设 `"langPath"`；卡片字段：`lang`、`langPath`、`dpi`）。扫描件永远只是草稿：速查表明确要求智能体对结果做语义复核。

**web — 读取允许的网站。** `web` 块，地址只来自卡片白名单：`"web": { "sites": ["example.com", "docs.corp.ru"] }`（本地地址同样只走清单）。`read address` — 页面转文本（文章阅读器 + 兜底路径），`links address [filter]` — 页面链接及其文字（“第 9 章。交易 — https://…”）：标题告诉你去哪而无需逐页读取；过滤器搜索地址和标题。跟随重定向，但每一跳都对着清单检查；不执行 JavaScript — 脚本绘制的页面会诚实说明。

**mail — 电子邮件。** 邮箱放在项目的 `mails.json`（`.dreamteam` 服务文件夹；密码只放那里，绝不放卡片；必须用**应用专用密码**）。邮箱用命令 `/mail add work user=… password=… imap=… smtp=…`、与经理对话（“添加 work 邮箱…”）或手动创建 — 格式唯一，一切显式，没有预设：

```json
{
  "personal": { "user": "me@yandex.ru", "password": "…",
                "imap": "imap.yandex.ru", "smtp": "smtp.yandex.ru" },
  "work": { "user": "me@corp.ru", "password": "…",
            "imap": "imap.corp.ru", "smtp": "smtp.corp.ru", "smtpPort": 587 }
}
```

`imap` — 收件服务器，`smtp` — 发件；默认 993/465 加密端口，可用 `port` / `smtpPort` 字段覆盖。常见服务商主机：

| 服务商 | IMAP (`imap`) | SMTP (`smtp`) |
|---|---|---|
| Yandex | `imap.yandex.ru` | `smtp.yandex.ru` |
| Gmail | `imap.gmail.com` | `smtp.gmail.com` |
| Mail.ru | `imap.mail.ru` | `smtp.mail.ru` |

如果服务商服务器出示的证书与名称不符（共享主机上的 `mail.my-site.ru` 常见），连接会被名称校验拒绝 — 此时在该邮箱设 `"tlsNoVerify": true`：加密保留，只校验密码，但这样的配置不再察觉服务器替换，请有意识地启用。`mail` 块：`boxes` — 不带密码的邮箱列表；`list [box] [N]`、`find <box> <text>` — 收信；`read <box> <uid>` — 整封信，附件存到工作文件夹的 `mail/`；`send <box>` — 块正文开头是 `to:` / `subject:` / `files:` 头部、空行、信件正文。发送总要问 `y/n`；附件 — 只能是工作文件夹里的文件；机密（`.env`、密钥、`.pem`）永不读取或发送。

**telegram 与 max — 即时通讯。** 机器人放在项目的 `messengers.json`（`.dreamteam` 服务文件夹；Telegram 令牌 — @BotFather，MAX 令牌 — dev.max.ru）。机器人用命令 `/messenger add telegram <token>` 或与经理对话创建：

```json
{ "telegram": { "token": "123456:ABC…" }, "max": { "token": "…" } }
```

`telegram` 块：`list` — 给机器人发过消息的聊天（chat_id + 名字）；`in [N]` — 收到的；`send <chat_id>` — 消息（正文是文本，开头一行 `files: path` — 附件作为文档）。`max` 块：`me`、`chats`、`in`、`send <chat_id>` 或 `send user:<user_id>` — 文件经 `/uploads` 下载。“发送到收藏夹” = 机器人与你的对话：你第一次给机器人写消息后，它的 chat_id 就出现在 `list`/`chats` 里。两个工具：读取 — 静默，发送 — 总是 `y/n`；代理或实验可换 API 地址 — `"api": { "max": "http://127.0.0.1:8082" }`。

“护照扫描件 → excel → MAX + 邮件”场景自行组装：智能体启用 `ocr`、`docs`、`max`、`mail` — 它识别扫描件、用 `docs write passports.xlsx` 做表，再用 `max send` + `mail send` 发出，每条外发消息都展示给你确认。

## 视觉与图片：`look` 和 `image`

可以给智能体独立于“大脑”的“眼睛”和“双手”：它用普通 LLM（`provider` 字段）与你交谈，用视觉模型（`vision` 字段）看图，用图像模型（`image` 字段）作画：

```json
"tools": { "look": null, "image": null },
"vision": "qwen2-vl-2b",
"image": "bk-sdm"
```

- **`look`** — 智能体把文件展示给视觉模型并提问：图里是什么、有哪些按钮和颜色、渐变在哪里、构图有什么问题。描述作为动作结果返回给它。排版师就这样把设计稿拆成代码块，画师在得出结论前先自查自己的生成图。
- **`image`** — 生成与重绘。智能体自己选全部参数 — 提示词、尺寸、变体数、质量、参考图：

````text
```image
prompt: poster sketch, minimal flat style, deep blue palette
size: 512x768
n: 4
refs: images/poster-2.png
```
````

`refs` 开启“以样本重绘”模式（以你选中的变体为基础）。文件保存到工作文件夹的 `images/`，路径作为结果发给智能体，并在看图器里为你打开。确认与其他工具一致 — 该行会显示智能体想要多少张、什么尺寸，因此过于野心勃勃的画师能在烧钱之前被拦下。

**眼睛和双手独立配置。** 画师用云端视觉（GLM-4.6V），排版师用本地（docker 里的 Qwen-VL）；改一行 `models/` 即换生成器，人设不动。服务商加 `"vision": true` 即“能看”（`openai-compatible` 和 `anthropic` 适配器可传图片；`mock` — 用自己的方式“看”，用于演示）。图像服务商 — `openai-images` 适配器（docker 里的我们的门面或云端 API）和 `mock-images`（测试用，无需 docker）。

**docker 里自己的模型。** `docker/` 文件夹自给自足：拷到任何机器，按名字拉起模型 — `docker compose --profile qwen2-vl-2b --profile bk-sdm up -d`（最轻的一对，各约 3 GB 内存，完全不需要 GPU），更宽裕的机器 — `sd-turbo`，有 GPU — `qwen3-vl-8b`、`flux-dev`、`photomaker`（人脸控制）等。容器总是手动启动 — 应用只通过 HTTP 与它们通信，自己从不启动任何东西。创作三人组（Marta、Nika、Pasha）出厂即指向 CPU 模型，所以手动启动轻量一对后循环立刻就绪，无需改配置；只有容器住在另一台电脑上时才需要改 `models/` 里的机器地址。细节与模型表 — `docker/README.md`。

**草图协议。** 创作成员的人设固化了规则：新任务 → 便宜的低分辨率草图若干变体 → 展示给你并询问 → 以选中的变体为参考修改 → 批准后才出高分辨率成品。选择权永远在你：智能体不得悄悄废掉一个方向。

mock 模式下整个循环无需模型即可工作：`mock` 按模板描述图片，`mock-images` 保存真实的 PNG — “草图 → 选择 → 重绘”场景在任何机器上都能验证。

## 历史、日志与上下文压缩

- **每场谈话的完整历史**以两种形式保存：
  - `<project>/.dreamteam/transcripts/<id>.md` — 人类可读的日志（任意编辑器可开），随谈话更新；
  - `<project>/.dreamteam/sessions/<id>.json` — 机器可读的状态（`/session` 用它）。
- **`/history [N]`** 在终端打印当前谈话的历史，带成员颜色。
- **上下文压缩。** 谈话变长时（超过约 24 条消息），旧消息由 LLM 自动卷成简短摘要（`session.summary`），上下文只进摘要 + 最后 16 条消息。完整历史在任何地方都不会被删除 — 它留在 JSON 和 transcript 里。聊天里会出现“旧消息已卷成摘要”的提示，智能体继续记得讨论的要点。

消息里：`@marina` / `@viktor` — 点名特定成员（按名字和 id 都行，大小写无关；`!` 是 `@` 的同义词）。

## 你对团队是谁：/me 与 ~/.dreamteam/user.json

默认成员只把对话者看作“User”。为了让团队知道你是谁、怎么称呼你，请自我介绍：

```
You > /me Alexey; startup founder; values brevity and specifics
  Noted: you are Alexey (startup founder). The team now knows who you are.
```

- 名字进入所有系统提示词（“你的对话者是 Alexey…”）、上下文里你消息的签名（“Alexey: …”）以及主持人处 — 智能体开始用名字称呼你。
- 资料保存在 `~/.dreamteam/user.json`，也可以手动编辑（无需重启即生效）；向导在首次启动时填写：

```json
{ "name": "Alexey", "role": "startup founder", "about": "values brevity" }
```

## 团队记忆：关系、任务与其他谈话

每个成员都有自己的**主观记忆**：

- **谈话内** — 本聊天中的个人任务、对你和每位同事的个人态度（“Timur 在催进度，但道理上他是对的”）；
- **谈话间** — 别的聊天里讨论过什么（每人有自己的版本，就像真人一样）以及**团队共享文档** — 决定、约定、悬而未决的问题。

这让成员像人：无需显式 `@session` 就记得已关闭聊天里的约定，与你和彼此形成关系，每个人都明白自己在当前谈话中的任务。

**Token 经济**（记忆永不膨胀）：

- 普通一轮 — **零**额外 LLM 调用：记忆从缓存读取；
- 约每 12 条消息，一名回答者会“反思”谈话并更新自己的记忆（一次小调用，不是全员同时）；
- 关闭谈话（`/session new`、`/exit`）时其摘要并入共享日志和共享记忆 — 通常 0–2 次调用，摘要已缓存；
- 每份文档都有硬性词数上限，记忆以紧凑块（约 150–250 token）进入智能体上下文。

偷看一眼：`/memory Gleb` — Gleb 在本谈话中记得什么（任务、对你的态度、关联），`/memory shared` — 团队共享记忆。存储：`.dreamteam/memory.json`（团队记忆 — 属于项目）+ 会话 JSON 里的 `memories` 字段（`<project>/.dreamteam/sessions/`）。

## 链接其他会话：`@session`

经典情形：一周前你们在某个聊天里讨论过公司名字并关闭了话题。今天在新聊天里讨论产品 — 想提醒团队关于名字已经决定了什么。为此，把旧谈话附上来：

```
You > we're discussing the company's products. Remind us what we decided about the name: @session
  → the list of sessions → enter a number (Enter — cancel)
You > what do we do next? @session 2     ← straight by number from /sessions
```

工作方式：

- `@session`（不带编号）显示其他会话列表；输入编号或按 Enter 取消。`@session N` 直接附加会话。`!session` 是 `@session` 的完全同义词。
- 对附加的会话，LLM 生成**摘要**（决定、论据、名字、悬而未决的问题）— 而不是全文，以免撑爆上下文。
- 摘要以 `📎 Attached a digest of session "..."` 的形式显示在聊天里并存入历史：当前谈话的所有成员都“看得见”它，并在后续回答中考虑它。
- 一条消息可以附加多场会话：`@session 2 @session 5`。
- 摘要缓存在原会话中，只有当该会话又增长了 10+ 条消息时才重建。

## 会议室经理：`@manager`

成员之外还有**会议室经理** — 就是那个规划轮次的主持人，但它有自己的配置和更改团队设置的权力。新谈话里它是第一位对话者（见“第一场对话”）；之后随时可以召唤：

```
You > @manager, add analyst Ruslan to the team, let him work on claude
You > @manager give Gleb the lead developer role and temperature 0.3
You > @manager bring Katya into this chat
You > @manager show the sessions and open the second one
You > @manager enable the git tool for Pasha and allow him commit
You > @manager add the router server — admin@192.168.1.1
```

经理完成请求并用 `✓ …` 行直接在聊天里报告。通过它 —— 且只通过它 —— 应用更改配置：

| 你请求什么 | 它做什么 |
|---|---|
| “把 … 加进团队” | `agents/` 里的新成员：id、名字、角色、提示词、表情、颜色、服务商、温度、工具 |
| “指派 …” | 编辑成员：角色、提示词、模型（服务商）、温度、名字、表情、颜色 |
| “叫进来 …” / “请出去 …” | 当前聊天名单（同 `/chat add` 和 `/chat remove`） |
| “显示会话”、“打开 #2”、“新会话 …”、“删除 #3” | 会话管理（同 `/sessions`、`/session open`、`/session new`、`/session delete`） |
| “把会话重命名为 …”、“给这场谈话起个名字” | 重命名（同 `/session rename`）；起名时经理用简短摘要或谈话开头 |
| “开启 … 工具 …” / “给 … 权限 …” | 成员的工具：启用或更新卡片（`shell`、`ssh`、`tools/` 里的自定义工具…） |
| “添加服务器 …” | `hosts.json` 服务器注册表：当前项目里的新服务器 |
| “添加邮箱 …”、“移除邮箱 …” | `mails.json` 邮箱注册表（同 `/mail add` 和 `/mail remove`） |
| “添加 telegram 机器人 …”、“移除机器人 …” | `messengers.json` 里的机器人令牌（同 `/messenger add` 和 `/messenger remove`） |

对 `agents/` 和项目注册表（`hosts.json`、`mails.json`、`messengers.json`）的编辑是安全的：文件经临时文件带有效性校验地重写 — 失败的编辑不会毁掉配置，未知字段被保留。如果你手动弄坏了 `agents/`（JSON 损坏、缺 `name` 或 `prompt` 的智能体），团队不会无声消失：错误在一轮中可见，也出现在网页外壳团队面板的红行里。文件缺失不是错误 — 就是从与经理一对一的空状态开始。

经理能做的一切也都有显式的清单操作 — `/team add`、`/team grant`、`/project host add`、`/project open`（同一批执行器：神经网络和命令都经同一批经过验证的助手写配置）。经理的价值在命令覆盖不到的地方 — 比如为新成员构思提示词，或决定谁该拿到哪个工具。

它的配置在 `.dreamteam/manager.json`（文件必需，如同 `settings.json`）：

```json
{ "model": "openai", "name": "Manager", "emoji": "🛎", "color": "yellow", "temperature": 0.2 }
```

- `provider` — `models/` 里的 id，模型取自服务商记录。未知 id — 应用不启动，并给出明确错误。
- `name` — 称呼用的名字。`@manager` 和 `!manager` 始终可用，与名字无关；在 `@` 面板里它排第一。
- `emoji`、`color` — 行的外观；`temperature` 默认比成员更严格（0.2）：期待经理谨慎行事，而不是发挥创意。

`/model` 更换的是**智能体**的主力服务商；经理有自己的服务商（来自 `manager.json`）— `/model` 不影响它。

## 自定义角色与自己的 API

**更换团队** — 编辑 `~/.dreamteam/agents/`（即时生效）：字段 `id`、`name`、`emoji`、`role`、`description`、`color`（red/green/yellow/blue/magenta/cyan/white/gray）、`prompt`（人设），可选 `provider` 和 `temperature`；真实动作的权限 — `tools`、`projects`、`workspace`，眼睛和双手 — `vision` 和 `image`（见“工具”与“视觉与图片”）。`provider` 字段只能是 `models/` 里存在的 id：`/team add|update` 命令、网页外壳和经理都会拒绝陌生的 id 并给出可用列表，而不是把垃圾写进配置。

**接入新 API — 一个文件，无需 fork。** 把适配器放进家目录的架子
`~/.dreamteam/models/`：文件名即适配器 id，`models/` 里的服务商卡片用 `"adapter": "<id>"` 引用它。架子在首次启动时创建；代码在启动时加载 — 文件损坏或与内置适配器（含 image-）重名，都会在启动时给出明确错误：

```ts
// ~/.dreamteam/models/my-api.ts
// npm 安装后用 'dreamteam/src/models/types.js';
// 仓库克隆里用 '../src/models/types.js'
import type { LLMProvider, ProviderConfig } from 'dreamteam/src/models/types.js';

export default (id: string, config: ProviderConfig): LLMProvider => ({
  id,
  kind: 'my-api',
  model: String(config.model ?? 'default'),
  async *stream(req) {
    // 调用你的 API，分片产出回答
    yield '回答 ';
    yield '分片';
  },
});
```

```json
{ "my": { "adapter": "my-api", "model": "任意" } }
```

对 OpenAI 风格的 API 通常不需要自定义适配器 — 内置 `openai-compatible` 已通过 `baseUrl` 覆盖它们。功能完整的内置示例是 `gigachat`：OAuth 令牌周期与 TLS 证书（见「Sber GigaChat」）。要让适配器随包发布，在 `src/models/` 实现同一接口并在 `src/models/registry.ts` 注册。

## 检查

项目由 `tests/` 里的探针检查 — 不用测试框架，每个文件直接运行并对每项检查打印 `ok`/`FAIL`。所有探针都是密封的：真实数据不被触碰，各层重定向到临时文件夹（`DT_HOME`/`DT_PROJECT`）。

- `npm run probe` — 无需真实终端的快速检查：折行（`probe-screen`）、`settings.json` 与 `hosts.json` 校验、“project:host”式 ssh 寻址与经项目的权限、屏幕区域计算、实时多行流式输出、鼠标与 Shift+按键选择、回滚区（`probe-editor`：按键、光标、历史、输入）、会议室经理（`probe-manager`：配置校验、回答解析、新动作 `tool.grant`/`project.add`/`project.host.add` 及回滚、状态）、作为配置入口的经理端到端管线（`probe-manager-flow`：给 LLM 的状态快照、JSON 协议、全部 11 种操作直至文件与回滚、历史里的 ✓/✗ 报告、切换时发言留在旧会话）、规范命令（`probe-commands`：内核里所有 `/…`、不写历史的拦截、`/team`/`/project` 控制）、项目切换（`probe-project`：家目录注册表、`/project open/add/remove`、内核连同会话与 hosts 隔离切换到另一文件夹、经理的 `project.open`、网页外壳的 rpc 与 state、自动补全）、导入导出（`probe-transfer`：家目录快照 — 卡片密钥在内、.env 不随行、会话按 id 合并、会话作为新会话带智能体按 id 并入、zip-slip 被挡、经 confirm 取消）、GUI/TUI 数据等价（`probe-consistency`：serve 快照 ≡ 家目录层文件、GUI 的一轮对 TUI 可见、重启即接上）、首次启动向导与骨架（`probe-wizard`，含 API 密钥隐藏）、旧布局向各层的迁移（`probe-migrate`：文件搬移、不覆盖、经 `DT_HOME`/`DT_PROJECT` 的探针保护）、外部世界工具 — 全部密封：`probe-docs`（在临时文件夹里读写真实 pdf/docx/xlsx）、`probe-ocr`（用本地 canvas 画带字图片并识别）、`probe-web`（白名单与本地桩站）、`probe-mail`（邮箱校验、发送解析、无网络）、`probe-messengers`（telegram 与 max 对两个 API 的本地 mock 服务器）。界面语言系统由 `probe-i18n` 覆盖（内置 en/zh、外部 lang/、现场切换）。
- `npm run probe:e2e` — Windows 真实伪终端（ConPTY）下的同样区域：真正到达应用的东西（`probe-input`）与经迷你 VT 仿真器的渲染屏幕（`probe-startup`）。它自行安装并移除 node-pty。
- `npm run probe:tui` — 伪终端里完整跑一遍应用：无需向导（各层已替换）、经理问候开场、`team.add`、`chat.add`、带工具的一轮、`/team`、退出 — 全在 mock 服务商和临时文件夹上进行。
- `npm run probe:api` — mock 服务商上的服务器 API（`dreamteam serve`），临时文件夹：gui/ 静态、WS 礼宾场景（问候、发言、经对话的 team.add）、rpc（chat.add/remove、model.set、session.new/delete 及其后的新 state）、实时 confirm/choose 问题 — 客户端回答、超时拒绝、无客户端拒绝。

`npm run typecheck` — 类型检查（src 与 tests）。

## 布局

包全局安装，数据在你身边分两层：

```
~/.dreamteam/                 # 家目录：一台机器 — 一个家
├── models/            # 服务商：适配器、URL、模型、密钥（"apiKey"）
├── settings.json             # 通用设置：界面语言（ui）、谈话语言、屏幕（width/margin/screen）、工具限制
├── user.json                 # 你对团队的资料（/me）
├── agents/               # 团队：角色、人设、颜色、工具
├── manager.json              # 会议室经理：服务商、名字、外观（@manager）
├── projects.json             # 已知项目注册表（/project open 按名字）
├── memory.json               # 团队共享记忆
├── lang/                     # 自定义界面语言：lang/<id>.json
├── tools/                    # 自定义工具：tools/name.ts → 工具 "name"
├── .env                      # serve 设置：TOKEN、PORT、HOST（属于机器的东西）
└── cache/                    # 本地缓存（ocr 的 tesseract 模型）

my-project/
├── .dreamteam/               # 项目：本项目的服务器、邮件与谈话（在 .gitignore 里）
│   ├── hosts.json            # 项目的 ssh 服务器
│   ├── mails.json            # mail 工具的邮箱（应用专用密码）
│   ├── messengers.json       # Telegram 与 MAX 机器人令牌
│   ├── sessions/             # 项目的谈话（JSON）
│   └── transcripts/          # 同样这些谈话的人类可读日志（.md）
└── …                         # 项目本身：智能体在这里写文件、跑命令
```

每场谈话的聊天名单 — 在其 `sessions/<id>.json` 文件里（`participants` 字段）：成员 id 对照家目录里的完整团队；空 — 全员回答。

包代码（经 npm 安装的部分）：

```
dreamteam/
├── bin/dreamteam.js          # 全局命令：tsx 加载器；serve → src/serve.ts
├── gui/                      # `dreamteam serve` 的网页外壳：HTML+JS+CSS，无需构建
├── scaffold/                 # 首次启动配置骨架：home/、project/ — JSON，由向导展开
├── src/
│   ├── index.ts              # 终端外壳：REPL 循环、聊天命令、屏幕与编辑器
│   ├── core/
│   │   ├── engine.ts         # 内核：轮次、主持人、经理、工具、记忆
│   │   ├── projects.ts       # 家目录的项目注册表：记住/遗忘、名字解析
│   │   ├── presenter.ts      # 内核→外壳通道（终端与网络各自实现）
│   │   └── bootstrap.ts      # 各外壳共用的启动：层、配置、服务商、会话
│   ├── serve.ts              # 本地服务器：127.0.0.1 上的 HTTP+WS、gui/ 静态、第二个 Presenter
│   ├── paths.ts              # 三层路径：家目录、项目、工作文件夹
│   ├── wizard.ts             # 首次启动向导：语言、模型、密钥、资料、骨架
│   ├── orchestrator.ts       # 主持人：谁回答、聚焦什么
│   ├── shortcut.ts           # 快速启动快捷方式 (.lnk/.desktop/.command)
│   ├── open.ts               # 浏览器打开 (serve --open)
│   ├── manager.ts            # 会议室经理：配置、提示词、动作（团队/聊天/会话/工具/项目）
│   ├── agents.ts             # agents/ 加载
│   ├── actions.ts            # 智能体动作块、项目、结构性权限、执行
│   ├── docs.ts               # 文档栈：pdf/docx/xlsx — 读与写 + LibreOffice 桥
│   ├── ocr.ts                # 识别：tesseract、pdf 页、按坐标的表格
│   ├── web.ts                # 读网站：白名单、文章阅读器、链接
│   ├── mail.ts               # 邮件：imapflow/mailparser/nodemailer、显式邮箱
│   ├── messengers.ts         # Telegram Bot API 与 MAX（platform-api2.max.ru）
│   ├── tools-api.ts          # 工具契约：check() → allow/deny/ask、卡片、命令规则
│   ├── tools-registry.ts     # 注册表：内置工具与从 tools/ 加载自定义工具
│   ├── tools/                # 内置工具 — 每个工具一个文件夹：tools/<tool>/<tool>.ts
│   │                         #   + 必需的 default.json（默认卡片）：
│   │                         #   files, shell, git, arch, ssh, look, image, docs,
│   │                         #   ocr, web, mail, telegram, max
│   ├── i18n.ts               # 界面语言：t()/tf()、内置 ru/en/zh + 家目录的 lang/
│   ├── locales/              # 内置翻译：en.ts、zh.ts
│   ├── completion.ts         # 命令与 @提及自动补全（提示面板、箭头面板）
│   ├── screen.ts             # 受管屏幕：备用缓冲、区域、按词折行
│   ├── editor.ts             # 输入编辑器：原始按键、历史、按码点移动光标
│   ├── memory.ts             # 团队记忆：个人的、共享的、关于其他谈话的
│   ├── compress.ts           # 长谈话压缩为摘要
│   ├── sessions.ts           # 谈话存储
│   ├── ui.ts                 # 输出颜色与样式（转轮、头部、流）
│   ├── types.ts
│   └── providers/            # API 适配器
│       ├── types.ts          #   LLMProvider 接口 + 配置
│       ├── registry.ts       #   适配器注册表
│       ├── utils.ts          #   SSE 解析器、消息规范化
│       ├── openai-compatible.ts
│       ├── anthropic.ts
│       ├── gigachat.ts       #   OAuth 令牌 + Sber TLS 证书
│       ├── openai-images.ts  #   图像适配器：OpenAI images API / docker 门面
│       ├── mock-images.ts    #   测试图像适配器（真实 PNG，无需模型）
│       └── mock.ts
├── docker/                   # look/image 的模型容器 + docs 工具转换用的 LibreOffice 桥（soffice）
│                             #   — 见 docker/README.md
├── tests/                    # 探针：probe-screen、probe-editor、probe-manager、
│   ├── …                     #   probe-manager-flow、probe-project、probe-tools、
│   │                         #   probe-wizard、probe-input、probe-startup、
│   │                         #   probe-tui、probe-api、probe-commands、probe-docs、
│   │                         #   probe-ocr、probe-web、probe-mail、
│   │                         #   probe-messengers + vt
└── package.json
```
