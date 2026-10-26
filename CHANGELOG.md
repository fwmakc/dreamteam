# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
semver while pre-1.0 (breaking changes may land in minors).

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
