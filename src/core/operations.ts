/**
 * Манифест операций: единый источник для всего, чем можно управлять.
 * Каноническое имя операции — `группа.глагол` — одновременно:
 *   - текстовая команда:  `/группа глагол аргументы`   (обзор группы — просто `/группа`);
 *   - rpc-метод WS:       то же имя строкой (GUI, скрипты);
 *   - тема справки:       /help печатает этот же список.
 * Никаких алиасов и коротких форм: одно имя — одна операция (активная фаза
 * разработки, легаси не тащим). Транспорт (`user_message`, `abort`, `file`,
 * диалоги confirm/choose) — не операции и здесь не живёт.
 *
 * Адресация — только id (строчная латиница, цифры, внутри . - _): агенты —
 * по id, разговоры — по id, проекты — по id, записи секретов (ящики, серверы,
 * боты) — по id. Имена и номера из списков адресацией не являются.
 *
 * Состояние: `new` всегда создаёт и открывает; `close` — честное «ничего
 * не открыто»; текущее (проект/разговор) удалить нельзя — сначала close.
 * Операции с needsSession работают с ТЕКУЩИМ разговором и требуют, чтобы
 * он был открыт.
 *
 * Реализации опираются на те же helpers, что исполняет менеджер переговорки
 * своими JSON-действиями: валидация и tmp+rename-откат общие. Ошибки летят
 * вызывающему (терминал покажет, сервер ушлёт error/rpc_error).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isToolId } from '../ids.js';
import { loadTeam } from '../agents.js';
import {
  addMailRecord,
  addHostRecord,
  addMessengerRecord,
  addTeamAgent,
  grantTool,
  loadHostsFile,
  loadMailsFile,
  loadManagerConfig,
  loadMessengersFile,
  removeMailAccount,
  removeMessengerBot,
  removeProjectHost,
  removeTeamAgent,
  revokeTool,
  updateHostRecord,
  updateMailRecord,
  updateManagerConfig,
  updateMessengerRecord,
  updateTeamAgent,
} from '../manager.js';
import { addModelConfig, loadModels, removeModelConfig, updateModelConfig } from '../providers/registry.js';
import { resolveEndpoints } from '../mail.js';
import { agentToolIds, BUILTIN_TOOL_IDS } from '../tools-api.js';
import { t, tf, applyLocale, knownLanguages, localeId } from '../i18n.js';
import { AGENTS_DIR, DT_HOME, MANAGER_FILE, MODELS_DIR, PROJECTS_DIR, PROJECT_DIR, PROJECT_FILE, SETTINGS_FILE, TOOLS_DIR, WORKSPACE } from '../paths.js';
import { listProjects } from './projects.js';
import { looksLikePath } from '../cli-project.js';
import { loadSettings } from '../settings.js';
import { chatTeam, isSessionRef, requireProject, requireSession, type App, type Engine } from './engine.js';
import { loadSchedule, saveSchedule } from './schedule.js';
import { bgDelete, bgInfo, bgKill, bgList, bgLog, formatBgDuration, parseBgSpawn, spawnBg } from './bg.js';
import {
  applyHomeImport,
  applyProjectImport,
  applySessionImport,
  applySettingsImport,
  homeEntries,
  packEntriesZip,
  projectEntries,
  readZipEntries,
  sessionEntriesById,
  settingsEntries,
} from './transfer.js';
import type { Agent, ManagerUpdateFields, ModelRef } from '../types.js';

/** Аргумент операции — для справки, подсказок и проверки количества. */
export interface OpArg {
  /** Как зовём аргумент в подсказках: «id», «файл.zip»… */
  name: string;
  required: boolean;
  /** Уточнение для панели подсказок (что подставлять: id, файлы, папки…) */
  hint?: 'sessions' | 'agents' | 'chat' | 'models' | 'projects' | 'schedule' | 'path' | 'bg' | 'lang';
}

export interface OpSpec {
  /** Каноническое имя: `группа.глагол`; оно же — rpc-метод WS */
  name: string;
  args?: OpArg[];
  title: string;
  help: string;
  /** Обзор группы: разрешает вызов без глагола (`/agents` = agents.list) */
  implicit?: boolean;
  /** Операция требует открытого проекта (разговоры, секреты проекта) */
  needsProject?: boolean;
  /** Операция работает с ТЕКУЩИМ разговором — он должен быть открыт */
  needsSession?: boolean;
  run: (engine: Engine, rest: string[], signal?: AbortSignal) => Promise<string[]>;
}

// ── просмотры (бесцветные: терминал рисует свои цветные версии сам) ─────────

function sessionsText(app: App): string[] {
  // список работает всегда, когда открыт проект — даже без разговора (/session close)
  if (!app.store) return [t('NO_OPEN_PROJECT_START_WITH_PROJECT_NEW_ID')];
  const list = app.store.list();
  if (list.length === 0) return [t('NO_SESSIONS_YET_SESSION_NEW_ID')];
  const fmt = (ts: number) => new Date(ts).toLocaleString('ru-RU');
  const lines = ['', t('SESSIONS_NEWEST_FIRST')];
  for (const s of list) {
    const cur = s.id === app.session?.id ? t('CURRENT_2') : '';
    lines.push(`• ${s.id} — ${s.title} — ${t('MSGS')} ${s.count}${cur}`);
    lines.push(`   ${t('CREATED')} ${fmt(s.createdAt)} · ${t('LATEST_MESSAGE')} ${fmt(s.updatedAt)}`);
  }
  lines.push('');
  return lines;
}

/** Перечитывает карточки моделей после правки файлов; app.models/images — новые карты. */
export function reloadModels(engine: Engine): void {
  const { models, images } = loadModels(MODELS_DIR);
  engine.app.models = models;
  engine.app.images = images;
}

function agentsText(app: App): string[] {
  let fullTeam: Agent[] = [];
  try {
    fullTeam = loadTeam(AGENTS_DIR);
  } catch {
    return [t('AGENTS_JSON_IS_UNAVAILABLE')];
  }
  const inChat = new Set(app.session ? chatTeam(app.session, fullTeam).map((a) => a.id) : []);
  const lines = [
    tf('MEETING_ROOM_MANAGER_CONCIERGE_AND_SETTINGS', {
      name: app.mgr.name, model: app.mgr.model.id ?? '',
    }),
  ];
  for (const a of fullTeam) {
    const tools = agentToolIds(a);
    const marks = [
      tools.length > 0 ? tf('TOOLS_LIST', { list: tools.join(', ') }) : '',
      a.model?.id ? tf('MODEL_ID', { id: a.model.id }) : '',
    ].filter(Boolean);
    lines.push(
      `• ${a.id} — ${a.name}${a.description ? ' — ' + a.description : ''}` +
      (marks.length > 0 ? ` [${marks.join(' · ')}]` : '') +
      (app.session && !inChat.has(a.id) ? ` · ${t('NOT_IN_THIS_CHAT')} (/session agent add ${a.id})` : ''),
    );
  }
  return lines;
}

/** Тысячи — в «128k», меньше тысячи — как есть (для окон моделей). */
function ctxK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function modelsText(app: App): string[] {
  const lines: string[] = [];
  for (const [id, s] of app.models) {
    const state = s.ok ? t('DONE') : `✗ ${s.note ?? t('NOT_CONFIGURED')}`;
    const w = s.config?.contextWindow;
    lines.push(
      `• ${id} (${s.provider.kind}, ${s.provider.model}) ${state}` +
      (s.vision ? ` ◉ ${t('VISION')}` : '') +
      (typeof w === 'number' && w > 0 ? ` · ${tf('WINDOW_N', { n: ctxK(w) })}` : '') +
      (id === app.settings.model?.id ? ` ${t('DEFAULT')}` : '') +
      (id === app.mgr.model.id ? ` ${t('MANAGER')}` : ''),
    );
  }
  for (const [id, s] of app.images) {
    lines.push(`  ${t('IMAGES')} ${id} ${s.ok ? t('DONE') : `✗ ${s.note ?? t('NOT_CONFIGURED')}`}`);
  }
  return lines;
}

/** /session history [from] [to]: срез включительно; один аргумент — от N до конца. */
function historyText(app: App, fromStr?: string, toStr?: string): string[] {
  const { session } = requireSession(app);
  const all = session.messages;
  let from = 1;
  let to = all.length;
  if (fromStr !== undefined) {
    const f = Number.parseInt(fromStr, 10);
    if (!Number.isInteger(f) || f <= 0) return [tf('FROM_A_MESSAGE_NUMBER_FROM_1_NOT_V', { v: fromStr })];
    from = f;
  }
  if (toStr !== undefined) {
    const to2 = Number.parseInt(toStr, 10);
    if (!Number.isInteger(to2) || to2 < from) return [tf('TO_A_MESSAGE_NUMBER_NOT_LESS_THAN_FROM', { from, v: toStr })];
    to = to2;
  }
  const shown = all.slice(from - 1, to);
  if (shown.length === 0) return [t('THE_SESSION_IS_EMPTY_OR_THE_SLICE_IS')];
  const lines = [
    tf('SESSION_TITLE_SHOWING_SHOWN_OF_ALL_MESSAGES', { title: session.title, shown: shown.length, all: all.length }),
    '',
  ];
  for (const m of shown) {
    const who = m.authorId === 'user'
      ? t('YOU')
      : m.authorId === 'tool'
        ? t('TOOLS')
        : isSessionRef(m)
          ? `📎 ${m.authorName}`
          : m.authorName;
    lines.push('', `${who}: ${m.text}`);
  }
  lines.push('');
  return lines;
}

function memoryText(app: App, arg: string): string[] {
  let memTeam: Agent[] = [];
  try {
    memTeam = loadTeam(AGENTS_DIR);
  } catch {
    // без agents.json показываем только общую память
  }
  const { session } = requireSession(app);
  if (arg === 'shared') {
    if (!app.memory.shared) {
      return [t('THE_SHARED_MEMORY_IS_STILL_EMPTY_IT_FILLS')];
    }
    return ['', t('TEAM_SHARED_MEMORY'), ...app.memory.shared.split('\n'), ''];
  }
  if (!arg) {
    const withMem = memTeam.filter((a) => session.memories?.[a.id]);
    return [
      t('WHOSE_MEMORY_MEMORY_ID_E_G_MEMORY_GLEB'),
      withMem.length > 0
        ? tf('ALREADY_REMEMBER_SOMETHING_IDS', { ids: withMem.map((a) => a.id).join(', ') })
        : t('NOBODY_HAS_REFLECTED_ON_THE_SESSION_YET_MEMORY'),
    ];
  }
  const who = memTeam.find((a) => a.id === arg.trim().toLowerCase());
  if (!who) return [tf('NO_AGENT_WITH_ID_ID_SEE_AGENTS', { id: arg })];
  const mine = session.memories?.[who.id];
  const glob = app.memory.agents[who.id];
  const lines = [
    '',
    tf('WHAT_NAME_ID_REMEMBERS_IN_SESSION_TITLE', { name: who.name, id: who.id, title: session.title }),
    `${t('TASK')} ${mine?.task ?? '—'}`,
    `${t('HOW_THEY_SEE_YOU')} ${mine?.towardUser ?? '—'}`,
  ];
  if (mine?.ties && Object.keys(mine.ties).length > 0) {
    const byId = new Map(memTeam.map((a) => [a.id, a.name] as const));
    for (const [id, note] of Object.entries(mine.ties)) lines.push(`${byId.get(id) ?? id}: ${note}`);
  } else {
    lines.push(`${t('COLLEAGUES')} —`);
  }
  lines.push(`${t('FROM_OTHER_SESSIONS')} ${glob?.otherChats ?? '—'}`, '');
  return lines;
}

function projectListText(): string[] {
  const lines = ['', t('PROJECTS_OPEN_PROJECT_OPEN_ID_PATH')];
  const all = listProjects();
  if (all.length === 0 && !PROJECT_DIR) {
    lines.push(t('NONE_YET_PROJECT_NEW_ID_FOLDER_WILL_CREATE'));
  }
  const noPath = t('FOLDER_NOT_SET');
  for (const p of all) {
    const cur = Boolean(PROJECT_DIR) && basename(PROJECT_DIR) === p.id;
    lines.push(
      cur
        ? tf('ID_PATH_CURRENT', { id: p.id, path: p.path ?? noPath })
        : tf('ID_PATH', { id: p.id, path: p.path ?? noPath }),
    );
  }
  lines.push('');
  return lines;
}

/** Состав текущего чата: кто в разговоре, кого можно позвать. */
function sessionAgentsText(engine: Engine): string[] {
  const app = engine.app;
  const { session } = requireSession(app);
  let fullTeam: Agent[] = [];
  try {
    fullTeam = loadTeam(AGENTS_DIR);
  } catch {
    return [t('AGENTS_JSON_IS_UNAVAILABLE')];
  }
  const inChat = chatTeam(session, fullTeam);
  const outside = fullTeam.filter((a) => !inChat.some((c) => c.id === a.id));
  const lines = [
    tf('IN_THE_CHAT_OF_SESSION_TITLE', { title: session.title }),
    ...inChat.map((a) => `• ${a.id} — ${a.name}${a.id === 'manager' ? ` — ${t('MANAGER_2')}` : ''}`),
  ];
  if (outside.length > 0) {
    lines.push('', t('CAN_INVITE_SESSION_AGENT_ADD_ID'), ...outside.map((a) => `• ${a.id} — ${a.name}`));
  }
  lines.push('');
  return lines;
}

/** id из хвоста команды: через пробел или запятую, без пустых и повторов. */
function expandIds(rest: string[]): string[] {
  return [...new Set(rest.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean))];
}

/** Строка списка фоновой задачи: статусы для человека (тул рендерит свой вид агенту). */
function bgTaskLine(task: ReturnType<typeof bgInfo>): string {
  const emoji =
    task.status === 'running' ? '⏳' : task.status === 'done' ? '✅' : task.status === 'failed' ? '❌' : task.status === 'timeout' ? '⏱' : task.status === 'killed' ? '⛔' : '❓';
  const dur = formatBgDuration((task.endedAt ?? Date.now()) - task.startedAt);
  const who = task.by === 'user' ? t('YOU_2') : task.by;
  const extra =
    task.status === 'running'
      ? `${emoji} идёт ${dur}${task.pid ? `, pid ${task.pid}` : ''}`
      : `${emoji} ${task.status}, ${dur}${task.exitCode !== undefined ? `, код ${task.exitCode}` : ''}`;
  return `${task.id} «${task.title}» — ${extra} (поставил: ${who})`;
}

/** /session agent add|delete <id…|all>: событие чата пишется репликой менеджера. */
function sessionAgentChange(engine: Engine, rest: string[], verb: 'add' | 'delete'): string[] {
  const emptyHint = verb === 'add'
    ? t('WHOM_TO_INVITE_SESSION_AGENT_ADD_ID_ALL')
    : t('WHOM_TO_REMOVE_SESSION_AGENT_DELETE_ID_ALL');
  let fullTeam: Agent[];
  try {
    fullTeam = loadTeam(AGENTS_DIR);
  } catch {
    return [t('AGENTS_JSON_IS_UNAVAILABLE_CANNOT_CHANGE_THE_CHAT')];
  }
  const req = expandIds(rest);
  if (req.length === 0) return [emptyHint];
  // all — вся команда (позвать) или все, кто в чате (вывести)
  const session = engine.app.session;
  let ids = req;
  if (req.length === 1 && req[0].toLowerCase() === 'all') {
    if (verb === 'add') {
      const inChat = new Set(session ? chatTeam(session, fullTeam).map((a) => a.id) : []);
      ids = fullTeam.map((a) => a.id).filter((id) => !inChat.has(id));
      if (ids.length === 0) {
        return [fullTeam.length === 0 ? t('THE_TEAM_IS_EMPTY_AGENT_NEW_ID_WILL') : t('THE_WHOLE_TEAM_IS_ALREADY_IN_THE_CHAT')];
      }
    } else {
      ids = session ? chatTeam(session, fullTeam).map((a) => a.id) : [];
      if (ids.length === 0) return [t('NOBODY_BUT_THE_MANAGER_IS_IN_THE_CHAT')];
    }
  }
  const notes: string[] = [];
  for (const id of ids) {
    const res = verb === 'add' ? engine.addToChat(id, fullTeam) : engine.removeFromChat(id, fullTeam);
    if (res.changed) engine.serviceLine(res.text);
    else notes.push(res.text);
  }
  // событие чата ядро уже записало в хронику репликой менеджера — заметкой не дублируем
  return notes;
}

/** Шаблон нового тула: честный hello world; описание берёт из карточки дома (config.description). */
function toolTemplate(id: string): string {
  return [
    '/**',
    ` * Тул «${id}» — шаблон: на любое тело отвечает hello world.`,
    ' * Замените desc и run на своё; check() решает: allow — молча, ask — спросить человека, deny — отказ.',
    ' * Файл перечитывается перед каждым раундом — правки подхватываются без перезапуска.',
    ' * config — карточка тула (карточка дома + карточка агента поверх): description читается здесь,',
    ' * остальные поля — ваши собственные настройки.',
    ' */',
    'export default (config: Record<string, unknown> = {}) => ({',
    "  desc: typeof config.description === 'string' && config.description.trim()",
    '    ? config.description.trim()',
    "    : 'отвечает hello world',",
    "  check: () => 'allow' as const,",
    "  run: async () => 'hello world',",
    '});',
    '',
  ].join('\n');
}

/**
 * Разбор `поле=значение` в словарь; ключи могут быть точечными путями
 * (`model.id=…`) — вызывающий сам решает, какие пути разрешены. temperature
 * и maxTokens — числом; пустое значение — ошибка.
 */
function parseFields(pairs: string[]): Record<string, string | number> | string[] {
  const out: Record<string, string | number> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) return [tf('A_FIELD_WITHOUT_A_VALUE_PAIR_EXPECTED_FIELD', { pair })];
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (!key) return [tf('EMPTY_FIELD_NAME_PAIR', { pair })];
    if (!value) return [tf('EMPTY_VALUE_FOR_FIELD_KEY', { key })];
    if (key === 'temperature' || key === 'maxTokens' || key.endsWith('.temperature') || key.endsWith('.maxTokens')) {
      const num = Number(value);
      if (!Number.isFinite(num)) return [tf('KEY_EXPECTED_A_NUMBER_NOT_VALUE', { key, value })];
      out[key] = num;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Точечные пути `model.*` / `serviceModel.*` (model.id, model.temperature…)
 * в дополнение к плоским полям. Возвращает { fields, ошибки }: fields.model /
 * fields.serviceModel — мердж текущей ссылки с патчем (id сохраняется).
 */
function modelRefPatch(
  parsed: Record<string, string | number>,
  bases: readonly string[],
  current: Record<string, ModelRef | undefined>,
): { patch: Record<string, ModelRef>; error?: string[] } {
  const patch: Record<string, ModelRef> = {};
  const SUBS = new Set(['id', 'temperature', 'maxTokens', 'thinking', 'reasoning']);
  for (const [k, v] of Object.entries(parsed)) {
    const dot = k.indexOf('.');
    if (dot === -1) continue;
    const base = k.slice(0, dot);
    const sub = k.slice(dot + 1);
    if (!bases.includes(base) || sub.includes('.')) {
      return { patch: {}, error: [tf('UNKNOWN_NESTED_FIELD_KEY_ALLOWED_BASES_ID_TEMPERATURE', { key: k, bases: bases.join(', ') + '.*' })] };
    }
    if (!SUBS.has(sub)) {
      return { patch: {}, error: [tf('UNKNOWN_BASE_SUB_ALLOWED_SUBS', { base, sub, subs: [...SUBS].join(', ') })] };
    }
    patch[base] = { ...(patch[base] ?? current[base] ?? {}), [sub]: v } as ModelRef;
  }
  return { patch };
}

// ── экспорт: имена файлов и папка ────────────────────────────────────────────

/** Метка времени для имён архивов: «202610271430». */
export const stamp = (): string => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

/** Имя профиля для имени файла: чужие символы → дефис. */
export const profileLabel = (name: string): string =>
  name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || 'me';

/** Куда класть архивы экспорта: папка проекта в доме; нет проекта — дом. */
function exportTargetDir(): string {
  const dir = PROJECT_DIR || DT_HOME;
  // путь проекта мог быть зарегистрирован, а папка — ещё не создана
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** /export — весь дом: настройки, команда, модели с ключами, все проекты и разговоры. */
function exportHomeZip(engine: Engine): string[] {
  const entries = homeEntries();
  const file = join(exportTargetDir(), `home-${stamp()}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('EXPORT_FILE_N_RECORDS_INCLUDES_MODEL_KEYS_TREAT', { file, n: entries.length })];
}

/** /settings export — настройки без проектов; в имени файла — профиль. */
function exportSettingsZip(engine: Engine): string[] {
  const entries = settingsEntries();
  const file = join(exportTargetDir(), `settings-${profileLabel(engine.app.profile.name)}-${stamp()}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('EXPORT_FILE_N_RECORDS_INCLUDES_MODEL_KEYS_TREAT', { file, n: entries.length })];
}

/** /project export — только текущий проект: project.json (с секретами) и разговоры. */
function exportProjectZip(engine: Engine): string[] {
  if (!PROJECT_DIR) return [t('NO_OPEN_PROJECT_NOTHING_TO_EXPORT')];
  const id = basename(PROJECT_DIR);
  let entries: ReturnType<typeof projectEntries>;
  try {
    entries = projectEntries(id);
  } catch (err) {
    return [tf('COULD_NOT_PACK_THE_ARCHIVE_OF_PROJECT_ID', { id, err: err instanceof Error ? err.message : String(err) })];
  }
  const file = join(exportTargetDir(), `project-${id}-${stamp()}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('EXPORT_FILE_N_RECORDS_PROJECT_JSON_AND_SESSIONS', { file, n: entries.length })];
}

/** /session export — только текущий разговор. */
function exportSessionZip(engine: Engine): string[] {
  const app = engine.app;
  const { session } = requireSession(app);
  const proj = PROJECT_DIR ? basename(PROJECT_DIR) : 'home';
  const entries = sessionEntriesById(app, session.id);
  const file = join(exportTargetDir(), `session-${proj}-${session.id}-${stamp()}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('EXPORT_FILE_N_RECORDS', { file, n: entries.length })];
}

// ── манифест ─────────────────────────────────────────────────────────────────

export const OPERATIONS: OpSpec[] = [
  // разговоры
  {
    name: 'sessions.list', implicit: true, needsProject: true, title: 'TITLE_SESSIONS_LIST',
    help: 'HELP_SESSIONS_LIST',
    run: async (engine) => sessionsText(engine.app),
  },
  {
    name: 'session.new',
    args: [{ name: 'id', required: false }],
    needsProject: true,
    title: 'TITLE_SESSION_NEW',
    help: 'HELP_SESSION_NEW',
    run: async (engine, rest, signal) => {
      if (rest.length > 1) return [t('SYNTAX_SESSION_NEW_ID_A_ONE_WORD_ID')];
      const id = rest[0];
      await engine.newSession(signal ?? new AbortController().signal, id);
      return [];
    },
  },
  {
    name: 'session.open',
    args: [{ name: 'id', required: true, hint: 'sessions' }],
    needsProject: true,
    title: 'TITLE_SESSION_OPEN',
    help: 'HELP_SESSION_OPEN',
    run: async (engine, rest) => {
      const id = rest.join(' ').trim();
      if (!id) return [t('SYNTAX_SESSION_OPEN_ID_LIST_SESSIONS')];
      engine.openSessionById(id);
      return [];
    },
  },
  {
    name: 'session.close', needsProject: true,
    title: 'TITLE_SESSION_CLOSE',
    help: 'HELP_SESSION_CLOSE',
    run: async (engine) => [engine.closeSession()],
  },
  {
    name: 'session.delete',
    args: [{ name: 'id…', required: true, hint: 'sessions' }],
    needsProject: true,
    title: 'TITLE_SESSION_DELETE',
    help: 'HELP_SESSION_DELETE',
    run: async (engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('SYNTAX_SESSION_DELETE_ID_LIST_SESSIONS')];
      return ids.map((id) => engine.deleteSessionById(id));
    },
  },
  {
    name: 'session.update',
    args: [{ name: 'title=…', required: false }],
    needsProject: true, needsSession: true,
    title: 'TITLE_SESSION_UPDATE',
    help: 'HELP_SESSION_UPDATE',
    run: async (engine, rest) => {
      const parsed = rest.length > 0 ? parseFields(rest) : {};
      if (Array.isArray(parsed)) return parsed;
      const keys = Object.keys(parsed);
      if (keys.some((k) => k !== 'title')) {
        return [t('A_SESSION_HAS_ONE_FIELD_TITLE_WITH_NO')];
      }
      return [await engine.renameSession(typeof parsed.title === 'string' ? parsed.title : undefined)];
    },
  },
  {
    name: 'session.history',
    args: [
      { name: 'from', required: false },
      { name: 'to', required: false },
    ],
    needsProject: true, needsSession: true,
    title: 'TITLE_SESSION_HISTORY',
    help: 'HELP_SESSION_HISTORY',
    run: async (engine, rest) => historyText(engine.app, rest[0], rest[1]),
  },
  {
    name: 'session.export', needsProject: true, needsSession: true,
    title: 'TITLE_SESSION_EXPORT',
    help: 'HELP_SESSION_EXPORT',
    run: async (engine) => exportSessionZip(engine),
  },
  {
    name: 'session.import',
    args: [{ name: 'файл.zip', required: true }],
    needsProject: true,
    title: 'TITLE_SESSION_IMPORT',
    help: 'HELP_SESSION_IMPORT',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('SYNTAX_SESSION_IMPORT_FILE_ZIP')];
      if (!existsSync(file)) return [tf('NO_FILE_FILE', { file })];
      const entries = readZipEntries(readFileSync(file));
      if (!entries.some((e) => e.rel === 'session.json')) {
        return [t('NO_SESSION_JSON_IN_THE_ARCHIVE_IS_IT')];
      }
      return [await applySessionImport(engine.app, entries)];
    },
  },
  {
    name: 'session.agents', needsProject: true, needsSession: true,
    title: 'TITLE_SESSION_AGENTS',
    help: 'HELP_SESSION_AGENTS',
    run: async (engine) => sessionAgentsText(engine),
  },
  {
    name: 'session.agent.add',
    args: [
      { name: 'id…|all', required: true, hint: 'agents' },
    ],
    needsProject: true, needsSession: true,
    title: 'TITLE_SESSION_AGENT_ADD',
    help: 'HELP_SESSION_AGENT_ADD',
    run: async (engine, rest) => sessionAgentChange(engine, rest, 'add'),
  },
  {
    name: 'session.agent.delete',
    args: [
      { name: 'id…|all', required: true, hint: 'chat' },
    ],
    needsProject: true, needsSession: true,
    title: 'TITLE_SESSION_AGENT_DELETE',
    help: 'HELP_SESSION_AGENT_DELETE',
    run: async (engine, rest) => sessionAgentChange(engine, rest, 'delete'),
  },

  // весь дом
  {
    name: 'export', title: 'TITLE_EXPORT',
    help: 'HELP_EXPORT',
    run: async (engine) => exportHomeZip(engine),
  },
  {
    name: 'import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'TITLE_IMPORT',
    help: 'HELP_IMPORT',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('SYNTAX_IMPORT_FILE_ZIP')];
      if (!existsSync(file)) return [tf('NO_FILE_FILE', { file })];
      const entries = readZipEntries(readFileSync(file));
      const ok = await engine.confirmAction(
        t('IMPORT_THE_WHOLE_APP_FROM_THIS_ARCHIVE'),
        t('SETTINGS_PROFILE_MODELS_TEAM_MEMORY_AND_THE_SCHEDULE'),
      );
      if (!ok) return [t('IMPORT_CANCELLED')];
      return [applyHomeImport(engine.app, entries)];
    },
  },

  // команда
  {
    name: 'agents.list', implicit: true, title: 'TITLE_AGENTS_LIST',
    help: 'HELP_AGENTS_LIST',
    run: async (engine) => agentsText(engine.app),
  },
  {
    name: 'agent.new',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: false },
    ],
    title: 'TITLE_AGENT_NEW',
    help: 'HELP_AGENT_NEW',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id) return [t('SYNTAX_AGENT_NEW_ID_FIELD_VALUE_THEN_AGENT')];
      if (!/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/.test(id)) {
        return [tf('ID_ID_VIOLATES_THE_MASK_LOWERCASE_LATIN_LETTERS', { id })];
      }
      const fields: Record<string, unknown> = { id, name: id };
      if (pairs.length > 0) {
        const parsed = parseFields(pairs);
        if (Array.isArray(parsed)) return parsed;
        const tempKey = Object.keys(parsed).find((k) => k.toLowerCase() === 'temperature');
        if (tempKey !== undefined) return [tf('TEMPERATURE_IS_NO_LONGER_AN_AGENT_FIELD_TEMPERATURE', { v: String(parsed[tempKey]) })];
        const { patch, error } = modelRefPatch(parsed, ['model'], {});
        if (error) return error;
        for (const [k, v] of Object.entries(parsed)) {
          if (k.includes('.')) continue;
          fields[k.toLowerCase()] = v;
        }
        if (patch.model) fields.model = patch.model;
      }
      return [addTeamAgent(AGENTS_DIR, fields as unknown as Parameters<typeof addTeamAgent>[1], engine.app.models)];
    },
  },
  {
    name: 'agent.update',
    args: [
      { name: 'id', required: true, hint: 'agents' },
      { name: 'поле=значение…', required: true },
    ],
    title: 'TITLE_AGENT_UPDATE',
    help: 'HELP_AGENT_UPDATE',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [
          t('SYNTAX_AGENT_UPDATE_ID_FIELD_VALUE'),
          t('FIELDS_NAME_COLOR_DESCRIPTION_PROMPT_WORKSPACE_VISION'),
        ];
      }
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      const tempKey = Object.keys(parsed).find((k) => k.toLowerCase() === 'temperature');
      if (tempKey !== undefined) return [tf('TEMPERATURE_IS_NO_LONGER_AN_AGENT_FIELD_TEMPERATURE', { v: String(parsed[tempKey]) })];
      // текущая ссылка агента — база для мерджа model.*
      let current: ModelRef | undefined;
      try {
        current = loadTeam(AGENTS_DIR).find((a) => a.id === id.trim().toLowerCase())?.model;
      } catch {
        // нет agents.json — updateTeamAgent сам ругнётся
      }
      const { patch, error } = modelRefPatch(parsed, ['model'], { model: current });
      if (error) return error;
      const fields: ManagerUpdateFields = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k.includes('.')) continue;
        (fields as Record<string, string | number>)[k.toLowerCase()] = v;
      }
      if (patch.model) fields.model = patch.model;
      if (Object.keys(fields).length === 0) return [t('DIDN_T_UNDERSTAND_WHAT_TO_CHANGE_EXPECTING_FIELD')];
      return [updateTeamAgent(AGENTS_DIR, id, fields, engine.app.models)];
    },
  },
  {
    name: 'agent.get',
    args: [{ name: 'id', required: true, hint: 'agents' }],
    title: 'TITLE_AGENT_GET',
    help: 'HELP_AGENT_GET',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim().toLowerCase();
      if (!id) return [t('SYNTAX_AGENT_GET_ID_LIST_AGENTS')];
      const agent = loadTeam(AGENTS_DIR).find((a) => a.id === id);
      if (!agent) return [tf('NO_AGENT_WITH_ID_ID_SEE_AGENTS', { id })];
      return [JSON.stringify(agent, null, 2)];
    },
  },
  {
    name: 'agent.delete',
    args: [{ name: 'id', required: true, hint: 'agents' }],
    title: 'TITLE_AGENT_DELETE',
    help: 'HELP_AGENT_DELETE',
    run: async (_engine, rest) => {
      const ids = rest.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return [t('SYNTAX_AGENT_DELETE_ID_ID_IDS_SEPARATED_BY')];
      const lines: string[] = [];
      for (const id of ids) {
        try {
          lines.push(removeTeamAgent(AGENTS_DIR, id));
        } catch (err) {
          lines.push(`✗ ${err instanceof Error ? err.message : err}`);
        }
      }
      return lines;
    },
  },
  {
    name: 'agent.tools',
    args: [{ name: 'id агента', required: true, hint: 'agents' }],
    title: 'TITLE_AGENT_TOOLS',
    help: 'HELP_AGENT_TOOLS',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim().toLowerCase();
      if (!id) return [t('SYNTAX_AGENT_TOOLS_ID_LIST_AGENTS')];
      let agent: Agent | undefined;
      try {
        agent = loadTeam(AGENTS_DIR).find((a) => a.id === id);
      } catch {
        return [t('AGENTS_JSON_IS_UNAVAILABLE')];
      }
      if (!agent) return [tf('NO_AGENT_WITH_ID_ID_SEE_AGENTS', { id })];
      const tools = agentToolIds(agent);
      if (tools.length === 0) return [tf('NAME_NO_TOOLS_YET_AGENT_TOOL_ADD_ID', { name: agent.name, id })];
      return ['', tf('NAME_ID_TOOLS', { name: agent.name, id }), ...tools.map((tl) => `• ${tl}`), ''];
    },
  },
  {
    name: 'agent.tool.add',
    args: [
      { name: 'id агента', required: true, hint: 'agents' },
      { name: 'тул…', required: true },
    ],
    title: 'TITLE_AGENT_TOOL_ADD',
    help: 'HELP_AGENT_TOOL_ADD',
    run: async (_engine, rest) => {
      const [who, ...req] = rest;
      const tools = req.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (!who || tools.length === 0) return [t('SYNTAX_AGENT_TOOL_ADD_AGENT_ID_TOOL_FILES')];
      const lines: string[] = [];
      for (const tool of tools) {
        try {
          lines.push(grantTool(AGENTS_DIR, who, tool, undefined, TOOLS_DIR));
        } catch (err) {
          lines.push(`✗ ${err instanceof Error ? err.message : err}`);
        }
      }
      return lines;
    },
  },
  {
    name: 'agent.tool.update',
    args: [
      { name: 'id агента', required: true, hint: 'agents' },
      { name: 'тул', required: true },
      { name: 'поле=значение…', required: true },
    ],
    title: 'TITLE_AGENT_TOOL_UPDATE',
    help: 'HELP_AGENT_TOOL_UPDATE',
    run: async (_engine, rest) => {
      const [who, tool, ...pairs] = rest;
      if (!who || !tool || pairs.length === 0) {
        return [t('SYNTAX_AGENT_TOOL_UPDATE_AGENT_ID_TOOL_FIELD')];
      }
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      return [grantTool(AGENTS_DIR, who, tool, parsed, TOOLS_DIR)];
    },
  },
  {
    name: 'agent.tool.delete',
    args: [
      { name: 'id агента', required: true, hint: 'agents' },
      { name: 'тул…|all', required: true },
    ],
    title: 'TITLE_AGENT_TOOL_DELETE',
    help: 'HELP_AGENT_TOOL_DELETE',
    run: async (_engine, rest) => {
      const [who, ...req] = rest;
      if (!who || req.length === 0) return [t('SYNTAX_AGENT_TOOL_DELETE_AGENT_ID_TOOL_ALL')];
      let tools = req.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (tools.length === 1 && tools[0].toLowerCase() === 'all') {
        let agent: Agent | undefined;
        try {
          agent = loadTeam(AGENTS_DIR).find((a) => a.id === who.trim().toLowerCase());
        } catch {
          return [t('AGENTS_JSON_IS_UNAVAILABLE')];
        }
        if (!agent) return [tf('NO_AGENT_WITH_ID_ID_SEE_AGENTS', { id: who })];
        tools = agentToolIds(agent);
        if (tools.length === 0) return [tf('NAME_NO_TOOLS_YET_AGENT_TOOL_ADD_ID', { name: agent.name, id: agent.id })];
      }
      const lines: string[] = [];
      for (const tool of tools) {
        try {
          lines.push(revokeTool(AGENTS_DIR, who, tool));
        } catch (err) {
          lines.push(`✗ ${err instanceof Error ? err.message : err}`);
        }
      }
      return lines;
    },
  },

  // ── тула дома: полка tools/ и обзор ────────────────────────────────────────
  {
    name: 'tools.list',
    implicit: true,
    args: [{ name: 'тул', required: false }],
    title: 'TITLE_TOOLS_LIST',
    help: 'HELP_TOOLS_LIST',
    run: async (engine, rest) => {
      await engine.refreshUserTools(); // полку могли править руками — показываем, что лежит сейчас
      const house = engine.houseTools();
      const holdersOf = (tid: string): string => {
        try {
          return engine
            .team()
            .filter((a) => agentToolIds(a).includes(tid))
            .map((a) => a.id)
            .join(', ');
        } catch {
          return '';
        }
      };
      const id = (rest[0] ?? '').trim().toLowerCase();
      if (!id) {
        const builtin = house.filter((tl) => tl.builtin).length;
        const lines = [tf('HOUSE_TOOLS_N_BUILT_IN_M_OWN_TOOLS', { n: builtin, m: house.length - builtin })];
        for (const tl of house) {
          const holders = holdersOf(tl.id);
          lines.push(
            `• ${tl.id} — ${tl.desc}${tl.builtin ? '' : t('OWN')}` +
              (holders ? tf('USED_BY_WHO', { who: holders }) : t('NOBODY')),
          );
        }
        lines.push('');
        lines.push(
          t('OWN_TOOL_TOOL_NEW_ID_DESCRIPTION_TOOL_UPDATE'),
        );
        return lines;
      }
      const tl = house.find((x) => x.id === id);
      if (!tl) return [tf('NO_TOOL_ID_KNOWN_KNOWN', { id, known: house.map((x) => x.id).join(', ') })];
      const holders = holdersOf(tl.id);
      const lines = [
        tf('ID_KIND', { id: tl.id, kind: tl.builtin ? t('BUILT_IN_TOOL') : tf('OWN_TOOL_TOOLS_ID_TS', { id: tl.id }) }),
        `  ${tl.desc}`,
      ];
      if (tl.builtin) {
        lines.push(
          t('BUILT_INS_HAVE_NO_HOUSE_CARDS_CODE_AND'),
        );
      } else {
        const cardFile = join(TOOLS_DIR, `${tl.id}.json`);
        if (existsSync(cardFile)) {
          try {
            lines.push(tf('HOUSE_CARD_TOOLS_ID_JSON_CARD', { id: tl.id, card: JSON.stringify(JSON.parse(readFileSync(cardFile, 'utf8'))) }));
          } catch (err) {
            lines.push(tf('TOOLS_ID_JSON_BROKEN_JSON_MSG_THE_TOOL', { id: tl.id, msg: String(err instanceof Error ? err.message : err) }));
          }
        } else {
          lines.push(t('NO_HOUSE_CARD_THE_TOOL_DESCRIBES_ITSELF_IN'));
        }
      }
      lines.push(holders ? tf('USED_BY_WHO_2', { who: holders }) : t('NOT_USED_BY_ANYONE_ENABLE_AGENT_TOOL_ADD'));
      return lines;
    },
  },
  {
    name: 'tool.new',
    args: [{ name: 'id тула', required: true }],
    title: 'TITLE_TOOL_NEW',
    help: 'HELP_TOOL_NEW',
    run: async (engine, rest) => {
      const id = (rest[0] ?? '').trim().toLowerCase();
      if (!id || !isToolId(id)) return [t('SYNTAX_TOOL_NEW_ID_TOOL_ID_LOWERCASE_LETTERS')];
      if ((BUILTIN_TOOL_IDS as readonly string[]).includes(id)) {
        return [tf('ID_IS_TAKEN_BY_A_BUILT_IN_TOOL', { id })];
      }
      const tsFile = join(TOOLS_DIR, `${id}.ts`);
      if (existsSync(tsFile)) return [tf('TOOLS_ID_TS_ALREADY_EXISTS_TOOLS_ID_SHOWS', { id })];
      mkdirSync(TOOLS_DIR, { recursive: true });
      writeFileSync(tsFile, toolTemplate(id), 'utf8');
      const cardFile = join(TOOLS_DIR, `${id}.json`);
      if (!existsSync(cardFile)) {
        writeFileSync(cardFile, `${JSON.stringify({ description: t('TEMPLATE_ANSWERS_HELLO_WORLD_TO_ANY_BODY') }, null, 2)}\n`, 'utf8');
      }
      await engine.refreshUserTools();
      return [
        tf('CREATED_TOOL_ID_TOOLS_ID_TS_HELLO_WORLD', { id }),
        tf('EDIT_THE_CODE_IN_THE_FILE_DESCRIPTION_TOOL', { id }),
      ];
    },
  },
  {
    name: 'tool.update',
    args: [
      { name: 'тул', required: true },
      { name: 'поле=значение…', required: true },
    ],
    title: 'TITLE_AGENT_TOOL_UPDATE',
    help: 'HELP_TOOL_UPDATE',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      const tid = (id ?? '').trim().toLowerCase();
      if (!tid || pairs.length === 0) return [t('SYNTAX_TOOL_UPDATE_TOOL_FIELD_VALUE_E_G')];
      if ((BUILTIN_TOOL_IDS as readonly string[]).includes(tid)) {
        return [tf('ID_IS_BUILT_IN_CODE_AND_DESCRIPTION_LIVE', { id: tid })];
      }
      if (!existsSync(join(TOOLS_DIR, `${tid}.ts`))) {
        return [tf('NO_TOOL_ID_NO_TOOLS_ID_TS_FILE', { id: tid })];
      }
      const cardFile = join(TOOLS_DIR, `${tid}.json`);
      const card: Record<string, unknown> = {};
      if (existsSync(cardFile)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(cardFile, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(card, parsed);
        } catch (err) {
          return [tf('TOOLS_ID_JSON_BROKEN_JSON_FIX_THE_FILE', { id: tid, msg: String(err instanceof Error ? err.message : err) })];
        }
      }
      const patch = parseFields(pairs);
      if (Array.isArray(patch)) return patch;
      Object.assign(card, patch);
      mkdirSync(TOOLS_DIR, { recursive: true });
      writeFileSync(cardFile, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
      await engine.refreshUserTools();
      return [tf('WROTE_THE_CARD_OF_TOOL_ID_TOOLS_ID', { id: tid, fields: Object.keys(patch).join(', ') })];
    },
  },
  {
    name: 'tool.delete',
    args: [{ name: 'тул…|all', required: true }],
    title: 'TITLE_TOOL_DELETE',
    help: 'HELP_TOOL_DELETE',
    run: async (engine, rest) => {
      const asked = rest.flatMap((s) => s.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (asked.length === 0) return [t('SYNTAX_TOOL_DELETE_TOOL_ALL_BUILT_INS_CANNOT')];
      await engine.refreshUserTools(); // «all» — это то, что на полке прямо сейчас
      const own = engine.houseTools().filter((tl) => !tl.builtin).map((tl) => tl.id);
      const targets = asked.length === 1 && asked[0] === 'all' ? own : asked;
      if (targets.length === 0) return [t('NO_OWN_TOOLS_YET_CREATE_ONE_TOOL_NEW')];
      let teamAgents: Agent[] = [];
      try {
        teamAgents = engine.team();
      } catch {
        // команда не читается — тула выключить некому, файлы всё равно удаляем
      }
      const lines: string[] = [];
      for (const tid of targets) {
        if ((BUILTIN_TOOL_IDS as readonly string[]).includes(tid)) {
          lines.push(tf('ID_IS_A_BUILT_IN_TOOL_AND_CANNOT', { id: tid }));
          continue;
        }
        const tsFile = join(TOOLS_DIR, `${tid}.ts`);
        if (!existsSync(tsFile)) {
          lines.push(tf('NO_TOOL_ID_THERE_IS_NO_TOOLS_ID', { id: tid }));
          continue;
        }
        try {
          rmSync(tsFile);
        } catch (err) {
          lines.push(tf('CANNOT_DELETE_TOOLS_ID_TS_MSG', { id: tid, msg: String(err instanceof Error ? err.message : err) }));
          continue;
        }
        const cardFile = join(TOOLS_DIR, `${tid}.json`);
        if (existsSync(cardFile)) rmSync(cardFile);
        let tail = '';
        for (const a of teamAgents) {
          if (!agentToolIds(a).includes(tid)) continue;
          try {
            revokeTool(AGENTS_DIR, a.id, tid);
            tail = tail ? `${tail}, ${a.id}` : tf('WAS_USED_BY_WHO', { who: a.id });
          } catch {
            // карточка агента уже не ссылается на этот тул
          }
        }
        if (tail) tail += ')';
        lines.push(tf('DELETED_TOOL_ID_TOOLS_ID_TS_AND_THE', { id: tid, tail }));
      }
      await engine.refreshUserTools();
      return lines;
    },
  },

  // модели
  {
    name: 'models.list', implicit: true, title: 'TITLE_MODELS_LIST',
    help: 'HELP_MODELS_LIST',
    run: async (engine) => modelsText(engine.app),
  },
  {
    name: 'model.new',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: true },
    ],
    title: 'TITLE_MODEL_NEW',
    help: 'HELP_MODEL_NEW',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [t('SYNTAX_MODEL_NEW_ID_PROVIDER_OPENAI_COMPATIBLE_MODEL')];
      }
      const config = parseFields(pairs);
      if (Array.isArray(config)) return config;
      const report = addModelConfig(MODELS_DIR, id, config);
      reloadModels(engine);
      return [report];
    },
  },
  {
    name: 'model.update',
    args: [
      { name: 'id', required: true, hint: 'models' },
      { name: 'поле=значение…', required: true },
    ],
    title: 'TITLE_MODEL_UPDATE',
    help: 'HELP_MODEL_UPDATE',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [t('SYNTAX_MODEL_UPDATE_ID_MODEL_BASEURL_APIKEY_PROVIDER')];
      }
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      if (Object.keys(parsed).some((k) => k.includes('.'))) {
        return [t('A_MODEL_CARD_HAS_NO_NESTED_FIELDS_ONLY')];
      }
      const fields: Record<string, unknown> = { ...parsed };
      const report = updateModelConfig(MODELS_DIR, id, fields);
      reloadModels(engine);
      return [report];
    },
  },
  {
    name: 'model.get',
    args: [{ name: 'id', required: true, hint: 'models' }],
    title: 'TITLE_MODEL_GET',
    help: 'HELP_MODEL_GET',
    run: async (engine, rest) => {
      const id = (rest[0] ?? '').trim();
      if (!id) return [t('SYNTAX_MODEL_GET_ID_SEE_MODELS')];
      const slot = engine.app.models.get(id);
      if (!slot) return [tf('NO_MODEL_ID_SEE_MODELS', { id })];
      return [JSON.stringify(slot.config ?? { provider: id }, null, 2)];
    },
  },
  {
    name: 'model.delete',
    args: [{ name: 'id…', required: true, hint: 'models' }],
    title: 'TITLE_MODEL_DELETE',
    help: 'HELP_MODEL_DELETE',
    run: async (engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('SYNTAX_MODEL_DELETE_ID')];
      const s = engine.app.settings;
      const protectedIds = [s.model?.id, s.serviceModel?.id, engine.app.mgr.model.id].filter((x): x is string => Boolean(x));
      const lines = ids.map((id) => {
        try {
          return removeModelConfig(MODELS_DIR, id, protectedIds);
        } catch (err) {
          return `✗ ${err instanceof Error ? err.message : err}`;
        }
      });
      reloadModels(engine);
      return lines;
    },
  },

  // профиль и память
  {
    name: 'profile.show', implicit: true, title: 'TITLE_PROFILE_SHOW',
    help: 'HELP_PROFILE_SHOW',
    run: async (engine) => {
      const p = engine.app.profile;
      return [
        tf('YOU_NAME_ABOUT', {
          name: p.name,
          about: p.about ? ` — ${p.about}` : '',
        }),
        t('TO_EDIT_PROFILE_UPDATE_NAME_ABOUT'),
      ];
    },
  },
  {
    name: 'profile.update',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'TITLE_PROFILE_UPDATE',
    help: 'HELP_PROFILE_UPDATE',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_PROFILE_UPDATE_NAME_ABOUT')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      const keys = Object.keys(parsed);
      if (keys.some((k) => !['name', 'about'].includes(k))) {
        return [t('PROFILE_FIELDS_NAME_ABOUT')];
      }
      return [engine.updateProfile({
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        about: typeof parsed.about === 'string' ? parsed.about : undefined,
      })];
    },
  },
  {
    name: 'memory.show', implicit: true, needsProject: true, needsSession: true,
    args: [{ name: 'id|shared', required: false, hint: 'agents' }],
    title: 'TITLE_MEMORY_SHOW',
    help: 'HELP_MEMORY_SHOW',
    run: async (engine, rest) => memoryText(engine.app, rest.join(' ')),
  },

  // проекты
  {
    name: 'projects.list', implicit: true, title: 'TITLE_PROJECTS_LIST',
    help: 'HELP_PROJECTS_LIST',
    run: async () => projectListText(),
  },
  {
    name: 'project.new',
    args: [
      { name: 'id', required: false },
      { name: 'папка', required: false, hint: 'path' },
    ],
    title: 'TITLE_PROJECT_NEW',
    help: 'HELP_PROJECT_NEW',
    run: async (engine, rest) => {
      if (rest.length === 0) return [engine.newProject(null, null)];
      const pathy = (a: string) => looksLikePath(a) || a.startsWith('~');
      try {
        // первый токен — путь: лексер режет по пробелам, склеиваем хвост обратно
        if (pathy(rest[0])) return [engine.newProject(null, rest.join(' '))];
        return [engine.newProject(rest[0], rest.length > 1 ? rest.slice(1).join(' ') : null, false)];
      } catch (err) {
        return [`✗ ${err instanceof Error ? err.message : err}`];
      }
    },
  },
  {
    name: 'project.open',
    args: [{ name: 'id|путь', required: true, hint: 'projects' }],
    title: 'TITLE_PROJECT_OPEN',
    help: 'HELP_PROJECT_OPEN',
    run: async (engine, rest) => {
      const arg = rest.join(' ').trim();
      if (!arg) return [t('SYNTAX_PROJECT_OPEN_ID_PATH_LIST_PROJECTS')];
      return [engine.switchProject(arg, false)];
    },
  },
  {
    name: 'project.close', title: 'TITLE_PROJECT_CLOSE',
    help: 'HELP_PROJECT_CLOSE',
    run: async (engine) => [engine.closeProject()],
  },
  {
    name: 'project.delete',
    args: [{ name: 'id|путь…', required: true, hint: 'projects' }],
    title: 'TITLE_PROJECT_DELETE',
    help: 'HELP_PROJECT_DELETE',
    run: async (engine, rest) => {
      const args = expandIds(rest);
      if (args.length === 0) return [t('SYNTAX_PROJECT_DELETE_ID_PATH')];
      return args.map((arg) => {
        try {
          return engine.deleteProject(arg);
        } catch (err) {
          return `✗ ${err instanceof Error ? err.message : err}`;
        }
      });
    },
  },
  {
    name: 'project.update',
    args: [{ name: 'поле=значение…', required: true }],
    needsProject: true,
    title: 'TITLE_PROJECT_UPDATE',
    help: 'HELP_PROJECT_UPDATE',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_PROJECT_UPDATE_NAME_NEW_ID_OR_PATH')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      const keys = Object.keys(parsed);
      if (keys.some((k) => k !== 'name' && k !== 'path')) {
        return [t('A_PROJECT_HAS_TWO_FIELDS_NAME_RENAME_AND')];
      }
      const lines: string[] = [];
      if (typeof parsed.name === 'string') lines.push(engine.renameCurrentProject(parsed.name));
      if (typeof parsed.path === 'string') lines.push(engine.repointProject(parsed.path));
      return lines;
    },
  },
  {
    name: 'project.export', needsProject: true,
    title: 'TITLE_PROJECT_EXPORT',
    help: 'HELP_PROJECT_EXPORT',
    run: async (engine) => exportProjectZip(engine),
  },
  {
    name: 'project.import',
    args: [
      { name: 'файл.zip', required: true },
      { name: 'id', required: false },
    ],
    title: 'TITLE_PROJECT_IMPORT',
    help: 'HELP_PROJECT_IMPORT',
    run: async (engine, rest) => {
      const file = rest[0] ?? '';
      if (!file) return [t('SYNTAX_PROJECT_IMPORT_FILE_ZIP_ID')];
      if (!existsSync(file)) return [tf('NO_FILE_FILE', { file })];
      const entries = readZipEntries(readFileSync(file));
      if (!entries.some((e) => e.rel === 'project.json')) {
        return [t('NO_PROJECT_JSON_IN_THE_ARCHIVE_IS_IT')];
      }
      const ok = await engine.confirmAction(
        t('IMPORT_A_PROJECT_FROM_THIS_ARCHIVE'),
        t('THE_PROJECT_NAME_IS_TAKEN_SESSIONS_MERGE_INTO'),
      );
      if (!ok) return [t('IMPORT_CANCELLED')];
      return [applyProjectImport(engine.app, entries, rest.slice(1).join(' ').trim() || undefined)];
    },
  },

  // секреты проекта
  {
    name: 'project.mails', needsProject: true, title: 'TITLE_PROJECT_MAILS',
    help: 'HELP_PROJECT_MAILS',
    run: async () => {
      const mails = loadMailsFile(PROJECT_FILE);
      const ids = Object.keys(mails);
      if (ids.length === 0) {
        return [t('NO_MAILBOXES_PROJECT_MAIL_ADD_ID_THEN_PROJECT')];
      }
      const lines = ['', t('MAILBOXES')];
      for (const [id, a] of Object.entries(mails)) {
        if (!a.user) {
          lines.push(`• ${id} — ${t('NOT_FILLED_IN_PROJECT_MAIL_UPDATE')} ${id} user=… password=… imap=… smtp=…`);
          continue;
        }
        try {
          const ep = resolveEndpoints(a);
          lines.push(`• ${id}: ${a.user} — imap ${ep.imap.host}:${ep.imap.port}, smtp ${ep.smtp.host}:${ep.smtp.port}${a.tlsNoVerify ? ` ${t('NO_CERTIFICATE_VERIFICATION')}` : ''}`);
        } catch {
          lines.push(`• ${id}: ${a.user} — ${t('SETTINGS_INCOMPLETE')}`);
        }
      }
      lines.push('');
      return lines;
    },
  },
  {
    name: 'project.mail.add',
    args: [{ name: 'id', required: true }],
    needsProject: true,
    title: 'TITLE_PROJECT_MAIL_ADD',
    help: 'HELP_PROJECT_MAIL_ADD',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim();
      if (!id) return [t('SYNTAX_PROJECT_MAIL_ADD_ID')];
      return [addMailRecord(PROJECT_FILE, id)];
    },
  },
  {
    name: 'project.mail.update',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: true },
    ],
    needsProject: true,
    title: 'TITLE_PROJECT_MAIL_UPDATE',
    help: 'HELP_PROJECT_MAIL_UPDATE',
    run: async (_engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) return [t('SYNTAX_PROJECT_MAIL_UPDATE_ID_USER_PASSWORD_IMAP')];
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      return [updateMailRecord(PROJECT_FILE, id, parsed)];
    },
  },
  {
    name: 'project.mail.delete',
    args: [{ name: 'id…', required: true }],
    needsProject: true,
    title: 'TITLE_PROJECT_MAIL_DELETE',
    help: 'HELP_PROJECT_MAIL_DELETE',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('SYNTAX_PROJECT_MAIL_DELETE_ID')];
      return ids.map((id) => {
        try {
          return removeMailAccount(PROJECT_FILE, id);
        } catch (err) {
          return `✗ ${err instanceof Error ? err.message : err}`;
        }
      });
    },
  },
  {
    name: 'project.hosts', needsProject: true, title: 'TITLE_PROJECT_HOSTS',
    help: 'HELP_PROJECT_HOSTS',
    run: async () => {
      const hosts = loadHostsFile(PROJECT_FILE);
      const ids = Object.keys(hosts);
      if (ids.length === 0) {
        return [t('NO_SERVERS_PROJECT_HOST_ADD_ID_THEN_PROJECT')];
      }
      return [
        '',
        t('PROJECT_SERVERS_THE_HOSTS_FIELD_OF_PROJECT_JSON'),
        ...Object.entries(hosts).map(([id, h]) => {
          if (!h.host) return `• ${id} — ${t('NOT_FILLED_IN_PROJECT_HOST_UPDATE')} ${id} host=… user=… port=…`;
          return `• ${id}: ${h.user ? h.user + '@' : ''}${h.host}${h.port ? ':' + h.port : ''}`;
        }),
        '',
      ];
    },
  },
  {
    name: 'project.host.add',
    args: [{ name: 'id', required: true }],
    needsProject: true,
    title: 'TITLE_PROJECT_HOST_ADD',
    help: 'HELP_PROJECT_HOST_ADD',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim();
      if (!id) return [t('SYNTAX_PROJECT_HOST_ADD_ID')];
      return [addHostRecord(PROJECT_FILE, id)];
    },
  },
  {
    name: 'project.host.update',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: true },
    ],
    needsProject: true,
    title: 'TITLE_PROJECT_HOST_UPDATE',
    help: 'HELP_PROJECT_HOST_UPDATE',
    run: async (_engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) return [t('SYNTAX_PROJECT_HOST_UPDATE_ID_HOST_USER_PASSWORD')];
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      return [updateHostRecord(PROJECT_FILE, id, parsed)];
    },
  },
  {
    name: 'project.host.delete',
    args: [{ name: 'id…', required: true }],
    needsProject: true,
    title: 'TITLE_PROJECT_HOST_DELETE',
    help: 'HELP_PROJECT_HOST_DELETE',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('SYNTAX_PROJECT_HOST_DELETE_ID')];
      return ids.map((id) => {
        try {
          return removeProjectHost(PROJECT_FILE, id);
        } catch (err) {
          return `✗ ${err instanceof Error ? err.message : err}`;
        }
      });
    },
  },
  {
    name: 'project.messengers', needsProject: true, title: 'TITLE_PROJECT_MESSENGERS',
    help: 'HELP_PROJECT_MESSENGERS',
    run: async () => {
      const cfg = loadMessengersFile(PROJECT_FILE);
      const rows = (['telegram', 'max'] as const)
        .filter((k) => cfg[k] !== undefined)
        .map((k) => {
          const token = (cfg[k] as { token?: string } | undefined)?.token;
          return `• ${k}: ${token ? t('TOKEN_SAVED') : t('TOKEN_NOT_SET_PROJECT_MESSENGER_UPDATE')} ${k} token=…`;
        });
      if (rows.length === 0) return [t('NO_BOTS_PROJECT_MESSENGER_ADD_TELEGRAM_MAX_THEN')];
      return ['', t('BOTS'), ...rows, ''];
    },
  },
  {
    name: 'project.messenger.add',
    args: [{ name: 'telegram|max', required: true }],
    needsProject: true,
    title: 'TITLE_PROJECT_MESSENGER_ADD',
    help: 'HELP_PROJECT_MESSENGER_ADD',
    run: async (_engine, rest) => {
      const key = (rest[0] ?? '').trim();
      if (!key) return [t('SYNTAX_PROJECT_MESSENGER_ADD_TELEGRAM_MAX')];
      return [addMessengerRecord(PROJECT_FILE, key)];
    },
  },
  {
    name: 'project.messenger.update',
    args: [
      { name: 'telegram|max', required: true },
      { name: 'token=…', required: true },
    ],
    needsProject: true,
    title: 'TITLE_PROJECT_MESSENGER_UPDATE',
    help: 'HELP_PROJECT_MESSENGER_UPDATE',
    run: async (_engine, rest) => {
      const [key, ...pairs] = rest;
      if (!key || pairs.length === 0) return [t('SYNTAX_PROJECT_MESSENGER_UPDATE_TELEGRAM_MAX_TOKEN')];
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      return [updateMessengerRecord(PROJECT_FILE, key, parsed)];
    },
  },
  {
    name: 'project.messenger.delete',
    args: [{ name: 'telegram|max', required: true }],
    needsProject: true,
    title: 'TITLE_PROJECT_MESSENGER_DELETE',
    help: 'HELP_PROJECT_MESSENGER_DELETE',
    run: async (_engine, rest) => {
      const key = (rest[0] ?? '').trim();
      if (!key) return [t('SYNTAX_PROJECT_MESSENGER_DELETE_TELEGRAM_MAX')];
      return [removeMessengerBot(PROJECT_FILE, key)];
    },
  },

  // расписание, автономный режим, статистика
  {
    name: 'schedule.list', implicit: true, title: 'TITLE_SCHEDULE_LIST',
    help: 'HELP_SCHEDULE_LIST',
    run: async () => {
      const tasks = loadSchedule(DT_HOME);
      if (tasks.length === 0) return [t('NO_TASKS_SCHEDULE_ADD_TASK_MINUTES')];
      return [
        '',
        t('SCHEDULE'),
        ...tasks.map((t2) => `${t2.enabled ? '▶' : '⏸'} ${t2.message.slice(0, 60)} — ${tf('EVERY_N_MIN', { n: t2.intervalMinutes })} [${t2.id}]`),
        '',
      ];
    },
  },
  {
    name: 'schedule.add',
    args: [
      { name: 'задание', required: true },
      { name: 'минуты', required: false },
    ],
    title: 'TITLE_SCHEDULE_ADD',
    help: 'HELP_SCHEDULE_ADD',
    run: async (_engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_SCHEDULE_ADD_TASK_MINUTES')];
      const last = rest[rest.length - 1];
      const minutes = Number.parseInt(last, 10);
      const every = Number.isInteger(minutes) && minutes > 0 ? minutes : 10;
      const message = (Number.isInteger(minutes) && minutes > 0 ? rest.slice(0, -1) : rest).join(' ');
      if (!message) return [t('SYNTAX_SCHEDULE_ADD_TASK_MINUTES')];
      const dir = DT_HOME;
      const tasks = loadSchedule(dir);
      const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      tasks.push({ id, message, intervalMinutes: every, enabled: true });
      saveSchedule(dir, tasks);
      return [tf('TASK_MSG_EVERY_N_MIN_ID', { msg: message.slice(0, 60), n: every, id })];
    },
  },
  {
    name: 'schedule.toggle',
    args: [{ name: 'id…', required: true, hint: 'schedule' }],
    title: 'TITLE_SCHEDULE_TOGGLE',
    help: 'HELP_SCHEDULE_TOGGLE',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('SYNTAX_SCHEDULE_TOGGLE_ID')];
      const dir = DT_HOME;
      const tasks = loadSchedule(dir);
      const lines: string[] = [];
      let touched = false;
      for (const id of ids) {
        const task = tasks.find((t2) => t2.id === id);
        if (!task) {
          lines.push(tf('NO_TASK_ID_SEE_SCHEDULE', { id }));
          continue;
        }
        task.enabled = !task.enabled;
        touched = true;
        lines.push(tf('STATE_MSG', { state: task.enabled ? t('ON') : t('OFF'), msg: task.message.slice(0, 60) }));
      }
      if (touched) saveSchedule(dir, tasks);
      return lines;
    },
  },
  {
    name: 'schedule.delete',
    args: [{ name: 'id…', required: true, hint: 'schedule' }],
    title: 'TITLE_SCHEDULE_DELETE',
    help: 'HELP_SCHEDULE_DELETE',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('SYNTAX_SCHEDULE_DELETE_ID')];
      const dir = DT_HOME;
      const gone = new Set(ids);
      const before = loadSchedule(dir);
      const tasks = before.filter((t2) => !gone.has(t2.id));
      saveSchedule(dir, tasks);
      const missing = ids.length - (before.length - tasks.length);
      const lines = [tf('DELETED_N_TASKS_LEFT', { n: tasks.length })];
      if (missing > 0) lines.push(tf('NOT_FOUND_N_LIST_SCHEDULE', { n: missing }));
      return lines;
    },
  },

  // фоновые задачи (диспетчер bg.ts): процессы под супервизией приложения
  {
    name: 'bg.list', implicit: true, needsProject: true,
    args: [{ name: 'all', required: false }],
    title: 'TITLE_BG_LIST',
    help: 'HELP_BG_LIST',
    run: async (_engine, rest) => {
      const all = (rest[0] ?? '').trim().toLowerCase() === 'all';
      const tasks = bgList();
      const mine = all ? tasks : tasks.filter((t2) => t2.sessionId === requireSession(_engine.app).session.id);
      if (mine.length === 0) {
        return [t('NO_BACKGROUND_TASKS_BG_RUN_COMMAND_OR_A')];
      }
      return [
        all ? t('BACKGROUND_TASKS_OF_THE_PROJECT') : t('BACKGROUND_TASKS_OF_THIS_SESSION'),
        ...mine.map(bgTaskLine),
      ];
    },
  },
  {
    name: 'bg.run', needsProject: true, needsSession: true,
    args: [{ name: 'команда…', required: true }],
    title: 'TITLE_BG_RUN',
    help: 'HELP_BG_RUN',
    run: async (_engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_BG_RUN_TIMEOUT_30M_CHECK_5_TITLE')];
      const parsed = parseBgSpawn(rest.join(' '));
      if (!parsed.command) return [t('SYNTAX_BG_RUN_TIMEOUT_30M_CHECK_5_TITLE')];
      const task = spawnBg({
        sessionId: requireSession(_engine.app).session.id,
        by: 'user',
        command: parsed.command,
        title: parsed.title,
        timeoutMs: parsed.timeoutMs,
        checkMinutes: parsed.checkMinutes,
      });
      return [bgTaskLine(task), tf('THE_COMPLETION_NOTICE_WILL_ARRIVE_IN_THIS_SESSION', { id: task.id })];
    },
  },
  {
    name: 'bg.log', needsProject: true,
    args: [
      { name: 'id', required: true, hint: 'bg' },
      { name: 'строк', required: false },
    ],
    title: 'TITLE_BG_LOG',
    help: 'HELP_BG_LOG',
    run: async (_engine, rest) => {
      const id = rest[0] ?? '';
      if (!id) return [t('SYNTAX_BG_LOG_ID_LINES_LIST_BG')];
      const lines = Math.max(1, Math.min(2000, Number.parseInt(rest[1] ?? '', 10) || 40));
      return [bgLog(id, lines)];
    },
  },
  {
    name: 'bg.kill', needsProject: true,
    args: [{ name: 'id…', required: true, hint: 'bg' }],
    title: 'TITLE_BG_KILL',
    help: 'HELP_BG_KILL',
    run: async (_engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_BG_KILL_ID_LIST_BG')];
      return rest.map((id) => bgKill(id));
    },
  },
  {
    name: 'bg.delete', needsProject: true,
    args: [{ name: 'id…', required: true, hint: 'bg' }],
    title: 'TITLE_BG_DELETE',
    help: 'HELP_BG_DELETE',
    run: async (_engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_BG_DELETE_ID_LIST_BG')];
      return rest.map((id) => bgDelete(id));
    },
  },

  // цель (Session.goal): крутить разговор, пока модель не отчитается
  {
    name: 'goal.status', implicit: true, needsProject: true, needsSession: true,
    title: 'TITLE_GOAL_STATUS',
    help: 'HELP_GOAL_STATUS',
    run: async (engine) => engine.goalStatusLines(),
  },
  {
    name: 'goal.set', needsProject: true, needsSession: true,
    args: [
      { name: 'текст…', required: true },
      { name: 'раунды', required: false },
    ],
    title: 'TITLE_GOAL_SET',
    help: 'HELP_GOAL_SET',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_GOAL_SET_TEXT_ROUNDS')];
      const last = Number.parseInt(rest[rest.length - 1]!, 10);
      const rounds = Number.isInteger(last) && last > 0 ? last : loadSettings(SETTINGS_FILE, 0).goalMaxRounds;
      const text = (Number.isInteger(last) && last > 0 ? rest.slice(0, -1) : rest).join(' ').trim();
      if (!text) return [t('SYNTAX_GOAL_SET_TEXT_ROUNDS')];
      return [engine.setGoal(text, rounds)];
    },
  },
  {
    name: 'goal.done', needsProject: true, needsSession: true,
    title: 'TITLE_GOAL_DONE',
    help: 'HELP_GOAL_DONE',
    run: async (engine) => [engine.finishGoal('done', 'подтверждено пользователем')],
  },
  {
    name: 'goal.cancel', needsProject: true, needsSession: true,
    title: 'TITLE_GOAL_CANCEL',
    help: 'HELP_GOAL_CANCEL',
    run: async (engine) => [engine.cancelGoal()],
  },

  {
    name: 'auto.on',
    args: [{ name: 'N', required: false }],
    title: 'TITLE_AUTO_ON',
    help: 'HELP_AUTO_ON',
    run: async (engine, rest) => {
      const turns = Math.min(Math.max(Number.parseInt(rest[0] ?? '', 10) || 10, 1), 50);
      engine.setAutoMode(true, turns);
      return [tf('AUTONOMOUS_MODE_UP_TO_N_TURNS_WITHOUT_YOU', { n: turns })];
    },
  },
  {
    name: 'auto.off', title: 'TITLE_AUTO_OFF',
    help: 'HELP_AUTO_OFF',
    run: async (engine) => {
      engine.setAutoMode(false, 0);
      return [t('AUTONOMOUS_MODE_IS_OFF')];
    },
  },

  {
    name: 'usage.show', implicit: true, needsProject: true, needsSession: true,
    args: [{ name: 'id модели', required: false, hint: 'models' }],
    title: 'TITLE_USAGE_SHOW',
    help: 'HELP_USAGE_SHOW',
    run: async (engine, rest) => {
      const { session } = requireProject(engine.app);
      const mid = (rest[0] ?? '').trim();
      const line = (u: { promptTokens: number; cachedTokens: number; outputTokens: number; rounds: number }): string[] => {
        const pct = u.promptTokens > 0 ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0;
        return [
          tf('ROUNDS_ROUNDS', { rounds: u.rounds }),
          tf('IN_IN_OUT_OUT_CACHED_CACHED_PCT', {
            in: u.promptTokens.toLocaleString('ru-RU'),
            out: u.outputTokens.toLocaleString('ru-RU'),
            cached: u.cachedTokens.toLocaleString('ru-RU'),
            pct,
          }),
        ];
      };
      if (mid) {
        const u = session.usageByModel?.[mid];
        if (!u || u.rounds === 0) {
          return [tf('NO_STATS_FOR_MODEL_ID_THE_PER_MODEL', { id: mid })];
        }
        return [tf('MODEL_ID_2', { id: mid }), ...line(u)];
      }
      const u = session.usage;
      if (!u || u.rounds === 0) return [t('NO_STATS_YET_RUN_A_ROUND_WITH_A')];
      const lines = ['', t('SESSION_TOTAL'), ...line(u)];
      const win = typeof session.contextModel === 'string'
        ? engine.app.models.get(session.contextModel)?.config?.contextWindow
        : undefined;
      if (session.contextTokens && typeof win === 'number' && win > 0) {
        lines.push(tf('CONTEXT_T_OF_W_PCT', {
          t: session.contextTokens.toLocaleString('ru-RU'),
          w: win.toLocaleString('ru-RU'),
          pct: Math.min(100, Math.round((session.contextTokens / win) * 100)),
        }));
      }
      const byModel = Object.entries(session.usageByModel ?? {}).filter(([, v]) => v.rounds > 0);
      if (byModel.length > 1) {
        lines.push('', t('BY_MODEL'));
        for (const [id, v] of byModel) lines.push(`• ${id} — ${tf('R_ROUND_S_IN_IN_OUT_OUT', { r: v.rounds, in: v.promptTokens.toLocaleString('ru-RU'), out: v.outputTokens.toLocaleString('ru-RU') })}`);
      }
      lines.push('');
      return lines;
    },
  },

  // язык интерфейса: частый случай settings update ui=… вынесен в отдельную
  // команду — работает одинаково из ввода TUI и веб-оболочки (ядро одно)
  {
    name: 'lang',
    args: [{ name: 'id', required: false, hint: 'lang' }],
    title: 'TITLE_LANG',
    help: 'HELP_LANG',
    run: async (engine, rest) => {
      if (rest.length > 1) return [t('SYNTAX_LANG_ID_SEE_LANG')];
      const langs = knownLanguages(DT_HOME);
      const id = (rest[0] ?? '').trim();
      if (!id) {
        const cur = localeId();
        return [
          '',
          t('LANG_AVAILABLE'),
          ...langs.map((l) => `    ${l.id} — ${l.name}${l.builtIn ? '' : ` (${t('OWN_2')})`}${l.id === cur ? ' ' + t('CURRENT_3') : ''}`),
          t('LANG_SWITCH_HINT'),
          '',
        ];
      }
      if (!langs.some((l) => l.id === id)) {
        return [tf('LANG_UNKNOWN_ID_AVAILABLE_IDS', { id, ids: langs.map((l) => l.id).join(', ') })];
      }
      // персист как в settings.update: tmp → валидация → rename; применение —
      // после записи, чтобы неудачная запись не оставила переключённый язык
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
      raw.ui = id;
      const tmp = SETTINGS_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
      loadSettings(tmp, 0);
      renameSync(tmp, SETTINGS_FILE);
      applyLocale(id, DT_HOME); // id уже проверен списком — не бросит
      return [tf('LANG_SWITCHED_ID', { id })];
    },
  },

  // настройки, менеджер
  {
    name: 'settings.show', implicit: true, title: 'TITLE_SETTINGS_SHOW',
    help: 'HELP_SETTINGS_SHOW',
    run: async (engine) => {
      const s = loadSettings(SETTINGS_FILE, 0);
      return [
        '',
        t('SETTINGS_SETTINGS_JSON'),
        ...Object.entries(s).map(([k, v]) => `    ${k} = ${String(v)}`),
        t('TO_CHANGE_SETTINGS_UPDATE_FIELD_VALUE_E_G'),
        '',
      ];
    },
  },
  {
    name: 'settings.update',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'TITLE_SETTINGS_UPDATE',
    help: 'HELP_SETTINGS_UPDATE',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_SETTINGS_UPDATE_FIELD_VALUE_SEE_SETTINGS')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      // ссылки на модели через точечные пути: id с проверкой существования
      const { patch, error } = modelRefPatch(parsed, ['model', 'serviceModel'], {
        model: engine.app.settings.model,
        serviceModel: engine.app.settings.serviceModel,
      });
      if (error) return error;
      for (const [base, ref] of Object.entries(patch)) {
        if (!ref.id) return [tf('BASE_ID_IS_EMPTY_NAME_AN_EXISTING_MODEL', { base })];
        if (!engine.app.models.has(ref.id)) {
          return [tf('NO_MODEL_ID_AVAILABLE_LIST', { id: ref.id, list: [...engine.app.models.keys()].join(', ') })];
        }
      }
      // настройки типизированы: числа и булевы приводим сразу
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k.includes('.')) continue;
        if (v === 'true' || v === 'false') fields[k] = v === 'true';
        else if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) fields[k] = Number(v);
        else fields[k] = v;
      }
      if (patch.model) fields.model = patch.model;
      if (patch.serviceModel) fields.serviceModel = patch.serviceModel;
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
      const merged = { ...raw, ...fields };
      const tmp = SETTINGS_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
      loadSettings(tmp, 0); // валидация
      renameSync(tmp, SETTINGS_FILE);
      // язык интерфейса и модели вступают в силу сразу
      if (typeof fields.ui === 'string') applyLocale(fields.ui, DT_HOME);
      if (patch.model) engine.app.settings.model = patch.model;
      if (patch.serviceModel) engine.app.settings.serviceModel = patch.serviceModel;
      return [t('SETTINGS_UPDATED_LANGUAGE_AND_LIMITS_APPLY_FROM_THE')];
    },
  },
  {
    name: 'settings.export', title: 'TITLE_SETTINGS_EXPORT',
    help: 'HELP_SETTINGS_EXPORT',
    run: async (engine) => exportSettingsZip(engine),
  },
  {
    name: 'settings.import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'TITLE_SETTINGS_IMPORT',
    help: 'HELP_SETTINGS_IMPORT',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('SYNTAX_SETTINGS_IMPORT_FILE_ZIP')];
      if (!existsSync(file)) return [tf('NO_FILE_FILE', { file })];
      const entries = readZipEntries(readFileSync(file));
      const ok = await engine.confirmAction(
        t('IMPORT_THE_APP_SETTINGS_FROM_THIS_ARCHIVE'),
        t('SETTINGS_JSON_THE_PROFILE_THE_MANAGER_AND_THE'),
      );
      if (!ok) return [t('IMPORT_CANCELLED')];
      return [applySettingsImport(engine.app, entries)];
    },
  },

  {
    name: 'manager.show', implicit: true, title: 'TITLE_MANAGER_SHOW',
    help: 'HELP_MANAGER_SHOW',
    run: async (engine) => [
      '',
      tf('MANAGER_NAME', { name: engine.app.mgr.name }),
      `    ${t('MODEL')} ${engine.app.mgr.model.id} · ${t('TEMPERATURE')} ${engine.app.mgr.model.temperature ?? '—'}`,
      t('CHANGE_MANAGER_UPDATE_FIELDS'),
      '',
    ],
  },
  {
    name: 'manager.update',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'TITLE_MANAGER_UPDATE',
    help: 'HELP_MANAGER_UPDATE',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('SYNTAX_MANAGER_UPDATE_FIELDS')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      const tempKey = Object.keys(parsed).find((k) => k.toLowerCase() === 'temperature');
      if (tempKey !== undefined) return [tf('TEMPERATURE_IS_NO_LONGER_A_MANAGER_FIELD_TEMPERATURE', { v: String(parsed[tempKey]) })];
      const { patch, error } = modelRefPatch(parsed, ['model'], { model: engine.app.mgr.model });
      if (error) return error;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k.includes('.')) continue;
        if (!['name'].includes(k)) {
          return [tf('UNKNOWN_FIELD_KEY_ALLOWED_NAME_MODEL', { key: k })];
        }
        fields[k] = v;
      }
      if (patch.model) fields.model = patch.model;
      if (Object.keys(fields).length === 0) return [t('DIDN_T_UNDERSTAND_WHAT_TO_CHANGE_EXPECTING_FIELD')];
      const known = [...engine.app.models.keys()];
      const report = updateManagerConfig(MANAGER_FILE, fields, known);
      engine.app.mgr = loadManagerConfig(MANAGER_FILE, known);
      return [report];
    },
  },
];

// ── поиск и исполнение ───────────────────────────────────────────────────────

const byName = new Map(OPERATIONS.map((o) => [o.name, o]));

export function findOperation(name: string): OpSpec | undefined {
  return byName.get(name);
}

/** Программный вызов операции по имени с позиционными аргументами (rpc, скрипты). */
export async function runOperationArgs(engine: Engine, name: string, args: string[]): Promise<string[]> {
  const op = byName.get(name);
  if (!op) throw new Error(`нет операции «${name}»`);
  return runOp(engine, op, args);
}

/** Гейты «без проекта»/«без разговора»: операции отвечают подсказкой вместо падения. */
async function runOp(engine: Engine, op: OpSpec, args: string[], signal?: AbortSignal): Promise<string[]> {
  if ((op.needsProject || op.needsSession) && !engine.app.store) {
    return [t('NO_OPEN_PROJECT_START_WITH_PROJECT_NEW_ID')];
  }
  if (op.needsSession && !engine.app.session) {
    return [t('NO_OPEN_SESSION_SESSION_NEW_ID_OR_SESSION')];
  }
  return op.run(engine, args, signal);
}

/**
 * Для операций с парами `поле=значение…` (и `title=…`) склеивает токены
 * обратно: значение с пробелами (`title=Привет мир`) живёт до следующего
 * токена вида «ключ=».
 */
function pairArgs(op: OpSpec, tokens: string[]): string[] {
  if (!op.args?.some((a) => a.name.includes('='))) return tokens;
  const out: string[] = [];
  for (const tok of tokens) {
    if (out.length === 0 || /^[^\s=]+=/.test(tok)) out.push(tok);
    else out[out.length - 1] += ' ' + tok;
  }
  return out;
}

/** Канонический текст команды операции: обзор группы — без глагола. */
export function operationCommand(op: OpSpec): string {
  const parts = op.name.split('.');
  if (parts.length === 1) return `/${op.name}`; // одиночные: /export, /import
  return op.implicit ? `/${parts[0]}` : `/${parts[0]} ${parts.slice(1).join(' ')}`;
}

/** Строка аргументов для справки: `<id> [роль]`. */
export function operationArgs(op: OpSpec): string {
  return (op.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
}

/** Плоский список для подсказок терминала и GUI (completion). */
export interface OpHint {
  cmd: string;
  args?: string;
  /** Машиночитаемые подсказки аргументов (sessions/agents/chat/models/…) — по одной на аргумент. */
  hints?: string[];
  help: string;
}

export function operationHints(): OpHint[] {
  const ops = OPERATIONS.map((op) => {
    const cmd = operationCommand(op);
    const args = operationArgs(op);
    return {
      cmd,
      args: args || undefined,
      hints: (op.args ?? []).map((a) => a.hint ?? ''),
      help: t(op.title),
    };
  });
  return [...ops, ...extraHints()];
}

// ── браузер путей для GUI (rpc fs.dirs): только чтение имён подпапок ─────────

/** Подпапка каталога: имя и полный путь (строка в браузере путей GUI). */
export interface DirEntry {
  name: string;
  path: string;
}

/** Ответ fs.dirs: текущий каталог, родитель (null — корень диска), подпапки, диски (Windows). */
export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  drives: string[];
}

/**
 * Подпапки каталога для браузера путей в GUI; без аргумента — домашняя папка
 * пользователя. Настоящее системное окно выбора папки абсолютный путь странице
 * не отдаёт (ограничение браузеров), поэтому путь серверу приносит этот
 * просмотр. Читаются только имена — содержимое не трогается.
 */
export function listDirs(rawPath?: string): DirListing {
  const target = rawPath && rawPath.trim() ? resolve(rawPath.trim()) : homedir();
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(tf('NO_FOLDER_PATH', { path: target }));
  }
  let dirs: DirEntry[] = [];
  try {
    dirs = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } catch {
    // нет прав на чтение — в браузере папка выглядит пустой
  }
  const parent = dirname(target);
  return {
    path: target,
    parent: parent !== target ? parent : null,
    dirs,
    drives:
      process.platform === 'win32'
        ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => existsSync(d))
        : [],
  };
}

/** Принимаются вводом вне реестра (runOperationText) — подсказки для них живут здесь же. */
export function extraHints(): OpHint[] {
  return [
    { cmd: '/help', help: t('LIST_THE_OPERATIONS_AND_INPUT_TRICKS') },
    { cmd: '/exit', help: t('QUIT_IN_THE_WEB_UI_JUST_CLOSE_THE') },
    { cmd: '/quit', help: t('SAME_AS_EXIT') },
    { cmd: '/q', help: t('SAME_AS_EXIT') },
  ];
}

/**
 * Исполняет `/группа глагол аргументы…` и возвращает строки отчёта — без
 * отступов, оболочка печатает их как хочет. Обзор группы можно звать без
 * глагола (`/agents`, `/memory gleb`). Одиночные имена (/export, /import) —
 * целиком. Ошибки летят вызывающему.
 */
export async function runOperationText(
  engine: Engine,
  line: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const tokens = line.slice(1).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return helpLines();
  const [group, second, ...rest] = tokens;
  if (group === 'help') return helpLines();
  if (group === 'exit' || group === 'quit' || group === 'q') {
    return [t('EXIT_IS_A_TERMINAL_COMMAND_IN_THE_WEB')];
  }
  // трёхсловные имена (project mail add) важнее двухсловных: ищем с хвоста
  const explicit3 = second && rest.length > 0 ? byName.get(`${group}.${second}.${rest[0].toLowerCase()}`) : undefined;
  if (explicit3) return runOp(engine, explicit3, pairArgs(explicit3, rest.slice(1)), signal);
  const explicit = second ? byName.get(`${group}.${second.toLowerCase()}`) : undefined;
  if (explicit) return runOp(engine, explicit, pairArgs(explicit, rest), signal);
  // одиночная команда без группы (/export, /import, /lang): второй токен —
  // не глагол группы, а её первый аргумент (/import файл.zip, /lang en)
  const single = byName.get(group.toLowerCase());
  if (single) return runOp(engine, single, pairArgs(single, second ? [second, ...rest] : rest), signal);
  // обзор группы: verb-less (`/agents`) или имплицитная операция с аргументом
  // (`/memory gleb`, `/memory shared`) — глагол не нужен
  const implicit = OPERATIONS.find((o) => o.name.startsWith(`${group}.`) && o.implicit);
  if (implicit) {
    const args = second ? [second, ...rest] : rest;
    return runOp(engine, implicit, pairArgs(implicit, args), signal);
  }
  // не похоже ни на что: подсказываем ближайшую группу
  const groups = [...new Set(OPERATIONS.map((o) => o.name.split('.')[0]))];
  const near = groups.find((g) => g.startsWith(group.toLowerCase()));
  return [
    near
      ? tf('DID_NOT_UNDERSTAND_CMD_THERE_IS_A_NEAR', { cmd: `${group}${second ? ' ' + second : ''}`, near })
      : t('UNKNOWN_COMMAND_HELP_THE_LIST_OF_OPERATIONS'),
  ];
}

function helpLines(): string[] {
  const lines = [t('OPERATIONS_THE_SAME_STRINGS_RPC_NAMES_AND_GUI')];
  let group = '';
  for (const op of OPERATIONS) {
    const g = op.name.split('.')[0];
    if (g !== group) {
      group = g;
      lines.push('');
    }
    const label = (operationCommand(op) + (op.args ? ' ' + operationArgs(op) : '')).padEnd(30);
    lines.push(`    ${label} — ${tf(op.help, { tools: BUILTIN_TOOL_IDS.join(', ') })}`);
  }
  lines.push(
    '',
    t('NAME_OR_NAME_ADDRESS_A_MEMBER_MANAGER_THE'),
    t('SESSION_SESSION_ID_ATTACH_A_DIGEST_OF_ANOTHER'),
  );
  return lines;
}
