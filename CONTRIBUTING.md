# Contributing

Languages: [English](CONTRIBUTING.md) · the repo docs also exist in Russian
(`README.ru.md`) and Chinese (`README.zh.md`) — issues and PRs are welcome in
English or Russian.

## Development setup

```bash
git clone https://github.com/fwmakc/dreamteam
cd dreamteam
npm install
npm run build:gui   # web shell for `dreamteam serve`
npm run typecheck   # src + tests
npm run probe       # all hermetic probes (~1-2 min)
```

Run the app from the clone with `npm run dev` (TUI) or `npm run serve` (web).
Point the data layers away from your real home with `DT_HOME`/`DT_PROJECT`
environment variables — the probes do this automatically.

## Ground rules

- **Hermetic changes.** Never touch a real `~/.dreamteam` from tests or probes —
  always redirect the layers into temp folders (`DT_HOME`/`DT_PROJECT`).
- **Fail fast, loudly.** Broken configs crash with a clear error mentioning the
  file; no silent fallbacks, no silently ignored unknown fields.
- **Canonical operations.** Anything the manager (LLM) can change must also
  exist as a manifest operation in `src/core/operations.ts` — one name, three
  surfaces: `/command`, rpc method, `/help` + completion.
- **One core, two shells.** Terminal (`src/index.ts`) and web (`src/serve.ts`)
  are Presenters over `src/core/engine.ts`; shell-specific code stays out of
  the core.
- **Secrets live in data files, not code.** Provider keys in
  `providers.json`, machine settings in `~/.dreamteam/.env`; never in agent
  cards, never in the repo.

## UI strings and i18n

Source strings are **Russian**. Wrap user-facing strings in `t()` (plain) or
`tf()` (with `{placeholders}`); add translations to `src/locales/en.ts` and
`src/locales/zh.ts` — both dictionaries must cover exactly the same key set.

Deliberately **not** translated: LLM-facing prompts, command argument names
(syntax), config diagnostics (the fail-fast layer), tool outputs/gates.

A probe guards this: `npm run probe:i18n`.

## Git workflow

- `main` is the stable branch. Feature work goes into short-lived branches and
  lands via PR; the maintainer may push small, verified changes directly.
- CI runs typecheck, `build:gui` and the full probe suite on every push and PR
  (Ubuntu + Windows, Node 22). A red `ci` check blocks a merge; keep local
  `npm run probe` green before pushing.

### Commit messages

Follow the existing style — a short **Russian one-line subject** describing the
behavior, not the file list:

```
Смена проекта не выходя из приложения: /project open/add/remove, реестр projects.json в доме
Перенос дома: разговоры действительно едут в архиве
```

No conventional-commit prefixes; the subject is the changelog line.

### Versions and releases

```bash
npm version 0.0.x --no-git-tag-version   # package.json + package-lock.json
git add package.json package-lock.json && git commit -m "Версия 0.0.x" && git push
npm publish                              # prepublishOnly: typecheck + build:gui
```

`gui-dist/` is gitignored but must ship — `prepublishOnly` rebuilds it before
packing. Check what goes out with `npm publish --dry-run`.

## Probes

No test framework: every file in `tests/probe-*.ts` runs directly via tsx,
prints `ok`/`FAIL` per check and exits non-zero on failure. All probes are
hermetic (temp layers, mock provider, local stub servers). `npm run probe`
is the main gate; `probe:e2e`/`probe:tui` additionally need `node-pty`.

When fixing a bug, add a probe case first when practical.

## Issues

Bug reports: OS, `node -v`, `dreamteam -v`, adapter, shell (TUI/serve), steps —
and never API keys or `.env` contents. Feature ideas: the use case first, then
the proposed behavior.
