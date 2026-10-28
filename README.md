# 🎬 Dream Team — a chat with a team of AI agents

[![ci](https://github.com/fwmakc/dreamteam/actions/workflows/ci.yml/badge.svg)](https://github.com/fwmakc/dreamteam/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dreamteam)](https://www.npmjs.com/package/dreamteam) [![node](https://img.shields.io/node/v/dreamteam)](https://www.npmjs.com/package/dreamteam)

**English** · [Русский](README.ru.md) · [中文](README.zh.md)

You don't talk to a single AI here, but to a virtual team: every member has their own
name, role, personality and text color. Your message goes to the moderator-orchestrator,
who decides which team members should answer (usually 1–3 people, not everyone at once).
The agents see each other's remarks, argue and build on each other's ideas. You can
address a specific member with `@name`. Every conversation is saved.

Two shells, one core: a terminal TUI and a local web GUI (`dreamteam serve`).

> **The API and the contracts are stable as of 0.0.10.** They are frozen and
> will be supported: the operations (slash commands and the same-named
> WebSocket rpc methods), the home file formats (`settings.json`, `models/`,
> `manager.json`, `user.json`, `agents/`, projects and sessions) and the web
> shell protocol (`/ws`). The semver promise: breaking changes only in a major
> version, each announced in the CHANGELOG. Before 0.0.10 the interface was
> still stabilizing, so earlier versions promised no compatibility.

The interface — and this documentation — come in three languages: English, Russian and
Chinese (`README.md`, `README.ru.md`, `README.zh.md`). The UI language is chosen at
first launch (in the wizard) and can be changed at any time with
`/settings update ui=en` (`ru`, `zh`, or the id of your own language from
`~/.dreamteam/lang/<id>.json`).

The team belongs to the machine: it lives in your home directory
(`~/.dreamteam/agents/`) and is shared by all projects. It starts out empty — you
are greeted by the **war-room manager**, who will summon members on request, enable
tools for someone, and set up projects with servers. Who exactly answers in a given
conversation is decided by the chat roster — the `participants` list in the session
file: an empty list means everyone you have summoned answers (`/session agent
add|delete <id…|all>`, or asking the manager to "bring Elena in").

## Quick start

You need Node.js ≥ 18.17.

```bash
npm install -g dreamteam   # or: git clone + npm install + npm run build:gui + npm link
cd my-project              # work inside a project folder
dreamteam
```

Check the installation: `dreamteam -v` — the version, `dreamteam -h` — help on the
launch modes (TUI, `serve`, project forms).

On first launch the wizard walks you through the setup (see "First-launch wizard"):
you pick the interface language and a model, enter an API key (the input is hidden)
and introduce yourself — the home `~/.dreamteam` (settings and the team) is
created. The app starts **without a project** — you pick one: `/project new
myproj .` creates a project (the data lives in the home,
`~/.dreamteam/projects/myproj/`; the working folder is the current one) and opens
it. After that it's just you and the war-room manager: tell it what you need.

A project can be opened right at launch — by naming its working folder (an
unknown folder registers itself, id = folder name; opening by name happens in
the chat — `/project open <name>`):

```bash
dreamteam .                  # TUI + the project of the current folder
dreamteam serve .            # the web shell with the current folder's project
```

Without a configured key the app runs in **mock mode** — the agents give canned
answers, so you can try out the interface and the mechanics. The key is entered by
the wizard or later in the model card (`~/.dreamteam/models/`, the
`"apiKey"` field).

## The home and the projects

The app is global (like any CLI), but its data is split into layers:

| Layer | Where | What it holds |
|---|---|---|
| **package** | the installation folder | the application code — read-only, it writes nothing |
| **home** | `~/.dreamteam` | EVERYTHING global: model cards (`models/`), settings (`settings.json`), your profile (`user.json`), **the whole team** — agents (`agents/`), the manager (`manager.json`), tools (`tools/`), the schedule (`schedule.json`), shared memory (`memory.json`) — plus the project folders (`projects/`): the registry of projects is the folders themselves, there is no separate list. The team simulator belongs to the machine: configured once, it works in any project |
| **project** | `~/.dreamteam/projects/<id>/` | EVERYTHING about this specific project: `project.json` (the working folder `"path"`, servers `"hosts"`, mail `"mails"`, bots `"messengers"` — project secrets, never in agent cards) and the conversations (`sessions/`, `transcripts/`). The agents' work files go into the project's working folder; the app's payloads — the person's attachments (`inbox/`), mail attachments (`mail/`), generated images (`images/`) and the export archives — land here too, in the project folder |

The tools' working folder is the `"path"` field of project.json: you set it when
creating the project (`/project new <id> [folder]` — the folder is created if it
doesn't exist) and change it later (`/project update path=<folder>`). A path inside the
home is forbidden — that's where the model keys and settings live. Usually it is
the git repository you launched the app from: the team works on it, nothing to
configure anywhere.

You can switch projects without leaving the app: `/project open <id or path>`
changes the working folder, the list of conversations and the project's secrets —
the team, the models and the shared memory stay with you. An unknown folder
registers itself (the id is the folder name). Overview: `/projects`, rename with
`/project update name=<new name>`, forget with `/project delete <id or path…>`
(the current one must be closed first — `/project close`; the working folder is
left untouched). In the web shell there is a
"Projects" panel: with no project chosen it is expanded and comes first, a click
switches, the "＋" button creates a new project. You can also ask the manager to
switch projects.

The layers are overridden by the `DT_HOME` environment variable — that's how the
probes and isolation work: all of the app's data lives in one folder, and nothing
extra appears in your working repository.

## First-launch wizard

If there is no home (`~/.dreamteam`), the wizard asks, in order:

1. **Interface language** — the very first question, and the wizard itself already
   speaks it: `ru`, `en`, `zh` out of the box, plus your own languages from
   `~/.dreamteam/lang/<id>.json` (see "Settings"). Changed later with
   `/settings update ui=<id>`.
2. **Model** — from the list of adapters (`mock` works for a trial run, no keys
   needed).
3. **API key** — the input is hidden (not displayed and not written to the terminal
   log); the key is saved right into the model card in `models/`
   (the `"apiKey"` field) and picked up immediately.
4. **How to introduce you to the team** — name, role, a couple of words (can be
   skipped).

Then the home is created with minimal files and clear starter notes: a starting
team of five members (an analyst, a secretary, a developer, a designer, a writer)
and the manager on the chosen model, plus the `lang/` shelf for custom languages.
The roster is edited in `agents/` or via a conversation with the manager. No project
is picked at startup — the app honestly starts without one, and the first
`/project new` opens a conversation. Running the wizard again breaks nothing:
existing files are left untouched. In non-interactive mode (a pipe) the wizard
honestly refuses to run — setup requires a live terminal.

## First conversation: the concierge manager

A new conversation always starts one-on-one with the war-room manager — it greets
you right away and explains what it can do. While it is the only participant, all
your remarks are addressed to it, no `@` needed.

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

The manager is the only one who changes the configuration, and only through a
conversation with it (no more shortcuts — only canonical operations). Its system
prompt includes the live state: the team roster with tools, the chat roster, the
list of conversations, the registry of projects with servers, and the list of slash
commands. The manager cannot write files in `tools/` — that action simply doesn't
exist in its protocol.

## Connecting APIs

### How it works

- **Model keys** — right in the model card in `~/.dreamteam/models/`
  (the `"apiKey"` field; for GigaChat you can set a `"clientId"`/`"clientSecret"`
  pair instead).
- **serve settings** — `~/.dreamteam/.env` (`TOKEN`, `PORT`, `HOST`; the `.env`
  in a project folder is deliberately not read — there is a single source of
  variables). These are settings of a specific machine: they are not included in
  the `/export` archive. The wizard creates `.env` on first launch on a fresh
  machine; a home moved over with `/import` does not carry the file — without
  it serve simply listens on `127.0.0.1`, and for outside access create `.env` from
  the sample in the package (`scaffold/home/env.example`) and put in a `TOKEN`
  (see "Access from outside").
- **API description** — the same `models/`: which adapter, URL, model
  and key.
- The app talks to LLMs through a single `LLMProvider` interface
  (`src/providers/types.ts`). The concrete protocols are hidden in the adapters:

| Adapter | For which APIs |
|---|---|
| `openai-compatible` | Z.ai (GLM), OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio… |
| `anthropic-compatible` | Claude |
| `gigachat` | Sber GigaChat (with the full OAuth token cycle inside) |
| `mock` | working without keys |

### Model cards

Each model is a file `models/<id>.json` in the home. The id is the file name
without `.json`. The card fields are validated by the **adapter contract** —
each adapter declares which keys it accepts, which are required, and which can
be overridden per-agent:

```json
{ "provider": "openai-compatible", "baseUrl": "https://api.z.ai/api/paas/v4",
  "model": "glm-4.6", "apiKey": "…", "maxTokens": 4096, "thinking": "disabled" }
```

Agents reference models with a **`ModelRef`** — an object with `id` plus
generation-param overrides (temperature, maxTokens, thinking, reasoning).
Connection fields (`baseUrl`, `apiKey`) are NOT overridable — create another
model card for that:

```json
{ "model": { "id": "glm-4.6", "temperature": 0.4 } }
```

Custom adapters go on the shelf `~/.dreamteam/providers/<id>.ts` (same pattern
as custom tools) — export default a `(id, config) => LLMProvider` factory.

Moving to another machine — `/export` and `/import`: settings, the team
and the models move together with the card keys, nothing needs to be re-entered;
the current project's conversations travel in the same archive and merge by id
(matching ones are replaced). The archive contains keys — treat it (in the cloud and
anywhere else) like a password.

### Z.ai (GLM)

1. Get an API key in the console of the Z.ai open platform (the API keys section).
2. Put it into the model card in `~/.dreamteam/models/`:
   ```json
   "apiKey": "your-key"
   ```
3. The default model is already set in `settings.json` (`"model": {"id": …}`). The model name is
   the `model` field in the same card.

**A note on key types.** For example, Z.ai has two different endpoints:

| Endpoint | For which key |
|---|---|
| `https://api.z.ai/api/paas/v4` | the regular pay-as-you-go API (paying per token) |
| `https://api.z.ai/api/coding/paas/v4` | keys of the **GLM Coding Plan** subscription |

A Coding Plan key on the regular endpoint gives the error
`429: Insufficient balance or no resource package` — that's normal: the subscription
is invisible to the payment balance. If you have a subscription, set the coding
endpoint in the `baseUrl` of the model card. The list of models available on
the subscription: `GET https://api.z.ai/api/coding/paas/v4/models`.

### Live smoke: `npm run smoke:live`

A quick check against a real (non-mock) provider: a live answer from the manager,
the manager actually creates an agent on request, an agent with `files` actually
writes a file. The home is the real one (keys and `models/`), the project is
a temporary sandbox — nothing in a real project changes. The hermetic probes
(`npm run probe`) never touch the live API — they are free and deterministic.

### Token caching (fewer tokens for the same conversation)

Conversation rounds grow the history at the tail, so providers can reuse the cached prefix — repeated tokens are not billed at full price twice.

- **Z.ai (GLM), OpenAI, DeepSeek…** (the `openai-compatible` adapter) — automatic prefix caching, nothing to enable. The app requests usage stats in streaming mode and reports hits.
- **Anthropic (Claude)** — explicit cache markers, enabled by default: two breakpoints (the system prompt and the end of the history) make each round's prefix the next round's cache hit. Disable per provider with `"cache": false` in the card.
- A cache hit shows up as a feed note: «1 240 из 1 500 входных токенов — из кэша промпта». The cache resets when history compaction (~24 messages) or a memory reflection (~once per 12 messages) rewrites the prefix — by design.

### Anthropic (Claude)

The key from the Anthropic console goes into the `claude` model card
(`~/.dreamteam/models/`):

```json
"apiKey": "your-key"
```

Then in the chat: `/settings update model.id=claude`.

### Sber GigaChat

The adapter does by itself everything people usually build a proxy service for:
gets an `access_token` with your API key, caches it, refreshes it ahead of time
(a minute before expiry), survives a sudden 401 (a silent refresh + retry), and
supplies the Russian TLS certificate.

1. Get an API key in the GigaChat console (developers.sber.ru → GigaChat API).
2. Put it into the `gigachat` model card in `~/.dreamteam/models/`:
   ```json
   "apiKey": "your-console-key"
   ```
   (the console key is already a ready Basic string; if you have a client_id/secret
   pair, set `"clientId"` and `"clientSecret"` instead).
3. Download the Ministry of Digital Development root certificate per the GigaChat
   instructions and place it at the path from `caCertPath` (by default
   `certs/russian_trusted_root_ca.pem`). For a quick check you can instead set
   `"insecureTLS": true` (insecure, for tests only).
4. In the chat: `/settings update model.id=gigachat`.

Every agent can run on its own model — in its card in `~/.dreamteam/agents/` the
`"model"` field is an id string or an object with overrides; by command:
`/agent update marina model.id=claude`. You can assemble a team of different
models (say, Marina on Claude, Dmitry on GLM).

## Operations: commands = rpc

Control is described by an **operations manifest** (`src/core/operations.ts`). The
canonical operation name — `group.verb` (for the global ones — just the verb:
`export`, `import`) — is the same across three surfaces:

- a text command: `/group verb arguments` (a group overview is just `/group`);
- a WebSocket rpc method: the same name as a string (the GUI calls it with buttons,
  scripts call it directly);
- the `/help` string and autocompletion: derived from the same list.

There are no aliases or short forms: one name — one operation.

| Operation | Command | Action |
|---|---|---|
| `sessions.list` | `/sessions` | the project's session list: ids, freshest on top, the current one marked |
| `session.new [id]` | `/session new` | create and open a session (one-on-one with the manager); no id — an auto stamp like `20261027-143052` |
| `session.open <id>` | `/session open 20261027-143052` | switch to a session (the list — `/sessions`) |
| `session.close` | `/session close` | close the current session (the project stays open) |
| `session.delete <id>` | `/session delete 20261027-143040` | delete a session; not the current one — `/session close` first |
| `session.update [title=…]` | `/session update title=Standup` | rename the current one; with no fields the manager will invent a name from the digest |
| `session.history [from] [to]` | `/session history 20` | a slice of the current session's history, inclusive; one argument — from N to the end |
| `session.export` | `/session export` | archive of the current session: `session-<project>-<session>-<stamp>.zip` |
| `session.import <file.zip>` | `/session import dt-session-….zip` | restore a session from an archive (merges into the open project as a new one) |
| `session.agents` | `/session agents` | who is in the current conversation and who can be summoned |
| `session.agent.add <id…\|all>` | `/session agent add yurist, keks` | summon members into the conversation: a comma- or space-separated list; `all` — the whole team (by id from `/agents`) |
| `session.agent.delete <id…\|all>` | `/session agent delete yurist keks` | send out of the conversation: several at once; `all` — everyone but the manager (the remarks stay in the history) |
| `export` | `/export` | the whole home: settings, the team, models with keys, memory, the schedule and ALL projects with their conversations (`home-<stamp>.zip`, no .env — a thing of the machine); store it like a password |
| `import <file.zip>` | `/import dt-home-….zip` | unfold a home from an archive (with keys): settings/profile/memory/schedule are replaced, projects and conversations merge by id; asks for confirmation |
| `settings.export` | `/settings export` | settings without projects: settings.json, the profile, the manager and the models with keys |
| `settings.import <file.zip>` | `/settings import dt-settings-….zip` | replace settings/profile/manager/models (projects untouched); asks for confirmation |
| `agents.list` | `/agents` | the team roster: ids, roles, tools, who is in the chat |
| `agent.new <id> [field=value…]` | `/agent new yurist name=Yurist role=law` | a new member (the name defaults to the id) |
| `agent.update <id> field=value…` | `/agent update yurist role=sourcream model.temperature=0.4` | edit: name= role= emoji= color= description= prompt= temperature= and the nested model.id= model.temperature= |
| `agent.delete <id…>` | `/agent delete yurist, keks` | delete members: a comma- or space-separated list |
| `agent.tools <id>` | `/agent tools yurist` | which tools are enabled and with what settings |
| `agent.tool add <id> <tool…>` | `/agent tool add yurist files shell` | enable tools (several at once): files, shell, ssh, look, image or a custom one from tools/ |
| `agent.tool update <id> <tool> field=value…` | `/agent tool update gleb git repo=C:/dev/shop` | configure the tool card in agents.json |
| `agent.tool delete <id> <tool…\|all>` | `/agent tool delete yurist files shell` | disable tools: several at once; `all` — all of them |
| `models.list` | `/models` | the models and their status |
| `model.new <id> field=value…` | `/model new glm provider=openai-compatible model=glm-4.6 baseUrl=… apiKey=…` | a new card (provider is required) |
| `model.update <id> field=value…` | `/model update glm model=glm-4.6` | edit a card: provider, model, baseUrl, apiKey, maxTokens, temperature… |
| `model.delete <id…>` | `/model delete glm spare` | delete models (several at once); the main one can't be deleted — `/settings update model.id=other` first |
| `profile.show` | `/profile` | how the team sees you (user.json) |
| `profile.update field=value…` | `/profile update name=Alexey role=founder about=brief` | fields: name, role, about |
| `memory.show [id\|shared]` | `/memory gleb`, `/memory shared` | what a member remembers; no argument — an overview; `shared` — the team's shared memory |
| `projects.list` | `/projects` | the home's project registry: ids and working folders, the current one marked |
| `project.new <id> [folder]` | `/project new shop .` | create a project in the home and open it; the working folder is created if missing |
| `project.open <id\|path>` | `/project open ../other` | switch project; an unknown folder registers itself |
| `project.close` | `/project close` | stay without a project: conversations are kept, the state is like after a launch |
| `project.delete <id\|path…>` | `/project delete old, older` | delete projects from the home (projects/<id>/ whole, with conversations); several at once; the working folder is untouched; the current one can't be deleted |
| `project.update field=value…` | `/project update name=shop2`, `/project update path=../other` | rename the current one (its folder in the home) or change the working folder (created if missing) |
| `project.export` | `/project export` | an archive of the current project: project.json (secrets included) and all conversations |
| `project.import <file.zip> [id]` | `/project import dt-project-….zip` | unfold a project from an archive; a taken id merges conversations by id |
| `project.mails` | `/project mails` | the project's mailbox registry (the "mails" field of project.json) |
| `project.mail add <id>` | `/project mail add work` | an empty mailbox entry; update fills the fields |
| `project.mail update <id> field=value…` | `/project mail update work user=… password=… imap=… smtp=…` | fields: user, password, imap, smtp, port, smtpPort, tlsNoVerify |
| `project.mail delete <id…>` | `/project mail delete work, spam` | remove mailboxes (several at once) |
| `project.hosts` | `/project hosts` | the project's servers (the "hosts" field of project.json) |
| `project.host add <id>` | `/project host add prod` | an empty server entry; update fills the fields |
| `project.host update <id> field=value…` | `/project host update prod host=deploy@203.0.113.10 dir=/var/www/app` | fields: host, user, password, dir, port |
| `project.host delete <id…>` | `/project host delete prod, backup` | remove servers from the current project (several at once) |
| `project.messengers` | `/project messengers` | bot tokens (the "messengers" field of project.json) |
| `project.messenger add <telegram\|max>` | `/project messenger add telegram` | an empty entry; update fills the token |
| `project.messenger update <telegram\|max> token=…` | `/project messenger update telegram token=123456:ABC…` | a bot token (never shown in reports) |
| `project.messenger delete <telegram\|max>` | `/project messenger delete max` | remove a bot |
| `schedule.list` | `/schedule` | the tasks serve runs by itself |
| `schedule.add <task> [minutes]` | `/schedule add "standup" 60` | a new task; the default interval is 10 minutes |
| `schedule.toggle <id…>` / `schedule.delete <id…>` | `/schedule toggle task-… task-…` | pause and delete tasks: several at once |
| `auto.on [N]` / `auto.off` | `/auto on 5`, `/auto off` | autonomous mode: the agents decide on their own for up to N turns |
| `usage.show [model id]` | `/usage`, `/usage glm` | token spend: input/output/cache cumulative; with an id — only that model |
| `settings.show` | `/settings` | the current settings |
| `settings.update field=value…` | `/settings update maxTurns=2 model.id=glm` | settings (take effect from the next round); nested: model.id, serviceModel.id, model.temperature |
| `manager.show` | `/manager` | the war-room manager: model, temperature, name |
| `manager.update field=value…` | `/manager update model.id=glm temperature=0.2` | fields: name, emoji, color, temperature and the nested model.id, model.temperature |
| `/help` | `/help` | help on the operations (the same manifest) |
| `/exit` | `/exit` | quit (in the terminal only) |

Switching a model is not a separate command but an owner's field: `/settings update
model.id=…` — the default for the agents, `/agent update <id> model.id=…` — a
member's model, `/manager update model.id=…` — the manager's model.

Commands are part of the core: in the web shell the same set works through the same
input (or via the panel buttons), the terminal only adds colored views.

When launched, the app continues the last conversation; if the last conversation is
empty (or it's the very first launch) — the manager greets you itself.

**Session names.** The name is taken from the first message, and after the first
answer the manager invents a short title for the session (based on the first
message). You can rename at any moment: `/session update title=<new name>` — or ask the
manager: "come up with a name for this conversation" — it will take the short
summary, or, if the session hasn't been compacted yet, the first and last messages.

**Command hints.** Start typing with `/` — a list of commands appears above the
input line (a short description for each); as you type, the list is filtered.
**Tab** autocompletes the command, and for commands with arguments it hints and
completes them too: session ids (with titles) for `/session open` and
`/session delete`, member ids for `/session agent add` and `/agent update`,
model ids for `/usage` and `/model update`, `id|shared` for `/memory`. Three-word
commands (`/session agent`, `/agent tool`, `/project mail|host|messenger`) know
their sub-verbs too: after `/session agent ` the panel offers `add` and `delete`,
and `/session agent add` shows its syntax and the ids.

The same for mentions: type `@` in the middle of a message — a popup with the
members of the current chat and `@session` opens above the input line (each with
their role). Typing filters the list, **up/down arrows** move the selection
(wrapping around), **Enter** or **Tab** insert the selected name, **Esc** closes
the popup leaving the typed `@fragment` as is. Case doesn't matter, and neither
does the Russian "ye"/"yo" letter distinction. After `@session` and a space, session
ids with titles are suggested.

**`!` is a full synonym of `@`** (Shift+1 on any layout and in any language):
`!Katya, look at the mockup`, `!manager, bring Gleb in`, `!session 20261027-143052` — everything
works the same, including the hint popup.

**Chat roster.** A new conversation (`/session new` and the very first one) always
starts one-on-one with the manager: it's the concierge — ask it to call in the
people you need. After that the roster changes on the fly: `/session agent add
<id…|all>` — summon (several at once, `all` — the whole team), `/session agent delete <id…|all>` — send out (their remarks and
memory stay in the history); the manager does the same on request. Chat events —
"Gleb joined the chat", "Katya left the chat" — go into the general chronology of
the conversation as a manager line (in the terminal, in the web chat and in the
saved history alike), not into a separate journal. If the last member is removed
from the chat, the manager stays — the war room doesn't work with no team at all.
The current roster is visible in `/agents` and `/session agents`. Digests of a closed
conversation are merged into the team's shared memory in the background, without
waiting.

**Multiline messages.** A line break inside a message: `\` + Enter (works in any
terminal) or **Ctrl+Enter** / **Alt+Enter**. While the input continues, the prompt
turns into `… `; an empty line is a paragraph break; a regular **Enter** sends the
message, a **double Enter** or `.` finishes the input as is. `\\` at the end of a
line is a literal backslash. A multiline paste from the clipboard (Ctrl+V in
Windows Terminal, Shift+Ins, right click) is also glued into one message instead of
sending the first line; if the paste ended with a newline, press Enter once more
after it.

**Interruption.** While the team is answering (the moderator is thinking or the
agents are typing) you can stop the round with **Esc** or **Ctrl+C** — the request
to the model is cancelled, the remaining members of the round are not called, and
the app immediately returns to the prompt. The answers that did appear are kept in
the history. On an empty prompt Ctrl+C, as before, quits the app.

## Web shell: `dreamteam serve`

The same thing — in the browser:

```bash
dreamteam serve         # or: npm run serve; the port is PORT, 8080 by default
dreamteam serve --open  # + open the web shell in the browser
dreamteam serve .       # with the current folder's project right away
```

A local server comes up: `http://127.0.0.1:8080` serves the web shell from `gui-dist/`
(the Vue build from `gui-src/`, `npm run build:gui`) and talks to it over WebSocket. By default it
listens on 127.0.0.1 only — the server is not visible from outside the machine.
The port and address are set by the `PORT` and `HOST` variables — you can put them
in `~/.dreamteam/.env`: the settings will survive a global reinstall and a project
switch. **Careful:** `HOST=0.0.0.0` exposes the server to the network — the API has
no authentication, so only do this on your own network. Conversations, the team
and the configs are shared with the terminal The `--open` flag makes serve open the browser itself; at first launch the wizard offers to create a desktop shortcut («Dream Team») that runs exactly this command (works on Windows, Linux and macOS).: you can work in the TUI and continue
in the browser.

- on the left — conversations (click to switch, "＋" for a new one), the team
  roster (click a member to summon/send them out of the chat), the models
  (click to make one the default for the agents) and the projects (click to switch
  project, "＋" by the section — a form with a path field);
- there is no double click in the web UI: right-clicking an entry opens an
  "Edit" and "Delete" menu ("Rename" for a conversation); deletion always goes
  through a "Delete this entry for sure?" confirmation — "Yes"/"No";
- in the center — the same chat: answer streaming, manager lines (including chat
  events — joined/left), tool results, `@session` digest attachments;
- a tool's "allow?" question is shown as ✓/✗ buttons; with no answer for 5 minutes
  it counts as a refusal — a round never hangs forever;
- "⏹ Abort" stops the round, like Esc in the terminal.

**Access from outside.** If the server is exposed (`HOST` is not 127.0.0.1), the
protection is a token: the `TOKEN` variable in `~/.dreamteam/.env`. The wizard
creates it on first launch on a fresh machine; after moving a home to another
machine `.env` doesn't come along — create the file from the sample
(`scaffold/home/env.example`) and generate a token by hand:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`serve` prints a ready tokenized link at startup (`http://host/?token=…`), and
`dreamteam serve --open` opens it: the shell picks the token up from the address,
stores it in the browser and strips it from the URL bar — nothing to type. Without
the link, the shell asks for the token once and remembers it in the browser;
the **Log out** button in the header forgets the token on that device. The token is
"server password"-level access: the agents have shell and files, so expose it only
behind HTTPS (a proxy with a certificate) or inside your own VPN.

The terminal slash commands work in the web shell through the same input: text
with `/` goes to the core as a command (and is not drawn as a user bubble), reports
stay in the log under the chat — only command reports and errors land there, chat
events live in the general chronology. Autocompletion is like in the terminal:
`@` opens the mentions popup (the manager, chat members, session —
arrows/Tab/Enter/Esc), `/` shows the command list with descriptions and argument
hints, Tab completes. The hint dictionary is delivered by the core in the state
snapshot.

One core for both shells: the server (`src/serve.ts`) is a second Presenter over
`src/core/engine.ts` — the web version has no separate "brains". The protocol is
JSON over the WebSocket `/ws` (the full list of events and rpc is in the serve.ts
header), so you can replace the web shell with your own.

## Settings: ~/.dreamteam/settings.json

General app settings — `~/.dreamteam/settings.json` (the file is required — without
it the app won't start): the interface language, the conversation language, the
screen and the agents' tool limits.

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

- `ui` — the interface language: `ru`, `en`, `zh` are built in, or the id of your
  own language from `~/.dreamteam/lang/<id>.json` (a file
  `{ "name": "Deutsch", "translations": { … } }`; the id is the file name without
  `.json`, files starting with `_` are ignored). Chosen in the first-launch wizard,
  changed with `/settings update ui=en`. The interface and the three READMEs
  (`README.md`, `README.ru.md`, `README.zh.md`) are available in English, Russian
  and Chinese. Deliberately not translated: the agents' and manager's system
  prompts (the answer language is governed by `language`), command argument names
  (part of the syntax), config diagnostics (the fail-fast layer).
- `maxTurns` — the maximum number of answerers per round (3 by default;
  0 — no limit, the moderator decides who and how many). Goes into the moderator's
  prompt: "pick from 1 to N".
- `language` — the language the team converses in (default: Russian). It goes into
  the system prompts verbatim — "answer strictly in the language: …" — so any
  wording works: `russian`, `ru-RU`, `english`, `中文`. The language is re-read in
  every round: edits are picked up without a restart.
- `width` — the logical screen width, an integer from 40 to 500. All output (agent
  answers, the banner, the help) wraps at this width rather than the full terminal
  width: text doesn't stretch across wide windows. If the terminal is narrower,
  the width is clamped to it.
- `margin` — screen edge margins, an integer from 0 to 10 (2 by default): the
  content is written with an indent on the left and right, the chat panel starts
  below the indent on top, and the input is separated by two empty lines at the
  bottom.
- `screen` — full-screen mode (`true` by default). `false` brings back the old
  "linear" readline interface — for pipes and exotic terminals, for example (a
  non-TTY launch turns it on automatically anyway).
- `runTimeoutMs` — the command timeout (`run` and `ssh` blocks, 180000 = 3 minutes
  by default); a hung process is interrupted together with its children.
- `maxOutputChars` — how many characters a command's output is trimmed to (4000 by
  default).

**How the full screen works** (the terminal's alternative buffer — after quitting,
your terminal looks like it did before the launch):

```
┌──────────────────────────────┐
│                              │
│  chat panel (scrollback)     │  ← history and answer streaming
│                              │
├──────────────────────────────┤
│  5 hint lines                │  ← commands, the @ popup, status/spinner
├──────────────────────────────┤
│  You > input                 │  ← the input field, grows upward when wrapping
│                              │
│  (two empty lines)           │  ← the indent from the bottom edge
└──────────────────────────────┘
```

The chat scrolls inside its panel — hints, input and status always stay in place
no matter what happens. Lines wrap at words, not characters; a word longer than
a line is cut by characters. The same rule in the input field: input wraps at
words, the cursor moves across lines (↑/↓ are taken by history, movement is
←/→/Home/End). Resizing the terminal rebuilds the zones on the fly.

**Scrollback.** On launch the panel immediately shows the tail of the previous
conversation — in the members' signature colors; to look further back, scroll with
the **mouse wheel** or **PgUp/PgDn** (a page at a time). **Ctrl+PgUp** jumps to
the very start of the history, **Ctrl+PgDn** — back to the fresh messages.
While you are scrolled up, new answers don't pull the view to the bottom — it
stays "pinned", and a counter appears on the bottom hint line: "↑ history: N more
pages above". Scroll down to the end — the view returns to the fresh messages,
and the stream goes live again. The wheel works through the terminal's mouse mode:
while it is on, text selection with the mouse in some terminals requires holding
**Shift**.

**Text selection.** In the chat history a fragment is selected with the mouse:
press the left button, drag, release — the text without colors goes to the
clipboard (Windows — via `clip`, other platforms — OSC 52), the status line
flashes "✓ Copied to clipboard".

In the **input field** (the message being typed) keyboard selection works like in
a regular editor: **Shift+arrows** (←/→/↑/↓ — by characters and soft-wrapped
lines), **Ctrl+Shift+←/→** (by words) and **Shift+Home/Shift+End** (to the
start/end of the input). Typing replaces the selection,
Backspace/Delete/Ctrl+W delete it, ←/→/Home/End collapse it to an edge,
↑/↓ dismiss it, **Ctrl+C** copies it (the selection stays), **Esc** dismisses it.
If the input field is empty, Shift+arrows select the chat history (a fresh press
grabs the last visible line, then line by line with autoscroll; Shift+Home/End —
the start/end of the line under the cursor). If there is no selection in either
place, Ctrl+C works as before — it interrupts the round/quits.

**An answer being streamed** is not cut to a single line: an agent's unfinished
stream wraps and occupies the bottom lines of the panel (from five up to the full
panel height — whichever is shorter), pressed against the input field. While the
stream runs, selection works over those "live" lines too — both with the mouse and
with Shift+arrows on empty input; once the answer is finished and moves into the
history, the selection is dropped (the lines stay in place, but as regular history
now). When you are scrolled up through the history, the live stream is not shown —
it finishes "off screen" and appears when the view returns to the fresh messages.

**Hint lines** (5 of them above the input): the command list while typing `/`,
the `@mentions` popup (it can grow taller still, over the chat), and the bottom
line is the status: the "Yana is typing…" spinner, an agent's action confirmation
question (`y/n`), and, when the history is scrolled up, the "↑ history: N more
pages above" counter.

**Input editor keys:** ↑/↓ — message history (the draft is kept), Ctrl+U — erase
the line, Ctrl+W or Alt+Backspace — erase a word, ←/→/Home/End — cursor,
Ctrl+←/→ — by words, Delete — delete the character after the cursor, Ctrl+D on an
empty line — quit. Pasting from the clipboard glues line breaks into spaces (a
multiline paste is not sent in parts). The cursor doesn't cut emoji or other
composite characters in half.

## Tools: agents write files and run commands

By default the team only discusses. But an agent can be trusted with real actions —
the `"tools"` field in `~/.dreamteam/agents/`. There is a single form — an
object of cards: tool name → its settings (an object; `null` or `{}` — default
settings):

```json
"tools": { "files": {}, "shell": null }
```

- `files` — the agent can create and overwrite files;
- `shell` — the agent can run commands on this PC through the **system shell**:
  on Windows — cmd.exe (`dir`, `type`, `findstr`), on Linux/macOS — `/bin/sh`
  (`ls`, `cat`, `grep`). The agent is told explicitly in its cheat sheet which
  environment it's in, so it doesn't write bash commands under Windows. Git gets
  a separate tool;
- `git` — repository work as a separate tool (``git status``, ``git commit -m "…"``)
  without a local shell: read-only — silently, mutating — per the card or a
  question (the repository is pinned by the `"repo"` card field, otherwise — the
  project's working folder);
- `arch` — **zip / tar / tar.gz** archives without external programs — pure Node,
  the same on Windows and Linux (``arch pack out.zip src/``, ``arch unpack
  archive.zip``, ``arch list archive.zip``). Protection: zip-slip and symlinks in
  an archive — refused; entry-count and size limits from the card (`maxEntries`,
  `maxTotalBytes`) against archive bombs; secrets (`.env`, keys) are never
  packed. rar/7z are deliberately unsupported;
- `ssh` — the agent can run commands **on configured servers** (see below) without
  a local console: `"tools": { "files": {}, "ssh": null }` — and `run` blocks from
  such an agent are rejected automatically;
- `look` — the agent can "look at" pictures with a vision model and `image` —
  generate/redraw images (see "Vision and images");
- `docs`, `ocr`, `web`, `mail`, `telegram`, `max` — documents, scans, the web,
  mail and messengers (see "Documents, scans, the web and messaging" below); the
  secrets of these tools live in home files, not in agent cards.

A tool can also be enabled through the manager: "enable shell for Gleb" — it will
add the card to `agents/` (and can edit it later: "give Gleb permission for
docker compose").

**How it works.** The agent inserts an action block into its answer, the app
checks the structural permissions (is the tool enabled for this agent, is the
project/server assigned), then the decision is made by **the tool itself** — its
mandatory `check()` method returns one of three verdicts:

- `allow` — pass silently, no question;
- `ask` — show you a confirmation:

  ```
  ⚙ Command: 💾 Gleb: [shop] docker compose up -d
      y — run · n — deny
  ```

  `y` — run it, `n` — refuse (the agent learns about the refusal and proposes
  another solution);
- `deny` — refuse right away, without a question.

The built-in defaults: `files` silently lets through paths inside the working
folder and asks about leaving it; `look` and `image` always allow; `shell` and
`ssh` ask about every command until the tool card defines rules (see "Tool cards"
below). The result is returned to the agent as a message from "⚙ tools", and it
keeps working — this way, step by step, the "coder" really writes files, and the
"devops" really runs `docker ps` and reads the output instead of making it up.
At most three "action → result → continuation" cycles per answer. Everything that
happens stays in the history: `/session history` shows the actions as "⚙ tools"
entries.

**The working folder comes from project.json.** The agents work in the folder the
project points to via its `"path"` field (set at `/project new`, changed with
`/project update path=…`; usually the repository you launched the app from — and in
subfolders assigned to an agent via its `"workspace"` field, a path relative to
the working folder). Files are written and commands run only there — with one
fixed exception: the app's payload folders of the project (`inbox/` — files the
person attached, `mail/` — letter attachments, `images/` — generated pictures)
live in the project folder in the home, and the tools read them by prefix
(`look inbox/scan.png`, `ocr mail/акт.pdf`, `refs: images/poster-2.png`).

**The server registry.** The `"hosts"` field of the project's project.json — the
ssh servers (in the home: `~/.dreamteam/projects/<id>/project.json`). Servers are
added with the commands `/project host add prod` and
`/project host update prod host=deploy@203.0.113.10`, through the manager ("add the prod
server — deploy@203.0.113.10") or by hand; removed with
`/project host delete prod`:

```json
{
  "prod": {
    "user": "deploy", "host": "203.0.113.10", "port": 22,
    "dir": "/var/www/app", "password": "…"
  },
  "router": { "user": "admin", "host": "192.168.1.1" }
}
```

A flat dictionary: server id → connection (an id is lowercase latin letters and
digits, with dots, "-", "_" inside), each with a mandatory `host` field.
In a block the server is addressed by name (`ssh prod uptime`); the long
`project:prod` form is understood too.

In `agents/` projects are assigned to the agent and its tools are enabled:

```json
"tools": { "files": {}, "ssh": null }, "projects": ["project"]
```

The project is one — the current folder, its label is `project`; the `projects`
field lets the agent reach its servers. An action with someone else's label is
rejected before confirmation. Accesses are visible in `/agents`.

**Servers over ssh.** An `ssh prod` block (or `ssh project:prod`) with a command
in the body is run by the regular ssh client on this PC:
`ssh deploy@203.0.113.10 "command"` — timeouts, output trimming and Esc work like
for local commands. By default `BatchMode=yes`: keys only, no key — the command
fails immediately instead of hanging.

A host can have two more fields:

- `dir` — the project folder on the server. After connecting, everything runs
  from it: the command is sent to the server as `cd '<dir>' && pwd && <command>` —
  if cd fails (no folder), the command won't start, and pwd confirms the folder in
  the output. Path checks in the ssh tool also start from this folder: an absolute
  path, `..` or `~` outside it — a refusal with a reason before even connecting;
- `password` — a password instead of keys. The regular ssh won't take a password
  from a config, so the command goes through `sshpass -e` (the password is in an
  environment variable, not in the process list); no sshpass on PATH — a clear
  refusal. The password sits in the config in plain text: it's your machine, but
  keep it in mind. Better not dictate the password in a conversation with the
  manager — put it into the `"hosts"` field of project.json by hand.

File exchange — the same block: a body of `put local remote` or
`get remote local` goes to the regular `scp`. The local side must be inside the
working folder, the remote one — inside the host's `dir`; by default the transfer
asks for your `y/n`, the card rules (`"allow": ["put *"]`) can allow it silently.

**Tool cards.** The `tools` field is only the object of cards: the tool reads the
card contents itself, the app doesn't look into it; an empty object or `null` —
default settings:

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

The `git` card (a built-in tool): `repo` — pin the repository (otherwise — the
working folder of the action), `allow`/`deny` — the same command rules as `shell`
(read-only — `status`, `log`, `diff`… — flow silently and without a card),
`timeoutMs` (120 000 by default) and `maxOutput` (characters, 4000 by default).

The `shell` and `ssh` rules (once set, the default is displaced entirely): a chain
(`&&`, `;`, `|`, `&`, a newline) is parsed into separate commands; `deny` forbids
a command in any part of the chain; `allow` passes a chain silently only if every
command starts with an allowed prefix by whole words (`git` matches `git status`,
not `gitify`; `*` — any continuation, only as the last word); commands with
substitutions (`$`, `(`, `)`, `<`, `>`, `` ` ``) never pass silently — only a
question. Anything that matched neither `allow` nor `deny` is shown to you as a
regular `y/n` question.

**The default policy** (an empty card or `null`) — a combo of the `git` tool and
the working-folder fence, like `files`:

- read-only commands flow silently: for `shell` on Linux that's `ls`, `cat`,
  `grep`…, on Windows — `dir`, `type`, `findstr`; for `ssh` — `uptime`, `df`,
  `systemctl status`… (`find`/`systemctl` mutating flags are outside the default);
- variable substitutions (`$VAR` and `%VAR%` — leaking environment secrets is
  caught too) — a question;
- a path outside the working folder — no longer a question but a **refusal with
  a reason**: for `shell` path arguments are checked against the folder
  (`cat ../secret` — refused), except the project's payload folders in the home
  — `inbox/`, `mail/`, `images/` are readable and copyable (an absolute path
  from an action's result, e.g. `cp …\\images\\x.png .` to move a picture into
  the working folder); for `ssh` the machine can't be escaped, so a
  relative path counts as "ours", while an absolute one, `..` and `~` — a way out
  (`cat /etc/passwd` — refused);
- secrets (`.env`, `*.pem`, `*.key`, `id_rsa`…) are never read silently even
  inside the working folder — refused;
- everything else — a regular `y/n` question.

None of this is hidden in the code: every built-in tool has a **mandatory default
config** — `src/tools/<tool>/default.json` next to its code. It holds both the
read-only command whitelists (`shell` — with the platform sets
`"allow"`/`"allowWin32"`, `ssh`, `git`) and the factory settings (the `arch`
limits, the `ocr` languages, the `soffice` bridge address for `docs`, the empty
`web` whitelist). An agent's empty card means "take default.json"; a card with
fields replaces it entirely. A broken default file fails the tool's build with a
clear error — same as a broken card.

**Wiring of the command tools.** `run`, `git` and `ssh` are three entrances to
the command line, each with its own domain, and the agent's cheat sheet says so
explicitly: the local command line — `run` (everything that isn't git and isn't
servers), repository work — only `git` blocks (git commands through `run` never
pass silently — the agent gets a human question and switches to the right tool),
commands on servers — only `ssh` blocks.

**File masks** (`"masks"` — on the `ssh` and `files` tools): another layer on top
of the working-folder fence — a list of masks in gitignore syntax. A mask without
`!` is a ban, with `!` — an allowance; the last match wins, if nothing matched —
allowed. A mask refusal reaches the agent with a reason and is not bypassed by
`allow` rules: the rules decide whether to ask the human, the masks — what is
never allowed.

```json
"ssh":   { "masks": ["*", "!logs/**", "!tmp/**"] },
"files": { "masks": ["*.env", "*.pem", "*.key", "id_rsa*", "secrets/**"] }
```

Syntax: `*` — any characters within a name, `?` — exactly one, `**` — any number
of folders (`src/**/*.ts`); a mask without a slash (`*.log`) catches the file at
any depth; a directory mask (`secrets`) locks the contents too. Relative paths
for `files` count from the working folder, for `ssh` — from the host's `dir`
(and in put/get the masks act on both sides — local and server).

A built-in tool's card is strict: unknown fields — a clear error when building
the tools, not a silently dead rule (`shell` allows `allow` and `deny`; `ssh` —
`allow`, `deny` and `masks`; `files` — `masks`; the other tools have no
settings). The same control applies to default.json.

**Custom tools.** Put a file into the home's `~/.dreamteam/tools/` — the file
name becomes the tool's name, the code is picked up without a restart:

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

The contract: `desc` — a string for the agent's cheat sheet; `check(body)` —
**the single validation point**, returns `'allow' | 'ask' | 'deny'`, and a
refusal can carry a reason — `{ deny: 'reason' }` goes to the agent in the
"⚙ tools" report, and it reformulates the request instead of poking blindly;
`run(body, ctx)` — the action. In `ctx` the tool sees the working folder and the
project of the action: `ctx.projectHome` — the project folder in the home (or
`null`), `ctx.workspaceFile(rel)` and `ctx.projectFile(rel)` — absolute paths
checked against their folder (`projectFile` throws with no open project) for
reading and writing the project's payloads (`inbox/`, `mail/`, `images/`), and
`ctx.run` — running a command through the full pipeline
(with your `y/n`), `ctx.http` — an HTTP request, `ctx.confirm` — a live question
to the human. The built-in tool names (`files`, `shell`, `ssh`, `look`, `image`)
cannot be taken. Responsibility for downloaded tool code is yours, as with any
npm package: it runs with your user's rights. (The
`dreamteam/src/tools-api.js` import path is for a global install from npm; when
working in a clone of the repository — the relative
`'../src/tools-api.js'`.)

**A ready-made tool: git** (ships in the box). A `git` block with a subcommand in
the body or on the block line (`git shop:log --oneline`); the repository — the
working folder of the action (the agent's subfolder) or the one pinned in the
card's `repo`.

```json
"git": {
  "allow": ["add *", "commit *", "checkout *"],
  "deny": ["push *"],
  "repo": "C:/dev/shop"
}
```

The default policy with no rules: read-only commands (the list is in
`src/tools/git/default.json`: `status`, `log`, `diff`, `show`, `blame`,
`branch` without arguments…) flow silently — even in chains; everything mutating
(`commit`, `push`, `reset`, `stash pop`…) and any substitutions — a question.
Set `allow`/`deny` — the rules work like `shell`'s and displace the default
entirely. Other settings: `timeoutMs` (120000 by default) and `maxOutput`
(characters, 4000); unknown fields — an error. `git` runs directly (spawn, no
cmd.exe), arguments as an array, so quotes in the block body are argument quotes,
not shell syntax. Enable the tool for an agent with a `"git": {}` field in its
`tools`.

**Security:**

- files are written **only inside the working folder** — the app's launch folder
  or a subfolder assigned to the agent (`workspace` in its card);
- every action goes through the tool's `check()`: allowed — silently, dubious —
  only with your `y/n`; a refusal (`deny`) reaches the agent with a reason — it
  understands the cause and builds a proper follow-up request; there is
  deliberately no "allow for the rest of the session": what is allowed is written
  in the card, you can always go and look;
- permissions are checked before confirmation: someone else's project (including
  its servers) — an automatic refusal;
- commands have a `runTimeoutMs` timeout (3 minutes by default) — a hung process
  is interrupted together with its children; the output is trimmed to
  `maxOutputChars` (4000 characters by default);
- interrupting a round (Esc) cancels a running command too.

In mock mode an agent with tools shows a demo: it writes `demo-agent.txt` and
runs `echo` — enough to check the whole cycle without API keys. On Windows command
output may show garbled Cyrillic — cmd.exe prints in the console encoding
(cp866); the commands themselves work fine.

## Documents, scans, the web and messaging: docs, ocr, web, mail, telegram, max

Six built-in tools for typical errands: "here's a contract — extract everyone
involved", "here are passport scans — recognize them, build an excel and send it
to me in MAX and by email". Enabled with cards in the agent's `tools`, all of
them go through regular action blocks and your `y/n`:

```json
"tools": { "files": {}, "docs": {}, "ocr": {}, "web": {}, "mail": {}, "max": {} }
```

**docs — documents: reading and writing.** The `docs` block:

- `read file` — the document's text: pdf, docx, xlsx (sheets → markdown tables),
  csv, txt/html/odt/ods/rtf;
- `tables file [csv] [sheet]` — xlsx/csv tables: the answer is markdown or csv
  rows, `sheet` — the sheet's name or number;
- `write file.xlsx` — the block body: a markdown table `| a | b |` with a header
  and a separator — saved as a real xlsx; `.md`/`.csv`/`.html`/`.json` — by
  extension;
- `append file.docx` — append paragraphs (the block body) to the end of an
  existing one;
- `convert pdf file.doc` — format transcoding. Native paths: docx↔pdf/html/txt,
  xlsx↔csv/html, csv↔xlsx. The rest (`.doc`, `.xls`, `.rtf`, `.odt`…) — through
  the LibreOffice bridge: `cd docker && docker compose --profile soffice up -d
  --build` (port 8200), in the tool card — `"soffice": "http://127.0.0.1:8200"`.

**ocr — text and tables from scans.** The `ocr` block (tesseract, rus+eng):

- `text scan.png [pages]` — the recognized text: a picture, pdf pages (`2` or
  `2-5`) or pictures inside a docx;
- `tables scan.pdf 1-3 [csv]` — tables: clustering words by coordinates, the
  answer is a markdown table or csv.

On first launch the models are downloaded into `~/.dreamteam/cache/tesseract`
(an offline machine — put `rus.traineddata` next to it and set `"langPath"` in
the card; card fields: `lang`, `langPath`, `dpi`). A scan is always a draft: the
cheat sheet tells the agent explicitly to double-check the result for sense.

**web — reading allowed sites.** The `web` block, addresses — only from the
whitelist in the card: `"web": { "sites": ["example.com", "docs.corp.ru"] }`
(local addresses — also only through the list). `read address` — the page as text
(an article reader + a fallback path), `links address [filter]` — the page's
links with their texts ("Chapter 9. Transactions — https://…"): the titles show
where to go without reading every page; the filter searches the address and the
title. Redirects are followed, but every hop is checked against the list;
JavaScript is not executed — a page drawn by scripts will honestly say so.

**mail — email.** Mailboxes live in the `"mails"` field of the project's
project.json (in the home: `~/.dreamteam/projects/<id>/`; passwords only there,
never in the cards; **app passwords** are required). A mailbox is created with the
commands `/project mail add work` and
`/project mail update work user=… password=… imap=… smtp=…`, a conversation with the
manager ("add the work mailbox…") or by hand — one format, everything explicit, no
presets. A mailbox id is lowercase latin letters and digits (dots, "-", "_"
inside); old entries with cyrillic names are still read, new ones follow the
mask. The contents of the `"mails"` field is a dict of mailboxes:

```json
{
  "personal": { "user": "me@yandex.ru", "password": "…",
                "imap": "imap.yandex.ru", "smtp": "smtp.yandex.ru" },
  "work": { "user": "me@corp.ru", "password": "…",
            "imap": "imap.corp.ru", "smtp": "smtp.corp.ru", "smtpPort": 587 }
}
```

`imap` — the incoming mail server, `smtp` — outgoing; ports 993/465 with
encryption are the default, overridden by the `port` / `smtpPort` fields. Hosts
of popular providers:

| Provider | IMAP (`imap`) | SMTP (`smtp`) |
|---|---|---|
| Yandex | `imap.yandex.ru` | `smtp.yandex.ru` |
| Gmail | `imap.gmail.com` | `smtp.gmail.com` |
| Mail.ru | `imap.mail.ru` | `smtp.mail.ru` |
If the model's server presents a certificate for a different name (typical for
`mail.my-site.ru` on shared hosting), the connection is rejected by the name
check — then set `"tlsNoVerify": true` on the mailbox: encryption stays, only the
password is verified, but such a setup no longer notices server substitution, so
enable it deliberately. The `mail` block: `boxes` — the mailboxes without
passwords; `list [box] [N]`, `find <box> <text>` — checking mail;
`read <box> <uid>` — a letter in full, attachments are saved into the project
folder's `mail/` in the home; `send <box>` — the block body holds the header `to:` /
`subject:` / `files:`, an empty line, the letter text. Sending always asks
`y/n`; attachments — only files from the working folder and the payload folders
(`images/…` prefixes); secrets (`.env`, keys,
`.pem`) are never read or sent.

**telegram and max — messengers.** Bots live in the `"messengers"` field of the
project's project.json (in the home; the Telegram token — @BotFather, the MAX
token — dev.max.ru). A bot is created with the commands
`/project messenger add telegram` and `/project messenger update telegram token=…`
or a conversation with the manager. The contents
of the field is a dict of bots:

```json
{ "telegram": { "token": "123456:ABC…" }, "max": { "token": "…" } }
```

The `telegram` block: `list` — the chats the bot was written from (chat_id +
name); `in [N]` — incoming; `send <chat_id>` — a message (the text in the body,
a `files: path` line at the start — an attachment as a document). The `max`
block: `me`, `chats`, `in`, `send <chat_id>` or `send user:<user_id>` — files go
through the `/uploads` download. "Send to favorites" = the bot's dialog with you:
its chat_id shows up in `list`/`chats` as soon as you write to the bot for the
first time. Both tools: reading — silently, sending — always `y/n`; for a proxy
or experiments the API address can be swapped —
`"api": { "max": "http://127.0.0.1:8082" }`.

The "passport scans → excel → MAX + email" scenario assembles itself: the agent
has `ocr`, `docs`, `max`, `mail` enabled — it recognizes the scans, builds the
table with `docs write passports.xlsx` and sends it out with `max send` +
`mail send`, showing you every outgoing message for confirmation.

## Vision and images: `look` and `image`

An agent can be given "eyes" and "hands" separate from its "brain": it talks to
you with its model (the `model` field in its card), looks at pictures with a vision
model (the `vision` field) and draws with an image model (the `image` field):

```json
"tools": { "look": null, "image": null },
"vision": "qwen2-vl-2b",
"image": "bk-sdm"
```

- **`look`** — the agent shows a file to the vision model and asks a question:
  what's in the picture, which buttons and colors, where the gradient fill is,
  what's wrong with the composition. The description comes back to it as the
  action's result. This is how the layout person breaks a mockup into blocks for
  code, and the artist checks their own generations before drawing conclusions.
- **`image`** — generation and redrawing. The agent picks all the parameters
  itself — prompt, size, number of variants, quality, references:

````text
```image
prompt: poster sketch, minimal flat style, deep blue palette
size: 512x768
n: 4
refs: images/poster-2.png
```
````

`refs` turns on redraw-from-samples mode (take the variants you picked as the
base). The files are saved into the project folder's `images/` in the home (not
the working folder), the paths come to
the agent as the result and open for you in a viewer. Confirmation works like
with the other tools — the line shows how many variants and of what size the
agent wants, so an over-ambitious artist can be stopped before the spending.

**The eyes and hands are configured independently.** For the artist — cloud
vision (GLM-4.6V), for the layout person — local (Qwen-VL in docker); the
generator changes with one record in `models/` without touching the
personas. A model becomes "seeing" with the `"vision": true` flag in its card (the
`openai-compatible` and `anthropic-compatible` adapters can pass pictures; `mock` — sees in
its own way, for the demo). Image providers — the `openai-images` adapters (our
facade in docker or a cloud API) and `mock-images` (a test one, works without
docker).

**Your own models in docker.** The `docker/` folder is self-sufficient: copy it
to any machine and bring the models up by name — `docker compose --profile
qwen2-vl-2b --profile bk-sdm up -d` (the lightest pair, ~3 GB RAM each, no GPU at
all), on richer machines — `sd-turbo`, and on GPU — `qwen3-vl-8b`, `flux-dev`,
`photomaker` (face control) and others. The containers are always started by
hand — the app only talks to them over HTTP and never starts anything itself.
The creative trio (Marta, Nika, Pasha) points at the CPU models out of the
factory, so after manually starting the light pair the cycle checks out right
away, no config edits; the machine's address in `models/` changes only if
the containers live on another PC. Details and the model table —
`docker/README.md`.

**The sketch protocol.** The creative members' personas codify the rules:
a new task → cheap low-resolution sketches in several variants → showing them to
you and asking → edits based on the chosen variants as references → the
high-resolution master version only after approval. The choice is always yours:
the agent may not silently scrap a direction.

In mock mode the whole cycle works without models: `mock` describes a picture
from a template, `mock-images` saves real PNGs — the "sketches → choice →
redraw" scenario can be checked on any machine.

## History, logs and context compaction

- **The full history of every conversation** is kept in two forms:
  - `~/.dreamteam/projects/<id>/transcripts/<id>.md` — a human-readable log
    (open it in any editor), updated as the conversation goes;
  - `~/.dreamteam/projects/<id>/sessions/<id>.json` — the machine-readable state
    (used for `/session history`).
- **`/session history [from] [to]`** prints a slice of the current conversation's
  history to the terminal with the members' colors.
- **Context compaction.** When a conversation gets long (more than ~24 messages),
  the old messages are automatically rolled up by an LLM into a short digest
  (`session.summary`), and only the digest + the last 16 messages go into the
  context. The full history is never deleted anywhere — it stays in the JSON and
  the transcript. A note appears in the chat that "old messages were rolled up
  into a digest", and the agents keep remembering the gist of the discussion.

In messages: `@marina` / `@viktor` — address specific members (works by name and
by id, case doesn't matter; `!` is a synonym of `@`).

## Who you are for the team: /profile and ~/.dreamteam/user.json

By default the members see the conversation partner simply as "User". So that the
team knows who you are and how to address you, introduce yourself:

```
You > /profile update name=Alexey role=startup founder about=values brevity
  Noted: you are Alexey (startup founder). The team now knows who you are.
```

- The name goes into all the system prompts ("Your conversation partner is
  Alexey…"), into the signatures of your messages in the context ("Alexey: …")
  and to the moderator — the agents start addressing you by name.
- The profile is stored in `~/.dreamteam/user.json` and can be edited by hand too
  (picked up without a restart); the wizard fills it in at first launch:

```json
{ "name": "Alexey", "role": "startup founder", "about": "values brevity" }
```

## Team memory: relationships, tasks and other conversations

Every member has their own **subjective memory**:

- **within a conversation** — a personal task in this chat, a personal attitude
  to you and to each of the colleagues ("Timur is pushing on the deadlines, but
  on the merits he's right");
- **between conversations** — what was discussed in other chats (everyone has
  their own version, like people do) and **the team's shared document** —
  decisions, agreements, open questions.

This makes the members human-like: they remember the agreements from closed
chats without an explicit `@session`, they form relationships with you and with
each other, and each understands their task in the current conversation.

**Token economy** (memory never balloons):

- in a regular round — **zero** extra LLM calls: memory is read from a cache;
- about once every 12 messages one of the answerers "reflects" on the
  conversation and updates their memory (one small call, not all at once);
- on closing a conversation (`/session close`, `/session new`, `/exit`) its digest is merged into
  the shared log and the shared memory — usually 0–2 calls, the digest is
  cached;
- every document has a hard word limit, and memory enters the agent's context as
  a compact block (~150–250 tokens).

To peek: `/memory Gleb` — what Gleb remembers in this conversation (the task,
the attitude to you, the connections), `/memory shared` — the team's shared
memory. Storage: `~/.dreamteam/memory.json` (the team's shared memory — a thing
of the home) + the `memories` field in the session JSON
(`~/.dreamteam/projects/<id>/sessions/`).

## Links to other sessions: `@session`

A classic case: a week ago you discussed the company name in one chat and closed
the topic. Today in a new chat you're discussing products — and want to remind
the team what was already decided about the name. For that, attach the old
conversation:

```
You > we're discussing the company's products. Remind us what we decided about the name: @session
  → the list of sessions → pick an id (Enter — cancel)
You > what do we do next? @session 20261027-143052     ← straight by id from /sessions
```

How it works:

- `@session` (no id) shows the list of other sessions; pick an id or press
  Enter to cancel. `@session <id>` attaches the session right away. `!session` is a
  full synonym of `@session`.
- For an attached session the LLM builds a **digest** (decisions, arguments,
  names, open questions) — not the whole text, so as not to bloat the context.
- The digest is shown in the chat as `📎 Attached a digest of session "..."` and
  saved into the history: all members of the current conversation "see" it and
  take it into account in further answers.
- Several sessions can be attached in one message: `@session <id1> @session <id2>`.
- The digest is cached in the original session and rebuilt only if that session
  has grown by 10+ messages.

## The war-room manager: `@manager`

Besides the members there is the **war-room manager** — the very moderator who
plans the rounds, but with its own config and the power to change the team's
settings. In new conversations it's the first conversation partner (see "First
conversation"); and later it can always be summoned:

```
You > @manager, add analyst Ruslan to the team, let him work on claude
You > @manager give Gleb the lead developer role and temperature 0.3
You > @manager bring Katya into this chat
You > @manager show the sessions and open the second one
You > @manager enable the git tool for Pasha and allow him commit
You > @manager add the router server — admin@192.168.1.1
```

The manager fulfills the request and reports with `✓ …` lines right in the chat.
Through it — and only through it — the app changes the configuration:

| What you ask | What it does |
|---|---|
| "add … to the team" | a new member in `agents/`: id, name, description, prompt, emoji, color, model, temperature, tools |
| "assign …" | a member edit: description, prompt, model, temperature, name, emoji, color |
| "bring in …" / "send out …" | the current chat roster (like `/session agent add` and `/session agent delete`) |
| "show the sessions", "open session 20261027-143052", "new session …", "delete …" | session management (like `/sessions`, `/session open`, `/session new`, `/session delete`) |
| "rename the session to …", "come up with a name for this conversation" | renaming (like `/session update title=…`); for inventing names the manager uses the short summary or the beginning of the conversation |
| "enable … tool …" / "grant permissions …" | a tool for a member: enable or update the card (`shell`, `ssh`, a custom tool from `tools/`…) |
| "add the server …" | the project's servers (the "hosts" field of project.json): a new server in the current project |
| "add a mailbox …", "remove the mailbox …" | the mailboxes (the "mails" field of project.json; like `/project mail add` and `/project mail delete`) |
| "add a telegram bot …", "remove the bot …" | a bot token (the "messengers" field of project.json; like `/project messenger add` and `/project messenger delete`) |

Edits of `agents/` and of the current project's project.json (the `"hosts"`,
`"mails"`, `"messengers"` fields) are safe: the file is rewritten through a
temporary file with
a validity check — a failed edit doesn't ruin the config, unknown fields are
preserved. And if you ruin `agents/` by hand (broken JSON, an agent without
`name` or `prompt`), the team doesn't vanish silently: the error is visible
during a round and as a red line in the team panel of the web shell. A missing
file is not an error — it's an empty start one-on-one with the manager.
Everything the manager controls also has explicit manifest operations —
`/agent new`, `/agent tool add`, `/project host add`, `/project open`
(the same executors: both the neural network and the commands write the config
through the same proven helpers). The manager is needed for whatever the commands
don't cover — e.g. thinking through a new member's prompt or choosing who gets
which tool.

It is configured in `~/.dreamteam/manager.json` (the file is required, like
`settings.json`):

```json
{ "model": "openai", "name": "Manager", "emoji": "🛎", "color": "yellow", "temperature": 0.2 }
```

- `model` — a reference to a card in `models/`; the model is taken from the
  card's record. An unknown id — the app won't start, with a clear error.
- `name` — the name for addressing. `@manager` and `!manager` always work,
  regardless of the name; in the `@` popup it is offered first.
- `emoji`, `color` — the look of the lines; `temperature` by default is stricter
  than the members' (0.2): careful actions are expected from the manager, not
  creativity.

`/settings update model.id=…` changes the default model of the **agents**; the
manager has its own model (from `manager.json`) — changed with
`/manager update model.id=…`.

## Custom roles and your own API

**Change the team** — edit `~/.dreamteam/agents/` (saved on the fly): the
`id`, `name`, `emoji`, `role`, `description`, `color`
(red/green/yellow/blue/magenta/cyan/white/gray), `prompt` (persona) fields,
optionally `model` (an id string or an object with `temperature`) and
`temperature`; access to real actions — `tools`,
`projects`, `workspace`, eyes and hands — `vision` and `image` (see "Tools"
and "Vision and images"). The `model.id` field — a reference to a card in
`models/`: the `/agent new|update` commands, the web shell and the manager
will reject a foreign id with the list of available ones instead of writing
garbage into the config.

**Add a new API — a file, no fork.** Drop an adapter into the home shelf
`~/.dreamteam/models/`: the file name becomes the adapter id, and a model card in
`models/` references it with "provider": "<id>". The shelf is scaffolded on first
launch; the code loads at startup — a broken file or a name colliding with a
built-in adapter (including the image ones) fails the startup with a clear
error:

```ts
// ~/.dreamteam/models/my-api.ts
// when installed from npm — 'dreamteam/src/providers/types.js';
// in a repo clone — '../src/providers/types.js'
import type { LLMProvider, ProviderConfig } from 'dreamteam/src/providers/types.js';

export default (id: string, config: ProviderConfig): LLMProvider => ({
  id,
  kind: 'my-api',
  model: String(config.model ?? 'default'),
  async *stream(req) {
    // call your API and yield the answer in pieces
    yield 'answer ';
    yield 'in parts';
  },
});
```

```json
{ "my": { "provider": "my-api", "model": "any" } }
```

For OpenAI-style APIs you rarely need a custom adapter — the built-in
`openai-compatible` already covers them via `baseUrl`. A full-featured built-in
example is `gigachat`: the OAuth token cycle and TLS certificates (see
"Sber GigaChat"). To ship an adapter inside the package, implement the same
interface in `src/providers/` and register it in `src/providers/registry.ts`.

## Checks

The project is checked by probes in `tests/` — no test framework, each file runs
directly and prints `ok`/`FAIL` per check. All probes are hermetic: real data is
untouched, the home is redirected into a temporary folder (`DT_HOME`).

- `npm run probe` — quick checks without a real terminal: line wrapping
  (`probe-screen`), `settings.json` validation, "project:host"
  ssh addressing and permissions through projects, screen zone math, live
  multi-line streaming, mouse and Shift+key selection, scrollback
  (`probe-editor`: keys, cursor, history, input), the war-room manager
  (`probe-manager`: config validation, answer parsing, new actions
  `tool.grant`/`project.host.add` with rollback, state) and the
  end-to-end manager pipeline as the configuration gateway (`probe-manager-flow`:
  the state snapshot for the LLM, the JSON protocol, all operations down to
  files with rollbacks, ✓/✗ reports in the history, a remark staying in the old
  session when switching), the canonical commands (`probe-commands`: all `/…` in
  the core, interception without history records, `/agents`/`/projects` control),
  projects in the home (`probe-project`: folder-projects instead of a registry
  file, the "no project" state at startup, `/project new/open/close/delete/update`,
  a working folder can't be inside the home, switching the core with session and
  secrets isolation, the manager's `project.open`, the web shell's rpc and
  state, autocompletion), four-level import-export (`probe-transfer`: the whole
  home, settings only, one project with conversations, one conversation —
  card keys inside, .env not transferred, merging by id,
  zip-slip blocked, cancellation via
  confirm), GUI/TUI data equivalence (`probe-consistency`: the serve snapshot ≡
  the home-layer files, a GUI round visible to the TUI, a restart picks things
  up), the first-launch wizard and scaffolding (`probe-wizard`, including API-key
  hiding), the outer-world
  tools — all hermetic: `probe-docs` (reads and writes real pdf/docx/xlsx in
  temporary folders), `probe-ocr` (draws pictures with text with a local canvas
  and recognizes them), `probe-web` (whitelist and a local stub site),
  `probe-mail` (mailbox validation in the "mails" field of project.json, send
  parsing, no network),
  `probe-messengers` (telegram and max against local mock servers of both APIs);
  the UI language system — `probe-i18n` (built-in en/zh, external lang/, live
  switching).
- `npm run probe:e2e` — the same zones under a real pseudo-TTY on Windows
  (ConPTY): what actually reaches the app (`probe-input`) and the rendered screen
  through a mini VT emulator (`probe-startup`: starting without a project,
  `/project open` with a past conversation, history in the panel,
  wheel/PgUp/mouse/selection). It installs and removes node-pty itself.
- `npm run probe:tui` — a full run of the app in a pseudo-TTY: starting without
  a project → `/project new` → the concierge's greeting, `team.add`,
  `chat.add`, a round with tools, `/agents`, exit — all on the mock provider in
  temporary folders. `probe:scenario-tui` — the same scenario with on-disk file
  checks after every step (sessions, agents/, the export archive).
- `npm run probe:api` — the server API (`dreamteam serve`) on the mock provider
  in temporary folders: gui-dist/ statics, the no-project state in the snapshot,
  a WS concierge scenario (`project.open` → greeting,
  remarks, team.add through a conversation), rpc (`project.open`, `sessions.list`,
  `session.agent.add/delete`, `settings.update` with model validation,
  `session.new` with fresh states after them), live confirm/choose
  questions — a client answer, a timeout refusal and a refusal with no clients.

`npm run typecheck` — type checking (src and tests).

## Layout

The package installs globally, the data lives in two layers next to you:

```
~/.dreamteam/                 # home: one machine — one home
├── models/                   # model cards: adapter, URL, model, key ("apiKey")
├── settings.json             # general settings: UI language (ui), default model, conversation language, screen, tool limits
├── user.json                 # your profile for the team (/profile)
├── agents/                   # the team: one card per agent (agents/<id>.json)
├── manager.json              # the war-room manager: model, name, look (@manager)
├── providers/                # custom adapters: providers/<id>.ts → the "<id>" adapter
├── memory.json               # the team's shared memory
├── lang/                     # custom UI languages: lang/<id>.json
├── tools/                    # custom tools: tools/name.ts → the "name" tool
├── bin/                      # quick-launch scripts (desktop shortcut)
├── .env                      # serve settings: TOKEN, PORT, HOST (a thing of the machine)
├── cache/                    # local caches (tesseract models for ocr)
└── projects/                 # the registry of projects = the folders themselves (projects/<id>/)
    └── <id>/
        ├── project.json      # the working folder "path", servers "hosts",
        │                     # mail "mails", bots "messengers"
        ├── sessions/         # the project's conversations (JSON)
        ├── transcripts/      # the same conversations as human-readable logs (.md)
        ├── inbox/            # files the person attached in the web shell
        ├── mail/             # attachments of read letters
        └── images/           # pictures the image tool generated

my-project/                   # the working folder ("path" from project.json):
└── …                         # the agents write files and run commands here
```

Each conversation's chat roster — in its `sessions/<id>.json` file (the
`participants` field): member ids against the full team from the home; empty —
the whole team answers.

The package code (what gets installed via npm):

```
dreamteam/
├── bin/dreamteam.js          # the global command: a tsx loader; serve → src/serve.ts
├── scaffold/                 # first-launch config skeletons: home/ — JSON, unfolded by the wizard
├── src/
│   ├── index.ts              # the terminal shell: the REPL loop, chat commands, screen and editor
│   ├── core/
│   │   ├── engine.ts         # the core: rounds, moderator, manager, tools, memory
│   │   ├── projects.ts       # the home's project registry: remember/forget, name resolution
│   │   ├── presenter.ts      # the core→shell channel (the terminal and the network implement it)
│   │   └── bootstrap.ts      # the shells' shared start: layers, configs, providers, session
│   ├── serve.ts              # the local server: HTTP+WS on 127.0.0.1, gui-dist/ statics, a second Presenter
│   ├── paths.ts              # the three layers of paths: home, project, working folder
│   ├── wizard.ts             # the first-launch wizard: language, model, key, profile, scaffolding
│   ├── orchestrator.ts       # the moderator: who answers and what to focus on
│   ├── shortcut.ts           # quick-launch shortcuts (.lnk/.desktop/.command)
│   ├── open.ts               # browser opening (serve --open)
│   ├── manager.ts            # the war-room manager: config, prompt, actions (team/chat/session/tool/project)
│   ├── agents.ts             # loading agents/
│   ├── actions.ts            # agents' action blocks, projects, structural permissions, execution
│   ├── docs.ts               # the document stack: pdf/docx/xlsx — reading and writing + the LibreOffice bridge
│   ├── ocr.ts                # recognition: tesseract, pdf pages, tables by coordinates
│   ├── web.ts                # reading sites: whitelist, article reader, links
│   ├── mail.ts               # mail: imapflow/mailparser/nodemailer, explicit mailboxes
│   ├── messengers.ts         # the Telegram Bot API and MAX (platform-api2.max.ru)
│   ├── tools-api.ts          # the tool contract: check() → allow/deny/ask, cards, command rules
│   ├── tools-registry.ts     # the registry: built-in tools and loading custom ones from tools/
│   ├── tools/                # the built-in tools — a folder per tool: tools/<tool>/<tool>.ts
│   │                         #   + a mandatory default.json (the default card):
│   │                         #   files, shell, git, arch, ssh, look, image, docs,
│   │                         #   ocr, web, mail, telegram, max
│   ├── i18n.ts               # UI languages: t()/tf(), built-in ru/en/zh + the home's lang/
│   ├── locales/              # built-in translations: en.ts, zh.ts
│   ├── completion.ts         # command and @mention autocompletion (the hint panel, the arrow popup)
│   ├── screen.ts             # the managed screen: alternative buffer, zones, word wrapping
│   ├── editor.ts             # the input editor: raw keys, history, cursor by codepoints
│   ├── memory.ts             # team memory: personal, shared, about other conversations
│   ├── compress.ts           # compacting long conversations into a digest
│   ├── sessions.ts           # conversation storage
│   ├── ui.ts                 # output colors and styling (spinner, header, stream)
│   ├── types.ts
│   └── providers/            # API adapters
│       ├── types.ts          #   the LLMProvider interface + configs
│       ├── registry.ts       #   the adapter registry
│       ├── utils.ts          #   the SSE parser, message normalization
│       ├── openai-compatible.ts
│       ├── anthropic.ts
│       ├── gigachat.ts       #   OAuth tokens + the Sber TLS certificates
│       ├── openai-images.ts  #   image adapter: OpenAI images API / docker facade
│       ├── mock-images.ts    #   test image adapter (real PNGs, no models)
│       └── mock.ts
├── docker/                   # model containers for look/image + the LibreOffice bridge (soffice)
│                             #   for the docs tool's conversions — see docker/README.md
├── tests/                    # probes: probe-screen, probe-editor, probe-manager,
│   ├── …                     #   probe-manager-flow, probe-project, probe-tools,
│   │                         #   probe-wizard, probe-input, probe-startup,
│   │                         #   probe-tui, probe-api, probe-commands, probe-docs,
│   │                         #   probe-ocr, probe-web, probe-mail,
│   │                         #   probe-messengers + vt
└── package.json
```
