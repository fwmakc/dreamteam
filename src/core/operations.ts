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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
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
import { agentToolIds } from '../tools-api.js';
import { t, tf, applyLocale } from '../i18n.js';
import { AGENTS_DIR, DT_HOME, MANAGER_FILE, MODELS_DIR, PROJECTS_DIR, PROJECT_DIR, PROJECT_FILE, SETTINGS_FILE, TOOLS_DIR, WORKSPACE } from '../paths.js';
import { listProjects } from './projects.js';
import { loadSettings } from '../settings.js';
import { chatTeam, isSessionRef, requireProject, requireSession, type App, type Engine } from './engine.js';
import { loadSchedule, saveSchedule } from './schedule.js';
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
  /** Уточнение для панели подсказок (что подставлять: id, файлы…) */
  hint?: 'sessions' | 'agents' | 'chat' | 'models' | 'projects' | 'schedule';
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
  if (!app.store) return [t('нет открытого проекта — сначала /project new <id> [папка] или /project open <id|путь>')];
  const list = app.store.list();
  if (list.length === 0) return [t('Разговоров пока нет — /session new [id].')];
  const fmt = (ts: number) => new Date(ts).toLocaleString('ru-RU');
  const lines = ['', t('Разговоры (свежие сверху):')];
  for (const s of list) {
    const cur = s.id === app.session?.id ? t(' ← текущий') : '';
    lines.push(`• ${s.id} — ${s.title} — ${t('сообщ.:')} ${s.count}${cur}`);
    lines.push(`   ${t('создан')} ${fmt(s.createdAt)} · ${t('последнее сообщение')} ${fmt(s.updatedAt)}`);
  }
  lines.push('');
  return lines;
}

/** Перечитывает карточки моделей после правки файлов; app.models/images — новые карты. */
function reloadModels(engine: Engine): void {
  const { models, images } = loadModels(MODELS_DIR);
  engine.app.models = models;
  engine.app.images = images;
}

function agentsText(app: App): string[] {
  let fullTeam: Agent[] = [];
  try {
    fullTeam = loadTeam(AGENTS_DIR);
  } catch {
    return [t('agents.json недоступен.')];
  }
  const inChat = new Set(app.session ? chatTeam(app.session, fullTeam).map((a) => a.id) : []);
  const lines = [
    tf('{emoji} {name} — менеджер переговорки: консьерж и шлюз настроек [модель: {model}]', {
      emoji: app.mgr.emoji, name: app.mgr.name, model: app.mgr.model.id ?? '',
    }),
  ];
  for (const a of fullTeam) {
    const tools = agentToolIds(a);
    const marks = [
      tools.length > 0 ? tf('тулы: {list}', { list: tools.join(', ') }) : '',
      a.model?.id ? tf('модель: {id}', { id: a.model.id }) : '',
    ].filter(Boolean);
    lines.push(
      `• ${a.id} — ${a.emoji} ${a.name} — ${a.role}${a.description ? ': ' + a.description : ''}` +
      (marks.length > 0 ? ` [${marks.join(' · ')}]` : '') +
      (app.session && !inChat.has(a.id) ? ` · ${t('не в этом чате')} (/session agent add ${a.id})` : ''),
    );
  }
  return lines;
}

function modelsText(app: App): string[] {
  const lines: string[] = [];
  for (const [id, s] of app.models) {
    const state = s.ok ? t('✓ готов') : `✗ ${s.note ?? t('не настроен')}`;
    lines.push(
      `• ${id} (${s.provider.kind}, ${s.provider.model}) ${state}` +
      (s.vision ? ` ${t('◉ зрение')}` : '') +
      (id === app.settings.model?.id ? ` ${t('★ основной')}` : '') +
      (id === app.mgr.model.id ? ` ${t('🛎 менеджер')}` : ''),
    );
  }
  for (const [id, s] of app.images) {
    lines.push(`  ${t('картинки:')} ${id} ${s.ok ? t('✓ готов') : `✗ ${s.note ?? t('не настроен')}`}`);
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
    if (!Number.isInteger(f) || f <= 0) return [tf('from — номер сообщения (с 1), а не «{v}»', { v: fromStr })];
    from = f;
  }
  if (toStr !== undefined) {
    const to2 = Number.parseInt(toStr, 10);
    if (!Number.isInteger(to2) || to2 < from) return [tf('to — номер сообщения не меньше from ({from}), а не «{v}»', { from, v: toStr })];
    to = to2;
  }
  const shown = all.slice(from - 1, to);
  if (shown.length === 0) return [t('Разговор пуст (или срез пустой — см. /session history).')];
  const lines = [
    tf('Разговор «{title}» — показано {shown} из {all} сообщений:', { title: session.title, shown: shown.length, all: all.length }),
    '',
  ];
  for (const m of shown) {
    const who = m.authorId === 'user'
      ? t('Вы')
      : m.authorId === 'tool'
        ? t('⚙ инструменты')
        : isSessionRef(m)
          ? `📎 ${m.authorName}`
          : `${m.authorName}${m.authorRole ? ` (${m.authorRole})` : ''}`;
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
      return [t('Общая память пока пуста — заполняется при закрытии разговоров (/session new, /exit).')];
    }
    return ['', t('Общая память команды:'), ...app.memory.shared.split('\n'), ''];
  }
  if (!arg) {
    const withMem = memTeam.filter((a) => session.memories?.[a.id]);
    return [
      t('Чья память: /memory <id> (например, /memory gleb), /memory shared — общая.'),
      withMem.length > 0
        ? tf('Уже помнят что-то: {ids}', { ids: withMem.map((a) => a.id).join(', ') })
        : t('Пока никто не «осмыслил» разговор (память обновляется примерно раз в 12 сообщений).'),
    ];
  }
  const who = memTeam.find((a) => a.id === arg.trim().toLowerCase());
  if (!who) return [tf('Нет агента с id «{id}» — см. /agents', { id: arg })];
  const mine = session.memories?.[who.id];
  const glob = app.memory.agents[who.id];
  const lines = [
    '',
    tf('Что {name} ({id}) помнит в разговоре «{title}»:', { name: who.name, id: who.id, title: session.title }),
    `${t('Задача:')} ${mine?.task ?? '—'}`,
    `${t('Отношение к вам:')} ${mine?.towardUser ?? '—'}`,
  ];
  if (mine?.ties && Object.keys(mine.ties).length > 0) {
    const byId = new Map(memTeam.map((a) => [a.id, a.name] as const));
    for (const [id, note] of Object.entries(mine.ties)) lines.push(`${byId.get(id) ?? id}: ${note}`);
  } else {
    lines.push(`${t('Коллеги:')} —`);
  }
  lines.push(`${t('Из других разговоров:')} ${glob?.otherChats ?? '—'}`, '');
  return lines;
}

function projectListText(): string[] {
  const lines = ['', t('Проекты (открыть: /project open <id|путь>):')];
  const all = listProjects();
  if (all.length === 0 && !PROJECT_DIR) {
    lines.push(t('  пока ни одного — /project new <id> [папка] создаст первый'));
  }
  const noPath = t('(папка не задана)');
  for (const p of all) {
    const cur = Boolean(PROJECT_DIR) && basename(PROJECT_DIR) === p.id;
    lines.push(
      cur
        ? tf('• {id} — {path} ← текущий', { id: p.id, path: p.path ?? noPath })
        : tf('• {id} — {path}', { id: p.id, path: p.path ?? noPath }),
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
    return [t('agents.json недоступен.')];
  }
  const inChat = chatTeam(session, fullTeam);
  const outside = fullTeam.filter((a) => !inChat.some((c) => c.id === a.id));
  const lines = [
    tf('В чате разговора «{title}»:', { title: session.title }),
    ...inChat.map((a) => `• ${a.id} — ${a.emoji} ${a.name}${a.id === 'manager' ? ` — ${t('менеджер')}` : ''}`),
  ];
  if (outside.length > 0) {
    lines.push('', t('Можно позвать: /session agent add <id>'), ...outside.map((a) => `• ${a.id} — ${a.emoji} ${a.name}`));
  }
  lines.push('');
  return lines;
}

/** id из хвоста команды: через пробел или запятую, без пустых и повторов. */
function expandIds(rest: string[]): string[] {
  return [...new Set(rest.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean))];
}

/** /session agent add|delete <id…|all>: событие чата пишется репликой менеджера. */
function sessionAgentChange(engine: Engine, rest: string[], verb: 'add' | 'delete'): string[] {
  const emptyHint = verb === 'add'
    ? t('Кого позвать? /session agent add <id…|all> (кто в чате — /session agents)')
    : t('Кого вывести? /session agent delete <id…|all> (кто в чате — /session agents)');
  let fullTeam: Agent[];
  try {
    fullTeam = loadTeam(AGENTS_DIR);
  } catch {
    return [t('agents.json недоступен — изменить чат не получится.')];
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
        return [fullTeam.length === 0 ? t('В команде никого нет — /agent new <id> создаст.') : t('Вся команда уже в чате.')];
      }
    } else {
      ids = session ? chatTeam(session, fullTeam).map((a) => a.id) : [];
      if (ids.length === 0) return [t('Кроме менеджера в чате никого.')];
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

/**
 * Разбор `поле=значение` в словарь; ключи могут быть точечными путями
 * (`model.id=…`) — вызывающий сам решает, какие пути разрешены. temperature
 * и maxTokens — числом; пустое значение — ошибка.
 */
function parseFields(pairs: string[]): Record<string, string | number> | string[] {
  const out: Record<string, string | number> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) return [tf('Поле без значения: «{pair}» — жду поле=значение', { pair })];
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (!key) return [tf('Пустое имя поля: «{pair}»', { pair })];
    if (!value) return [tf('Пустое значение у поля «{key}»', { key })];
    if (key === 'temperature' || key === 'maxTokens' || key.endsWith('.temperature') || key.endsWith('.maxTokens')) {
      const num = Number(value);
      if (!Number.isFinite(num)) return [tf('{key} — жду числом, а не «{value}»', { key, value })];
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
      return { patch: {}, error: [tf('Вложенное поле «{key}» не знаю — можно {bases}.* (id, temperature, maxTokens…)', { key: k, bases: bases.join(', ') + '.*' })] };
    }
    if (!SUBS.has(sub)) {
      return { patch: {}, error: [tf('«{base}.{sub}» не знаю — можно: {subs}', { base, sub, subs: [...SUBS].join(', ') })] };
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
  return [tf('Экспорт: {file} ({n} записей, включая ключи моделей — хранить как пароль)', { file, n: entries.length })];
}

/** /settings export — настройки без проектов; в имени файла — профиль. */
function exportSettingsZip(engine: Engine): string[] {
  const entries = settingsEntries();
  const file = join(exportTargetDir(), `settings-${profileLabel(engine.app.profile.name)}-${stamp()}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('Экспорт: {file} ({n} записей, включая ключи моделей — хранить как пароль)', { file, n: entries.length })];
}

/** /project export — только текущий проект: project.json (с секретами) и разговоры. */
function exportProjectZip(engine: Engine): string[] {
  if (!PROJECT_DIR) return [t('Нет открытого проекта — экспортировать нечего.')];
  const id = basename(PROJECT_DIR);
  let entries: ReturnType<typeof projectEntries>;
  try {
    entries = projectEntries(id);
  } catch (err) {
    return [tf('Не удалось собрать архив проекта «{id}»: {err}', { id, err: err instanceof Error ? err.message : String(err) })];
  }
  const file = join(exportTargetDir(), `project-${id}-${stamp()}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('Экспорт: {file} ({n} записей — project.json и разговоры)', { file, n: entries.length })];
}

/** /session export — только текущий разговор. */
function exportSessionZip(engine: Engine): string[] {
  const app = engine.app;
  const { session } = requireSession(app);
  const proj = PROJECT_DIR ? basename(PROJECT_DIR) : 'home';
  const entries = sessionEntriesById(app, session.id);
  const file = join(exportTargetDir(), `session-${proj}-${session.id}-${stamp()}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('Экспорт: {file} ({n} записей)', { file, n: entries.length })];
}

// ── манифест ─────────────────────────────────────────────────────────────────

export const OPERATIONS: OpSpec[] = [
  // разговоры
  {
    name: 'sessions.list', implicit: true, needsProject: true, title: 'список разговоров',
    help: 'разговоры проекта: id, свежие сверху, текущий отмечен',
    run: async (engine) => sessionsText(engine.app),
  },
  {
    name: 'session.new',
    args: [{ name: 'id', required: false }],
    needsProject: true,
    title: 'новый разговор',
    help: 'создаёт и открывает; без id — автоштамп вида 20261027-143052',
    run: async (engine, rest, signal) => {
      if (rest.length > 1) return [t('Синтаксис: /session new [id] — id одним словом (или вовсе без id — автоштамп)')];
      const id = rest[0];
      await engine.newSession(signal ?? new AbortController().signal, id);
      return [];
    },
  },
  {
    name: 'session.open',
    args: [{ name: 'id', required: true, hint: 'sessions' }],
    needsProject: true,
    title: 'открыть разговор',
    help: 'переключиться на разговор по id (список — /sessions)',
    run: async (engine, rest) => {
      const id = rest.join(' ').trim();
      if (!id) return [t('Синтаксис: /session open <id> (список — /sessions)')];
      engine.openSessionById(id);
      return [];
    },
  },
  {
    name: 'session.close', needsProject: true,
    title: 'закрыть разговор',
    help: 'текущий разговор закрыт, проект остаётся открытым',
    run: async (engine) => [engine.closeSession()],
  },
  {
    name: 'session.delete',
    args: [{ name: 'id…', required: true, hint: 'sessions' }],
    needsProject: true,
    title: 'удалить разговор',
    help: 'текущий удалить нельзя — сначала /session close; можно несколько',
    run: async (engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('Синтаксис: /session delete <id…> (список — /sessions)')];
      return ids.map((id) => engine.deleteSessionById(id));
    },
  },
  {
    name: 'session.update',
    args: [{ name: 'title=…', required: false }],
    needsProject: true, needsSession: true,
    title: 'править разговор',
    help: 'текущий разговор: title=… ; без полей менеджер придумает имя по дайджесту',
    run: async (engine, rest) => {
      const parsed = rest.length > 0 ? parseFields(rest) : {};
      if (Array.isArray(parsed)) return parsed;
      const keys = Object.keys(parsed);
      if (keys.some((k) => k !== 'title')) {
        return [t('У разговора одно поле: title=… (без полей имя придумает менеджер)')];
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
    title: 'история разговора',
    help: 'срез сообщений включительно; один аргумент — от N до конца; без — весь',
    run: async (engine, rest) => historyText(engine.app, rest[0], rest[1]),
  },
  {
    name: 'session.export', needsProject: true, needsSession: true,
    title: 'экспорт разговора',
    help: 'архив текущего разговора: session-<проект>-<разговор>-<штамп>.zip',
    run: async (engine) => exportSessionZip(engine),
  },
  {
    name: 'session.import',
    args: [{ name: 'файл.zip', required: true }],
    needsProject: true,
    title: 'импорт разговора',
    help: 'вернуть разговор из архива (вливается в открытый проект как новый)',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('Синтаксис: /session import <файл.zip>')];
      if (!existsSync(file)) return [tf('Файла «{file}» нет', { file })];
      const entries = readZipEntries(readFileSync(file));
      if (!entries.some((e) => e.rel === 'session.json')) {
        return [t('В архиве нет session.json — это архив всего приложения? Тогда: /import <файл>')];
      }
      return [await applySessionImport(engine.app, entries)];
    },
  },
  {
    name: 'session.agents', needsProject: true, needsSession: true,
    title: 'кто в чате',
    help: 'участники текущего разговора и кого можно позвать',
    run: async (engine) => sessionAgentsText(engine),
  },
  {
    name: 'session.agent.add',
    args: [
      { name: 'id…|all', required: true, hint: 'agents' },
    ],
    needsProject: true, needsSession: true,
    title: 'позвать в чат',
    help: 'по id из /agents; можно несколько; all — вся команда',
    run: async (engine, rest) => sessionAgentChange(engine, rest, 'add'),
  },
  {
    name: 'session.agent.delete',
    args: [
      { name: 'id…|all', required: true, hint: 'chat' },
    ],
    needsProject: true, needsSession: true,
    title: 'вывести из чата',
    help: 'реплики останутся в истории; можно несколько; all — все',
    run: async (engine, rest) => sessionAgentChange(engine, rest, 'delete'),
  },

  // весь дом
  {
    name: 'export', title: 'экспорт всего приложения',
    help: 'дом целиком: настройки, команда, модели с ключами, память, расписание и ВСЕ проекты с разговорами; .env (TOKEN/PORT) — вещь машины',
    run: async (engine) => exportHomeZip(engine),
  },
  {
    name: 'import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'импорт всего приложения',
    help: 'настройки/профиль/память/расписание заменяются, проекты и разговоры вливаются; с подтверждением',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('Синтаксис: /import <файл.zip>')];
      if (!existsSync(file)) return [tf('Файла «{file}» нет', { file })];
      const entries = readZipEntries(readFileSync(file));
      const ok = await engine.confirmAction(
        t('Импортировать всё приложение из этого архива?'),
        t('Настройки/профиль/модели, память команды и расписание заменяются; проекты и их разговоры вливаются по id; открытый проект перечитывается. Ключи (.env) не переносятся.'),
      );
      if (!ok) return [t('Импорт отменён.')];
      return [applyHomeImport(engine.app, entries)];
    },
  },

  // команда
  {
    name: 'agents.list', implicit: true, title: 'состав команды',
    help: 'кто в команде (id, имя, роль), у кого какие тулы, кто в чате',
    run: async (engine) => agentsText(engine.app),
  },
  {
    name: 'agent.new',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: false },
    ],
    title: 'новый агент',
    help: 'имя по умолчанию = id; поля: name= role= emoji= color= description= prompt= model.id= temperature=',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id) return [t('Синтаксис: /agent new <id> [поле=значение…] — затем /agent update <id> name=… role=…')];
      if (!/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/.test(id)) {
        return [tf('id «{id}» не по маске: строчная латиница и цифры, внутри точка, «-», «_»', { id })];
      }
      const fields: Record<string, unknown> = { id, name: id };
      if (pairs.length > 0) {
        const parsed = parseFields(pairs);
        if (Array.isArray(parsed)) return parsed;
        const { patch, error } = modelRefPatch(parsed, ['model'], {});
        if (error) return error;
        if (patch.model && !patch.model.id) return [t('model.temperature= без model.id= — не знаю, к какой модели отнести')];
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
    title: 'править агента',
    help: 'поля: name, role, emoji, color, description, prompt, temperature, workspace; вложенные: model.id, model.temperature, model.maxTokens',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [
          t('Синтаксис: /agent update <id> поле=значение…'),
          t('Поля: name, role, emoji, color, description, prompt, temperature, workspace; вложенные: model.id, model.temperature, model.maxTokens'),
        ];
      }
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
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
      if (Object.keys(fields).length === 0) return [t('Не понял, что менять — жду поле=значение')];
      return [updateTeamAgent(AGENTS_DIR, id, fields, engine.app.models)];
    },
  },
  {
    name: 'agent.get',
    args: [{ name: 'id', required: true, hint: 'agents' }],
    title: 'показать агента',
    help: 'полная карточка JSON — все поля, включая вложенные model/vision/image/context',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim().toLowerCase();
      if (!id) return [t('Синтаксис: /agent get <id> (список — /agents)')];
      const agent = loadTeam(AGENTS_DIR).find((a) => a.id === id);
      if (!agent) return [tf('нет агента с id «{id}» — список: /agents', { id })];
      return [JSON.stringify(agent, null, 2)];
    },
  },
  {
    name: 'agent.delete',
    args: [{ name: 'id', required: true, hint: 'agents' }],
    title: 'удалить агента',
    help: 'из команды; можно несколько — через запятую или пробел',
    run: async (_engine, rest) => {
      const ids = rest.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return [t('Синтаксис: /agent delete <id> [id…] — id через пробел или запятую')];
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
    title: 'тулы агента',
    help: 'какие тулы включены и с какими настройками',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim().toLowerCase();
      if (!id) return [t('Синтаксис: /agent tools <id> (список — /agents)')];
      let agent: Agent | undefined;
      try {
        agent = loadTeam(AGENTS_DIR).find((a) => a.id === id);
      } catch {
        return [t('agents.json недоступен.')];
      }
      if (!agent) return [tf('Нет агента с id «{id}» — см. /agents', { id })];
      const tools = agentToolIds(agent);
      if (tools.length === 0) return [tf('{name}: тулов и так нет — /agent tool add {id} <тул>', { name: agent.name, id })];
      return ['', tf('{name} ({id}), тулы:', { name: agent.name, id }), ...tools.map((tl) => `• ${tl}`), ''];
    },
  },
  {
    name: 'agent.tool.add',
    args: [
      { name: 'id агента', required: true, hint: 'agents' },
      { name: 'тул…', required: true },
    ],
    title: 'включить тул',
    help: 'встроенные files/shell/ssh/look/image или свой из tools/; можно несколько',
    run: async (_engine, rest) => {
      const [who, ...req] = rest;
      const tools = req.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (!who || tools.length === 0) return [t('Синтаксис: /agent tool add <id агента> <тул…> (files, shell, ssh, look, image или свой из tools/)')];
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
    title: 'настроить тул',
    help: 'карточка тула в agents.json: поле=значение…',
    run: async (_engine, rest) => {
      const [who, tool, ...pairs] = rest;
      if (!who || !tool || pairs.length === 0) {
        return [t('Синтаксис: /agent tool update <id агента> <тул> поле=значение…')];
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
    title: 'выключить тул',
    help: 'убрать карточку тула из агента; можно несколько; all — все тулы',
    run: async (_engine, rest) => {
      const [who, ...req] = rest;
      if (!who || req.length === 0) return [t('Синтаксис: /agent tool delete <id агента> <тул…|all>')];
      let tools = req.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (tools.length === 1 && tools[0].toLowerCase() === 'all') {
        let agent: Agent | undefined;
        try {
          agent = loadTeam(AGENTS_DIR).find((a) => a.id === who.trim().toLowerCase());
        } catch {
          return [t('agents.json недоступен.')];
        }
        if (!agent) return [tf('Нет агента с id «{id}» — см. /agents', { id: who })];
        tools = agentToolIds(agent);
        if (tools.length === 0) return [tf('{name}: тулов и так нет — /agent tool add {id} <тул>', { name: agent.name, id: agent.id })];
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

  // модели
  {
    name: 'models.list', implicit: true, title: 'модели',
    help: 'какие есть, кто готов, кто основная и менеджерская',
    run: async (engine) => modelsText(engine.app),
  },
  {
    name: 'model.new',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: true },
    ],
    title: 'новая модель',
    help: 'provider обязателен; дальше model, baseUrl, apiKey и ключи контракта провайдера',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [t('Синтаксис: /model new <id> provider=openai-compatible model=… baseUrl=… apiKey=…')];
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
    title: 'править модель',
    help: 'provider, model, baseUrl, apiKey, maxTokens, temperature, thinking…; вложенных полей у карточки нет',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [t('Синтаксис: /model update <id> model=… baseUrl=… apiKey=… provider=…')];
      }
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      if (Object.keys(parsed).some((k) => k.includes('.'))) {
        return [t('У карточки модели вложенных полей нет — только плоские: provider, model, baseUrl, apiKey…')];
      }
      const fields: Record<string, unknown> = { ...parsed };
      const report = updateModelConfig(MODELS_DIR, id, fields);
      reloadModels(engine);
      return [report];
    },
  },
  {
    name: 'model.delete',
    args: [{ name: 'id…', required: true, hint: 'models' }],
    title: 'удалить модель',
    help: 'основную не удалить — сначала /settings update model.id=другая; можно несколько',
    run: async (engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('Синтаксис: /model delete <id…>')];
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
    name: 'profile.show', implicit: true, title: 'ваш профиль',
    help: 'как вас видит команда (user.json)',
    run: async (engine) => {
      const p = engine.app.profile;
      return [
        tf('Вы: {name}{role}{about}', {
          name: p.name,
          role: p.role ? ` — ${p.role}` : '',
          about: p.about ? ` — ${p.about}` : '',
        }),
        t('Поправить: /profile update name=… role=… about=…'),
      ];
    },
  },
  {
    name: 'profile.update',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'править профиль',
    help: 'поля: name, role, about',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('Синтаксис: /profile update name=… role=… about=…')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      const keys = Object.keys(parsed);
      if (keys.some((k) => !['name', 'role', 'about'].includes(k))) {
        return [t('Поля профиля: name, role, about')];
      }
      return [engine.updateProfile({
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        role: typeof parsed.role === 'string' ? parsed.role : undefined,
        about: typeof parsed.about === 'string' ? parsed.about : undefined,
      })];
    },
  },
  {
    name: 'memory.show', implicit: true, needsProject: true, needsSession: true,
    args: [{ name: 'id|shared', required: false, hint: 'agents' }],
    title: 'память',
    help: 'без аргумента — обзор; «shared» — общая память команды',
    run: async (engine, rest) => memoryText(engine.app, rest.join(' ')),
  },

  // проекты
  {
    name: 'projects.list', implicit: true, title: 'проекты',
    help: 'реестр проектов дома; смена — /project open, создание — /project new',
    run: async () => projectListText(),
  },
  {
    name: 'project.new',
    args: [
      { name: 'id', required: true },
      { name: 'папка', required: false },
    ],
    title: 'новый проект',
    help: 'создаёт и открывает; папка создаётся, если её нет',
    run: async (engine, rest) => {
      const id = rest[0];
      if (!id) return [t('Синтаксис: /project new <id> [папка] — id без пробелов; рабочая папка создаётся, если её нет')];
      const dir = rest.length > 1 ? rest.slice(1).join(' ') : null;
      return [engine.newProject(id, dir, false)];
    },
  },
  {
    name: 'project.open',
    args: [{ name: 'id|путь', required: true, hint: 'projects' }],
    title: 'открыть проект',
    help: 'сменить проект не выходя из приложения; незнакомая папка — регистрируется',
    run: async (engine, rest) => {
      const arg = rest.join(' ').trim();
      if (!arg) return [t('Синтаксис: /project open <id|путь> (список — /projects)')];
      return [engine.switchProject(arg, false)];
    },
  },
  {
    name: 'project.close', title: 'закрыть проект',
    help: 'остаться без проекта: разговоры сохранены, состояние как после запуска',
    run: async (engine) => [engine.closeProject()],
  },
  {
    name: 'project.delete',
    args: [{ name: 'id|путь…', required: true, hint: 'projects' }],
    title: 'удалить проект',
    help: 'из дома (projects/<id>/ вместе с разговорами); рабочая папка не трогается; текущий не удалить; можно несколько',
    run: async (engine, rest) => {
      const args = expandIds(rest);
      if (args.length === 0) return [t('Синтаксис: /project delete <id|путь…>')];
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
    title: 'править проект',
    help: 'текущий проект: name=… (переименовать, папка в доме) или path=… (сменить рабочую папку)',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('Синтаксис: /project update name=новое-id или path=папка')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      const keys = Object.keys(parsed);
      if (keys.some((k) => k !== 'name' && k !== 'path')) {
        return [t('У проекта два поля: name=… (переименовать) и path=… (рабочая папка)')];
      }
      const lines: string[] = [];
      if (typeof parsed.name === 'string') lines.push(engine.renameCurrentProject(parsed.name));
      if (typeof parsed.path === 'string') lines.push(engine.repointProject(parsed.path));
      return lines;
    },
  },
  {
    name: 'project.export', needsProject: true,
    title: 'экспорт проекта',
    help: 'архив текущего проекта: project-<id>-<штамп>.zip (project.json с секретами и все разговоры)',
    run: async (engine) => exportProjectZip(engine),
  },
  {
    name: 'project.import',
    args: [
      { name: 'файл.zip', required: true },
      { name: 'id', required: false },
    ],
    title: 'импорт проекта',
    help: 'id занят — разговоры вольются в него по id, свободен — новый проект; с подтверждением',
    run: async (engine, rest) => {
      const file = rest[0] ?? '';
      if (!file) return [t('Синтаксис: /project import <файл.zip> [id]')];
      if (!existsSync(file)) return [tf('Файла «{file}» нет', { file })];
      const entries = readZipEntries(readFileSync(file));
      if (!entries.some((e) => e.rel === 'project.json')) {
        return [t('В архиве нет project.json — это архив всего приложения? Тогда: /import <файл>')];
      }
      const ok = await engine.confirmAction(
        t('Импортировать проект из этого архива?'),
        t('Имя проекта занято — разговоры вливаются в него по id (совпавшие заменяются); свободно — создастся новый проект. Секреты (серверы, почта, боты) не заменяются.'),
      );
      if (!ok) return [t('Импорт отменён.')];
      return [applyProjectImport(engine.app, entries, rest.slice(1).join(' ').trim() || undefined)];
    },
  },

  // секреты проекта
  {
    name: 'project.mails', needsProject: true, title: 'ящики',
    help: 'реестр ящиков (поле "mails" в project.json); добавить — /project mail add <id>',
    run: async () => {
      const mails = loadMailsFile(PROJECT_FILE);
      const ids = Object.keys(mails);
      if (ids.length === 0) {
        return [t('Ящиков нет — /project mail add <id>, затем /project mail update <id> user=… password=… imap=… smtp=…')];
      }
      const lines = ['', t('Ящики:')];
      for (const [id, a] of Object.entries(mails)) {
        if (!a.user) {
          lines.push(`• ${id} — ${t('не заполнен: /project mail update')} ${id} user=… password=… imap=… smtp=…`);
          continue;
        }
        try {
          const ep = resolveEndpoints(a);
          lines.push(`• ${id}: ${a.user} — imap ${ep.imap.host}:${ep.imap.port}, smtp ${ep.smtp.host}:${ep.smtp.port}${a.tlsNoVerify ? ` ${t('(без сверки сертификата)')}` : ''}`);
        } catch {
          lines.push(`• ${id}: ${a.user} — ${t('настройки неполные')}`);
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
    title: 'новый ящик',
    help: 'пустая запись; поля заполнит /project mail update',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim();
      if (!id) return [t('Синтаксис: /project mail add <id>')];
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
    title: 'править ящик',
    help: 'поля: user, password, imap, smtp, port, smtpPort, tlsNoVerify',
    run: async (_engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) return [t('Синтаксис: /project mail update <id> user=… password=… imap=… smtp=… [port=…] [smtpPort=…] [tlsNoVerify=true]')];
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      return [updateMailRecord(PROJECT_FILE, id, parsed)];
    },
  },
  {
    name: 'project.mail.delete',
    args: [{ name: 'id…', required: true }],
    needsProject: true,
    title: 'убрать ящик',
    help: 'из поля "mails" project.json проекта; можно несколько',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('Синтаксис: /project mail delete <id…>')];
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
    name: 'project.hosts', needsProject: true, title: 'серверы',
    help: 'серверы проекта (поле "hosts" в project.json); добавить — /project host add <id>',
    run: async () => {
      const hosts = loadHostsFile(PROJECT_FILE);
      const ids = Object.keys(hosts);
      if (ids.length === 0) {
        return [t('Серверов нет — /project host add <id>, затем /project host update <id> host=… user=… port=…')];
      }
      return [
        '',
        t('Серверы проекта (поле "hosts" в project.json):'),
        ...Object.entries(hosts).map(([id, h]) => {
          if (!h.host) return `• ${id} — ${t('не заполнен: /project host update')} ${id} host=… user=… port=…`;
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
    title: 'новый сервер',
    help: 'пустая запись; поля заполнит /project host update',
    run: async (_engine, rest) => {
      const id = (rest[0] ?? '').trim();
      if (!id) return [t('Синтаксис: /project host add <id>')];
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
    title: 'править сервер',
    help: 'поля: host, user, password, dir, port',
    run: async (_engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) return [t('Синтаксис: /project host update <id> host=… [user=…] [password=…] [dir=…] [port=…]')];
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      return [updateHostRecord(PROJECT_FILE, id, parsed)];
    },
  },
  {
    name: 'project.host.delete',
    args: [{ name: 'id…', required: true }],
    needsProject: true,
    title: 'убрать сервер',
    help: 'из поля "hosts" project.json проекта; можно несколько',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('Синтаксис: /project host delete <id…>')];
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
    name: 'project.messengers', needsProject: true, title: 'боты',
    help: 'токены ботов (поле "messengers" в project.json); добавить — /project messenger add <telegram|max>',
    run: async () => {
      const cfg = loadMessengersFile(PROJECT_FILE);
      const rows = (['telegram', 'max'] as const)
        .filter((k) => cfg[k] !== undefined)
        .map((k) => {
          const token = (cfg[k] as { token?: string } | undefined)?.token;
          return `• ${k}: ${token ? t('токен сохранён') : t('токен не задан — /project messenger update')} ${k} token=…`;
        });
      if (rows.length === 0) return [t('Ботов нет — /project messenger add <telegram|max>, затем /project messenger update <id> token=…')];
      return ['', t('Боты:'), ...rows, ''];
    },
  },
  {
    name: 'project.messenger.add',
    args: [{ name: 'telegram|max', required: true }],
    needsProject: true,
    title: 'новый бот',
    help: 'пустая запись; токен зальёт /project messenger update',
    run: async (_engine, rest) => {
      const key = (rest[0] ?? '').trim();
      if (!key) return [t('Синтаксис: /project messenger add <telegram|max>')];
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
    title: 'залить токен',
    help: 'Telegram — @BotFather, MAX — dev.max.ru; токен в отчёте не светится',
    run: async (_engine, rest) => {
      const [key, ...pairs] = rest;
      if (!key || pairs.length === 0) return [t('Синтаксис: /project messenger update <telegram|max> token=…')];
      const parsed = parseFields(pairs);
      if (Array.isArray(parsed)) return parsed;
      return [updateMessengerRecord(PROJECT_FILE, key, parsed)];
    },
  },
  {
    name: 'project.messenger.delete',
    args: [{ name: 'telegram|max', required: true }],
    needsProject: true,
    title: 'убрать бота',
    help: 'из поля "messengers" project.json проекта',
    run: async (_engine, rest) => {
      const key = (rest[0] ?? '').trim();
      if (!key) return [t('Синтаксис: /project messenger delete <telegram|max>')];
      return [removeMessengerBot(PROJECT_FILE, key)];
    },
  },

  // расписание, автономный режим, статистика
  {
    name: 'schedule.list', implicit: true, title: 'расписание',
    help: 'задачи, которые serve запускает сам по интервалу',
    run: async () => {
      const tasks = loadSchedule(DT_HOME);
      if (tasks.length === 0) return [t('Задач нет — /schedule add <задание> [минуты]')];
      return [
        '',
        t('Расписание:'),
        ...tasks.map((t2) => `${t2.enabled ? '▶' : '⏸'} ${t2.message.slice(0, 60)} — ${tf('каждые {n} мин', { n: t2.intervalMinutes })} [${t2.id}]`),
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
    title: 'новая задача',
    help: 'текст уйдёт в чат как сообщение руководителя; интервал по умолчанию 10 минут',
    run: async (_engine, rest) => {
      if (rest.length === 0) return [t('Синтаксис: /schedule add <задание> [минуты]')];
      const last = rest[rest.length - 1];
      const minutes = Number.parseInt(last, 10);
      const every = Number.isInteger(minutes) && minutes > 0 ? minutes : 10;
      const message = (Number.isInteger(minutes) && minutes > 0 ? rest.slice(0, -1) : rest).join(' ');
      if (!message) return [t('Синтаксис: /schedule add <задание> [минуты]')];
      const dir = DT_HOME;
      const tasks = loadSchedule(dir);
      const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      tasks.push({ id, message, intervalMinutes: every, enabled: true });
      saveSchedule(dir, tasks);
      return [tf('✓ Задача «{msg}» каждые {n} мин [{id}]', { msg: message.slice(0, 60), n: every, id })];
    },
  },
  {
    name: 'schedule.toggle',
    args: [{ name: 'id…', required: true, hint: 'schedule' }],
    title: 'вкл/выкл задачу',
    help: 'пауза и возврат без удаления; можно несколько',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('Синтаксис: /schedule toggle <id…>')];
      const dir = DT_HOME;
      const tasks = loadSchedule(dir);
      const lines: string[] = [];
      let touched = false;
      for (const id of ids) {
        const task = tasks.find((t2) => t2.id === id);
        if (!task) {
          lines.push(tf('Нет задачи «{id}» — см. /schedule', { id }));
          continue;
        }
        task.enabled = !task.enabled;
        touched = true;
        lines.push(tf('{state}: {msg}', { state: task.enabled ? t('▶ Включена') : t('⏸ Выключена'), msg: task.message.slice(0, 60) }));
      }
      if (touched) saveSchedule(dir, tasks);
      return lines;
    },
  },
  {
    name: 'schedule.delete',
    args: [{ name: 'id…', required: true, hint: 'schedule' }],
    title: 'удалить задачу',
    help: 'полностью; можно несколько',
    run: async (_engine, rest) => {
      const ids = expandIds(rest);
      if (ids.length === 0) return [t('Синтаксис: /schedule delete <id…>')];
      const dir = DT_HOME;
      const gone = new Set(ids);
      const before = loadSchedule(dir);
      const tasks = before.filter((t2) => !gone.has(t2.id));
      saveSchedule(dir, tasks);
      const missing = ids.length - (before.length - tasks.length);
      const lines = [tf('Удалено: задач осталось {n}', { n: tasks.length })];
      if (missing > 0) lines.push(tf('Не нашёл: {n} (список — /schedule)', { n: missing }));
      return lines;
    },
  },

  {
    name: 'auto.on',
    args: [{ name: 'N', required: false }],
    title: 'включить автономный режим',
    help: 'агенты решают вопросы сами, до N ходов (по умолчанию 10)',
    run: async (engine, rest) => {
      const turns = Math.min(Math.max(Number.parseInt(rest[0] ?? '', 10) || 10, 1), 50);
      engine.setAutoMode(true, turns);
      return [tf('🤖 автономный режим: до {n} ходов без вашего участия. Остановить — /auto off или ⏹.', { n: turns })];
    },
  },
  {
    name: 'auto.off', title: 'выключить автономный режим',
    help: 'вернуть руководителя в разговор',
    run: async (engine) => {
      engine.setAutoMode(false, 0);
      return [t('🤖 автономный режим выключен.')];
    },
  },

  {
    name: 'usage.show', implicit: true, needsProject: true, needsSession: true,
    args: [{ name: 'id модели', required: false, hint: 'models' }],
    title: 'статистика токенов',
    help: 'вход/выход/кэш накопительно; с id модели — только по ней',
    run: async (engine, rest) => {
      const { session } = requireProject(engine.app);
      const mid = (rest[0] ?? '').trim();
      const line = (u: { promptTokens: number; cachedTokens: number; outputTokens: number; rounds: number }): string[] => {
        const pct = u.promptTokens > 0 ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0;
        return [
          tf('Раундов: {rounds}', { rounds: u.rounds }),
          tf('Вход: {in} · Выход: {out} · Из кэша: {cached} ({pct}%)', {
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
          return [tf('По модели «{id}» статистики нет (срез по моделям собирается с этого обновления).', { id: mid })];
        }
        return [tf('Модель {id}:', { id: mid }), ...line(u)];
      }
      const u = session.usage;
      if (!u || u.rounds === 0) return [t('Статистики пока нет — сделайте раунд с API (не mock).')];
      const lines = ['', t('Итого за разговор:'), ...line(u)];
      const byModel = Object.entries(session.usageByModel ?? {}).filter(([, v]) => v.rounds > 0);
      if (byModel.length > 1) {
        lines.push('', t('По моделям:'));
        for (const [id, v] of byModel) lines.push(`• ${id} — ${tf('{r} раунд(ов), вход {in}, выход {out}', { r: v.rounds, in: v.promptTokens.toLocaleString('ru-RU'), out: v.outputTokens.toLocaleString('ru-RU') })}`);
      }
      lines.push('');
      return lines;
    },
  },

  // настройки, менеджер
  {
    name: 'settings.show', implicit: true, title: 'настройки',
    help: 'язык, maxTurns, ширина и остальные поля settings.json',
    run: async (engine) => {
      const s = loadSettings(SETTINGS_FILE, 0);
      return [
        '',
        t('Настройки (settings.json):'),
        ...Object.entries(s).map(([k, v]) => `    ${k} = ${String(v)}`),
        t('Поменять: /settings update поле=значение (например, /settings update maxTurns=2 или /settings update ui=en; модель — model.id=…)'),
        '',
      ];
    },
  },
  {
    name: 'settings.update',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'поменять настройки',
    help: 'вступают в силу со следующего раунда; вложенные: model.id=…, serviceModel.id=…, model.temperature=…',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('Синтаксис: /settings update поле=значение… (см. /settings)')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      // ссылки на модели через точечные пути: id с проверкой существования
      const { patch, error } = modelRefPatch(parsed, ['model', 'serviceModel'], {
        model: engine.app.settings.model,
        serviceModel: engine.app.settings.serviceModel,
      });
      if (error) return error;
      for (const [base, ref] of Object.entries(patch)) {
        if (!ref.id) return [tf('{base}.id пуст — укажите существующую модель', { base })];
        if (!engine.app.models.has(ref.id)) {
          return [tf('Нет модели «{id}». Доступны: {list}', { id: ref.id, list: [...engine.app.models.keys()].join(', ') })];
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
      return [t('✓ Настройки обновлены (язык и лимиты — со следующего раунда)')];
    },
  },
  {
    name: 'settings.export', title: 'экспорт настроек',
    help: 'настройки без проектов: settings-<профиль>-<штамп>.zip (settings, профиль, менеджер, модели с ключами)',
    run: async (engine) => exportSettingsZip(engine),
  },
  {
    name: 'settings.import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'импорт настроек',
    help: 'settings/профиль/менеджер/модели заменяются, проекты не трогаются; с подтверждением',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('Синтаксис: /settings import <файл.zip>')];
      if (!existsSync(file)) return [tf('Файла «{file}» нет', { file })];
      const entries = readZipEntries(readFileSync(file));
      const ok = await engine.confirmAction(
        t('Импортировать настройки приложения из этого архива?'),
        t('settings.json, профиль, менеджер и карточки моделей (с ключами) заменяются; проекты и разговоры не трогаются.'),
      );
      if (!ok) return [t('Импорт отменён.')];
      return [applySettingsImport(engine.app, entries)];
    },
  },

  {
    name: 'manager.show', implicit: true, title: 'менеджер переговорки',
    help: 'его модель, имя и температура',
    run: async (engine) => [
      '',
      tf('Менеджер: {emoji} {name}', { emoji: engine.app.mgr.emoji, name: engine.app.mgr.name }),
      `    ${t('модель:')} ${engine.app.mgr.model.id} · ${t('температура:')} ${engine.app.mgr.temperature ?? '—'}`,
      t('Поменять: /manager update model.id=… model.temperature=… name=… emoji=… color=…'),
      '',
    ],
  },
  {
    name: 'manager.update',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'настроить менеджера',
    help: 'поля: name, emoji, color, temperature; вложенные: model.id, model.temperature',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('Синтаксис: /manager update model.id=… model.temperature=… name=… emoji=… color=…')];
      const parsed = parseFields(rest);
      if (Array.isArray(parsed)) return parsed;
      const { patch, error } = modelRefPatch(parsed, ['model'], { model: engine.app.mgr.model });
      if (error) return error;
      if (patch.model && !patch.model.id) return [t('model.temperature= без model.id= — не знаю, к какой модели отнести')];
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k.includes('.')) continue;
        if (!['name', 'emoji', 'color', 'temperature'].includes(k)) {
          return [tf('Поле «{key}» не знаю — можно: name, emoji, color, temperature, model.id, model.temperature', { key: k })];
        }
        fields[k] = v;
      }
      if (patch.model) fields.model = patch.model;
      if (Object.keys(fields).length === 0) return [t('Не понял, что менять — жду поле=значение')];
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

/** Гейты «без проекта»/«без разговора»: операции отвечают подсказкой вместо падения. */
async function runOp(engine: Engine, op: OpSpec, args: string[], signal?: AbortSignal): Promise<string[]> {
  if ((op.needsProject || op.needsSession) && !engine.app.store) {
    return [t('нет открытого проекта — сначала /project new <id> [папка] или /project open <id|путь>')];
  }
  if (op.needsSession && !engine.app.session) {
    return [t('нет открытого разговора — /session new [id] или /session open <id>; список — /sessions')];
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

/** Принимаются вводом вне реестра (runOperationText) — подсказки для них живут здесь же. */
export function extraHints(): OpHint[] {
  return [
    { cmd: '/help', help: t('список операций и приёмы ввода') },
    { cmd: '/exit', help: t('выход; в веб-оболочке просто закройте страницу') },
    { cmd: '/quit', help: t('то же, что /exit') },
    { cmd: '/q', help: t('то же, что /exit') },
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
    return [t('/exit — команда терминала. В веб-оболочке просто закройте страницу.')];
  }
  // трёхсловные имена (project mail add) важнее двухсловных: ищем с хвоста
  const explicit3 = second && rest.length > 0 ? byName.get(`${group}.${second}.${rest[0].toLowerCase()}`) : undefined;
  if (explicit3) return runOp(engine, explicit3, pairArgs(explicit3, rest.slice(1)), signal);
  const explicit = second ? byName.get(`${group}.${second.toLowerCase()}`) : undefined;
  if (explicit) return runOp(engine, explicit, pairArgs(explicit, rest), signal);
  // одиночная команда без группы (/export, /import)
  const single = second ? undefined : byName.get(group.toLowerCase());
  if (single) return runOp(engine, single, pairArgs(single, rest), signal);
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
      ? tf('Не понял «/{cmd}». Есть группа /{near} — /help покажет её операции.', { cmd: `${group}${second ? ' ' + second : ''}`, near })
      : t('Неизвестная команда. /help — список операций.'),
  ];
}

function helpLines(): string[] {
  const lines = [t('Операции (это же — имена rpc и подсказки GUI):')];
  let group = '';
  for (const op of OPERATIONS) {
    const g = op.name.split('.')[0];
    if (g !== group) {
      group = g;
      lines.push('');
    }
    const label = (operationCommand(op) + (op.args ? ' ' + operationArgs(op) : '')).padEnd(30);
    lines.push(`    ${label} — ${t(op.help)}`);
  }
  lines.push(
    '',
    t('  @имя или !имя — обратиться к участнику; @менеджер — к менеджеру переговорки;'),
    t('  @session <id разговора> — приложить конспект другого разговора.'),
  );
  return lines;
}
