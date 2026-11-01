# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/). Starting with
0.0.10 the public API and the contracts — the operations (text commands and
their rpc names), the file formats of the home and the serve WebSocket
protocol — are stable and follow semver: breaking changes land only in a major
version. Before 0.0.10 the interface was still stabilizing, so no
compatibility is promised across earlier versions.

## [Unreleased]

### Added

- **Plan quotas: an optional `quota()` in the provider contract, the
  `zai-coding-plan` adapter and a quota indicator next to the context bar in
  both shells.** `LLMProvider` gains an optional `quota()` returning a
  `ProviderQuota` — the plan name plus limit windows (a stable key like `5h` /
  `week` / `mcp`, the kind — tokens/credits/calls/time, `usedPercent` as
  *used*, optional `limit`/`remaining` and `resetAt`); the method's absence is
  the contract's way to say «this provider has no limits», and a failed fetch
  never reaches the UI — it degrades to `null`. A universal consumer
  (`src/core/quota.ts`) caches snapshots by provider id — a 60-second TTL, a
  ten-minute stale grace, in-flight dedup — so neither shell hammers the API.
  The new `zai-coding-plan` adapter speaks the coding plan's Anthropic-style
  GLM endpoint (its own default `https://api.z.ai/api/anthropic`) and reads
  the plan limits from a Z.ai monitor endpoint (Bearer first, a bare key on a
  401; the endpoint is not documented by Z.AI and may change — every
  unexpected answer degrades to «no data»). The scaffold `glm.json` card
  switches to the new provider, and `anthropic-compatible` gains a `thinking`
  switch (`enabled`/`disabled` → GLM's `{thinking: {type}}` body field). Both
  status bars show the limits as `Q 5ч 97% · нед 81% · mcp 100%` — the
  remainder of each window, green/yellow/red like the context bar; the web
  GUI receives the default model's quota inside the state snapshot (no new
  rpc) with a resets-at tooltip. `mock` carries a demo quota for the GUI
  probe. New probe: `npm run probe:quota` (hermetic: window mapping, auth
  fallback, transport, TTL/stale).

- **Card forms in the web GUI follow the provider contracts.** The model form
  is no longer a fixed four-field stub: a `model.get` rpc hands the browser
  the card (secrets masked — an empty key field means «don't change») plus a
  schema built from the provider's contract, so an openai-compatible model
  shows all nine fields (baseUrl, model, apiKey, maxTokens, temperature,
  thinking, reasoning, vision, extra), anthropic-compatible — seven,
  gigachat — twelve, mock — four; a custom adapter without a contract gets a
  five-field universal fallback. Real field types arrived with the schema:
  a boolean renders as a checkbox, an object as a JSON textarea (a parse
  error is shown in the form and nothing is saved), enums as selects,
  secrets as password inputs — and the card lands on disk with real JSON
  types (`vision: true`, `extra` as an object). The agent form grew four
  fields of its own — `model.thinking`, `model.reasoning`, `vision.id` and
  `image.id` (a model id from `models/`, checked by the server) — and
  sighted models are marked with a ◉ in the sidebar. The CLI counterpart
  `/model get <id>` prints the full card.

- **Project settings dialog in the web GUI.** The current project's
  right-click menu gets one «Настройки проекта…» item instead of the rename
  and change-folder forms. The dialog edits the name and the working folder
  (the folder comes from a built-in path browser — 🏠 home, ↑ up, Windows
  drives, subfolder list, «pick» — because a native folder picker cannot
  hand an absolute path to the page) and manages the project registries:
  hosts, mailboxes and messenger bots, each with add / edit / delete forms.
  Secrets never reach the browser — the state lists «password is set 🔑»
  marks instead; the `fs.dirs` listing rpc (subfolders of a directory) backs
  the path browser and is intentionally not an operation: it is service
  transport like `state`, so `/help` and the manager's hints stay clean.

- **The manager manages model cards.** "Make the model see images" now lands
  with the manager himself: three new actions — `model.new`, `model.update`
  and `model.delete`, the same executors as `/model new|update|delete`
  (the provider contract validates the card; the main, service and manager
  cards are protected from deletion; the model map reloads immediately).
  The negotiation-room state now lists the house models — id, provider,
  the vision flag, the main/manager card marked — so the manager knows the
  ids without being told.

- **Chat messages render Markdown.** Replies and user messages are formatted
  as markdown: paragraphs, **bold**/*italic*, headings, ordered and unordered
  lists, `inline code`, fenced code blocks, quotes, tables, rules and links
  (external links open in a new tab). Raw HTML in a reply is shown literally,
  not executed. The markdown parser trims block content, so the leading and
  trailing blank lines and stray whitespace that the old span wrappers used
  to paint inside bubbles are gone. A `[file.ext]` label keeps working as a
  file link (click to open · Ctrl+click to save · right-click menu), also
  inside markdown text, and never fires in code blocks or in ordinary
  `[text](url)` links. The streaming preview is formatted the same way.

- **Adaptive mobile layout for the web GUI.** Below a viewport width of 820 px
  the sidebar becomes a slide-in drawer: a ☰ button in the top bar toggles it,
  the backdrop closes it, and picking a section (a conversation, a project, an
  agent) closes it automatically. The drawer rows answer long-press with the
  same context menu as a right-click. The layout itself is reworked for
  touch: the top bar and status bar wrap, paddings shrink, buttons get larger
  touch targets, inputs are 16 px so iOS Safari does not zoom in on focus,
  `100dvh` keeps the chat within the visible screen, and double-tap zoom is
  suppressed on buttons. Desktop rendering is unchanged.

- **The interface language in the web GUI is a selector.** The ⚙ settings
  form no longer asks to type a locale id: the «Язык интерфейса» field is now
  a dropdown fed by the server (`state.ui.languages` — the same
  `knownLanguages` list the first-launch wizard uses): the built-in
  `ru`/`en`/`zh` plus every own language from `~/.dreamteam/lang/`, options
  reading `id — name`, own languages marked «(свой)». Picking one and saving
  applies it on the fly — the next state carries the new dictionary. With an
  older server that doesn't list languages the field falls back to plain
  text. The conversation-language field stays free text.

- **Usage stats in the web GUI.** The right-click menu of a conversation gets
  a «Статистика» item — that session's token totals (rounds, input/output,
  prompt-cache hit) with a per-model breakdown — and a model's menu gets the
  same totals summed across all sessions of the home. The report opens in a
  read-only modal. The numbers ride the regular state snapshot (SessionMeta
  now carries the session's usage and its per-model slice, and the store was
  already reading the session files whole), so no new rpc is needed — and
  they are the same figures `/usage` prints in the terminal.

- **Context fill indicator and threshold-based compression.** Model cards
  gained an optional `contextWindow` — a contract field on every adapter, so
  it appears in the web card form, the card validation and `/model get` by
  itself. Each session now remembers how full its context is: the last
  round's prompt + answer tokens (`contextTokens`) and the model that
  reported them (`contextModel`). Both shells show it in the same format, as
  visible text — a 10-cell bar, the percent and the exact numbers:
  `[++++------] 27% · 34k / 128k`. The TUI status bar grew to four lines
  (session title, keys, context, status — the spinner still owns only the
  bottom line, so the bar never blinks); the web shell draws the same line
  under the input with the exact numbers in the tooltip. Colors follow the
  new `compressThreshold` setting (an integer from 10 to 99, 85 by default):
  green up to 15 points below the line, yellow closer, red from it. `/usage`
  appends a "Context: 34 112 of 128 000 (27%)" line when the window is
  known, `/models` marks such cards with a "window 128k" suffix. Compression
  learned a second trigger: as soon as the fill crosses the threshold against
  the smallest `contextWindow` among the conversation's models, old messages
  roll up into a digest before the next round — even before the old
  ~24-messages counter fires. Without `contextWindow` in the cards
  everything works as before; KEEP_RECENT and "nothing to compress" guard
  the threshold trigger too. The indicator appears after the first round
  (mock synthesizes usage, so it shows up immediately there).

### Changed

- **The context indicator got a real bar.** The terminal's `[++++------]`
  fills with block characters — `[██████░░░░] 27% · 34k / 128k`; in the web
  GUI the context line and the quota line merged into one flex status row
  under the input, and the ASCII bar became a CSS scale — a rounded track
  with a fill that inherits the segment's color (green/yellow/red), one
  meter per quota window.

- **Settings export/import moved into the settings dialog.** The toolbar's
  ⬇⚙/⬆⚙ buttons are gone; the ⚙ settings form now carries a row of two
  labeled buttons — «⬇ экспорт настроек» (a zip with settings, profile,
  manager and models, no projects) and «⬆ импорт настроек» (projects
  untouched). Importing from the dialog closes it first: the form fields
  hold a copy of the values from the moment the dialog opened, so a
  «Сохранить» afterwards would silently roll the import back.

- **An empty conversation language follows the interface language.** With no
  `language` field in settings.json the team now speaks whatever the interface
  speaks: `ru` maps to «русский», `en` to english, `zh` to 中文, and a custom
  language from `~/.dreamteam/lang/` contributes its own name ("Deutsch").
  The fallback lives in the core — the same in the terminal and in the
  browser — and an explicit `language` still wins. The settings scaffold no
  longer pins «русский», so the wizard's single language choice decides both
  the interface and the team's tongue. The manager's greeting prompt re-reads
  the language now too (before, it stayed Russian until the first real round),
  and the web settings form shows the empty field with an "empty — follows the
  UI language" placeholder instead of pretending a value is set.

- **Attached files stay attachment chips in the sent message.** Attachments
  used to be encoded as `[name.ext]` text markers glued to the front of the
  message, so in the feed they rendered as ordinary inline file links,
  indistinguishable from a file mentioned mid-sentence. The attachment list
  now travels as a structured field on the user message (through the engine
  and the state snapshot; the transcript and the LLM context keep the text
  markers), and the feed renders each attachment as a pill chip above the
  user bubble — click opens, Ctrl+click downloads, right-click gives the
  same menu as before. The leading `[name]` markers are hidden from the
  displayed text, while manually written `[file]` references inside the
  text remain inline links. Older messages without the field render as
  they always did.

- **Web GUI composer.** The input area is now a single rounded bubble
  (8 px radius): the textarea on top, an attachment toolbar below it —
  📎 upload and 🔗 attach-by-path on the left, a round accent send button
  with an up arrow on the right. Staged-file chips sit inside the bubble,
  and focus highlights the whole composer instead of the bare field. The
  field itself rests at two rows while empty, grows with the text up to
  the `maxInputRows` cap and scrolls past it. Enter/Shift+Enter and the
  @// hints are unchanged.

### Fixed

- **Usage from the anthropic-compatible stream reaches the context indicator.**
  GLM on z.ai reports the real token counts in `message_delta` and zeros in
  `message_start` (Anthropic puts input tokens in `message_start` and only the
  cumulative output in `message_delta`) — the adapter now reads both places.
  `promptTokens` also counts cache reads and cache writes in, like OpenAI's
  `prompt_tokens` does: `input_tokens` alone excludes them, so with prompt
  caching on (the default) the context bar and the auto-compression threshold
  saw a nearly empty context. `cachedTokens` keeps its meaning — cache reads,
  for the /usage hit stats.

- **`agent update` silently dropped `vision` and `image`.** The manager's
  updatable-field whitelist never listed them, and unknown keys are skipped
  without a word — so «помни скриншоты» set nothing, be it the GUI form, the
  word or the manager himself. Both are whitelisted now: a string becomes a
  `{id}` reference, an unknown model id is rejected loudly, an empty string
  removes the reference.

- **Saving a web-GUI form crashed on an edited number field.** Vue's
  `v-model` on `<input type="number">` casts the typed value to a number,
  and the modal submit handler called `.trim()` on every field value — the
  thrown TypeError was swallowed by Vue's error logging, so the form
  silently stayed open and nothing was saved (the temperature and
  max-tokens fields of the model and agent forms were affected). The
  handler now stringifies field values before trimming.

- **Host passwords leaked into the web GUI state.** The project projection in
  `state` copied the hosts registry raw, so every connected browser received
  the passwords in plain text. The projection now masks secrets: hosts,
  mailboxes and bots are listed with `hasPassword`/`hasToken` flags instead
  of the values (the registries were not sent to the GUI at all before —
  only hosts were, with passwords).

- **`/model update id vision=true` rejected `true` as a string.** The
  `field=value` parser only typed `temperature`/`maxTokens` as numbers, so a
  boolean like `vision` arrived as the string `"true"` and failed the
  provider-contract check («параметр "vision" — true или false»). The card
  validator now coerces values by the contract key's type — `"true"`/`"false"`
  to booleans, numeric strings to numbers — so `/model new|update`, the GUI
  rpc and the manager's JSON actions all accept string-typed values, while a
  numeric `apiKey` stays a string. Non-coercible junk still fails loudly, and
  the card file is written with real JSON types.

- **User messages rendered a bubble inside a bubble.** The text renderer put
  a `txt` class on the inner spans it generates, and the user-message styles
  match descendants — so the nested span got the same background, border and
  padding as the outer container. The class is dropped from the generated
  spans (nothing referenced it — styles for messages key off the container
  only), for agent messages as well, where it had no styling.

- **The empty input field started several rows tall.** Chromium counts the
  wrapped placeholder text in a textarea's `scrollHeight`, and the autosize
  run that fires when settings arrive sized the empty field after that
  inflated measurement — with the long hint line the composer opened two or
  three rows high. The empty field is now sized directly to its two-row
  minimum; `scrollHeight` is only consulted when there is text to measure.

- **Three mobile-drawer defects.** The long-press context menu only stayed
  open while the finger was down — the browser's synthetic click after
  `touchend` landed on the overlay and closed it at once; that click is now
  suppressed, so the menu survives the lift and its items can be tapped.
  Tapping an agent row (call into the chat, recall) closed the drawer after
  every tap; the drawer now closes only when the chat content actually
  switches — a conversation or a project is picked. And a modal form opened
  from the drawer (e.g. editing an agent) hid beneath it: the modal's z-index
  is now 60, above the drawer's 40. Also: context-menu items get touch-sized
  padding, and text selection is disabled in the drawer so a long press does
  not start a selection on Android.

## [0.0.13] — 2026-10-31

### Added

- **Big files: streaming upload and attach-by-path.** Files picked with 📎 now
  go to the project inbox over a streaming `POST /api/upload` — the size is
  bounded by the disk, not by the WebSocket message limit (the old base64-over-
  WS path topped out around 70 MiB). A 🔗 button stages a file that is already
  on the server by its path (absolute, or relative to the project working
  folder): `serve` copies it into the inbox without any transfer through the
  browser — the way to hand over a huge file when the app runs on a server and
  the GUI is just a web frontend. `/api/file` streams its responses instead of
  reading the whole file into memory.

- **`maxInputRows` — the visible height of the input field, shared by both
  shells.** An integer from 1 to 20 (8 by default) in `settings.json`; also
  editable in the web GUI settings form. In the TUI it is the window of visible
  input lines stuck to the cursor; in the web shell the textarea grows up to
  the same limit instead of the hard-coded 160 px.

### Changed

- **Core notices render inside the chat flow in the web GUI** — as dim
  service blocks between the replies, in chronological order, the way the TUI
  prints them into its chat panel (they used to collect in a detached journal
  block below the message list). Errors are inline too, in red. The journal
  clears when another session is opened and is capped at the last 400 entries.

- **Multiline input in the full-screen TUI.** **Ctrl+Enter** / **Alt+Enter**
  insert a line break inside the input field instead of the stepwise `… `
  continuation, and multiline pastes keep line breaks instead of gluing them
  into spaces; **Enter** sends the whole message with all its breaks. The
  cursor walks the input lines — **↑/↓** move within the typed text and step
  over to the message history / the draft at the edges. The stepwise
  `\` + Enter / `…` flow remains in the linear readline mode
  (`"screen": false`).

- **Full-screen layout: the input field sits right under the chat panel, the
  status bar moved to the bottom edge.** The status bar is three lines —
  `[session title]` (truncated to 24 characters, `[no project]` when there is
  none), the keys line (`@name or !name — to a member · Esc — abort the round ·
  /exit — quit · /help — commands`) and the status line (the spinner, `y/n`,
  the scroll counter). Two empty lines sit between the chat panel and the
  input, and two more between the input and the status bar. The command and
  `@mentions` popup opens below the input line, over the gap and the status
  bar — it no longer covers chat history.

- **The input prompt is just `Ты > `** — the `[session title]` prefix moved to
  the status bar (see above).

- **An agent's reply is printed with its header on a separate line** and the
  text starting on the next one; between replies there is exactly one empty
  line (previously the header and the text shared a line).

- **The launch banner is short.** A frame with the name, a
  "version · home · project" line, the mode (`TUI`; `Server` for
  `dreamteam serve`) with the web shell address
  (`dreamteam serve → http://127.0.0.1:8080` — also shown by `/help`), and the
  tail `/project — проект · /session — разговор`. The team and model listings
  are gone from the banner — see `/agents` and `/models`; the `serve` startup
  output gained a `режим: Server` line.

### Fixed

- **📎 in the web GUI no longer sends a message right away.** Picked files
  stack as chips above the input field (several at once, removable) and go out
  together with the next message: the server puts them into the project inbox
  without starting a round, the text of the message gets `[name]` prefixes,
  and `/api/file` also serves attachments from the inbox — the links in the
  sent message open.

- **Attachments and imports larger than 32 KiB no longer arrive truncated.**
  The GUI read files into base64 in 0x8000-byte chunks — a chunk is not a
  multiple of 3, so every chunk's base64 ended with `=` padding, and the
  server's decoder stopped at the first one: any file over 32 KiB landed in
  the project inbox (and in home/project/session imports) cut to exactly
  32768 bytes. Encoding is now done by the browser in one `readAsDataURL`
  call — files of any size arrive whole.

- **A file link in a chat message opens the file; saving is a separate
  action.** `/api/file` now sends a real content type for things the browser
  can display (images, PDF, text) with `content-disposition: inline` — a
  click opens the file in a new tab instead of popping the save dialog
  (unknown types still download). Ctrl+click (⌘+click) saves a displayed
  file, and right-click on a link opens the shell's own menu with
  «Open»/«Save» — the in-app browser does not show a native menu of its own.

## [0.0.12] — 2026-10-29

### Breaking

- **The manager's tool action is renamed and split.** The single undocumented
  `tool.grant` action is gone from the manager protocol; it is replaced by the
  trio `agent.tool.add` / `agent.tool.update` / `agent.tool.delete` — the same
  operations the text commands and the GUI rpc use, so the manager can now
  also **disable** a tool (and reconfigure its card), not only grant it. The
  known manager operations grew from 16 to 18; the human commands were not
  renamed. Old `tool.grant` actions in saved manager histories are simply
  rejected by the new protocol — no shims, as in 0.0.9.

### Added

- **House tools: the `/tools` group next to `/agent tool …`.** `/tools` lists
  every tool of the house — the built-ins and the own ones from `tools/`,
  each with its description and who has it enabled; `/tools <tool>` shows the
  tool's card. A custom tool gets a house card `tools/<id>.json` with a
  reserved `description` field — what the tool is for, shown by `/tools` and
  read by the manager. New operations: `tools.list` (implicit), `tool.new <id>`
  (a hello-world template `tools/<id>.ts` plus the card), `tool.update <tool>
  field=value…` (the card), `tool.delete <tool…|all>` (file + card; enabled
  agents lose the tool; built-ins cannot be deleted). Built-in ids are now a
  single source (`BUILTIN_TOOL_IDS`): `files, shell, git, arch, ssh, look,
  image, docs, ocr, web, mail, telegram, max`.
- **The first-run wizard speaks keyboard and reuses existing models.** Every
  choice is a list navigated with ↑/↓, PgUp/PgDn, Home/End and Enter (a real
  terminal; without one — the same list as numbers or text). The model step
  first offers the cards already in `models/` (id — provider · model · baseUrl),
  with «create a new model» as a separate last item — a new card is no longer
  forced on an existing setup.
- **GUI comfort:** thin themed scrollbars everywhere; the input textarea grows
  with its content up to 160 px and only then scrolls; the sidebar width is
  draggable by its edge (280–640 px, remembered in localStorage); user
  messages align right; Escape closes the sidebar context menu.
- **A grammar guard in `check-i18n`.** Every `/xxx` token inside a dictionary
  key must be a known operation group from the manifest (or one of the special
  commands and whitelisted non-commands); an unknown one fails the check hard.
  The dead keys of the pre-0.0.9 grammar this uncovered (`/team …`, `/messenger
  …`, «при следующем /new.» and friends) are removed from en/zh.
- **The models: a lighter CPU vision pair.** New `qwen3-vl-2b` (vision, CPU,
  port 8000, ~3 GB RAM; ollama: 1.9 GB) joins `qwen3-vl-8b` (vision, vLLM,
  port moved to 8001, ~20 GB VRAM; ollama: 6.2 GB) in `docker/compose.yaml`;
  the retired `qwen2-vl-2b`, `qwen2.5-vl-7b` and `qwen3-vl-4b` profiles and
  scaffold cards are removed. The creative trio keeps pointing at the lightest
  CPU pair out of the factory.
- (previous work, kept) **The «Edit» forms are generated from the card
  schemas.** A new core
  module `card-schema.ts` declares, per home card (agent, model, session,
  project), the editable fields with their kinds — string, text, number,
  enum, password — and paths (`model.temperature` for the nested ones); the
  compiler checks the paths against the interfaces. `serve` ships the
  schemas in the state snapshot, so the GUI builds the «Edit» forms of the
  agent (full scalar set + model.* + tools), the model, the session and the
  project from them instead of a hardcoded couple of fields: text areas for
  prompts, selects for colors, masked inputs for API keys (empty = keep),
  numbers parsed as numbers, `model.*` merged into the agent's current
  model reference. The full agent card travels on demand: rpc `agent.get`
  (and the matching `/agent get` operation) return it; `agent.update` now
  also accepts `workspace`.
- **The manager sees the house tool registry and the app version.** The
  manager's state now carries a «Тулы дома» block — built-ins and the custom
  `tools/*.ts` shelf, each with a short description — and a «Приложение:
  dreamteam …» line. «Кто может собрать xlsx из csv?» is answerable from the
  registry, and a tool grant follows without asking the human for the exact
  file name. The built-in list in the manager prompt is derived from the
  registry (`BUILTIN_TOOL_DESCS`), so the two can no longer drift — they had:
  the prompt named 7 of the 13 built-ins.

### Fixed

- `/project open` and `/project new` printed the project line twice in the
  feed — the «Проект: …» notice and the «✓ Проект: …» operation reply carried
  the same information. The interactive commands now return only the reply
  (plus «Открыт разговор …»); the notice stays for the startup paths that
  have no reply to show.
- The commands the engine accepts outside the registry — `/help`, `/exit`,
  `/quit`, `/q` — were missing from the completion hints of both the terminal
  and the GUI (typing `/q` even answered «нет такой команды — см. /help»).
  They now come from the same core list as the registry operations, so the
  terminal panel, Tab completion and the GUI command hints all show them.

## [0.0.11] — 2026-10-27

### Fixed

- Russian strings decline the word «тул» (tool) correctly: the nominative
  plural is «тулы» everywhere «тула» stood wrongly («тулы не собраны»,
  «какие тулы включены», «все тулы», «встроенные тулы», «Свои тулы»…), the
  absent-tools line is «тулов нет», and a Latin "e" inside «в туле» is gone.
  The matching keys in the en/zh dictionaries are updated in lockstep, so the
  lines keep translating; the README (ru) follows the same declension.

### Added

- **Markdown as the rich interchange of the docs tool.** The `write` and
  `append` bodies are now interpreted as markdown — headings `#`–`######`,
  bold/italic/strike, inline code and links, nested lists, quotes, code
  fences, tables with alignment, a `---` rule (a literal asterisk is `\*`; a
  line break inside a paragraph is a line break). The new `docs md <file>`
  subcommand returns a document as markdown: docx (mammoth → html → md) and
  odt keep headings, emphasis, lists and tables; xlsx/ods sheets become
  `# name` + a table each (symmetric with building them back); pdf yields its
  text layer. Honest limits (skipped images, skipped non-table blocks) come
  back in the answer's notes. Contracts 0.0.10 are untouched — the tool's
  input semantics are not part of the declared contracts (see Changed).
- **A single rich pdf renderer.** All pdf paths go through one layout:
  heading scale with spacing, justified paragraphs with leading, manual
  nested lists, italic quotes with a gray bar, code on gray plates, tables as
  aligned mono columns with a header rule. Fonts: bold/italic/bold-italic/mono
  are looked up next to the configured regular (arial/calibri/DejaVu
  variants; a missing style falls back to regular).
- **Native docx→pdf fallback**: `convert pdf файл.docx` without the soffice
  bridge no longer refuses — it goes docx → markdown → the pdf renderer and
  says so in the report (the bridge, when up, still produces the full
  formatting).

### Changed

- **`docs write`/`append` semantics**: the body is always markdown now
  (before: plain lines — docx paragraphs, an xlsx markdown/TSV/CSV table).
  Plain text still lands as plain paragraphs; `*` must be escaped as `\*`.
  The xlsx builder keeps its fallback: a body without md tables is parsed as
  one markdown/TSV/CSV table as before. Declared here because scripts may
  rely on the old literal reading; the 0.0.10 contracts (operations, home
  formats, serve protocol) are unaffected.
- The `append` report counts lines (`✓ дописано строк: N`), matching the
  visual lines of the markdown blocks.

### Fixed

- Writing odt/ods through the soffice bridge: the produced file stayed in the
  OS temp dir and the write would fail with ENOENT — the file is now copied
  next to the source (the path was never exercised while the bridge was
  absent; the refusal path was).
- The stale README docs sections no longer promise txt/html/rtf reads and
  `.md`/`.html`/`.json` writes that the tool never did.

### Removed

- The superseded single-style writers `writeDocx`, `writePdf`, `writeXlsx`,
  `appendDocx` and `writeOdfViaSoffice` from `documents.ts` — the markdown
  renderers in `documents-md.ts` cover them (the odf one also carried the
  temp-dir bug fixed above).

### Added

- **The API and the contracts are stable as of 0.0.10** and will be supported:
  the operations (slash commands and the same-named rpc methods), the home
  file formats and the serve protocol; breaking changes are reserved for
  major versions. Earlier releases promised no compatibility — the interface
  was still stabilizing. Declared at the top of every README.

### Fixed

- e2e probes dump their raw output to the OS temp dir instead of hardcoded
  `C:\tmp`/`/tmp` paths; with the whole e2e job green on runners, its
  `continue-on-error` scaffold is dropped — e2e is a hard gate again.

### Changed

- **xlsx engine replaced**: reading — `read-excel-file`, writing —
  `write-excel-file` (instead of the frozen `exceljs` with its deprecated
  transitive tree). Readings are pinned by a new golden-master probe on real
  documents (`npm run probe:data`); honest contract changes: a merged cell's
  value lives only in its master cell (exceljs multiplied it across the whole
  merge span), and trailing never-filled columns are dropped — row width is
  the content width, not the sheet's styled width.
- **html parsing in the `web` tool**: `cheerio` replaced by `jsdom`, which was
  already in the dependency tree for `@mozilla/readability` (kills the
  `whatwg-encoding` deprecation chain). Behavior is unchanged.
- **Node.js ≥ 22** (24 LTS recommended and used in CI); `@types/node` ^24.
- Dependencies refreshed (`docx` 9.15 and others); the install tree shrinks
  from 358 to 227 packages with zero vulnerabilities.

### Removed

- `exceljs` and `cheerio` — together they pulled all seven deprecated
  transitive packages (`glob`, `inflight`, `rimraf`, `fstream`,
  `lodash.isequal`, `whatwg-encoding`, `uuid@8`); a global install is now
  warning-free.

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
