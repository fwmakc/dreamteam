import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import pc from 'picocolors';
import { findMentions, loadTeam, loadUserProfile } from './agents.js';
import {
  actionsHint,
  checkPermission,
  describeAction,
  executeAction,
  loadToolsConfig,
  parseActions,
  type Action,
  type ToolsConfig,
  type ToolContext,
} from './actions.js';
import { SessionStore } from './sessions.js';
import { COMMANDS, HintPanel, MentionPicker, hintRowsFor, makeCompleter, type CompletionContext } from './completion.js';
import { Editor } from './editor.js';
import { Screen, loadUiConfig } from './screen.js';
import { planTurns, type PlanResult } from './orchestrator.js';
import { compressIfNeeded, contextSlice } from './compress.js';
import {
  REFLECT_WINDOW,
  appendChatToLog,
  loadTeamMemory,
  memoryBlock,
  mergeOtherChats,
  mergeShared,
  needsGlobalMerge,
  needsReflection,
  reflectSessionMemory,
  saveTeamMemory,
} from './memory.js';
import { loadProviders, loadImageProviders, type ImageProviderStatus, type ProviderStatus } from './providers/registry.js';
import { agentHeader, colorFn, printDim, printError, rosterLine, setOutputSink, setSpinnerRenderer, Spinner } from './ui.js';
import type {
  Agent,
  ChatMessage,
  LLMMessage,
  LLMProvider,
  Session,
  StreamRequest,
  TeamMemory,
  UserProfile,
} from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = join(ROOT, 'config');
const DATA_DIR = join(ROOT, 'data', 'sessions');
const USER_FILE = join(CONFIG_DIR, 'user.json');
const UI_FILE = join(CONFIG_DIR, 'ui.json');
const MEMORY_FILE = join(ROOT, 'data', 'memory.json');

// доступен командам /exit: закрытие readline завершает приложение через 'close'
let rl: ReturnType<typeof createInterface> | null = null;

/** Управляемый экран и редактор ввода — в TTY; null в пайпе (там readline) */
let screen: Screen | null = null;
let editor: Editor | null = null;

/** Подсказки на пустом вводе: постоянная шпаргалка вместо пустой зоны */
const STATIC_HINTS = [
  pc.dim('  /help — команды · /new — новый разговор · /sessions — список разговоров'),
  pc.dim('  @имя — вопрос участнику · Esc — прервать раунд · /exit — выход'),
];

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
    const agents = loadTeam(join(CONFIG_DIR, 'team.json'));
    team = agents.map((a) => a.name);
    // всплывашка @упоминаний предлагает только позванных в текущий чат
    if (appRef) chat = chatTeam(appRef.session, agents).map((a) => ({ name: a.name, role: a.role }));
  } catch {
    // без team.json дополняем без имён
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
  };
}

const COMMON_RULES =
  'Общие правила: отвечай на русском, от первого лица, коротко и живо (обычно 2–5 предложений), ' +
  'без заголовков и списков, если тебя прямо не просят. Не выходи из роли и не упоминай, что ты ИИ. ' +
  'Если не согласен с коллегой — говори об этом прямо и обращайся к нему по имени.';

const DIGEST_SYSTEM = `Ты — помощник команды. Сделай краткий конспект разговора, чтобы его можно было передать в другой разговор.
Сохрани: тему; что решили и договорились; ключевые аргументы с именами; важные названия, цифры и ограничения; что осталось незакрытым.
Пиши сжато, до 150 слов, без воды. Это рабочий конспект, а не пересказ.`;

/** Приложение — конспект другого разговора, подшитый в текущий через @session */
function isSessionRef(m: ChatMessage): boolean {
  return m.authorId === 'session-ref';
}

interface App {
  store: SessionStore;
  session: Session;
  providers: Map<string, ProviderStatus>;
  /** image-провайдеры (генерация картинок) из того же providers.json */
  images: Map<string, ImageProviderStatus>;
  defaultProviderId: string;
  profile: UserProfile;
  memory: TeamMemory;
}

function defaultProvider(app: App): LLMProvider {
  const status = app.providers.get(app.defaultProviderId);
  if (!status) {
    throw new Error('не настроен ни один провайдер — проверьте config/providers.json');
  }
  return status.provider;
}

function agentProvider(app: App, agent: Agent): LLMProvider {
  if (agent.provider) {
    const status = app.providers.get(agent.provider);
    if (status) return status.provider;
    printDim(`⚠ у агента ${agent.name} указан неизвестный провайдер «${agent.provider}», использую основной`);
  }
  return defaultProvider(app);
}

/** Состав чата: явно выбранные участники или вся команда (старые разговоры). */
function chatTeam(session: Session, fullTeam: Agent[]): Agent[] {
  if (!session.participants || session.participants.length === 0) return fullTeam;
  const byId = new Map(fullTeam.map((a) => [a.id, a] as const));
  const picked = session.participants
    .map((id) => byId.get(id))
    .filter((a): a is Agent => Boolean(a));
  return picked.length > 0 ? picked : fullTeam;
}

/** Имена участников чата для подписи (без чтения team.json возвращает null). */
function participantsLine(session: Session): string | null {
  if (!session.participants || session.participants.length === 0) return null;
  try {
    const full = loadTeam(join(CONFIG_DIR, 'team.json'));
    return chatTeam(session, full).map((a) => `${a.emoji} ${a.name}`).join(', ');
  } catch {
    return null;
  }
}

/**
 * Выбор участников при создании чата: номера через запятую/пробел,
 * Enter или «все» — вся команда.
 */
async function pickParticipants(app: App): Promise<void> {
  let fullTeam: Agent[];
  try {
    fullTeam = loadTeam(join(CONFIG_DIR, 'team.json'));
  } catch {
    return; // нет team.json — чат без явного списка, живёт всей командой
  }
  console.log(pc.dim('  Кого зовём в чат? (Enter — вся команда)'));
  fullTeam.forEach((a, i) => console.log(`    ${i + 1}. ${rosterLine(a)}`));
  printDim('  Номера через запятую или пробел (можно сразу написать первое сообщение — позовём всех):');
  const answer = (await stdinLines.next())?.trim() ?? '';
  const ids = new Set<string>();
  let firstMessage: string | null = null;
  if (answer.startsWith('/')) {
    stdinLines.queue.unshift(answer); // команду не съедаем — выполнится сразу после выбора
  } else if (answer && !/^(все|всех|all)$/i.test(answer)) {
    for (const token of answer.split(/[\s,;]+/)) {
      const n = Number.parseInt(token, 10);
      if (Number.isInteger(n) && n > 0 && n <= fullTeam.length) ids.add(fullTeam[n - 1].id);
    }
    if (ids.size === 0) firstMessage = answer; // это не номера, а текст первого сообщения
  }
  if (ids.size === 0 || ids.size === fullTeam.length) {
    app.session.participants = undefined;
    printDim('  Зовём всю команду.');
  } else {
    app.session.participants = [...ids];
    printDim('  В чате: ' + fullTeam.filter((a) => ids.has(a.id)).map((a) => `${a.emoji} ${a.name}`).join(', '));
  }
  app.store.save(app.session);
  if (firstMessage) {
    stdinLines.queue.unshift(firstMessage);
    stdinLines.wake?.();
    stdinLines.wake = null;
  }
}

/** Собирает запрос агенту: профиль собеседника + конспект старой части + недавняя история + слово от модератора. */
function buildRequest(
  agent: Agent,
  focus: string | undefined,
  history: ChatMessage[],
  user: UserProfile,
  summary?: string,
  personal?: string,
): StreamRequest {
  const messages: LLMMessage[] = [];
  if (summary) {
    messages.push({
      role: 'user',
      content: `Итог более ранней части разговора (сжатый конспект):\n${summary}\n\nНиже — недавние сообщения.`,
    });
  }
  for (const m of history.slice(-30)) {
    if (isSessionRef(m)) {
      messages.push({
        role: 'user',
        content: `Приложение — конспект другого разговора «${m.authorName}»:\n${m.text}`,
      });
    } else if (m.authorId === 'user') {
      messages.push({ role: 'user', content: `${user.name}: ${m.text}` });
    } else if (m.authorId === 'tool') {
      messages.push({ role: 'user', content: `⚙ Результаты твоих действий:\n${m.text}` });
    } else {
      messages.push({
        role: 'user',
        content: `${m.authorName} (${m.authorRole ?? 'коллега'}): ${m.text}`,
      });
    }
  }
  messages.push({
    role: 'user',
    content: focus
      ? `Модератор передаёт слово тебе. Фокус: ${focus}`
      : 'Модератор передаёт слово тебе. Ответь по существу.',
  });
  const who = user.role ? ` (${user.role})` : '';
  const identity =
    `Твой собеседник — ${user.name}${who}.${user.about ? ` О себе: ${user.about}.` : ''} ` +
    'Обращайся к собеседнику по имени, когда это уместно.';
  const blocks = [agent.prompt, identity];
  if (personal) {
    blocks.push(`Твоя память (субъективно и сжато, это то, что ты помнишь сам):\n${personal}`);
  }
  if (agent.tools?.length) {
    const hint = actionsHint(agent, loadToolsConfig(ROOT));
    if (hint) blocks.push(hint);
  }
  blocks.push(COMMON_RULES);
  return {
    system: blocks.join('\n\n'),
    messages,
    temperature: agent.temperature ?? 0.7,
  };
}

/**
 * Выбор разговора для @session: "@session 2" — сразу номер из списка других
 * разговоров, "@session" — интерактивный выбор. Enter отменяет.
 */
async function pickSession(app: App, numStr?: string): Promise<Session | null> {
  const list = app.store.list().filter((s) => s.id !== app.session.id);
  if (list.length === 0) {
    printDim('  ⚠ Других разговоров пока нет — нечего прикладывать.');
    return null;
  }
  if (numStr) {
    const n = Number.parseInt(numStr, 10);
    const meta = Number.isInteger(n) && n > 0 ? list[n - 1] : undefined;
    if (!meta) {
      printDim(`  ⚠ В списке других разговоров нет №${numStr} (см. /sessions).`);
      return null;
    }
    return app.store.load(meta.id);
  }
  console.log(pc.dim('  Приложить разговор (свежие сверху):'));
  list.forEach((s, i) => console.log(pc.dim(`    ${i + 1}. ${s.title} — ${s.count} сообщ.`)));
  printDim('  Введите номер (Enter — не прикладывать):');
  const answer = (await stdinLines.next())?.trim() ?? '';
  const n = Number.parseInt(answer, 10);
  const meta = Number.isInteger(n) && n > 0 ? list[n - 1] : undefined;
  if (!meta) {
    printDim('  … продолжаю без приложения.');
    return null;
  }
  return app.store.load(meta.id);
}

/**
 * Конспект разговора для передачи в другой чат. Кэшируется в самом разговоре
 * (session.digest) и перестраивается, только если разговор заметно вырос.
 */
async function getSessionDigest(
  app: App,
  session: Session,
  signal?: AbortSignal,
  userName = 'Пользователь',
  quiet = false,
): Promise<string | null> {
  const provider = defaultProvider(app);
  if (session.digest && session.digestAtCount !== undefined
      && session.messages.length - session.digestAtCount < 10) {
    return session.digest;
  }
  const parts: string[] = [];
  if (session.summary) parts.push(`Предыдущий конспект:\n${session.summary}`);
  const rest = session.messages.slice(session.compressedUpTo ?? 0);
  if (rest.length > 0) {
    parts.push(
      'Сообщения разговора:\n' +
      rest.map((m) =>
        `${m.authorId === 'user' ? userName : `${m.authorName} (${m.authorRole ?? 'участник'})`}: ${m.text}`,
      ).join('\n'),
    );
  }
  if (parts.length === 0) {
    if (!quiet) printDim('  ⚠ Выбранный разговор пуст.');
    return null;
  }

  const spinner = quiet ? null : new Spinner(`Читаю разговор «${session.title}»…`);
  spinner?.start();
  try {
    let digest: string;
    if (provider.kind === 'mock') {
      digest = `Разговор «${session.title}»: ` +
        rest.slice(0, 6).map((m) => `${m.authorName}: ${m.text.slice(0, 60)}`).join('; ');
    } else {
      let out = '';
      for await (const chunk of provider.stream({
        system: DIGEST_SYSTEM,
        messages: [{ role: 'user', content: parts.join('\n\n') }],
        temperature: 0.2,
        signal,
      })) {
        out += chunk;
      }
      digest = out.trim();
    }
    if (!digest) {
      if (!quiet) printDim('  ⚠ Не удалось построить конспект разговора.');
      return null;
    }
    session.digest = digest;
    session.digestAtCount = session.messages.length;
    app.store.save(session);
    return digest;
  } catch (err) {
    if (signal?.aborted) return null; // прервано (Esc) — сообщение об этом ниже
    if (!quiet) printDim(`  ⚠ Не удалось прочитать разговор: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    spinner?.stop();
  }
}

async function handleMessage(app: App, text: string): Promise<void> {
  let team: Agent[];
  try {
    team = loadTeam(join(CONFIG_DIR, 'team.json'));
  } catch (err) {
    printError(`не удалось прочитать команду: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Весь раунд (конспекты, сжатие, модератор, ответы агентов) под одним
  // AbortController: Esc/Ctrl+C прерывают его, а уже сказанное остаётся в истории.
  const ac = new AbortController();
  abortActiveRound = () => ac.abort();
  try {
    await runRound(app, text, team, ac.signal);
  } finally {
    abortActiveRound = null;
  }
}

async function runRound(app: App, text: string, fullTeam: Agent[], signal: AbortSignal): Promise<void> {
  const { session, store } = app;
  // профиль читаем каждый раунд: правки config/user.json подхватываются на лету
  const profile = loadUserProfile(USER_FILE);
  app.profile = profile;
  // в чате отвечают только позванные (старые чаты без списка — вся команда)
  const team = chatTeam(session, fullTeam);

  // @session — приложить конспект другого разговора (можно несколько, "@session 2" — сразу номер)
  const attachments: ChatMessage[] = [];
  const usedIds = new Set<string>();
  let cleaned = text;
  const refRegex = /@session(?:\s+(\d+))?/gi;
  for (const match of text.matchAll(refRegex)) {
    const picked = await pickSession(app, match[1]);
    if (!picked || picked.id === session.id || usedIds.has(picked.id)) continue;
    usedIds.add(picked.id);
    const digest = await getSessionDigest(app, picked, signal, profile.name);
    if (!digest) continue;
    attachments.push({
      authorId: 'session-ref',
      authorName: picked.title,
      text: digest,
      ts: Date.now(),
    });
    cleaned = cleaned.replace(match[0], ' ');
  }
  if (signal.aborted) return;
  // подчищаем следы @session, но не трогаем переносы строк (многострочные сообщения)
  cleaned = cleaned.replace(/[^\S\n]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').trim();

  for (const a of attachments) {
    console.log(pc.dim(`\n  📎 Приложен конспект разговора «${a.authorName}»:`));
    for (const line of a.text.split('\n')) console.log(pc.dim('  │ ' + line));
    console.log();
    session.messages.push(a);
  }
  store.save(session);

  const userText = cleaned || (attachments.length > 0 ? 'Ознакомься с приложенным конспектом' : '');
  if (!userText) return;
  session.messages.push({ authorId: 'user', authorName: 'Вы', text: userText, ts: Date.now() });
  if (session.title === 'Новый разговор') {
    const flat = userText.replace(/\s+/g, ' ');
    session.title = flat.slice(0, 42) + (flat.length > 42 ? '…' : '');
  }
  store.save(session);

  const moderator = defaultProvider(app);

  // не даём контексту расти бесконечно: старые сообщения сворачиваются в конспект
  const compressing = new Spinner('Проверяю длину разговора…');
  compressing.start();
  let compressed = false;
  try {
    compressed = await compressIfNeeded(session, moderator, signal, profile.name);
  } catch (err) {
    if (signal.aborted) return;
    printDim(`  … не удалось сжать историю, продолжаю как есть: ${err instanceof Error ? err.message : err}`);
  } finally {
    compressing.stop();
  }
  if (compressed) {
    store.save(session);
    printDim('  … разговор длинный: старые сообщения свёрнуты в конспект (полная история — /history и data/transcripts)');
  }

  const planning = new Spinner('Модератор решает, кто из команды ответит…');
  planning.start();
  let plan: PlanResult;
  const mentionedAll = findMentions(text, fullTeam);
  for (const a of mentionedAll) {
    if (!team.some((t) => t.id === a.id)) {
      printDim(`  ⚠ ${a.name} не в этом чате — позвать: /add ${a.name}`);
    }
  }
  try {
    plan = await planTurns({
      text,
      team,
      history: session.messages.slice(0, -1),
      moderator,
      mentioned: findMentions(text, team),
      signal,
      userName: profile.name,
    });
  } finally {
    planning.stop();
  }
  if (signal.aborted) return;
  if (plan.note) printDim(`  … ${plan.note}`);

  for (const turn of plan.turns) {
    if (signal.aborted) break; // Esc во время предыдущего ответа — остальных не зовём
    console.log('\n' + agentHeader(turn.agent));
    const provider = agentProvider(app, turn.agent);
    const personal = memoryBlock(turn.agent, session, fullTeam, app.memory, profile.name);
    const spinner = new Spinner(`${turn.agent.emoji} ${turn.agent.name} печатает…`);
    spinner.start();
    let full = '';
    let streamError: unknown = null;
    let textStarted = false;
    try {
      for await (const chunk of provider.stream({
        ...buildRequest(turn.agent, turn.focus, contextSlice(session), profile, session.summary, personal),
        signal,
      })) {
        if (!textStarted) {
          // снимаем индикатор ровно до появления первого текста, иначе его таймер
          // продолжит затирать строку поверх стримящегося ответа
          spinner.stop();
          textStarted = true;
        }
        full += chunk;
        out(chunk);
      }
    } catch (err) {
      streamError = err;
    } finally {
      if (!textStarted) spinner.stop();
    }
    if (streamError && !signal.aborted) {
      printError(`ошибка провайдера «${provider.id}»: ${streamError instanceof Error ? streamError.message : streamError}`);
    }
    if (full.trim()) {
      out('\n\n');
      session.messages.push({
        authorId: turn.agent.id,
        authorName: turn.agent.name,
        authorRole: turn.agent.role,
        text: full.trim(),
        ts: Date.now(),
      });
      store.save(session);
      if (turn.agent.tools?.length && !signal.aborted) {
        await runToolLoop(app, turn.agent, full.trim(), fullTeam, profile, provider, signal);
      }
    } else if (!signal.aborted) {
      printDim('(пустой ответ)');
    }
  }
  if (signal.aborted) {
    printDim('\n  ⏹ Прервано (Esc). Ответы, которые успели появиться, сохранены в истории.');
    return;
  }
  // ленивые обновления памяти: максимум одна рефлексия и одно слияние за раунд
  await updateMemories(app, team, profile, plan, signal);
}

/** Максимум циклов «ответ с действиями → результаты → продолжение» на один ответ агента. */
const MAX_TOOL_ITERATIONS = 3;

/** Действия, разрешённые пользователем «до конца сессии» (ответ [a] в подтверждении). */
const sessionAllowed = new Set<string>();

/** «Разрешить такие» привязываем к типу действия и его цели: ssh:prod ≠ ssh:staging. */
function actionScope(action: Action): string {
  if (action.kind === 'ssh') return `ssh:${action.host}`;
  return `${action.kind}:${action.project ?? '*'}`;
}

const KIND_LABEL: Record<Action['kind'], string> = {
  file: 'Запись файла',
  run: 'Команда',
  ssh: 'Команда по ssh',
  look: 'Просмотр картинки',
  image: 'Генерация изображений',
};

/** Глаза и руки агентов: vision-провайдер для look и image-провайдер для image. */
function toolContext(app: App): ToolContext {
  return {
    getVisionProvider(agent) {
      const pid = agent?.vision ?? agent?.provider ?? app.defaultProviderId;
      const status = app.providers.get(pid);
      if (!status) return { error: `провайдер «${pid}» не найден (см. providers.json)` };
      if (!status.vision) {
        return {
          error: `провайдер «${pid}» (${status.provider.model}) не умеет смотреть картинки — задайте агенту поле "vision" с провайдером, у которого в providers.json "vision": true`,
        };
      }
      return { provider: status.provider };
    },
    getImageProvider(agent) {
      const pid = agent?.image;
      if (!pid) return { error: 'агенту не назначен image-провайдер (поле "image" в team.json)' };
      const status = app.images.get(pid);
      if (!status) return { error: `image-провайдер «${pid}» не найден (см. providers.json)` };
      if (!status.ok) return { error: `image-провайдер «${pid}» не настроен: ${status.note ?? ''}` };
      return { provider: status.provider };
    },
  };
}

/**
 * Спрашивает пользователя перед реальным действием агента. 'a' запоминает
 * разрешение на такие действия (тип + цель) до закрытия разговора (/new, /session).
 */
async function confirmToolAction(action: Action, who: string): Promise<boolean> {
  const scope = actionScope(action);
  if (sessionAllowed.has(scope)) return true;
  printDim(`  ⚙ ${KIND_LABEL[action.kind]}: ${who}: ${describeAction(action)}`);
  const hint = pc.dim('    y — выполнить · n — отказать · a — такие действия до конца сессии');
  if (editor && screen) {
    // вопрос — в строку статуса над вводом; ответ придёт обычной строкой
    screen.setStatus(hint);
  } else if (rl) {
    rl.setPrompt(pc.dim('  y/n/a › '));
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
  if (answer === 'a' || answer === 'а') {
    sessionAllowed.add(scope);
    return true;
  }
  return answer === 'y' || answer === 'д';
}

const TOOL_FOLLOW_FOCUS =
  'Результаты твоих действий — в истории от «⚙ инструменты». Продолжай: следующий шаг или краткий итог. ' +
  'Опирайся только на эти результаты, ничего не додумывай.';

/** Договорращивает ответ агента после показа результатов его действий. */
async function streamFollowUp(
  app: App,
  agent: Agent,
  fullTeam: Agent[],
  profile: UserProfile,
  provider: LLMProvider,
  signal: AbortSignal,
): Promise<string> {
  const personal = memoryBlock(agent, app.session, fullTeam, app.memory, profile.name);
  const spinner = new Spinner(`${agent.emoji} ${agent.name} продолжает…`);
  spinner.start();
  let full = '';
  let textStarted = false;
  try {
    for await (const chunk of provider.stream({
      ...buildRequest(
        agent,
        TOOL_FOLLOW_FOCUS,
        contextSlice(app.session),
        profile,
        app.session.summary,
        personal,
      ),
      signal,
    })) {
      if (!textStarted) {
        spinner.stop();
        textStarted = true;
      }
      full += chunk;
      out(chunk);
    }
  } catch (err) {
    if (!signal.aborted) {
      printDim(`  ⚠ не удалось получить продолжение: ${err instanceof Error ? err.message : err}`);
    }
  } finally {
    if (!textStarted) spinner.stop();
  }
  return full.trim();
}

/**
 * Цикл инструментов: разбираем блоки ```file / ```run из ответа агента,
 * выполняем с подтверждением, отдаём результаты в историю и просим агента
 * продолжить — до трёх итераций или пока блоки не кончатся.
 */
async function runToolLoop(
  app: App,
  agent: Agent,
  firstText: string,
  fullTeam: Agent[],
  profile: UserProfile,
  provider: LLMProvider,
  signal: AbortSignal,
): Promise<void> {
  const { session, store } = app;
  const cfg = loadToolsConfig(ROOT);
  let text = firstText;
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS && !signal.aborted; iteration++) {
    const actions = parseActions(text);
    if (actions.length === 0) break;
    const results: string[] = [];
    for (const action of actions) {
      if (signal.aborted) break;
      // права агента проверяем до вопроса пользователю: чужой проект/хост — сразу отказ
      const deny = checkPermission(agent, action, cfg);
      if (deny) {
        results.push(`⛔ ${describeAction(action)} — запрещено: ${deny}`);
        continue;
      }
      const allowed = await confirmToolAction(action, `${agent.emoji} ${agent.name}`);
      if (!allowed) {
        results.push(`⛔ ${describeAction(action)} — отклонено пользователем`);
        continue;
      }
      const res = await executeAction(action, cfg, signal, agent, toolContext(app));
      results.push(`${res.ok ? '✅' : '❌'} ${res.output}`);
    }
    if (results.length === 0) break;
    console.log();
    for (const r of results) {
      for (const line of r.split('\n')) console.log(pc.dim('  ⚙ ' + line));
    }
    console.log();
    session.messages.push({
      authorId: 'tool',
      authorName: '⚙ инструменты',
      text: results.join('\n\n'),
      ts: Date.now(),
    });
    store.save(session);
    const follow = await streamFollowUp(app, agent, fullTeam, profile, provider, signal);
    if (!follow) break;
    session.messages.push({
      authorId: agent.id,
      authorName: agent.name,
      authorRole: agent.role,
      text: follow,
      ts: Date.now(),
    });
    store.save(session);
    text = follow;
  }
}

/**
 * Субъективная память после раунда. Экономика: в обычном раунде — 0 вызовов;
 * когда разговор вырос на ~12 сообщений — одна рефлексия самого устаревшего
 * из отвечавших; и максимум одно слияние «другие разговоры» одному агенту.
 */
async function updateMemories(
  app: App,
  team: Agent[],
  profile: UserProfile,
  plan: PlanResult,
  signal: AbortSignal,
): Promise<void> {
  const { session } = app;

  // 1) память разговора
  const speakers = plan.turns
    .map((t) => t.agent)
    .filter((a) => needsReflection(session, a.id))
    .sort((a, b) =>
      (session.memories?.[a.id]?.updatedAtMsg ?? 0) - (session.memories?.[b.id]?.updatedAtMsg ?? 0),
    );
  if (speakers.length > 0) {
    const agent = speakers[0];
    const from = session.memories?.[agent.id]?.updatedAtMsg ?? 0;
    const window = Math.max(from, session.messages.length - REFLECT_WINDOW);
    const dialog = session.messages.slice(window);
    const spinner = new Spinner(`${agent.emoji} ${agent.name} осмысливает разговор…`);
    spinner.start();
    try {
      const memory = await reflectSessionMemory(
        agent,
        session.memories?.[agent.id],
        dialog,
        profile.name,
        team,
        agentProvider(app, agent),
        signal,
      );
      session.memories = { ...session.memories, [agent.id]: { ...memory, updatedAtMsg: session.messages.length } };
      app.store.save(session);
      printDim(`  … ${agent.name} осмыслил(а) разговор — память обновлена`);
    } catch (err) {
      if (!signal.aborted) {
        printDim(`  … не удалось обновить память ${agent.name}: ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      spinner.stop();
    }
  }
  if (signal.aborted) return;

  // 2) память о других разговорах — одному «устаревшему» агенту за раунд
  const stale = team.find((a) => needsGlobalMerge(app.memory, a.id));
  if (stale) {
    try {
      const otherChats = await mergeOtherChats(
        app.memory.agents[stale.id]?.otherChats,
        app.memory.log.map((e) => `«${e.title}»: ${e.digest}`),
        agentProvider(app, stale),
        signal,
      );
      app.memory.agents[stale.id] = {
        ...app.memory.agents[stale.id],
        otherChats,
        seenVersion: app.memory.logVersion,
      };
      saveTeamMemory(MEMORY_FILE, app.memory);
      printDim(`  … ${stale.name} освежил(а) память о других разговорах`);
    } catch {
      // не критично: попробуем в следующем раунде
    }
  }
}

/**
 * Вливание итогов разговора в общую память команды: конспект — в лог,
 * слияние — в общий документ. quiet — фоновый режим без единой печати
 * (при /new и /session); onlyIfFreshDigest — не делать дорогой постройки
 * конспекта (при /exit: нет свежего конспекта — отложим на следующий /new).
 */
async function flushChatMemory(
  app: App,
  target: Session = app.session,
  opts: { quiet?: boolean; onlyIfFreshDigest?: boolean } = {},
): Promise<void> {
  const session = target;
  const quiet = opts.quiet ?? false;
  if (session.messages.length < 6) return; // нечего запоминать
  const fresh = !!(session.digest && session.digestAtCount !== undefined
    && session.messages.length - session.digestAtCount < 10);
  if (fresh && session.digestInLog) return; // с прошлой выгрузки ничего нового
  if (opts.onlyIfFreshDigest && !fresh) {
    printDim('  Итоги этого разговора вольются в общую память позже — при следующем /new.');
    return;
  }

  const digest = fresh && session.digest
    ? session.digest
    : await getSessionDigest(app, session, AbortSignal.timeout(60_000), app.profile.name, quiet);
  if (!digest) return;

  appendChatToLog(app.memory, session.title, digest);
  session.digestInLog = true;
  app.store.save(session);
  try {
    if (!quiet) printDim('  Сохраняю итоги разговора в общую память команды…');
    app.memory.shared = await mergeShared(app.memory.shared, session.title, digest, defaultProvider(app));
    saveTeamMemory(MEMORY_FILE, app.memory);
    if (!quiet) printDim('  … итоги влиты в общую память команды');
  } catch (err) {
    if (!quiet) printDim(`  … не удалось обновить общую память: ${err instanceof Error ? err.message : err}`);
  }
}

/** Очередь фоновых вливаний: закрывают чаты подряд — merges не перетирают друг друга. */
let flushChain: Promise<void> = Promise.resolve();

function queueFlush(app: App, session: Session): void {
  flushChain = flushChain
    .then(() => flushChatMemory(app, session, { quiet: true }))
    .catch(() => {
      // фоновое вливание не критично: конспект не помечен как влитый и повторится при следующем закрытии
    });
}

/** Строки одного сообщения в фирменном формате (шапка с автором и текст) */
function messageRows(m: ChatMessage, team: Agent[]): string[] {
  const agent = team.find((a) => a.id === m.authorId);
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
    const team = loadTeam(join(CONFIG_DIR, 'team.json'));
    console.log(pc.dim('\n  Команда:'));
    for (const agent of team) console.log(rosterLine(agent));
  } catch (err) {
    printError(`проблема с config/team.json: ${err instanceof Error ? err.message : err}`);
  }

  console.log(pc.dim('\n  Провайдеры:'));
  for (const [pid, status] of app.providers) {
    const mark = pid === app.defaultProviderId ? pc.cyan(' ★') : '';
    const state = status.ok
      ? pc.green('✓ готов')
      : pc.yellow(`✗ ${status.note ?? 'не настроен'}`);
    const vision = status.vision ? pc.magenta(' ◉ зрение') : '';
    console.log(
      `  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}${vision}${mark}`,
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

  if (defaultProvider(app).kind === 'mock') {
    console.log(
      pc.yellow('\n  ⚠ Работает MOCK-режим: ответы заготовлены. Впишите API-ключ в .env (см. README).'),
    );
  }

  printDim('\n  /help — команды · @имя — участнику · @session — приложить разговор · Esc — прервать · /exit — выход');
}

function printHelp(): void {
  const rows = COMMANDS.map((c) => {
    const label = (c.cmd + (c.args ? ' ' + c.args : '')).padEnd(18);
    return `    ${label} — ${c.help}`;
  });
  console.log(
    [
      '',
      '  Команды:',
      ...rows,
      '',
      '  Esc или Ctrl+C во время ответа команды — прервать (частичные ответы сохранятся).',
      '  Перенос строки в сообщении: \\ + Enter или Ctrl+Enter; пустая строка — разрыв абзаца;',
      '  двойной Enter или «.» — закончить ввод. Вставка многострочного текста тоже работает.',
      '  В сообщении можно адресовать участников: @марина, @viktor и т.д.',
      '  @session — приложить конспект другого разговора (@session 2 — сразу номер).',
      '  Начните ввод с «/» — под строкой появятся подсказки (фильтруются при наборе), Tab — дополнить.',
      '',
    ].join('\n'),
  );
}

function printTeam(app: App): void {
  try {
    const fullTeam = loadTeam(join(CONFIG_DIR, 'team.json'));
    const inChat = new Set(chatTeam(app.session, fullTeam).map((a) => a.id));
    const cfg = loadToolsConfig(ROOT);
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
  if (!agent.tools?.length) return '';
  const parts: string[] = [];
  const projects = (agent.projects ?? []).filter((p) => cfg.projects.has(p) || p === agent.workspace);
  if (projects.length > 0) parts.push(`проекты: ${projects.join(', ')}`);
  const hosts = agent.hosts ?? [];
  if (hosts.length > 0) parts.push(`серверы: ${hosts.join(', ')}`);
  if (agent.vision) parts.push(`глаза: ${agent.vision}`);
  if (agent.image) parts.push(`рисует: ${agent.image}`);
  const labels = agent.tools.map((t) =>
    t === 'files' ? 'файлы' : t === 'shell' ? 'консоль' : t === 'ssh' ? 'ssh' : t === 'look' ? 'зрение' : 'картинки',
  );
  return pc.dim(` [${labels.join(', ')}${parts.length ? ' · ' + parts.join(' · ') : ''}]`);
}

function printProviders(app: App): void {
  console.log(pc.dim('\n  Провайдеры (★ — основной):'));
  for (const [pid, status] of app.providers) {
    const mark = pid === app.defaultProviderId ? pc.cyan(' ★') : '';
    const state = status.ok ? pc.green('✓ готов') : pc.yellow(`✗ ${status.note ?? 'не настроен'}`);
    const vision = status.vision ? pc.magenta(' ◉ зрение') : '';
    console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}${vision}${mark}`);
  }
  if (app.images.size > 0) {
    console.log(pc.dim('  Картинки (для инструмента image):'));
    for (const [pid, status] of app.images) {
      const state = status.ok ? pc.green('✓ готов') : pc.yellow(`✗ ${status.note ?? 'не настроен'}`);
      console.log(`  • ${pid} (${status.provider.kind}, ${status.provider.model}) ${state}`);
    }
  }
  printDim('  Сменить основной: /provider <id>. Свой провайдер агенту — поля "provider", "vision", "image" в team.json.');
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

/** Ищет агента по номеру из /team, имени или id (регистр и «ё» не важны). */
function findAgentByArg(fullTeam: Agent[], arg: string): Agent | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const n = Number.parseInt(arg, 10);
  if (Number.isInteger(n) && n > 0) return fullTeam[n - 1];
  return fullTeam.find((a) => norm(a.name) === norm(arg) || a.id === norm(arg));
}

async function runCommand(app: App, line: string): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'help':
    case 'h':
      printHelp();
      break;
    case 'new': {
      // чат создаём мгновенно; итоги предыдущего вольются в общую память в фоне
      const old = app.session;
      app.session = app.store.create();
      sessionAllowed.clear(); // разрешения «до конца сессии» не переезжают в новый чат
      printDim(`  Новый разговор ${app.session.id}`);
      await pickParticipants(app);
      queueFlush(app, old);
      break;
    }
    case 'sessions': {
      const list = app.store.list();
      if (list.length === 0) {
        printDim('  Разговоров пока нет.');
        break;
      }
      console.log(pc.dim('\n  Разговоры (свежие сверху):'));
      list.forEach((s, i) => {
        const date = new Date(s.updatedAt).toLocaleString('ru-RU');
        const cur = s.id === app.session.id ? pc.cyan(' ← текущий') : '';
        console.log(`    ${i + 1}. ${s.title} — ${s.count} сообщ., ${date}${cur}`);
      });
      console.log();
      break;
    }
    case 'session': {
      const n = Number.parseInt(arg, 10);
      const target = Number.isInteger(n) ? app.store.list()[n - 1] : undefined;
      const loaded = target ? app.store.load(target.id) : null;
      if (!loaded) {
        printDim(`  Не нашёл разговор №${arg}. Посмотрите список: /sessions`);
        break;
      }
      if (loaded.id !== app.session.id) {
        const old = app.session;
        app.session = loaded;
        sessionAllowed.clear(); // разрешения «до конца сессии» не переезжают в другой чат
        queueFlush(app, old);
      }
      printDim(`  Открыт разговор «${loaded.title}» (${loaded.messages.length} сообщ.)`);
      const line = participantsLine(loaded);
      if (line) printDim(`  Участники: ${line}`);
      replaySession(loaded);
      break;
    }
    case 'history': {
      const n = Number.parseInt(rest[0] ?? '', 10);
      const all = app.session.messages;
      const shown = Number.isInteger(n) && n > 0 ? all.slice(-n) : all;
      if (shown.length === 0) {
        printDim('  Разговор пуст.');
        break;
      }
      let team: Agent[] = [];
      try {
        team = loadTeam(join(CONFIG_DIR, 'team.json'));
      } catch {
        // без team.json печатаем без фирменных цветов
      }
      console.log(
        pc.dim(`\n  Разговор «${app.session.title}» — показано ${shown.length} из ${all.length} сообщений:`),
      );
      for (const m of shown) {
        console.log('');
        for (const row of messageRows(m, team)) console.log(row);
      }
      console.log('');
      break;
    }
    case 'delete': {
      const n = Number.parseInt(arg, 10);
      const meta = Number.isInteger(n) && n > 0 ? app.store.list()[n - 1] : undefined;
      if (!meta) {
        printDim(`  Не нашёл разговор №${arg} — см. /sessions`);
        break;
      }
      if (meta.id === app.session.id) {
        printDim('  Текущий разговор удалить нельзя — сначала /new или /session.');
        break;
      }
      app.store.delete(meta.id);
      printDim(`  Разговор «${meta.title}» удалён.`);
      break;
    }
    case 'team':
      printTeam(app);
      break;
    case 'add': {
      let fullTeam: Agent[] = [];
      try {
        fullTeam = loadTeam(join(CONFIG_DIR, 'team.json'));
      } catch {
        printDim('  team.json недоступен — позвать никого не получится.');
        break;
      }
      if (!arg) {
        printDim('  Кого позвать? /add <имя или номер> (список — /team)');
        break;
      }
      const agent = findAgentByArg(fullTeam, arg);
      if (!agent) {
        printDim(`  Нет участника «${arg}» — см. /team`);
        break;
      }
      if (chatTeam(app.session, fullTeam).some((a) => a.id === agent.id)) {
        printDim(`  ${agent.emoji} ${agent.name} уже в чате.`);
        break;
      }
      app.session.participants ??= fullTeam.map((a) => a.id);
      if (!app.session.participants.includes(agent.id)) app.session.participants.push(agent.id);
      app.store.save(app.session);
      printDim(`  ${agent.emoji} ${agent.name} присоединился к чату.`);
      break;
    }
    case 'out': {
      let fullTeam: Agent[] = [];
      try {
        fullTeam = loadTeam(join(CONFIG_DIR, 'team.json'));
      } catch {
        printDim('  team.json недоступен — выгнать никого не получится.');
        break;
      }
      if (!arg) {
        printDim('  Кого выгнать? /out <имя или номер> (список — /team)');
        break;
      }
      const kicked = findAgentByArg(fullTeam, arg);
      if (!kicked) {
        printDim(`  Нет участника «${arg}» — см. /team`);
        break;
      }
      if (!chatTeam(app.session, fullTeam).some((a) => a.id === kicked.id)) {
        printDim(`  ${kicked.emoji} ${kicked.name} и так не в этом чате.`);
        break;
      }
      // материализуем явный список, иначе выгон «вернул» бы всю команду
      app.session.participants ??= fullTeam.map((a) => a.id);
      if (app.session.participants.length <= 1) {
        printDim('  Это последний участник — совсем без команды нельзя. Создайте новый: /new');
        break;
      }
      app.session.participants = app.session.participants.filter((id) => id !== kicked.id);
      app.store.save(app.session);
      printDim(`  ${kicked.emoji} ${kicked.name} покинул(а) чат. Реплики останутся в истории.`);
      break;
    }
    case 'providers':
      printProviders(app);
      break;
    case 'provider':
      if (!arg) {
        printDim(`  Основной провайдер: ${app.defaultProviderId}`);
      } else if (app.providers.has(arg)) {
        app.defaultProviderId = arg;
        printDim(`  Основной провайдер: ${arg}`);
      } else {
        printDim(`  Нет провайдера «${arg}». Доступны: ${[...app.providers.keys()].join(', ')}`);
      }
      break;
    case 'all':
      printDim('  Команды /all больше нет — состав отвечает по решению модератора или @упоминания.');
      break;
    case 'memory': {
      let memTeam: Agent[] = [];
      try {
        memTeam = loadTeam(join(CONFIG_DIR, 'team.json'));
      } catch {
        // без team.json показываем только общую память
      }
      if (arg === 'shared') {
        if (app.memory.shared) {
          printDim('\n  Общая память команды:');
          for (const line of app.memory.shared.split('\n')) console.log('  ' + line);
        } else {
          printDim('  Общая память пока пуста — заполняется при закрытии разговоров (/new, /exit).');
        }
        break;
      }
      if (!arg) {
        const withMem = memTeam.filter((a) => app.session.memories?.[a.id]);
        printDim('  Чья память: /memory <имя> (например, /memory Глеб), /memory shared — общая.');
        printDim(
          withMem.length > 0
            ? `  Уже помнят что-то: ${withMem.map((a) => a.name).join(', ')}`
            : '  Пока никто не «осмыслил» разговор (память обновляется примерно раз в 12 сообщений).',
        );
        break;
      }
      const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
      const who = memTeam.find((a) => norm(a.name) === norm(arg) || a.id === norm(arg));
      if (!who) {
        printDim(`  Нет участника «${arg}» — см. /team`);
        break;
      }
      const mine = app.session.memories?.[who.id];
      const glob = app.memory.agents[who.id];
      console.log(pc.dim(`\n  Что ${who.name} помнит в разговоре «${app.session.title}»:`));
      console.log(`  Задача: ${mine?.task ?? '—'}`);
      console.log(`  Отношение к вам: ${mine?.towardUser ?? '—'}`);
      if (mine?.ties && Object.keys(mine.ties).length > 0) {
        const byId = new Map(memTeam.map((a) => [a.id, a.name]));
        for (const [id, note] of Object.entries(mine.ties)) {
          console.log(`  ${byId.get(id) ?? id}: ${note}`);
        }
      } else {
        console.log('  Коллеги: —');
      }
      console.log(pc.dim(`  Из других разговоров: ${glob?.otherChats ?? '—'}`));
      console.log();
      break;
    }
    case 'me': {
      const parts = arg.split(';').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) {
        const p = app.profile;
        printDim(`  Вы: ${p.name}${p.role ? ' — ' + p.role : ''}${p.about ? ' — ' + p.about : ''}`);
        printDim('  Представиться: /me Имя; роль; пара слов о себе (сохраняется в config/user.json)');
        break;
      }
      app.profile = { name: parts[0], role: parts[1], about: parts[2] };
      try {
        writeFileSync(USER_FILE, JSON.stringify(app.profile, null, 2) + '\n');
        printDim(
          `  Запомнил: вы — ${app.profile.name}` +
          (app.profile.role ? ` (${app.profile.role})` : '') +
          '. Команда теперь знает, кто вы.',
        );
      } catch (err) {
        printError(`не удалось сохранить ${USER_FILE}: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case 'exit':
    case 'quit':
    case 'q':
      exitRequested = true;
      if (editor) {
        requestExit();
        return true;
      }
      rl?.close();
      return true;
    default:
      printDim('  Неизвестная команда. /help — список команд.');
  }
  return false;
}

async function main(): Promise<void> {
  // конфиг экрана читаем до всего вывода: ошибка конфига видна в обычном терминале
  const ui = loadUiConfig(UI_FILE, process.stdout.columns || 0);
  const store = new SessionStore(DATA_DIR);
  const providersFile = join(CONFIG_DIR, 'providers.json');
  const loaded = loadProviders(providersFile);
  const images = loadImageProviders(providersFile);
  // при старте продолжаем последний разговор, а не плодим пустые сессии
  const existing = store.list();
  const session = existing.length > 0 ? store.load(existing[0].id) ?? store.create() : store.create();
  const app: App = {
    store,
    session,
    providers: loaded.providers,
    images: images.images,
    defaultProviderId: loaded.defaultId,
    profile: loadUserProfile(USER_FILE),
    memory: loadTeamMemory(MEMORY_FILE),
  };
  appRef = app;

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
            screen?.setHints(hintRowsFor(buf, ctx) ?? STATIC_HINTS);
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
    'Представиться команде: /me Имя; роль; о себе',
  );
  // Прошлый разговор сразу в панель: внизу виден хвост, вся старая история —
  // колесом/PgUp. В линейном режиме не нужно — там прокручивает сам терминал.
  if (screen && session.messages.length > 0) {
    let team: Agent[] = [];
    try {
      team = loadTeam(join(CONFIG_DIR, 'team.json'));
    } catch {
      // без team.json история засеивается без фирменных цветов агентов
    }
    const rows: string[] = [];
    for (const m of session.messages) {
      rows.push('');
      rows.push(...messageRows(m, team));
    }
    screen.seed(rows);
    printDim(
      `  Продолжаю разговор «${session.title}» (${session.messages.length} сообщ.) — /new для нового, /sessions для списка`,
    );
  }
  // страховка от потерянных первых кадров терминала: одна полная перерисовка
  // после того, как весь стартовый вывод уже в состоянии экрана
  screen?.repaint();

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
        const done = await runCommand(app, line);
        if (done) break;
      } else {
        await handleMessage(app, line);
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
  // иначе откладываем до следующего /new — выход не должен ждать LLM
  if (exitRequested) {
    try {
      await flushChatMemory(app, app.session, { onlyIfFreshDigest: true });
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
