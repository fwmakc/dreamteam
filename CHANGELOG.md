# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
semver while pre-1.0 (breaking changes may land in minors).

## [0.0.6] — 2026-10-25

### Added

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
