**0.0.7** — Layout v2: model cards + agent cards + adapter contracts.

### Breaking
- `providers.json` → `models/` folder (one .json per model)
- `agents.json` → `agents/` folder (one .json per agent)
- `settings.json` gains `"model"` (default model reference)
- `manager.json`: `"provider"` → `"model"`
- `/provider` → `/model`; agent field `"provider"` → `"model"`
- Per-adapter contracts: required keys → loud error at startup

### Added
- `ModelRef` overrides in agent/tool cards
- Custom adapters: `providers/<id>.ts` shelf
- `serviceModel` routing for moderator/naming/compression
- Solo moderator skip (one agent in chat)
- `scripts/check-i18n.mjs`
- 18 scaffold model cards + 5 agent cards

See CHANGELOG.md for full details.
