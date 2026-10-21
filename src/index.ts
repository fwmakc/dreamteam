import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { format } from 'node:util';
import pc from 'picocolors';
import { loadTeam } from './agents.js';
import { managerAsAgent } from './manager.js';
import { agentToolIds } from './tools-api.js';
import { loadToolsConfig, type ToolsConfig } from './actions.js';
import { HintPanel, MentionPicker, hintRowsFor, makeCompleter, type CompletionContext } from './completion.js';
import { OPERATIONS, operationArgs, operationCommand } from './core/operations.js';
import { Editor } from './editor.js';
import { Screen } from './screen.js';
// пути всех трёх слоёв (пакет / дом / проект) — только в paths.ts
import { AGENTS_FILE, PROJECTS_FILE, SETTINGS_FILE, WORKSPACE } from './paths.js';
import { agentHeader, colorFn, printDim, printError, rosterLine, setOutputSink, setSpinnerRenderer, Spinner } from './ui.js';
// ядро: раунды, менеджер, инструменты, память — общение только через Presenter
import { Engine, chatTeam, isSessionRef, type App } from './core/engine.js';
import { bootstrapApp } from './core/bootstrap.js';
import type { ConfirmRequest, Presenter, SpeakerRef, TurnSink } from './core/presenter.js';
import type { Agent, ChatMessage, Session } from './types.js';

// доступен командам /exit: закрытие readline завершает приложение через 'close'
let rl: ReturnType<typeof createInterface> | null = null;

/** Управляемый экран и редактор ввода — в TTY; null в пайпе (там readline) */
let screen: Screen | null = null;
let editor: Editor | null = null;

/** Подсказки на пустом вводе: постоянная шпаргалка вместо пустой зоны */
const STATIC_HINTS = [
  pc.dim('  /help — операции · /session new — новый разговор · /sessions — список разговоров'),
  pc.dim('  @имя или №имя — участнику · Esc — прервать раунд · /exit — выход'),
];

/** Веб-оболочка — отдельный запуск; адрес из тех же PORT/HOST, что читает serve
 *  (лениво: .env дома грузится уже после импорта модуля). */
const serveHint = (): string =>
  pc.dim(`  веб-оболочка: dreamteam serve → http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8080}`);

/** Таймер «Скопировано» в строке статуса, чтобы не висел вечно */
let statusTimer: NodeJS.Timeout | null = null;

function flashStatus(screen: Screen, text: string): void {
  if (statusTimer) clearTimeout(statusTimer);
  screen.setStatus(text);
  statusTimer = setTimeout(() => {
    statusTimer = null;
    screen.setStatus(null);
  }, 2500);
  statusTimer.unref?.();
}

/** Текст в системный буфер: Windows — clip.exe (UTF-16LE с BOM ради кириллицы), иначе OSC 52 */
function copyToClipboard(text: string): void {
  if (process.platform === 'win32') {
    try {
      const child = spawn('clip', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin?.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
      child.on('error', () => {});
    } catch {
      // нет clip.exe — не страшно
    }
  } else {
    // буфер обмена самого терминала (работает и через ssh)
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
  }
}

/** Скопировать выделенное (если есть); true — было что копировать */
function copySelection(screen: Screen | null): boolean {
  const text = screen?.selectedText() ?? '';
  if (!text) return false;
  copyToClipboard(text);
  screen?.clearSelection();
  if (screen) flashStatus(screen, `  ✓ Скопировано в буфер (${text.length} симв.)`);
  return true;
}

/** Сырой вывод: в экране — в панель чата, без экрана — в stdout как есть */
function out(text: string): void {
  if (screen) screen.push(text);
  else process.stdout.write(text);
}

/** Плавный выход из TUI: вернуть терминал, закрыть очередь ввода */
function requestExit(): void {
  if (editor) {
    editor.stop();
    editor = null;
  }
  if (screen) {
    screen.stop();
    screen = null;
  }
  stdinLines.closed = true;
  stdinLines.wake?.();
  stdinLines.wake = null;
}

/** Живая панель подсказок команд под строкой ввода (вне TTY молчит) */
const hintPanel = new HintPanel(process.stdout);

/** Всплывашка @упоминаний: стрелки/Tab/Enter/Esc поверх обычного ввода */
const mentionPicker = new MentionPicker();

/** Пока true — keypress-ы рисуют панель подсказок (REPL ждёт строку) */
let awaitingInput = false;

let appRef: App | null = null;

/**
 * Активный раунд ответа команды. Esc и Ctrl+C во время раунда прерывают его
 * (abort летит во все LLM-вызовы), не убивая приложение; на промпте — как раньше.
 */
let abortActiveRound: (() => void) | null = null;

/** /exit: плавный выход — успеваем влить итоги разговора в общую память команды */
let exitRequested = false;

/**
 * Строки ввода. readline эмитит 'line' на каждую строку, очередь не даёт
 * терять строки, пришедшие во время ответов агентов. Через stdinLines.next()
 * можно и задавать вопросы пользователю посреди обработки сообщения (@session).
 */
const stdinLines = {
  queue: [] as string[],
  closed: false,
  wake: null as (() => void) | null,

  next(): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      this.wake = () => resolve(this.closed ? null : this.queue.shift() ?? null);
    });
  },
};

/**
 * Пометка строки, «отправленной» мягким переносом (Ctrl+Enter / Alt+Enter):
 * readline не эмитит 'line', патч кладёт строку в очередь сам. NUL с клавиатуры
 * не приходит, обычным строкам не мешает.
 */
const CE_PREFIX = '\u0000';

/** Мягкий перенос активен, только пока читается сообщение (не пикеры/команды) */
let ceEnabled = false;

async function nextInput(): Promise<string | null> {
  awaitingInput = true;
  ceEnabled = true;
  const v = await stdinLines.next();
  ceEnabled = false;
  awaitingInput = false;
  return v;
}

/**
 * Читает ввод с переносами строк:
 *  - `\` в конце строки + Enter — новая строка (работает в любом терминале);
 *  - Ctrl+Enter / Alt+Enter — новая строка без `\`;
 *  - пустая строка в продолжении — пустая строка сообщения (разрыв абзаца);
 *  - `.` в продолжении — закончить ввод; `\\` в конце — литеральный бэкслэш.
 * Команды (строки с `/`) и пустой ввод продолжения не создают.
 */
async function readMultiline(): Promise<string | null> {
  const first = await nextInput();
  if (first === null) return null;
  if (!first.startsWith(CE_PREFIX)) {
    const t = first.trim();
    if (!t || t.startsWith('/') || !t.endsWith('\\')) return t;
  }
  const parts: string[] = [];
  let raw = first;
  let soft = raw.startsWith(CE_PREFIX);
  let emptyRun = 0; // подряд идущие пустые строки: две — конец ввода (двойной Enter)
  while (true) {
    let text: string;
    let cont = false;
    if (soft) {
      text = raw.slice(CE_PREFIX.length);
      cont = true; // мягкий перенос всегда продолжается
    } else {
      text = raw.trim();
      if (text === '.') break; // закончить ввод как есть
      if (text.endsWith('\\\\')) {
        text = text.slice(0, -1); // '\\' — литеральный бэкслэш в конце
      } else if (text.endsWith('\\')) {
        text = text.slice(0, -1);
        cont = true;
        emptyRun = 0;
      } else if (text === '') {
        emptyRun++;
        if (emptyRun >= 2) {
          parts.pop(); // вторая пустая подряд — не абзац, а «отправить»
          break;
        }
        cont = true; // одна пустая строка — разрыв абзаца
      } else {
        emptyRun = 0;
      }
    }
    parts.push(text);
    if (!cont) break;
    if (!stdinLines.closed) {
      // пайп может закрыться раньше, чем вычитана очередь: тогда продолжаем
      // без промпта (он чисто косметический), только по строкам из очереди
      if (editor) editor.setPrompt(pc.dim('  … '));
      else if (rl) {
        rl.setPrompt(pc.dim('  … '));
        try {
          rl.prompt();
        } catch {
          // readline уже закрыт
        }
      }
    }
    const next = await nextInput();
    if (next === null) return null;
    raw = next;
    soft = raw.startsWith(CE_PREFIX);
  }
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n');
}

/**
 * Живые данные для автодополнения: список разговоров и состав команды читаем
 * не на каждый keystroke, а раз в секунду.
 */
let completionCache: {
  at: number;
  sessions: { title: string }[];
  team: string[];
  chat: { name: string; role?: string }[];
} | null = null;

function refreshCompletionCache(): void {
  const now = Date.now();
  if (completionCache && now - completionCache.at < 1000) return;
  const sessions = appRef ? appRef.store.list().map((s) => ({ title: s.title })) : [];
  let team: string[] = [];
  let chat: { name: string; role?: string }[] = [];
  try {
    const agents = loadTeam(AGENTS_FILE);
    team = agents.map((a) => a.name);
    // всплывашка @упоминаний предлагает только позванных в текущий чат
    if (appRef) chat = chatTeam(appRef.session, agents).map((a) => ({ name: a.name, role: a.role }));
  } catch {
    // без agents.json дополняем без имён
  }
  completionCache = { at: now, sessions, team, chat };
}

function completionCtx(): CompletionContext {
  return {
    sessions() {
      refreshCompletionCache();
      return completionCache?.sessions ?? [];
    },
    teamNames() {
      refreshCompletionCache();
      return completionCache?.team ?? [];
    },
    chatAgents() {
      refreshCompletionCache();
      return completionCache?.chat ?? [];
    },
    providerIds() {
      return appRef ? [...appRef.providers.keys()] : [];
    },
    managerName() {
      return appRef?.mgr.name ?? 'Менеджер';
    },
  };
}

// ─── Терминальная оболочка ядра: Presenter поверх экрана/readline ───────────

/**
 * Всё, что ядро хочет показать человеку, здесь рисуется в терминал:
 * в управляемом экране — в панель чата и строку статуса, без экрана — в stdout.
 */
class CliPresenter implements Presenter {
  notice(text: string): void {
    printDim(text);
  }

  error(text: string): void {
    printError(text);
  }

  turnHeader(agent: SpeakerRef): void {
    out('\n' + agentHeader(agent as Agent));
  }

  busy(label: string): { stop(): void } {
    const spinner = new Spinner(label);
    spinner.start();
    return { stop: () => spinner.stop() };
  }

  stream(busyLabel: string): TurnSink {
    const spinner = new Spinner(busyLabel);
    spinner.start();
    let started = false;
    return {
      delta: (text) => {
        if (!started) {
          // снимаем индикатор ровно до появления первого текста, иначе его таймер
          // продолжит затирать строку поверх стримящегося ответа
          spinner.stop();
          started = true;
        }
        out(text);
      },
      done: () => {
        if (!started) spinner.stop();
      },
    };
  }

  turnEnd(full: string): void {
    if (full.trim()) out('\n\n');
  }

  say(text: string): void {
    out(text);
    out('\n\n');
  }

  toolLines(results: string[]): void {
    console.log();
    for (const r of results) {
      for (const line of r.split('\n')) console.log(pc.dim('  ⚙ ' + line));
    }
    console.log();
  }

  attachment(title: string, digest: string): void {
    console.log(pc.dim(`\n  📎 Приложен конспект разговора «${title}»:`));
    for (const line of digest.split('\n')) console.log(pc.dim('  │ ' + line));
    console.log();
  }

  /**
   * Живой вопрос человеку перед действием, которое тул передал наверх
   * (check() сказал 'ask'). Только y/n: «разрешений на будущее» больше нет —
   * то, что должно ходить молча, записано в карточке тула или решено его check().
   */
  async confirm(req: ConfirmRequest): Promise<boolean> {
    const who = `${req.who.emoji ?? '🤖'} ${req.who.name}`;
    printDim(`  ⚙ ${req.label}: ${who}: ${req.desc}`);
    const hint = pc.dim('    y — выполнить · n — отказать');
    if (editor && screen) {
      // вопрос — в строку статуса над вводом; ответ придёт обычной строкой
      screen.setStatus(hint);
    } else if (rl) {
      rl.setPrompt(pc.dim('  y/n › '));
      try {
        rl.prompt();
      } catch {
        // readline уже закрыт (пайп кончился) — но ответы могли уже лежать в очереди,
        // поэтому не отказываем сразу, а пробуем вычитать ответ как обычно
      }
    }
    let answer = '';
    try {
      answer = ((await stdinLines.next()) ?? '').trim().toLowerCase();
    } finally {
      screen?.setStatus(null);
    }
    return answer === 'y' || answer === 'д';
  }

  async chooseSession(items: { title: string; count: number }[]): Promise<number | null> {
    console.log(pc.dim('  Приложить разговор (свежие сверху):'));
    items.forEach((s, i) => console.log(pc.dim(`    ${i + 1}. ${s.title} — ${s.count} сообщ.`)));
    printDim('  Введите номер (Enter — не прикладывать):');
    const answer = (await stdinLines.next())?.trim() ?? '';
    const n = Number.parseInt(answer, 10);
    return Number.isInteger(n) && n > 0 ? n - 1 : null;
  }

  sessionOpened(session: Session): void {
    replaySession(session);
  }
}

// ─── Рендер: баннер, справки, история ───────────────────────────────────────

/** Строки одного сообщения в фирменном формате (шапка с автором и текст) */
function messageRows(m: ChatMessage, team: Agent[]): string[] {
  const agent = m.authorId === 'manager' && appRef
    ? managerAsAgent(appRef.mgr)
    : team.find((a) => a.id === m.authorId);
  const who = m.authorId === 'user'
    ? pc.cyan('Вы')
    : m.authorId === 'tool'
      ? pc.dim('⚙ инструменты')
      : isSessionRef(m)
        ? pc.dim(`📎 разговор «${m.authorName}»`)
        : colorFn(agent?.color)(`${agent?.emoji ?? '🤖'} ${m.authorName}`);
  const rows = [`  ${who} ${pc.dim(`· ${new Date(m.ts).toLocaleTimeString('ru-RU')}`)}`];
  for (const line of m.text.split('\n')) rows.push('  ' + line);
  return rows;
}

function printBanner(app: App): void {  console.log(pc.bold(pc.cyan('\n  ╔══════════════════════════════════════════════╗')));
  console.log(pc.bold(pc.cyan('  ║   🎬  DREAM TEAM — совещание начинается      ║')));
  console.log(pc.bold(pc.cyan('  ╚══════════════════════════════════════════════╝')));

  try {
    const team = loadTeam(AGENTS_FILE);
    console.log(pc.dim('\n  Команда:'));
    if (team.length === 0) {
      console.log(pc.dim('  (пока пусто — новый разговор начнётся один на один с менеджером)'));
    }
    for (const agent of team) console.log(rosterLine(agent));
  } catch (err) {
    printError(`проблема с config/agents.json: ${err instanceof Error ? err.message : err}`);
  }

  const mgrAgent = managerAsAgent(app.mgr);
  console.log(pc.dim('\n  Менеджер переговорки (обращение: @менеджер):'));
  console.log(rosterLine(mgrAgent) + pc.dim(` [провайдер: ${app.mgr.provider}]`));

  console.log(pc.dim('\n  Провайдеры:'));
  for (const [pid, status] of app.providers) {
    const mark = pid === app.defaultProviderId ? pc.cyan(' ★') : '';
    const mgr = pid === app.mgr.provider ? pc.yellow(' 🛎 менеджер') : '';
    const state = status.ok
      ? pc.green('✓ готов')
      : pc.yellow(`✗ ${status.note ?? 'не настроен'}`);
    const vision = status.vision ? pc.magenta(' ◉ зрение') : '';
    console.log(
      `  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}${vision}${mark}${mgr}`,
    );
  }
  if (app.images.size > 0) {
    console.log(pc.dim('  Картинки:'));
    for (const [pid, status] of app.images) {
      const state = status.ok
        ? pc.green('✓ готов')
        : pc.yellow(`✗ ${status.note ?? 'не настроен'}`);
      console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}`);
    }
  }

  if (app.providers.get(app.defaultProviderId)?.provider.kind === 'mock') {
    console.log(
      pc.yellow('\n  ⚠ Работает MOCK-режим: ответы заготовлены. Впишите API-ключ в .env (см. README).'),
    );
  }

  printDim('\n  /help — команды · @имя или №имя — участнику · @session — приложить разговор · Esc — прервать · /exit — выход');
}

function printHelp(): void {
  const rows: string[] = [];
  let group = '';
  for (const op of OPERATIONS) {
    const g = op.name.split('.')[0];
    if (g !== group) {
      group = g;
      rows.push('');
    }
    const args = operationArgs(op);
    rows.push(`    ${(operationCommand(op) + (args ? ' ' + args : '')).padEnd(26)} — ${op.help}`);
  }
  console.log(
    [
      '',
      '  Операции (то же — имена rpc и подсказки GUI):',
      ...rows,
      '',
      '  Esc или Ctrl+C во время ответа команды — прервать (частичные ответы сохранятся).',
      '  Перенос строки в сообщении: \\ + Enter или Ctrl+Enter; пустая строка — разрыв абзаца;',
      '  двойной Enter или «.» — закончить ввод. Вставка многострочного текста тоже работает.',
      '  В сообщении можно адресовать участников: @марина, @viktor и т.д.',
      '  «№» — полный синоним «@» (Shift+3 в русской раскладке): №марина, №менеджер, №session.',
      '  @менеджер — конфигурация переговорки: состав команды и чата, разговоры.',
      '  @session — приложить конспект другого разговора (@session 2 — сразу номер).',
      '  Начните ввод с «/» — под строкой появятся подсказки (фильтруются при наборе), Tab — дополнить.',
      '',
    ].join('\n'),
  );
}

function printTeam(app: App): void {
  try {
    const fullTeam = loadTeam(AGENTS_FILE);
    const inChat = new Set(chatTeam(app.session, fullTeam).map((a) => a.id));
    const cfg = loadToolsConfig(SETTINGS_FILE, PROJECTS_FILE, WORKSPACE);
    console.log(pc.dim('\n  Команда:'));
    for (const agent of fullTeam) {
      const own = agent.provider ? pc.dim(` [провайдер: ${agent.provider}]`) : '';
      const access = accessLine(agent, cfg);
      const mark = inChat.has(agent.id) ? '' : pc.dim(' · не в этом чате (/add ' + agent.name + ')');
      console.log(rosterLine(agent) + own + access + mark);
    }
    console.log();
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }
}

/** Короткая строка о доступах агента: инструменты, проекты, серверы, глаза и руки. */
function accessLine(agent: Agent, cfg: ToolsConfig): string {
  const toolIds = agentToolIds(agent);
  if (toolIds.length === 0) return '';
  const parts: string[] = [];
  const projects = (agent.projects ?? []).filter((p) => cfg.projects.has(p) || p === agent.workspace);
  if (projects.length > 0) parts.push(`проекты: ${projects.join(', ')}`);
  // серверы живут внутри проектов: «проект:хост» для каждого назначенного проекта
  const servers = projects.flatMap((p) => [...(cfg.projects.get(p)?.hosts.keys() ?? [])].map((h) => `${p}:${h}`));
  if (servers.length > 0) parts.push(`серверы: ${servers.join(', ')}`);
  if (agent.vision) parts.push(`глаза: ${agent.vision}`);
  if (agent.image) parts.push(`рисует: ${agent.image}`);
  const labels = toolIds.map((t) =>
    t === 'files'
      ? 'файлы'
      : t === 'shell'
        ? 'консоль'
        : t === 'ssh'
          ? 'ssh'
          : t === 'look'
            ? 'зрение'
            : t === 'image'
              ? 'картинки'
              : t,
  );
  return pc.dim(` [${labels.join(', ')}${parts.length ? ' · ' + parts.join(' · ') : ''}]`);
}

function printProviders(app: App): void {
  console.log(pc.dim('\n  Провайдеры (★ — основной):'));
  for (const [pid, status] of app.providers) {
    const mark = pid === app.defaultProviderId ? pc.cyan(' ★') : '';
    const mgr = pid === app.mgr.provider ? pc.yellow(' 🛎 менеджер') : '';
    const state = status.ok ? pc.green('✓ готов') : pc.yellow(`✗ ${status.note ?? 'не настроен'}`);
    const vision = status.vision ? pc.magenta(' ◉ зрение') : '';
    console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}${vision}${mark}${mgr}`);
  }
  if (app.images.size > 0) {
    console.log(pc.dim('  Картинки (для инструмента image):'));
    for (const [pid, status] of app.images) {
      const state = status.ok ? pc.green('✓ готов') : pc.yellow(`✗ ${status.note ?? 'не настроен'}`);
      console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}`);
    }
  }
  printDim('  Сменить основной: /provider <id> — он для агентов; у менеджера переговорки свой (config/manager.json).');
  printDim('  Свой провайдер агенту — поля "provider", "vision", "image" в agents.json.');
}

function replaySession(session: Session): void {
  const last = session.messages.slice(-8);
  if (last.length === 0) {
    printDim('  (разговор пуст)');
    return;
  }
  printDim('  Последние сообщения:');
  for (const m of last) {
    const who = m.authorId === 'user'
      ? 'Вы'
      : m.authorId === 'tool'
        ? '⚙ инструменты'
        : `${m.authorName} (${m.authorRole})`;
    const brief = m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text;
    console.log(pc.dim(`    ${who}: ${brief.replace(/\n+/g, ' ')}`));
  }
}

// ─── Команды: терминал оставляет себе цветные просмотры и /exit ─────────────
// Цветной показ — только безглагольные формы обзора (/sessions, /team,
// /provider) и /session history; всё остальное исполняет ядро (манифест).

type CommandVerdict = 'exit' | 'handled' | 'unknown';

/** Цветная история разговора — /session history. */
function printHistory(app: App, nStr?: string): void {
  const n = Number.parseInt(nStr ?? '', 10);
  const all = app.session.messages;
  const shown = Number.isInteger(n) && n > 0 ? all.slice(-n) : all;
  if (shown.length === 0) {
    printDim('  Разговор пуст.');
    return;
  }
  let team: Agent[] = [];
  try {
    team = loadTeam(AGENTS_FILE);
  } catch {
    // без agents.json печатаем без фирменных цветов
  }
  console.log(
    pc.dim(`\n  Разговор «${app.session.title}» — показано ${shown.length} из ${all.length} сообщений:`),
  );
  for (const m of shown) {
    console.log('');
    for (const row of messageRows(m, team)) console.log(row);
  }
  console.log('');
}

function runCommand(engine: Engine, line: string): CommandVerdict {
  const app = engine.app;
  const [cmd, second, ...rest] = line.slice(1).trim().split(/\s+/);
  if (cmd === 'session' && second === 'history') {
    printHistory(app, rest[0]);
    return 'handled';
  }
  if (second !== undefined) return 'unknown';
  switch (cmd) {
    case 'help':
    case 'h':
      printHelp();
      return 'handled';
    case 'sessions': {
      const list = app.store.list();
      if (list.length === 0) {
        printDim('  Разговоров пока нет.');
        return 'handled';
      }
      console.log(pc.dim('\n  Разговоры (свежие сверху):'));
      list.forEach((s, i) => {
        const date = new Date(s.updatedAt).toLocaleString('ru-RU');
        const cur = s.id === app.session.id ? pc.cyan(' ← текущий') : '';
        console.log(`    ${i + 1}. ${s.title} — ${s.count} сообщ., ${date}${cur}`);
      });
      console.log();
      return 'handled';
    }
    case 'team':
      printTeam(app);
      return 'handled';
    case 'providers':
      printProviders(app);
      return 'handled';
    case 'exit':
    case 'quit':
    case 'q':
      exitRequested = true;
      if (editor) {
        requestExit();
        return 'exit';
      }
      rl?.close();
      return 'exit';
    default:
      // мутации и всё незнакомое — в ядро: там перехват `/` в handleMessage
      return 'unknown';
  }
}

async function main(): Promise<void> {
  // общий старт ядра: env дома, миграция, wizard, конфиги, fail-fast на тулах
  const { app, ui } = await bootstrapApp();
  appRef = app;
  const engine = new Engine(app, new CliPresenter());

  // Управляемый экран: альтернативный буфер, зоны чата/подсказок/ввода и свой
  // редактор строки. В пайпе (не TTY) — прежний readline-режим ниже.
  if (ui.screen && process.stdout.isTTY && process.stdin.isTTY) {
    screen = new Screen(process.stdout, ui.width, ui.margin);
    const completer = makeCompleter(completionCtx());
    editor = new Editor(
      {
        interceptKey: (key) => {
          if (mentionPicker.active) {
            const picked = mentionPicker.key(key.name);
            if (picked === 'handled') return 'handled';
            if (picked) return { text: picked.line, cursor: picked.cursor };
          }
          if (key.name === 'escape' && screen?.hasSelection()) {
            screen.clearSelection();
            return 'handled';
          }
          if (key.name === 'tab') {
            const line = editor?.text ?? '';
            const [hits, base] = completer(line);
            if (hits.length > 0) {
              const text = line.slice(0, line.length - base.length) + hits[0];
              return { text, cursor: text.length };
            }
            return 'handled';
          }
          return null;
        },
        onEdit: (buf, cur) => {
          const ctx = completionCtx();
          const rows = mentionPicker.update(buf, cur, ctx);
          if (rows) screen?.setOverlay(rows);
          else {
            screen?.setOverlay(null);
            // без контекстных подсказок (пустой ввод) — постоянная шпаргалка
            screen?.setHints(hintRowsFor(buf, ctx) ?? [...STATIC_HINTS, serveHint()]);
          }
        },
        onScroll: (dir, lines) => {
          if (dir === 'up') screen?.scrollUp(lines);
          else if (dir === 'down') screen?.scrollDown(lines);
          else if (dir === 'top') screen?.scrollToStart();
          else screen?.scrollToEnd();
        },
        onMouse: (type, col, row) => {
          if (!screen) return;
          if (type === 'down') screen.selMouseDown(col, row);
          else if (type === 'drag') screen.selMouseDrag(col, row);
          else if (copySelection(screen)) {
            // текст уже в буфере и в статусе; выделение остаётся до Esc/Ctrl+C
          }
        },
        onSelectKey: (dir) => {
          screen?.selMoveKeyboard(dir);
        },
        onSubmit: (line, soft) => {
          stdinLines.queue.push((ceEnabled && soft ? CE_PREFIX : '') + line);
          stdinLines.wake?.();
          stdinLines.wake = null;
        },
        onCtrlC: () => {
          const selText = editor?.selectionText() ?? '';
          if (selText) {
            // выделение в поле ввода: копируем, не снимая и не выходя
            copyToClipboard(selText);
            if (screen) flashStatus(screen, `  ✓ Скопировано в буфер (${selText.length} симв.)`);
            return;
          }
          if (copySelection(screen)) return; // есть выделение панели — копируем, а не выходим
          if (abortActiveRound) abortActiveRound();
          else requestExit();
        },
        onEof: () => requestExit(),
      },
      screen,
      process.stdin,
    );
    // весь вывод приложения — в панель чата экрана
    setOutputSink((t) => {
      if (screen) screen.push(t);
    });
    setSpinnerRenderer((t) => {
      screen?.setStatus(t);
    });
    // console.log по всему коду тоже ведёт в экран
    const nativeLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      if (screen) screen.push(format(...args) + '\n');
      else nativeLog(...args);
    };
    screen.start();
    editor.start();
  }

  printBanner(app);
  printDim(
    `  Вы — ${app.profile.name}${app.profile.role ? ` (${app.profile.role})` : ''}. ` +
    'Представиться команде: /profile set Имя; роль; о себе',
  );
  // Прошлый разговор сразу в панель: внизу виден хвост, вся старая история —
  // колесом/PgUp. В линейном режиме не нужно — там прокручивает сам терминал.
  if (screen && app.session.messages.length > 0) {
    let team: Agent[] = [];
    try {
      team = loadTeam(AGENTS_FILE);
    } catch {
      // без agents.json история засеивается без фирменных цветов агентов
    }
    const rows: string[] = [];
    for (const m of app.session.messages) {
      rows.push('');
      rows.push(...messageRows(m, team));
    }
    screen.seed(rows);
    printDim(
      `  Продолжаю разговор «${app.session.title}» (${app.session.messages.length} сообщ.) — /session new для нового, /sessions для списка`,
    );
  }
  // страховка от потерянных первых кадров терминала: одна полная перерисовка
  // после того, как весь стартовый вывод уже в состоянии экрана
  screen?.repaint();

  // Пустой разговор на старте (первый запуск или неиспользованная сессия) —
  // менеджер здоровается сам, как по /session new. Только в TTY: в пайпе LLM не зовём.
  if (editor && app.session.messages.length === 0) {
    const ac = new AbortController();
    abortActiveRound = () => ac.abort();
    try {
      await engine.startupWelcome(ac.signal);
    } finally {
      abortActiveRound = null;
    }
  }

  // Цветной промпт передаём самому readline: иначе при перерисовке строки
  // (например, при стирании текста) он подставит свой дефолтный белый '> '.
  // Название текущего разговора видно прямо в промпте.
  const promptFor = (session: Session): string => {
    const title = session.title.length > 24 ? session.title.slice(0, 24) + '…' : session.title;
    return pc.dim(`[${title}] `) + pc.cyan('Ты > ');
  };

  if (!editor) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: promptFor(app.session),
      completer: makeCompleter(completionCtx()),
    });

    // Enter всегда стирает панель подсказок — до того, как пойдёт вывод приложения
    rl.on('line', () => hintPanel.clear());
    rl.on('line', (line: string) => {
      stdinLines.queue.push(line);
      stdinLines.wake?.();
      stdinLines.wake = null;
    });
    rl.on('close', () => {
      hintPanel.clear();
      stdinLines.closed = true;
      stdinLines.wake?.();
      stdinLines.wake = null;
    });
    // Живая панель: на каждый вводимый символ фильтруем подсказки под строкой.
    // Ключевое: в современном Node интерфейс readline не эмитит 'keypress' —
    // события приходят только на входной поток (process.stdin), а readline
    // обрабатывает клавишу раньше нас (подписан первым), поэтому rl.line и
    // rl.cursor здесь уже новые.
    process.stdin.on('keypress', (_str: string, key?: { name?: string }) => {
      if (!awaitingInput || key?.name === 'return' || key?.name === 'enter') return;
      const line = rl?.line ?? '';
      const rows = mentionPicker.update(line, rl?.cursor ?? 0, completionCtx()) ?? hintRowsFor(line, completionCtx());
      hintPanel.render(rows);
    });
    rl.on('SIGINT', () => {
      // Ctrl+C во время ответа команды — прервать раунд; на промпте — выход
      if (abortActiveRound) abortActiveRound();
      else rl?.close();
    });
    // Мягкий перенос: Ctrl+Enter приходит как \n (LF), Alt+Enter как \x1b\r —
    // readline считает их обычным Enter и отправил бы строку. Перехватываем до
    // отправки: текущую строку — в очередь с пометкой продолжения, буфер чистим.
    // Shift+Enter обычные терминалы неотличимы от Enter — для него переноса нет.
    {
      const iface = rl as unknown as {
        _ttyWrite?: (s: string, key: { sequence?: string; name?: string; meta?: boolean }) => void;
        line: string;
        cursor: number;
        _refreshLine: () => void;
      };
      const orig = iface._ttyWrite?.bind(rl);
      if (orig) {
        iface._ttyWrite = (s, key) => {
          const seq = key?.sequence ?? '';
          const softNewline =
            seq === '\n' ||
            seq === '\x1b\n' ||
            ((key?.name === 'return' || key?.name === 'enter') && (seq === '\x1b\r' || key?.meta));
          if (ceEnabled && softNewline) {
            hintPanel.clear();
            stdinLines.queue.push(CE_PREFIX + (iface.line ?? ''));
            stdinLines.wake?.();
            stdinLines.wake = null;
            iface.line = '';
            iface.cursor = 0;
            process.stdout.write('\n');
            iface._refreshLine();
            return;
          }
          // Всплывашка @упоминаний: стрелки/Tab/Enter/Esc разбираем до readline,
          // иначе стрелки листали бы историю, а Enter отправлял строку.
          if (awaitingInput && key?.name) {
            const picked = mentionPicker.key(key.name);
            if (picked === 'handled') {
              hintPanel.render(mentionPicker.active ? mentionPicker.rows() : null);
              return;
            }
            if (picked) {
              iface.line = picked.line;
              iface.cursor = picked.cursor;
              iface._refreshLine();
              hintPanel.clear();
              return;
            }
          }
          orig(s, key);
        };
      }
    }
  }
  // Esc в сыром терминальном вводе приходит одиноким байтом \x1b, а стрелки
  // и F-клавиши — последовательностями \x1b[…/\x1bO…; последние не считаем прерыванием.
  process.stdin.on('data', (chunk: Buffer | string) => {
    if (!abortActiveRound) return;
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (s.includes('\x1b') && !s.includes('\x1b[') && !s.includes('\x1bO')) {
      abortActiveRound();
    }
  });

  while (true) {
    if (stdinLines.closed && stdinLines.queue.length === 0) break;
    if (editor) {
      editor.setPrompt(promptFor(app.session));
    } else if (rl) {
      rl.setPrompt(promptFor(app.session));
      if (!stdinLines.closed) {
        process.stdout.write('\n');
        try {
          rl.prompt();
        } catch {
          break; // readline уже закрыт (например, после /exit)
        }
      }
    }
    const raw = await readMultiline();
    if (raw === null) break; // stdin закрыт: конец пайпа, Ctrl+D
    const line = raw.trim();
    if (!line) continue;
    try {
      if (line.startsWith('/')) {
        const verdict = runCommand(engine, line);
        if (verdict === 'exit') break;
        if (verdict === 'handled') continue;
      }
      // Весь путь — команды и разговоры — под одним AbortController:
      // Esc/Ctrl+C прерывают раунд, а уже сказанное остаётся в истории.
      const ac = new AbortController();
      abortActiveRound = () => ac.abort();
      try {
        await engine.handleMessage(line, ac.signal);
      } finally {
        abortActiveRound = null;
      }
    } catch (err) {
      printError(`ошибка: ${err instanceof Error ? err.message : err}`);
    }
  }
  // страховка: выход мимо requestExit (закрытие stdin и т.п.) — гасим экран,
  // чтобы прощание и приглашение ОС печатались в обычном терминале
  if (editor || screen) {
    editor?.stop();
    editor = null;
    screen?.stop();
    screen = null;
  }
  // плавный /exit: вливаем итоги, только если конспект свежий (дешёвый путь),
  // иначе откладываем до следующего /session new — выход не должен ждать LLM
  if (exitRequested) {
    try {
      await engine.flushChatMemory(app.session, { onlyIfFreshDigest: true });
    } catch {
      // память не критична на выходе
    }
  }
  console.log(pc.dim('\n  Совещание окончено. Пока! 👋'));
  // фоновые вливания держат сетевые сокеты — не даём процессу висеть после прощания
  setTimeout(() => process.exit(0), 250).unref();
}

main().catch((err) => {
  // сначала возвращаем терминал из альтернативного буфера, потом диагностика
  try {
    screen?.stop();
    editor?.stop();
  } catch {
    // экран мог не успеть стартовать
  }
  console.error(pc.red(`Фатальная ошибка: ${err instanceof Error ? err.stack ?? err.message : err}`));
  process.exit(1);
});
