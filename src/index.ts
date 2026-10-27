import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { format } from 'node:util';
import { basename } from 'node:path';
import pc from 'picocolors';
import { loadTeam } from './agents.js';
import { managerAsAgent } from './manager.js';
import { agentToolIds } from './tools-api.js';
import { loadToolsConfig, type ToolsConfig } from './actions.js';
import { HintPanel, MentionPicker, hintRowsFor, makeCompleter, type CompletionContext } from './completion.js';
import { OPERATIONS, operationArgs, operationCommand } from './core/operations.js';
import { listProjects } from './core/projects.js';
import { Editor } from './editor.js';
import { Screen } from './screen.js';
// дом и текущий проект — только в paths.ts (проект переключается на лету)
import { AGENTS_DIR, APP_VERSION, DT_HOME, PROJECT_DIR, PROJECT_FILE, SETTINGS_FILE, WORKSPACE } from './paths.js';
import { agentHeader, colorFn, printDim, printError, rosterLine, setOutputSink, setSpinnerRenderer, Spinner } from './ui.js';
// ядро: раунды, менеджер, инструменты, память — общение только через Presenter
import { Engine, chatTeam, isSessionRef, type App } from './core/engine.js';
import { cliProjectArgs, parseCliProject } from './cli-project.js';
import { bootstrapApp } from './core/bootstrap.js';
import type { ConfirmRequest, Presenter, SpeakerRef, TurnSink } from './core/presenter.js';
import type { Agent, ChatMessage, Session } from './types.js';
import { fmtDate, fmtTime, t, tf } from './i18n.js';

// доступен командам /exit: закрытие readline завершает приложение через 'close'
let rl: ReturnType<typeof createInterface> | null = null;

/** Управляемый экран и редактор ввода — в TTY; null в пайпе (там readline) */
let screen: Screen | null = null;
let editor: Editor | null = null;

/** Подсказки на пустом вводе: постоянная шпаргалка вместо пустой зоны (функция — читается после выбора языка) */
const staticHints = (): string[] => [
  pc.dim(t('  /help — операции · /session new — новый разговор · /sessions — список разговоров')),
  pc.dim(t('  @имя или !имя — участнику · Esc — прервать раунд · /exit — выход')),
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
  if (screen) flashStatus(screen, tf('  ✓ Скопировано в буфер ({n} симв.)', { n: text.length }));
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
  sessions: { id: string; title: string }[];
  agentIds: string[];
  chat: { id: string; name: string; role?: string }[];
} | null = null;

function refreshCompletionCache(): void {
  const now = Date.now();
  if (completionCache && now - completionCache.at < 1000) return;
  const sessions = appRef?.store ? appRef.store.list().map((s) => ({ id: s.id, title: s.title })) : [];
  let agentIds: string[] = [];
  let chat: { id: string; name: string; role?: string }[] = [];
  try {
    const agents = loadTeam(AGENTS_DIR);
    agentIds = agents.map((a) => a.id);
    // всплывашка @упоминаний предлагает только позванных в текущий чат
    if (appRef?.session) chat = chatTeam(appRef.session, agents).map((a) => ({ id: a.id, name: a.name, role: a.role }));
  } catch {
    // без agents.json дополняем без имён
  }
  completionCache = { at: now, sessions, agentIds, chat };
}

function completionCtx(): CompletionContext {
  return {
    sessions() {
      refreshCompletionCache();
      return completionCache?.sessions ?? [];
    },
    agentIds() {
      refreshCompletionCache();
      return completionCache?.agentIds ?? [];
    },
    chatAgents() {
      refreshCompletionCache();
      return completionCache?.chat ?? [];
    },
    modelIds() {
      return appRef ? [...appRef.models.keys()] : [];
    },
    managerName() {
      return appRef?.mgr.name ?? 'Менеджер';
    },
    projectNames() {
      try {
        return listProjects().map((p) => p.id);
      } catch {
        return [];
      }
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

  /** Событие чата уже в истории разговора; в терминале показываем строку живьём. */
  service(text: string): void {
    printDim('  ' + text);
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
    console.log(pc.dim(tf('\n  📎 Приложен конспект разговора «{title}»:', { title })));
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
    const hint = pc.dim(t('    y — выполнить · n — отказать'));
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
    console.log(pc.dim(t('  Приложить разговор (свежие сверху):')));
    items.forEach((s, i) => console.log(pc.dim(`    ${i + 1}. ${s.title} — ${tf('{n} сообщ.', { n: s.count })}`)));
    printDim(t('  Введите номер (Enter — не прикладывать):'));
    const answer = (await stdinLines.next())?.trim() ?? '';
    const n = Number.parseInt(answer, 10);
    return Number.isInteger(n) && n > 0 ? n - 1 : null;
  }

  sessionOpened(session: Session): void {
    replaySession(session);
  }
}

// ─── Рендер: баннер, справки, история ───────────────────────────────────────

/** Строки истории разговора для панели (пустая команда — без карточек, без цветов). */
function historyRows(messages: ChatMessage[]): string[] {
  let team: Agent[] = [];
  try {
    team = loadTeam(AGENTS_DIR);
  } catch {
    // без карточек агентов история печатается без фирменных цветов
  }
  const rows: string[] = [];
  for (const m of messages) {
    rows.push('');
    rows.push(...messageRows(m, team));
  }
  return rows;
}

/** Строки одного сообщения в фирменном формате (шапка с автором и текст) */
function messageRows(m: ChatMessage, team: Agent[]): string[] {
  const agent = m.authorId === 'manager' && appRef
    ? managerAsAgent(appRef.mgr)
    : team.find((a) => a.id === m.authorId);
  const who = m.authorId === 'user'
    ? pc.cyan(t('Вы'))
    : m.authorId === 'tool'
      ? pc.dim(t('⚙ инструменты'))
      : isSessionRef(m)
        ? pc.dim(tf('📎 разговор «{title}»', { title: m.authorName }))
        : colorFn(agent?.color)(`${agent?.emoji ?? '🤖'} ${m.authorName}`);
  const rows = [`  ${who} ${pc.dim(`· ${fmtTime(m.ts)}`)}`];
  for (const line of m.text.split('\n')) rows.push('  ' + line);
  return rows;
}

function printBanner(app: App): void {  console.log(pc.bold(pc.cyan('\n  ╔══════════════════════════════════════════════╗')));
  console.log(pc.bold(pc.cyan(`  ║   🎬  DREAM TEAM — ${t('совещание начинается')}     ║`)));
  console.log(pc.bold(pc.cyan('  ╚══════════════════════════════════════════════╝')));
  console.log(
    pc.dim(
      tf('  версия {v} · дом: {home} · проект: {project}', {
        v: APP_VERSION,
        home: DT_HOME,
        project: PROJECT_DIR ? `${basename(PROJECT_DIR)} (${WORKSPACE || t('без рабочей папки')})` : t('не выбран'),
      }),
    ),
  );

  try {
    const team = loadTeam(AGENTS_DIR);
    console.log(pc.dim(`\n  ${t('Команда:')}`));
    if (team.length === 0) {
      console.log(pc.dim(t('  (пока пусто — новый разговор начнётся один на один с менеджером)')));
    }
    for (const agent of team) console.log(rosterLine(agent));
  } catch (err) {
    printError(`проблема с agents.json в доме: ${err instanceof Error ? err.message : err}`);
  }

  const mgrAgent = managerAsAgent(app.mgr);
  console.log(pc.dim(t('\n  Менеджер переговорки (обращение: @менеджер):')));
  console.log(rosterLine(mgrAgent) + pc.dim(` [${t('модель:')} ${app.mgr.model.id}]`));

  console.log(pc.dim(`\n  ${t('Модели:')}`));
  for (const [pid, status] of app.models) {
    const mark = pid === app.settings.model?.id ? pc.cyan(' ★') : '';
    const mgr = pid === app.mgr.model.id ? pc.yellow(` 🛎 ${t('менеджер')}`) : '';
    const state = status.ok
      ? pc.green(t('✓ готов'))
      : pc.yellow(`✗ ${status.note ?? t('не настроен')}`);
    const vision = status.vision ? pc.magenta(` ◉ ${t('зрение')}`) : '';
    console.log(
      `  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}${vision}${mark}${mgr}`,
    );
  }
  if (app.images.size > 0) {
    console.log(pc.dim(`  ${t('Картинки:')}`));
    for (const [pid, status] of app.images) {
      const state = status.ok
        ? pc.green(t('✓ готов'))
        : pc.yellow(`✗ ${status.note ?? t('не настроен')}`);
      console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}`);
    }
  }

  if (app.models.get(app.settings.model?.id ?? '')?.provider.kind === 'mock') {
    console.log(
      pc.yellow(t('\n  ⚠ Работает MOCK-режим: ответы заготовлены. Впишите API-ключ в .env (см. README).')),
    );
  }

  printDim(t('\n  /help — команды · @имя или !имя — участнику · @session — приложить разговор · Esc — прервать · /exit — выход'));
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
    rows.push(`    ${(operationCommand(op) + (args ? ' ' + args : '')).padEnd(26)} — ${t(op.help)}`);
  }
  console.log(
    [
      '',
      t('  Операции (то же — имена rpc и подсказки GUI):'),
      ...rows,
      '',
      t('  Esc или Ctrl+C во время ответа команды — прервать (частичные ответы сохранятся).'),
      t('  Перенос строки в сообщении: \\ + Enter или Ctrl+Enter; пустая строка — разрыв абзаца;'),
      t('  двойной Enter или «.» — закончить ввод. Вставка многострочного текста тоже работает.'),
      t('  В сообщении можно адресовать участников: @марина, @viktor и т.д.'),
      t('  «!» — полный синоним «@» (Shift+1 на любой раскладке): !марина, !менеджер, !session.'),
      t('  @менеджер — конфигурация переговорки: состав команды и чата, разговоры.'),
      t('  @session — приложить конспект другого разговора (@session 2 — сразу номер).'),
      t('  Начните ввод с «/» — под строкой появятся подсказки (фильтруются при наборе), Tab — дополнить.'),
      '',
    ].join('\n'),
  );
}

function printTeam(app: App): void {
  try {
    const fullTeam = loadTeam(AGENTS_DIR);
    // без открытого проекта чата нет — никто не отмечен как «в этом чате»
    const inChat = new Set(app.session ? chatTeam(app.session, fullTeam).map((a) => a.id) : []);
    const cfg = loadToolsConfig(SETTINGS_FILE, PROJECT_FILE || null, WORKSPACE);
    console.log(pc.dim(`\n  ${t('Команда:')}`));
    for (const agent of fullTeam) {
      const own = agent.model?.id ? pc.dim(` [${t('модель:')} ${agent.model.id}]`) : '';
      const access = accessLine(agent, cfg);
      const mark = inChat.has(agent.id) ? '' : pc.dim(` · ${tf('не в этом чате (/session agent add {id})', { id: agent.id })}`);
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
  // серверы — из поля "hosts" project.json текущего проекта: агентам доступен весь его реестр
  const servers = [...new Set([...cfg.projects.values()].flatMap((p) => [...p.hosts.keys()]))];
  if (servers.length > 0) parts.push(`${t('серверы:')} ${servers.join(', ')}`);
  if (agent.vision) parts.push(`${t('глаза:')} ${agent.vision}`);
  if (agent.image) parts.push(`${t('рисует:')} ${agent.image}`);
  const labels = toolIds.map((id) =>
    id === 'files'
      ? t('файлы')
      : id === 'shell'
        ? t('консоль')
        : id === 'ssh'
          ? 'ssh'
          : id === 'look'
            ? t('зрение')
            : id === 'image'
              ? t('картинки')
              : id,
  );
  return pc.dim(` [${labels.join(', ')}${parts.length ? ' · ' + parts.join(' · ') : ''}]`);
}

function printProviders(app: App): void {
  console.log(pc.dim(t('\n  Модели (★ — основная):')));
  for (const [pid, status] of app.models) {
    const mark = pid === app.settings.model?.id ? pc.cyan(' ★') : '';
    const mgr = pid === app.mgr.model.id ? pc.yellow(` 🛎 ${t('менеджер')}`) : '';
    const state = status.ok ? pc.green(t('✓ готов')) : pc.yellow(`✗ ${status.note ?? t('не настроен')}`);
    const vision = status.vision ? pc.magenta(` ◉ ${t('зрение')}`) : '';
    console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}${vision}${mark}${mgr}`);
  }
  if (app.images.size > 0) {
    console.log(pc.dim(t('  Картинки (для инструмента image):')));
    for (const [pid, status] of app.images) {
      const state = status.ok ? pc.green(t('✓ готов')) : pc.yellow(`✗ ${status.note ?? t('не настроен')}`);
      console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}`);
    }
  }
  printDim(t('  Сменить основную: /settings update model.id=<id>; у менеджера своя — /manager update model.id=<id>.'));
  printDim(t('  Своя модель у агента: /agent update <id> model.id=<id> (и model.temperature=… при желании).'));
}

function replaySession(session: Session): void {
  const last = session.messages.slice(-8);
  if (last.length === 0) {
    printDim(t('  (разговор пуст)'));
    return;
  }
  printDim(t('  Последние сообщения:'));
  for (const m of last) {
    const who = m.authorId === 'user'
      ? t('Вы')
      : m.authorId === 'tool'
        ? t('⚙ инструменты')
        : `${m.authorName} (${m.authorRole})`;
    const brief = m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text;
    console.log(pc.dim(`    ${who}: ${brief.replace(/\n+/g, ' ')}`));
  }
}

// ─── Команды: терминал оставляет себе цветные просмотры и /exit ─────────────
// Цветной показ — только безглагольные формы обзора (/sessions, /agents,
// /providers) и /session history; всё остальное исполняет ядро (манифест).

type CommandVerdict = 'exit' | 'handled' | 'unknown';

/** Цветная история разговора — /session history [from] [to], срез включительно. */
function printHistory(app: App, fromStr?: string, toStr?: string): void {
  if (!app.session) {
    printDim(t('  Нет открытого разговора — /session new [id] или /session open <id>.'));
    return;
  }
  const all = app.session.messages;
  let start = 0;
  let end = all.length;
  if (fromStr !== undefined) {
    const from = Number.parseInt(fromStr, 10);
    if (!Number.isInteger(from) || from < 1) {
      printDim(t('  from — номер сообщения (с 1); один аргумент = от N до конца.'));
      return;
    }
    start = Math.min(from, all.length) - 1;
  }
  if (toStr !== undefined) {
    const to = Number.parseInt(toStr, 10);
    if (!Number.isInteger(to) || to < start + 1) {
      printDim(t('  to — номер сообщения не меньше from.'));
      return;
    }
    end = Math.min(to, all.length);
  }
  const shown = all.slice(start, end);
  if (shown.length === 0) {
    printDim(t('  Разговор пуст.'));
    return;
  }
  let team: Agent[] = [];
  try {
    team = loadTeam(AGENTS_DIR);
  } catch {
    // без agents.json печатаем без фирменных цветов
  }
  console.log(
    pc.dim(tf('\n  Разговор «{title}» — показано {shown} из {all} сообщений:', { title: app.session.title, shown: shown.length, all: all.length })),
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
    printHistory(app, rest[0], rest[1]);
    return 'handled';
  }
  if (second !== undefined) return 'unknown';
  switch (cmd) {
    case 'help':
    case 'h':
      printHelp();
      return 'handled';
    case 'sessions': {
      // список работает всегда, когда проект открыт (сессия не обязательна)
      if (!app.store) {
        printDim(t('  Нет открытого проекта — /project new <id> [папка] или /project open <id|путь>.'));
        return 'handled';
      }
      const list = app.store.list();
      if (list.length === 0) {
        printDim(t('  Разговоров пока нет.'));
        return 'handled';
      }
      const currentId = app.session?.id;
      console.log(pc.dim(`\n  ${t('Разговоры (свежие сверху):')}`));
      list.forEach((s) => {
        const date = fmtDate(s.updatedAt);
        const cur = s.id === currentId ? pc.cyan(` ${t('← текущий')}`) : '';
        console.log(`    ${s.id} — ${s.title} — ${tf('{n} сообщ.', { n: s.count })}, ${date}${cur}`);
      });
      console.log();
      return 'handled';
    }
    case 'agents':
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

  // Проект из аргументов запуска (`dreamteam .`): применяем до входа в
  // управляемый экран — ошибка формы или папки уходит в обычный stdout с кодом
  // 1, а заметки ядра в экранном режиме всё равно сотрутся при смене буфера,
  // поэтому строку проекта после баннера печатаем отдельно.
  const cliForm = parseCliProject(cliProjectArgs());
  if (cliForm.kind === 'error') {
    console.error(`  ${cliForm.message}`);
    process.exit(1);
  }
  try {
    if (cliForm.kind === 'open') engine.switchProject(cliForm.target);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

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
            screen?.setHints(hintRowsFor(buf, ctx) ?? [...staticHints(), serveHint()]);
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
            if (screen) flashStatus(screen, tf('  ✓ Скопировано в буфер ({n} симв.)', { n: selText.length }));
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
    tf('  Вы — {name}{role}', { name: app.profile.name, role: app.profile.role ? ` (${app.profile.role})` : '' }) + '. ' +
    t('Представиться команде: /profile set Имя; роль; о себе'),
  );
  // Проект человек выбирает сам: без аргументов стартуем без него и показываем
  // путь; с аргументами проект уже открыт (выше), но его заметки в экранном
  // режиме до альтернативного буфера не видны — дублируем строку у баннера.
  if (PROJECT_DIR) {
    if (screen) printDim(`  ${t('Проект:')} ${basename(PROJECT_DIR)}${WORKSPACE ? ` · ${WORKSPACE}` : ''}`);
  } else if (!app.session) {
    printDim(t('  Проект не выбран — /project new <имя> [папка] создаст, /project open <имя|путь> откроет, /project — список.'));
  }
  // Прошлый разговор сразу в панель: внизу виден хвост, вся старая история —
  // колесом/PgUp. В линейном режиме не нужно — там прокручивает сам терминал.
  if (screen && app.session && app.session.messages.length > 0) {
    screen.seed(historyRows(app.session.messages));
    printDim(
      tf('  Продолжаю разговор «{title}» ({n} сообщ.) — /session new для нового, /sessions для списка', { title: app.session.title, n: app.session.messages.length }),
    );
  }
  // страховка от потерянных первых кадров терминала: одна полная перерисовка
  // после того, как весь стартовый вывод уже в состоянии экрана
  screen?.repaint();

  // Пустой разговор на старте (первый запуск или неиспользованная сессия) —
  // менеджер здоровается сам, как по /session new. Только в TTY: в пайпе LLM не зовём.
  if (editor && app.session && app.session.messages.length === 0) {
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
  // Название текущего разговора видно прямо в промпте; без проекта — метка.
  const promptFor = (session: Session | null): string => {
    if (!session) return pc.dim(t('  [без проекта] ')) + pc.cyan(t('Ты > '));
    const title = session.title.length > 24 ? session.title.slice(0, 24) + '…' : session.title;
    return pc.dim(`[${title}] `) + pc.cyan(t('Ты > '));
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
    const sessionBefore = app.session?.id ?? null;
    // команда открыла проект в пустой разговор — консьерж здоровается сам
    // (как на старте приложения и как по /session new); приветствие само
    // пишет сообщение, поэтому повторно не срабатывает
    const greetIfEmpty = async (): Promise<void> => {
      if (app.session && app.session.messages.length === 0) {
        const ac = new AbortController();
        abortActiveRound = () => ac.abort();
        try {
          await engine.startupWelcome(ac.signal);
        } finally {
          abortActiveRound = null;
        }
      }
    };
    // команда переключила разговор — его история сменяет старую в панели
    // (как при старте приложения)
    const reseedIfSwitched = (): void => {
      if (screen && app.session && app.session.id !== sessionBefore && app.session.messages.length > 0) {
        screen.reseed(historyRows(app.session.messages));
      }
    };
    try {
      if (line.startsWith('/')) {
        const verdict = runCommand(engine, line);
        if (verdict === 'exit') break;
        if (verdict === 'handled') {
          reseedIfSwitched();
          await greetIfEmpty();
          continue;
        }
        // остальное (/project new …, /session …) исполняет ядро — см. ниже
      }
      // Весь путь — команды и разговоры — под одним AbortController:
      // Esc/Ctrl+C прерывают раунд, а уже сказанное остаётся в истории.
      const ac = new AbortController();
      abortActiveRound = () => ac.abort();
      try {
        await engine.handleMessage(line, ac.signal);
        // манифест-команда могла открыть проект/разговор (тогда консьерж
        // здоровается, а история сменяется в панели); обычная реплика
        // сообщение уже добавила — guards не сработают
        if (line.startsWith('/')) {
          reseedIfSwitched();
          await greetIfEmpty();
        }
      } finally {
        abortActiveRound = null;
      }
    } catch (err) {
      printError(tf('ошибка: {err}', { err: err instanceof Error ? err.message : String(err) }));
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
  if (exitRequested && app.session) {
    try {
      await engine.flushChatMemory(app.session, { onlyIfFreshDigest: true });
    } catch {
      // память не критична на выходе
    }
  }
  console.log(pc.dim(t('\n  Совещание окончено. Пока! 👋')));
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
  console.error(pc.red(tf('Фатальная ошибка: {err}', { err: err instanceof Error ? err.stack ?? err.message : String(err) })));
  process.exit(1);
});
