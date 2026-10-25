# 🎬 Dream Team — a chat with a team of AI agents

[![ci](https://github.com/fwmakc/dreamteam/actions/workflows/ci.yml/badge.svg)](https://github.com/fwmakc/dreamteam/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dreamteam)](https://www.npmjs.com/package/dreamteam) [![node](https://img.shields.io/node/v/dreamteam)](https://www.npmjs.com/package/dreamteam)

**English** · [Русский](README.ru.md) · [中文](README.zh.md)

You don't talk to a single AI here, but to a virtual team: every member has their own
name, role, personality and text color. Your message goes to the moderator-orchestrator,
who decides which team members should answer (usually 1–3 people, not everyone at once).
The agents see each other's remarks, argue and build on each other's ideas. You can
address a specific member with `@name`. Every conversation is saved.

Two shells, one core: a terminal TUI and a local web GUI (`dreamteam serve`).

The interface — and this documentation — come in three languages: English, Russian and
Chinese (`README.md`, `README.ru.md`, `README.zh.md`). The UI language is chosen at
first launch (in the wizard) and can be changed at any time with
`/settings set ui=en` (`ru`, `zh`, or the id of your own language from
`~/.dreamteam/lang/<id>.json`).

The team belongs to the machine: it lives in your home directory
(`~/.dreamteam/agents.json`) and is shared by all projects. It starts out empty — you
are greeted by the **war-room manager**, who will summon members on request, enable
tools for someone, and set up projects with servers. Who exactly answers in a given
conversation is decided by the chat roster — the `participants` list in the session
file: an empty list means everyone you have summoned answers (`/add`, `/out`, or
asking the manager to "bring Elena in").

## Quick start

You need Node.js ≥ 18.17.

```bash
npm install -g dreamteam   # or: git clone + npm install + npm link
cd my-project              # work inside a project folder
dreamteam
```

Check the installation: `dreamteam -v` — the version, `dreamteam -h` — help on the
launch modes (TUI, `serve`).

On first launch the wizard walks you through the setup (see "First-launch wizard"):
you pick the interface language and a provider, enter an API key (the input is hidden)
and introduce yourself — `~/.dreamteam` (the home: settings and the team) and
`./.dreamteam` (the project: the hosts.json, mails.json, messengers.json registries
and the conversations) are created. After that it's just you and the war-room
manager: tell it what you need.

Without a configured key the app runs in **mock mode** — the agents give canned
answers, so you can try out the interface and the mechanics. The key is entered by
the wizard or later in the provider card (`~/.dreamteam/providers.json`, the
`"apiKey"` field).

## Two layers: home and project

The app is global (like any CLI), but its data is split into layers:

| Layer | Where | What it holds |
|---|---|---|
| **package** | the installation folder | the application code — read-only, it writes nothing |
| **home** | `~/.dreamteam` | EVERYTHING global: providers with model keys (`providers.json`), settings (`settings.json`), your profile (`user.json`), **the whole team** — agents (`agents.json`), the manager (`manager.json`), tools (`tools/`), the schedule (`schedule.json`), shared memory (`memory.json`) — plus the registry of known projects (`projects.json`). The team simulator belongs to the machine: configured once, it works in any project |
| **project** | `<project folder>/.dreamteam` | EVERYTHING about this specific project: `hosts.json` (ssh servers), the project's mail and bots (`mails.json`, `messengers.json` — project secrets, never in agent cards), the conversations (`sessions/`, `transcripts/`). The agents' work files go into the project folder (inbox and the like) |

The tools' working folder is **always the folder the app was launched from**:
`dreamteam` run inside a project folder works on that project. No paths to configure
anywhere — launch it in a repository, and the team works on it.

You can switch projects without leaving the app: `/project open <path or name>`
changes the working folder, the list of conversations and the project registries
(servers, mail, bots) — the team, the providers and the shared memory stay with you.
Overview: `/project` (the current project with its servers and the known projects),
`/project add <path>` adds a new path to the registry, `/project remove <name>`
forgets it (the current project can't be removed this way). In the web shell there
is a "Projects" panel: click an entry to switch, the "＋" button by the section opens
a form with a path field. You can also ask the manager to switch projects.

The layers are overridden by the `DT_HOME` and `DT_PROJECT` environment variables —
that's how the probes and isolation work (add `.dreamteam/` to the project's
`.gitignore`: the wizard will remind you when creating it).

## First-launch wizard

If there is no home (`~/.dreamteam`), the wizard asks, in order:

1. **Interface language** — the very first question, and the wizard itself already
   speaks it: `ru`, `en`, `zh` out of the box, plus your own languages from
   `~/.dreamteam/lang/<id>.json` (see "Settings"). Changed later with
   `/settings set ui=<id>`.
2. **Provider** — from the list of adapters (`mock` works for a trial run, no keys
   needed).
3. **API key** — the input is hidden (not displayed and not written to the terminal
   log); the key is saved right into the provider card in `providers.json`
   (the `"apiKey"` field) and picked up immediately.
4. **How to introduce you to the team** — name, role, a couple of words (can be
   skipped).

Then both layers are created with minimal files and clear starter notes: the home
gets a starting team of five members (an analyst, a secretary, a developer,
a designer, a writer) and the manager on the chosen provider, plus the `lang/` shelf
for custom languages. The roster is edited in `agents.json` or via a conversation
with the manager. If the project folder is a git repository without `.dreamteam/` in
`.gitignore`, the wizard offers to add it. Running the wizard again breaks nothing:
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

- **Model keys** — right in the provider card in `~/.dreamteam/providers.json`
  (the `"apiKey"` field; for GigaChat you can set a `"clientId"`/`"clientSecret"`
  pair instead).
- **serve settings** — `~/.dreamteam/.env` (`TOKEN`, `PORT`, `HOST`; the `.env`
  in a project folder is deliberately not read — there is a single source of
  variables). These are settings of a specific machine: they are not included in
  the `/home export` archive. The wizard creates `.env` on first launch on a fresh
  machine; a home moved over with `/home import` does not carry the file — without
  it serve simply listens on `127.0.0.1`, and for outside access create `.env` from
  the sample in the package (`scaffold/home/env.example`) and put in a `TOKEN`
  (see "Access from outside").
- **API description** — the same `providers.json`: which adapter, URL, model
  and key.
- The app talks to LLMs through a single `LLMProvider` interface
  (`src/providers/types.ts`). The concrete protocols are hidden in the adapters:

| Adapter | For which APIs |
|---|---|
| `openai-compatible` | Z.ai (GLM), OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio… |
| `anthropic` | Claude |
| `gigachat` | Sber GigaChat (with the full OAuth token cycle inside) |
| `mock` | working without keys |

Moving to another machine — `/home export` and `/home import`: settings, the team
and the providers move together with the card keys, nothing needs to be re-entered;
the current project's conversations travel in the same archive and merge by id
(matching ones are replaced). The archive contains keys — treat it (in the cloud and
anywhere else) like a password.

### Z.ai (GLM)

1. Get an API key in the console of the Z.ai open platform (the API keys section).
2. Put it into the provider card in `~/.dreamteam/providers.json`:
   ```json
   "apiKey": "your-key"
   ```
3. The default provider is already selected there (`"default"`). The model is
   changed right next to it (the `model` field).

**A note on key types.** For example, Z.ai has two different endpoints:

| Endpoint | For which key |
|---|---|
| `https://api.z.ai/api/paas/v4` | the regular pay-as-you-go API (paying per token) |
| `https://api.z.ai/api/coding/paas/v4` | keys of the **GLM Coding Plan** subscription |

A Coding Plan key on the regular endpoint gives the error
`429: Insufficient balance or no resource package` — that's normal: the subscription
is invisible to the payment balance. If you have a subscription, set the coding
endpoint in the `baseUrl` of the `openai` provider. The list of models available on
the subscription: `GET https://api.z.ai/api/coding/paas/v4/models`.

### Live smoke: `npm run smoke:live`

A quick check against a real (non-mock) provider: a live answer from the manager,
the manager actually creates an agent on request, an agent with `files` actually
writes a file. The home is the real one (keys and `providers.json`), the project is
a temporary sandbox — nothing in a real project changes. The hermetic probes
(`npm run probe`) never touch the live API — they are free and deterministic.

### Anthropic (Claude)

The key from the Anthropic console goes into the `claude` provider card
(`~/.dreamteam/providers.json`):

```json
"apiKey": "your-key"
```

Then in the chat: `/provider claude` (or change `"default"` in `providers.json`).

### Sber GigaChat

The adapter does by itself everything people usually build a proxy service for:
gets an `access_token` with your API key, caches it, refreshes it ahead of time
(a minute before expiry), survives a sudden 401 (a silent refresh + retry), and
supplies the Russian TLS certificate.

1. Get an API key in the GigaChat console (developers.sber.ru → GigaChat API).
2. Put it into the `gigachat` provider card in `~/.dreamteam/providers.json`:
   ```json
   "apiKey": "your-console-key"
   ```
   (the console key is already a ready Basic string; if you have a client_id/secret
   pair, set `"clientId"` and `"clientSecret"` instead).
3. Download the Ministry of Digital Development root certificate per the GigaChat
   instructions and place it at the path from `caCertPath` (by default
   `certs/russian_trusted_root_ca.pem`). For a quick check you can instead set
   `"insecureTLS": true` (insecure, for tests only).
4. In the chat: `/provider gigachat`.

Every agent can run on its own provider — give it a `"provider": "<provider id>"`
field in `~/.dreamteam/agents.json`. You can assemble a team of different models
(say, Marina on Claude, Dmitry on GLM).

## Operations: commands = rpc

Control is described by an **operations manifest** (`src/core/operations.ts`). The
canonical operation name — `group.verb` — is the same across three surfaces:

- a text command: `/group verb arguments` (a group overview is just `/group`);
- a WebSocket rpc method: the same name as a string (the GUI calls it with buttons,
  scripts call it directly);
- the `/help` string and autocompletion: derived from the same list.

There are no aliases or short forms: one name — one operation.

| Operation | Command | Action |
|---|---|---|
| `session.new` | `/session new` | a new session: one-on-one with the manager |
| `sessions.list` | `/sessions` | the list of sessions (freshest on top, the current one marked) |
| `session.open <number>` | `/session open 2` | open a session from the list |
| `session.delete <number>` | `/session delete 2` | delete a session (not the current one) |
| `session.rename [name]` | `/session rename Morning standup` | rename the current one; with no name the manager will invent one |
| `session.history [N]` | `/session history 20` | the current session's history (or the last N) |
| `session.export [number]` | `/session export 2` | archive a session into a zip (no number — the current one) |
| `session.import <file>` | `/session import dt-session-….zip` | restore a session from an archive (merges in as a new one) |
| `home.export` | `/home export` | a snapshot of the home for moving: settings, providers with keys, the team's memory, the schedule and all sessions (no .env — a thing of the machine); store it like a password |
| `home.import <file>` | `/home import dt-home-….zip` | unfold a home from an archive (with keys); sessions merge by id, session dates are preserved |
| `chat.add <name\|number>` | `/chat add Lawyer` | summon a member into the current conversation |
| `chat.remove <name\|number>` | `/chat remove Lawyer` | send out of the conversation (the remarks stay in the history) |
| `team.list` | `/team` | the team roster: roles, tools, who is in the chat |
| `team.add <id> <Name> [role]` | `/team add lawyer Lawyer law` | a new member (defaults like the manager's) |
| `team.update <id> field=value…` | `/team update lawyer role=sourcream` | edit: name, role, emoji, color, description, prompt, provider, temperature |
| `team.delete <id…>` | `/team delete lawyer, keks` | delete members: a comma- or space-separated list |
| `team.grant <agent> <tool>` | `/team grant lawyer files` | enable a tool: files, shell, ssh, look, image or a custom one from tools/ |
| `provider.list` | `/provider` | the providers and their status |
| `provider.set <id>` | `/provider set glm` | change the main provider |
| `provider.add <id> field=value…` | `/provider add glm adapter=openai-compatible …` | a new provider (adapter is required) |
| `provider.update <id> field=value…` | `/provider update glm model=glm-4.6` | edit an existing card (adapter, model, baseUrl, apiKey, maxTokens, temperature) |
| `provider.delete <id>` | `/provider delete glm` | delete a provider; the main one can't be deleted — `/provider set` another one first |
| `profile.show` / `profile.set` | `/profile set Name; role; about you` | how the team sees you (user.json) |
| `memory.show [who\|shared]` | `/memory show Lawyer` | what a member remembers; `shared` — the shared memory |
| `project.list` | `/project` | the current project: servers (hosts.json) and known projects |
| `project.open <path\|name>` | `/project open ../other` | switch project: the working folder and sessions; a name — from the `/project` overview |
| `project.add <path>` | `/project add ../other` | remember a project in the registry without opening it |
| `project.remove <name>` | `/project remove other` | forget a project (the current one can't be removed this way) |
| `project.host.add <name=host>` | `/project host add backup=deploy@10.0.0.2` | a server in the current project; the host format is [user@]host[:port] |
| `project.host.delete <name>` | `/project host delete backup` | remove a server from the current project |
| `mail.list` | `/mail` | the mailbox registry (mails.json) |
| `mail.add <name> field=value…` | `/mail add work user=… password=… imap=… smtp=…` | a mailbox into mails.json; ports and `tlsNoVerify` — optional |
| `mail.remove <name>` | `/mail remove work` | remove a mailbox |
| `messenger.list` | `/messenger` | bots (messengers.json) |
| `messenger.add <telegram\|max> <token>` | `/messenger add telegram 123456:ABC…` | a bot token into messengers.json |
| `messenger.remove <telegram\|max>` | `/messenger remove max` | remove a bot |
| `schedule.list` | `/schedule` | the tasks serve runs by itself |
| `schedule.add <task> [minutes]` | `/schedule add "standup" 60` | a new task; the default interval is 10 minutes |
| `schedule.toggle <id>` / `schedule.delete <id>` | `/schedule toggle task-…` | pause and delete a task |
| `settings.show` / `settings.set field=value…` | `/settings set maxTurns=2` | settings (take effect from the next round) |
| `manager.show` / `manager.set field=value…` | `/manager set provider=glm` | the war-room manager: provider, temperature, name |
| `auto.on [N]` / `auto.off` | `/auto on 5`, `/auto off` | autonomous mode: the agents decide on their own for up to N turns |
| `/help` | `/help` | help on the operations (the same manifest) |
| `/exit` | `/exit` | quit (in the terminal only) |

Commands are part of the core: in the web shell the same set works through the same
input (or via the panel buttons), the terminal only adds colored views.

When launched, the app continues the last conversation; if the last conversation is
empty (or it's the very first launch) — the manager greets you itself.

**Session names.** The name is taken from the first message, and after the first
answer the manager invents a short title for the session (based on the first
message). You can rename at any moment: `/session rename <new name>` — or ask the
manager: "come up with a name for this conversation" — it will take the short
summary, or, if the session hasn't been compacted yet, the first and last messages.

**Command hints.** Start typing with `/` — a list of commands appears above the
input line (a short description for each); as you type, the list is filtered.
**Tab** autocompletes the command, and for commands with arguments it hints and
completes them too: session numbers (with titles) for `/session open` and
`/session delete`, member names for `/chat add` and `/chat remove`, `who|shared`
for `/memory`, provider ids for `/provider set`.

The same for mentions: type `@` in the middle of a message — a popup with the
members of the current chat and `@session` opens above the input line (each with
their role). Typing filters the list, **up/down arrows** move the selection
(wrapping around), **Enter** or **Tab** insert the selected name, **Esc** closes
the popup leaving the typed `@fragment` as is. Case doesn't matter, and neither
does the Russian "ye"/"yo" letter distinction. After `@session` and a space, session
numbers with titles are suggested.

**`!` is a full synonym of `@`** (Shift+1 on any layout and in any language):
`!Katya, look at the mockup`, `!manager, bring Gleb in`, `!session 2` — everything
works the same, including the hint popup.

**Chat roster.** A new conversation (`/session new` and the very first one) always
starts one-on-one with the manager: it's the concierge — ask it to call in the
people you need. After that the roster changes on the fly: `/chat add <name or
number>` — summon, `/chat remove <name or number>` — send out (their remarks and
memory stay in the history); the manager does the same on request. Chat events —
"Gleb joined the chat", "Katya left the chat" — go into the general chronology of
the conversation as a manager line (in the terminal, in the web chat and in the
saved history alike), not into a separate journal. If the last member is removed
from the chat, the manager stays — the war room doesn't work with no team at all.
The current roster is visible in `/team` and `/session`. Digests of a closed
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
```

A local server comes up: `http://127.0.0.1:8080` serves the web shell from `gui/`
(plain HTML/JS/CSS, no build step) and talks to it over WebSocket. By default it
listens on 127.0.0.1 only — the server is not visible from outside the machine.
The port and address are set by the `PORT` and `HOST` variables — you can put them
in `~/.dreamteam/.env`: the settings will survive a global reinstall and a project
switch. **Careful:** `HOST=0.0.0.0` exposes the server to the network — the API has
no authentication, so only do this on your own network. Conversations, the team
and the configs are shared with the terminal: you can work in the TUI and continue
in the browser.

- on the left — conversations (click to switch, "＋" for a new one), the team
  roster (click a member to summon/send them out of the chat), the providers
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

When connecting, the shell asks for the token once and remembers it in the browser;
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
  changed with `/settings set ui=en`. The interface and the three READMEs
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
the `"tools"` field in `~/.dreamteam/agents.json`. There is a single form — an
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
  `maxTotalBytes`) against archive bombs; secrets and `.dreamteam` are never
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
add the card to `agents.json` (and can edit it later: "give Gleb permission for
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

**The working folder is the launch folder.** The agents work in the folder the app
was launched from (and in subfolders assigned to an agent via its `"workspace"`
field — a path relative to the launch folder). Files are written and commands run
only there.

**The server registry.** `.dreamteam/hosts.json` — the ssh servers of the current
project (the file is created by the scaffold). The project is the folder the app
was launched from; servers are added with the command
`/project host add prod=deploy@203.0.113.10`, through the manager ("add the prod
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

A flat dictionary: server name → connection, each with a mandatory `host` field.
In a block the server is addressed by name (`ssh prod uptime`); the long
`project:prod` form is understood too.

In `agents.json` projects are assigned to the agent and its tools are enabled:

```json
"tools": { "files": {}, "ssh": null }, "projects": ["project"]
```

The project is one — the current folder, its label is `project`; the `projects`
field lets the agent reach its servers. An action with someone else's label is
rejected before confirmation. Accesses are visible in `/team`.

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
  manager — put it into `hosts.json` by hand.

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
  (`cat ../secret` — refused); for `ssh` the machine can't be escaped, so a
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
project of the action, `ctx.run` — running a command through the full pipeline
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

**mail — email.** Mailboxes live in the project's `mails.json` (the `.dreamteam`
service folder; passwords only there, never in the cards; **app passwords** are
required). A mailbox is created with the command
`/mail add work user=… password=… imap=… smtp=…`, a conversation with the manager
("add the work mailbox…") or by hand — one format, everything explicit, no
presets:

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
If the provider's server presents a certificate for a different name (typical for
`mail.my-site.ru` on shared hosting), the connection is rejected by the name
check — then set `"tlsNoVerify": true` on the mailbox: encryption stays, only the
password is verified, but such a setup no longer notices server substitution, so
enable it deliberately. The `mail` block: `boxes` — the mailboxes without
passwords; `list [box] [N]`, `find <box> <text>` — checking mail;
`read <box> <uid>` — a letter in full, attachments are saved into the working
folder's `mail/`; `send <box>` — the block body holds the header `to:` /
`subject:` / `files:`, an empty line, the letter text. Sending always asks
`y/n`; attachments — only files from the working folder; secrets (`.env`, keys,
`.pem`) are never read or sent.

**telegram and max — messengers.** Bots live in the project's `messengers.json`
(the `.dreamteam` service folder; the Telegram token — @BotFather, the MAX token
— dev.max.ru). A bot is created with the command
`/messenger add telegram <token>` or a conversation with the manager:

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
you with a regular LLM (the `provider` field), looks at pictures with a vision
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
base). The files are saved into the working folder's `images/`, the paths come to
the agent as the result and open for you in a viewer. Confirmation works like
with the other tools — the line shows how many variants and of what size the
agent wants, so an over-ambitious artist can be stopped before the spending.

**The eyes and hands are configured independently.** For the artist — cloud
vision (GLM-4.6V), for the layout person — local (Qwen-VL in docker); the
generator changes with one record in `providers.json` without touching the
personas. A provider becomes "seeing" with the `"vision": true` flag (the
`openai-compatible` and `anthropic` adapters can pass pictures; `mock` — sees in
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
away, no config edits; the machine's address in `providers.json` changes only if
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
  - `<project>/.dreamteam/transcripts/<id>.md` — a human-readable log (open it
    in any editor), updated as the conversation goes;
  - `<project>/.dreamteam/sessions/<id>.json` — the machine-readable state (used
    for `/session`).
- **`/history [N]`** prints the current conversation's history to the terminal
  with the members' colors.
- **Context compaction.** When a conversation gets long (more than ~24 messages),
  the old messages are automatically rolled up by an LLM into a short digest
  (`session.summary`), and only the digest + the last 16 messages go into the
  context. The full history is never deleted anywhere — it stays in the JSON and
  the transcript. A note appears in the chat that "old messages were rolled up
  into a digest", and the agents keep remembering the gist of the discussion.

In messages: `@marina` / `@viktor` — address specific members (works by name and
by id, case doesn't matter; `!` is a synonym of `@`).

## Who you are for the team: /me and ~/.dreamteam/user.json

By default the members see the conversation partner simply as "User". So that the
team knows who you are and how to address you, introduce yourself:

```
You > /me Alexey; startup founder; values brevity and specifics
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
- on closing a conversation (`/session new`, `/exit`) its digest is merged into
  the shared log and the shared memory — usually 0–2 calls, the digest is
  cached;
- every document has a hard word limit, and memory enters the agent's context as
  a compact block (~150–250 tokens).

To peek: `/memory Gleb` — what Gleb remembers in this conversation (the task,
the attitude to you, the connections), `/memory shared` — the team's shared
memory. Storage: `.dreamteam/memory.json` (the team's memory — a thing of the
project) + the `memories` field in the session JSON
(`<project>/.dreamteam/sessions/`).

## Links to other sessions: `@session`

A classic case: a week ago you discussed the company name in one chat and closed
the topic. Today in a new chat you're discussing products — and want to remind
the team what was already decided about the name. For that, attach the old
conversation:

```
You > we're discussing the company's products. Remind us what we decided about the name: @session
  → the list of sessions → enter a number (Enter — cancel)
You > what do we do next? @session 2     ← straight by number from /sessions
```

How it works:

- `@session` (no number) shows the list of other sessions; pick a number or press
  Enter to cancel. `@session N` attaches the session right away. `!session` is a
  full synonym of `@session`.
- For an attached session the LLM builds a **digest** (decisions, arguments,
  names, open questions) — not the whole text, so as not to bloat the context.
- The digest is shown in the chat as `📎 Attached a digest of session "..."` and
  saved into the history: all members of the current conversation "see" it and
  take it into account in further answers.
- Several sessions can be attached in one message: `@session 2 @session 5`.
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
| "add … to the team" | a new member in `agents.json`: id, name, role, prompt, emoji, color, provider, temperature, tools |
| "assign …" | a member edit: role, prompt, model (provider), temperature, name, emoji, color |
| "bring in …" / "send out …" | the current chat roster (like `/chat add` and `/chat remove`) |
| "show the sessions", "open #2", "new session …", "delete #3" | session management (like `/sessions`, `/session open`, `/session new`, `/session delete`) |
| "rename the session to …", "come up with a name for this conversation" | renaming (like `/session rename`); for inventing names the manager uses the short summary or the beginning of the conversation |
| "enable … tool …" / "grant permissions …" | a tool for a member: enable or update the card (`shell`, `ssh`, a custom tool from `tools/`…) |
| "add the server …" | the `hosts.json` server registry: a new server in the current project |
| "add a mailbox …", "remove the mailbox …" | the `mails.json` mailbox registry (like `/mail add` and `/mail remove`) |
| "add a telegram bot …", "remove the bot …" | a bot token in `messengers.json` (like `/messenger add` and `/messenger remove`) |

Edits of `agents.json` and of the project registries (`hosts.json`, `mails.json`,
`messengers.json`) are safe: the file is rewritten through a temporary file with
a validity check — a failed edit doesn't ruin the config, unknown fields are
preserved. And if you ruin `agents.json` by hand (broken JSON, an agent without
`name` or `prompt`), the team doesn't vanish silently: the error is visible
during a round and as a red line in the team panel of the web shell. A missing
file is not an error — it's an empty start one-on-one with the manager.
Everything the manager controls also has explicit manifest operations —
`/team add`, `/team grant`, `/project host add`, `/project open`
(the same executors: both the neural network and the commands write the config
through the same proven helpers). The manager is needed for whatever the commands
don't cover — e.g. thinking through a new member's prompt or choosing who gets
which tool.

It is configured in `.dreamteam/manager.json` (the file is required, like
`settings.json`):

```json
{ "provider": "openai", "name": "Manager", "emoji": "🛎", "color": "yellow", "temperature": 0.2 }
```

- `provider` — an id from `providers.json`, the model is taken from the
  provider's record. An unknown id — the app won't start, with a clear error.
- `name` — the name for addressing. `@manager` and `!manager` always work,
  regardless of the name; in the `@` popup it is offered first.
- `emoji`, `color` — the look of the lines; `temperature` by default is stricter
  than the members' (0.2): careful actions are expected from the manager, not
  creativity.

`/provider` changes the main provider of the **agents**; the manager has its own
provider (from `manager.json`) — `/provider` doesn't affect it.

## Custom roles and your own API

**Change the team** — edit `~/.dreamteam/agents.json` (saved on the fly): the
`id`, `name`, `emoji`, `role`, `description`, `color`
(red/green/yellow/blue/magenta/cyan/white/gray), `prompt` (persona) fields,
optionally `provider` and `temperature`; access to real actions — `tools`,
`projects`, `workspace`, eyes and hands — `vision` and `image` (see "Tools"
and "Vision and images"). The `provider` field — only an existing id from
`providers.json`: the `/team add|update` commands, the web shell and the manager
will reject a foreign id with the list of available ones instead of writing
garbage into the config.

**Add a new API** — implement the interface in one file:

```ts
// src/providers/my-api.ts
import type { ProviderConfig, ProviderFactory } from './types.js';

export const myApiFactory: ProviderFactory = (id, config) => ({
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

and register it in `src/providers/registry.ts`:

```ts
import { myApiFactory } from './my-api.js';

const adapters = {
  ...,
  'my-api': myApiFactory,
};
```

After that the provider is described in `providers.json` as
`{ "adapter": "my-api", ... }`.

## Checks

The project is checked by probes in `tests/` — no test framework, each file runs
directly and prints `ok`/`FAIL` per check. All probes are hermetic: real data is
untouched, the layers are redirected into temporary folders
(`DT_HOME`/`DT_PROJECT`).

- `npm run probe` — quick checks without a real terminal: line wrapping
  (`probe-screen`), `settings.json` and `hosts.json` validation, "project:host"
  ssh addressing and permissions through projects, screen zone math, live
  multi-line streaming, mouse and Shift+key selection, scrollback
  (`probe-editor`: keys, cursor, history, input), the war-room manager
  (`probe-manager`: config validation, answer parsing, new actions
  `tool.grant`/`project.add`/`project.host.add` with rollback, state) and the
  end-to-end manager pipeline as the configuration gateway (`probe-manager-flow`:
  the state snapshot for the LLM, the JSON protocol, all 11 operations down to
  files with rollbacks, ✓/✗ reports in the history, a remark staying in the old
  session when switching), the canonical commands (`probe-commands`: all `/…` in
  the core, interception without history records, `/team`/`/project` control),
  project switching (`probe-project`: the registry in the home,
  `/project open/add/remove`, switching the core to another folder with session
  and hosts isolation, the manager's `project.open`, the web shell's rpc and
  state, autocompletion), import-export (`probe-transfer`: the home snapshot —
  card keys inside, .env not transferred, merging sessions by id,
  a session as a new one with agents by id, zip-slip blocked, cancellation via
  confirm), GUI/TUI data equivalence (`probe-consistency`: the serve snapshot ≡
  the home-layer files, a GUI round visible to the TUI, a restart picks things
  up), the first-launch wizard and scaffolding (`probe-wizard`, including API-key
  hiding), migrating the old layout to layers (`probe-migrate`: file moves, no
  overwriting, probe protection via `DT_HOME`/`DT_PROJECT`), the outer-world
  tools — all hermetic: `probe-docs` (reads and writes real pdf/docx/xlsx in
  temporary folders), `probe-ocr` (draws pictures with text with a local canvas
  and recognizes them), `probe-web` (whitelist and a local stub site),
  `probe-mail` (mailbox validation, send parsing, no network),
  `probe-messengers` (telegram and max against local mock servers of both APIs); the UI language system — `probe-i18n` (built-in en/zh, external lang/, live switching).
- `npm run probe:e2e` — the same zones under a real pseudo-TTY on Windows
  (ConPTY): what actually reaches the app (`probe-input`) and the rendered screen
  through a mini VT emulator (`probe-startup`). It installs and removes node-pty
  itself.
- `npm run probe:tui` — a full run of the app in a pseudo-TTY: no wizard needed
  (layers substituted), start with the manager's greeting, `team.add`,
  `chat.add`, a round with tools, `/team`, exit — all on the mock provider in
  temporary folders.
- `npm run probe:api` — the server API (`dreamteam serve`) on the mock provider
  in temporary folders: gui/ statics, a WS concierge scenario (greeting,
  remarks, team.add through a conversation), rpc (chat.add/remove, provider.set,
  session.new/delete with fresh states after them), live confirm/choose
  questions — a client answer, a timeout refusal and a refusal with no clients.

`npm run typecheck` — type checking (src and tests).

## Layout

The package installs globally, the data lives in two layers next to you:

```
~/.dreamteam/                 # home: one machine — one home
├── providers.json            # providers: adapter, URL, model, key ("apiKey")
├── settings.json             # general settings: UI language (ui), conversation language, screen (width/margin/screen), tool limits
├── user.json                 # your profile for the team (/me)
├── agents.json               # the team: roles, personas, colors, tools
├── manager.json              # the war-room manager: provider, name, look (@manager)
├── projects.json             # the registry of known projects (/project open by name)
├── memory.json               # the team's shared memory
├── lang/                     # custom UI languages: lang/<id>.json
├── tools/                    # custom tools: tools/name.ts → the "name" tool
├── .env                      # serve settings: TOKEN, PORT, HOST (a thing of the machine)
└── cache/                    # local caches (tesseract models for ocr)

my-project/
├── .dreamteam/               # the project: servers, mail and conversations of this project (in .gitignore)
│   ├── hosts.json            # the project's ssh servers
│   ├── mails.json            # mailboxes for the mail tool (app passwords)
│   ├── messengers.json       # Telegram and MAX bot tokens
│   ├── sessions/             # the project's conversations (JSON)
│   └── transcripts/          # the same conversations as human-readable logs (.md)
└── …                         # the project itself: the agents write files and run commands here
```

Each conversation's chat roster — in its `sessions/<id>.json` file (the
`participants` field): member ids against the full team from the home; empty —
the whole team answers.

The package code (what gets installed via npm):

```
dreamteam/
├── bin/dreamteam.js          # the global command: a tsx loader; serve → src/serve.ts
├── gui/                      # the web shell for `dreamteam serve`: HTML+JS+CSS, no build
├── scaffold/                 # first-launch config skeletons: home/, project/ — JSON, unfolded by the wizard
├── src/
│   ├── index.ts              # the terminal shell: the REPL loop, chat commands, screen and editor
│   ├── core/
│   │   ├── engine.ts         # the core: rounds, moderator, manager, tools, memory
│   │   ├── projects.ts       # the home's project registry: remember/forget, name resolution
│   │   ├── presenter.ts      # the core→shell channel (the terminal and the network implement it)
│   │   └── bootstrap.ts      # the shells' shared start: layers, configs, providers, session
│   ├── serve.ts              # the local server: HTTP+WS on 127.0.0.1, gui/ statics, a second Presenter
│   ├── paths.ts              # the three layers of paths: home, project, working folder
│   ├── wizard.ts             # the first-launch wizard: language, provider, key, profile, scaffolding
│   ├── orchestrator.ts       # the moderator: who answers and what to focus on
│   ├── manager.ts            # the war-room manager: config, prompt, actions (team/chat/session/tool/project)
│   ├── agents.ts             # loading agents.json
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
│       ├── images.ts         #   image providers: openai-images, mock-images
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
