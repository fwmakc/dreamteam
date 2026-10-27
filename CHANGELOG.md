# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
semver while pre-1.0 (breaking changes may land in minors).

## [0.0.10] — 2026-10-27

### Added

- **Several ids at once and `all`** in the id-taking commands: `/session agent
  add <id…|all>` (several members at once; `all` — the whole team) and
  `/session agent delete <id…|all>` (`all` — everyone but the manager),
  `/session delete <id…>`, `/model delete <id…>`, `/project delete <id|path…>`,
  `/agent tool add <id> <tool…>` and `/agent tool delete <id> <tool…|all>`
  (`all` — all the agent's tools), `/project mail delete <id…>`,
  `/project host delete <id…>`, `/schedule toggle <id…>` and
  `/schedule delete <id…>`. Ids are separated by spaces or commas; one bad id
  doesn't sink the rest — it gets its own `✗` line.

### Fixed

- The hint panel, Tab and the web hints know the three-word operations now:
  `/session agent add` used to answer «нет такой команды»; after
  `/session agent ` the panel offers `add` and `delete`, and the exact command
  shows its usage and argument values.
- Schedule task ids no longer collide when two tasks are created within the
  same millisecond.

### Changed

- Launch forms are down to the path: `dreamteam <путь>` (and
  `dreamteam serve <путь>`) open the project of that working folder; the
  `dreamteam open <имя|путь>` and `dreamteam new <имя> [папка]` subcommands are
  gone — working by name stays inside the app (`/project open <имя>`,
  `/project new <имя> [папка]`) and in the web panel.

## [0.0.9] — 2026-10-27

### Breaking

- **One command grammar: operations, ids, `update` with nested fields** — the
  slash-command surface (and with it the rpc names: a text command and its rpc
  method are the same operation from the manifest in `src/core/operations.ts`)
  is reworked. No shims: the old commands are gone.
  - Roster and chats: `/team` → `/agents`; `/team add|update|delete` →
    `/agent new <id> [field=value…]`, `/agent update <id> field=value…`,
    `/agent delete <id…>`; `/team grant <agent> <tool>` →
    `/agent tool add <agent> <tool>` next to `/agent tool update|delete` and
    the `/agent tools <id>` overview; `/chat add|remove <name|number>` →
    `/session agent add|delete <id>`, `/session agents` shows who is in and
    who can be called.
  - Sessions: `/session open|delete` and `@session` take the session **id**
    (list numbers are gone); new `/session close`; `/session rename` →
    `/session update [title=…]` (no fields — the manager invents a name from
    the digest); `/session history [from] [to]` is a slice, inclusive (one
    argument — from N to the end); `/session export` archives the current
    session only, as `session-<project>-<session>-<stamp>.zip`.
  - Models: `/model add` → `/model new <id> field=value…`; `/model set` is
    gone — switching a model is an owner's field, not a command:
    `/settings update model.id=…` (the agents' default), `/agent update <id>
    model.id=… model.temperature=…`, `/manager update model.id=…`.
  - `field=value` pairs learned dotted paths: `/settings set` and
    `/manager set` → `/settings update` / `/manager update` (nested
    `model.id=`, `serviceModel.id=`, `model.temperature=`), and
    `/profile set "Name; role; about"` → `/profile update name=… role=…
    about=…`.
  - Home transfer: `/home export|import` → `/export` and `/import <file.zip>`
    — the whole home as `home-<stamp>.zip`; `/settings export|import` stay.
  - Projects: `/project rename <name>` and `/project path <folder>` →
    `/project update name=… | path=…`; `/project remove` → `/project delete`;
    new `/project close` — the honest projectless state (the current project
    refuses `delete` until closed). The secrets moved under the project:
    `/mail …` → `/project mail add|update|delete <id> field=value…`, same for
    `host` and `messenger`; `/project mails|hosts|messengers` are the lists,
    `add` creates an empty entry, `update` fills it (`user= password= imap=
    smtp=…` / `host= user= password= dir= port=` / `token=…`).
  - The id mask (lowercase latin/digits, `. - _` inside) now covers sessions
    and secret entries; old free-form entries still load, new ones need the
    mask.
  - State rules everywhere: `new` always opens (create + open); the lists
    (`/sessions`, `/agents`, `/models`, `/projects`) work with nothing open;
    commands about "the current one" refuse with a hint when there is none.
    Completion and the GUI panels speak ids everywhere. (The manager's JSON
    action protocol — `team.add`, `chat.add`, `session.rename`, `tool.grant`,
    `mail.add`… — is untouched: it is the manager's internal vocabulary, not
    commands.)
- **Card field `adapter` renamed to `provider`** — `models/<id>.json` now reads
  `{"provider": "openai-compatible", …}`. No compatibility shim: a card still
  carrying `adapter` fails the regular validation — «не указан "provider"» or
  «неизвестный параметр "adapter"», same as any other stale key. `/model
  new|update` and the wizard/GUI forms take `provider=` too.
- **Provider `anthropic` renamed to `anthropic-compatible`** — symmetry with
  `openai-compatible`. The old name is gone: a card with
  `"provider": "anthropic"` fails with «провайдер „anthropic“ неизвестен».
  Rename the field and the value in `models/<id>.json`.

### Fixed

- **Startup crash on vision model cards** — the registry reads the `vision`
  flag from every card, but the `openai-compatible` contract didn't declare
  it, so shipped cards (`glm-vision`, Qwen-VL…) failed validation with
  «неизвестный параметр "vision"». The flag is now a declared key of the
  `openai-compatible`, `anthropic-compatible` and `gigachat` contracts.
- **Ids may contain dots** — the id masks allowed letters/digits/-/_ while
  names are full of dots: the shipped `qwen2.5-vl-7b.json` failed to load with
  «id модели: строчные буквы…». One shared mask in `src/ids.ts` now covers
  agents, tools, models and custom adapters; a dot is legal inside
  (`qwen2.5-vl-7b`, `pdf.export`) but not at the edges and not doubled — ids
  end up in file names, and Windows forbids trailing dots. `/agent new` used to
  accept uppercase ids its own loader then rejected — now it enforces the same
  mask the loader reads with. Tool names are escaped when ```fence kinds are
  compiled into the action parser's regex.
- Stale layout-v1 leftovers: «впиши ключ… в providers.json» in anthropic and
  gigachat key errors, comments and env.example pointing at providers.json,
  `apiKeyEnv` in docker/README.md — now the card `models/<id>.json` and the
  `apiKey` field.

### Added

- **Honest "nothing open" state and the usage filter** — `/session close` and
  `/project close` park the app with nothing open (lists keep working);
  `/usage [model id]` filters token spend by model; `/session agents` shows
  the current roster and who can be called.
- **Launch with a project from the command line** — the same words as in the
  conversation now work at start: `dreamteam <путь>` (sugar for open; `dreamteam
  .` opens the current folder's project, an unknown folder registers itself),
  `dreamteam open <имя|путь>`, `dreamteam new <имя> [папка]`; `serve` takes the
  same forms (`dreamteam serve .`). Bare `dreamteam` still starts projectless.
  Malformed forms fail fast before the app (and the wizard) loads; `.`/`..` are
  now also accepted as paths by `/project open`.
- **Ready tokenized link for `serve`** — the startup banner prints
  `открыть с токеном: http://адрес/?token=…`, and `serve --open` opens that
  link. The web shell picks the token up from the URL, stores it in the
  browser and strips it from the address bar, so the auth form is only for
  the case when the link is not at hand. The banner also states the real
  auth state for a network-exposed HOST (по токену / без авторизации).
- `npm run probe:models` (also in the `probe` chain) — loads every scaffold
  card through the real registry and asserts the contract holds: keys legal,
  `vision` reaches the model status, no `apiKeyEnv`/`keyEnv` anywhere,
  keyless anthropic/gigachat cards stay a soft «не настроен», not a crash.
- Scaffold cards that take a key (`claude`, `gigachat`, `glm-vision`,
  `openai`) ship with an explicit `"apiKey": ""` — the field is visible in
  edit forms as the place to paste the key; an empty string means «не задан»
  and behaves like an absent field everywhere.

### Changed

- **The tool inbox and the export archives live in the project folder in the
  home** — files attached in the web GUI land in `projects/<id>/inbox/` (they
  used to go to the working folder), and every export zip — `session.export`,
  `project.export`, the whole-home `export`, `settings.export` — lands in
  `projects/<id>/` as well; with no project open, in the home, as before.
  The working folder stays purely the files of work.
- **Mail attachments and generated images join them** — `mail read` saves
  into `projects/<id>/mail/`, the ```image block into `projects/<id>/images/`
  (both used to litter the working folder). One fixed path rule for tools:
  a path with the `inbox/`, `mail/` or `images/` prefix resolves to the
  project's payload folders in the home (look, docs, ocr, image refs, `mail
  send` files:), everything else stays in the working folder. The custom-tool
  SDK gains `ctx.projectHome`, `ctx.workspaceFile(rel)` and
  `ctx.projectFile(rel)` — absolute paths checked against their folder.
  `shell` lets absolute paths into the payload folders (e.g. `cp …\images\x.png .`
  to move a picture into the working folder); `project.json`, `sessions/` and
  the rest of the home stay out of reach.

## [0.0.8] — 2026-10-26

### Breaking

- **Projects move into the app home** — each project is a folder
  `~/.dreamteam/projects/<id>/` with `project.json` (`path` — the working
  folder, `createdAt`, `lastOpened`, plus the secrets: `hosts`, `mails`,
  `messengers`). The registry **is** the folders themselves — `projects.json`
  is gone. Sessions and transcripts live there too.
- **No `.dreamteam` anywhere** — the per-project service folder is gone:
  `hosts.json`/`mails.json`/`messengers.json` are now fields of `project.json`;
  `scaffold/project/` is removed. `DT_PROJECT` is gone — probes isolate with
  `DT_HOME` only.
- **The app starts with no project selected** — you pick one:
  `/project new <name> [folder]` (creates the project and the working folder;
  the folder may not be inside the home) or `/project open <name|path>` — an
  unknown folder registers itself (id = folder name). No auto-migration of old
  `./.dreamteam` data — a clean start.
- **Import/export in exactly four levels** — the whole home
  (`home.export`/`import`), settings only (`settings.export`/`import`, new),
  one project with its conversations (`project.export`/`import`, new) and one
  session (`session.export`/`import`).

### Added

- **Project CRUD** — `/project new|open|rename|path|remove`; the current
  project can't be removed; `remove` deletes `projects/<id>/` wholesale and
  never touches the working folder.
- **GUI**: with no project chosen the "Projects" panel is expanded and comes
  first; the "＋" button creates a project (rpc `project.new`).

### Changed

- **Vanilla `gui/` shell removed** — `serve` always serves the Vue build
  (`gui-dist/`); publishing runs `npm run build:gui` anyway. From a repo clone
  run `npm run build:gui` once — without the build serve explains itself
  instead of silently falling back to the old shell.
- Switching a project or a session now renders the conversation history into
  the TUI panel (as on startup), and the concierge greets after
  `/project new` / `project.open` in an empty session.
- Wizard: home only, no gitignore step. README ×3 + CONTRIBUTING rewritten for
  the folders-as-registry model; `scripts/check-readme.mjs` keeps the three
  READMEs in sync, `scripts/i18n-diff.mjs` harvests `t()`/`tf()` keys against
  `en.ts`.
- Probes rewritten for the new model: `probe-project` (folders instead of a
  registry file), `probe-transfer` (all four levels), no-project start in
  `probe-startup`/`probe-tui`/`probe-scenario-tui`/`probe-api`.

## [0.0.7] — 2026-10-26

### Breaking

- **`providers.json` → `models/` folder** — each model is a card file
  `models/<id>.json` with `{adapter, model, baseUrl, apiKey, maxTokens,
  temperature, thinking, reasoning}`. `settings.json` gains `"model"` (default
  model reference). `manager.json` field `"provider"` → `"model"`.
- **`agents.json` → `agents/` folder** — each agent is a card file
  `agents/<id>.json`. Agent `role` removed (use `description`). Roster is
  alphabetical by id.
- **`/provider` → `/model`** — operations, rpc names, state field, completion
  hints, GUI panel. Agent field `"provider"` → `"model"`.
- Per-adapter **contracts**: required keys → loud error with parameter name and
  file path at startup. Unknown keys → rejected with allowed list.

### Added

- **`ModelRef` overrides** — agent/tool cards can override generation params:
  `"model": {"id": "glm-5-turbo", "temperature": 0.4}`. Card connection fields
  (`baseUrl`, `apiKey`) are NOT overridable — create another model card.
- **Custom adapters** — `~/.dreamteam/providers/<id>.ts` with
  `export default` factory, same as custom tools.
- **serviceModel** — `settings.serviceModel` routes moderator, naming,
  compression and memory to a cheaper model.
- **Solo moderator skip** — with one agent in chat, the moderator LLM call is
  skipped (saves a call per round).
- **`scripts/check-i18n.mjs`** — dictionary completeness check.

### Changed

- Image adapters split file-per-adapter (`openai-images.ts`, `mock-images.ts`).
- First-run wizard asks interface language → adapter → creates `models/<id>.json`.
- Scaffold ships 18 model cards and 5 agent cards in folders.

## [0.0.6] — 2026-10-25

### Added

- **Quick-launch shortcut and `serve --open`** — `dreamteam serve --open` opens
  the web shell in the browser; the first-launch wizard offers to create a
  desktop shortcut that runs exactly that: Windows — `.lnk` (via PowerShell),
  Linux — `.desktop` in the applications menu and on the Desktop, macOS —
  `Dream Team.command`. The launcher script lives in `~/.dreamteam/bin/` with
  absolute paths (no dependence on the desktop session's PATH). New probe:
  `probe-shortcut`.
- **Custom provider adapters** — the same shelf pattern as custom tools: put a
  `~/.dreamteam/providers/<id>.ts` file exporting a `(id, config) => LLMProvider`
  factory and reference it from a provider card with `"adapter": "<id>"`.
  Loaded at startup: a broken file or a name colliding with a built-in adapter
  (including image adapters) fails loudly; the shelf is scaffolded on first
  launch; `/provider add|update` accepts custom adapters and lists them among
  the available ones. New probe: `probe-providers`.

## [0.0.5] — 2026-10-25

### Added

- **Interface languages (i18n):** built-in `ru` / `en` / `zh`, custom languages
  as `~/.dreamteam/lang/<id>.json`. Language is picked at first launch (the
  wizard's first question) and switchable on the fly with
  `/settings set ui=<id>`; the web shell gets the active dictionary in the
  state snapshot and its own language field in settings.
- **Three READMEs:** `README.md` (English, primary), `README.ru.md`,
  `README.zh.md`.
- Project switching without leaving the app: `/project open/add/remove`,
  `projects.json` registry in the home, a "Projects" panel in the GUI, rpc
  parity between TUI and GUI.
- Home transfer for real: conversations travel inside the `/home export`
  archive and merge by id on import.
- Chat events (joined/left) as manager lines in the shared chronology.
- Session autotitles: the manager names a session after the first answer;
  `/session rename`.
- New hermetic probes: `probe-i18n` (dictionaries, external languages, live
  switching), extended `probe-api` (state contract incl. `ui`).

### Changed

- Default interface for fresh installs is English (`scaffold/home/settings.json`
  sets `"ui": "en"`); existing homes keep their settings.
- `settings.json` validates the new `ui` field (non-empty string; unknown ids
  fail loudly at startup).

## Earlier

See the [commit history](https://github.com/fwmakc/dreamteam/commits/main) —
notable milestones: core/shell split with the Presenter interface, the
first-launch wizard and config scaffolding, the war-room manager as the
configuration gateway, tool cards with per-tool `check()` policies (files,
shell, git, arch, ssh, look, image, docs, ocr, web, mail, telegram, max),
`dreamteam serve` with the web shell and WS token auth, commands = rpc
manifest, project switching, home transfer.
