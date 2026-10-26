/**
 * Импорт-экспорт: упаковка/разбор zip-переносов. Четыре уровня:
 *
 *   1. всё приложение (home)   — настройки дома, команда, модели с ключами,
 *                                тула, память, расписание и ВСЕ проекты
 *                                вместе с разговорами;
 *   2. настройки (settings)    — settings.json + профиль + менеджер + модели;
 *   3. один проект (project)   — project.json (с секретами) + все разговоры;
 *   4. один разговор (session) — session.json + карточки участников (архив
 *                                уезжает к чужим людям, вся команда — нет).
 *
 * Формат — обычный zip (adm-zip, как в тулe arch). Не переносится только
 * .env: это настройки самой машины (TOKEN, PORT, HOST для serve), на новом
 * месте дом создаст его из примера. Транскрипты в архивы не пакуются — это
 * производный кэш, они перегенерируются из session.json при первом же
 * сохранении.
 *
 * Импорт настроек: settings/профиль/менеджер/модели заменяются, проекты не
 * трогаются. Импорт дома: то же + память/расписание, а проекты вливаются по
 * id — нового создаём целиком, у существующего сохраняются локальные
 * настройки и секреты, вливаются только разговоры. Импорт проекта: то же
 * правило для одного проекта. Импорт сессии: разговор разворачивается КАК
 * НОВАЯ сессия (новый id — ничего не перетирается), участники вливаются по
 * id; дата создания сохраняется, digestInLog сбрасывается — памяти команды
 * в архиве сессии нет.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import AdmZip from 'adm-zip';
import { loadModels } from '../providers/registry.js';
import { loadTeam } from '../agents.js';
import { loadTeamMemory } from '../memory.js';
import {
  AGENTS_DIR,
  DT_HOME,
  MANAGER_FILE,
  MEMORY_FILE,
  MODELS_DIR,
  PROJECTS_DIR,
  PROJECT_DIR,
  SETTINGS_FILE,
  TOOLS_DIR,
  USER_FILE,
} from '../paths.js';
import { listProjects, loadProjectConfig, saveProjectConfig, validateProjectId, type ProjectConfig } from './projects.js';
import { loadManagerConfig, mergeTeamAgents } from '../manager.js';
import { t, tf } from '../i18n.js';
import type { App } from './engine.js';
import type { Agent, Session } from '../types.js';

export interface TransferEntry {
  rel: string;
  data: Buffer;
}

/** Файлы настроек дома: базовые + память/расписание (только для полного экспорта). */
const SETTINGS_FILES = ['settings.json', 'user.json', 'manager.json'] as const;
const HOME_FILES = [...SETTINGS_FILES, 'memory.json', 'schedule.json'] as const;
/** id разговора — метка времени; из архива путь строится только из такого id (zip-slip мимо). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function readIfExists(file: string): Buffer | null {
  return existsSync(file) ? readFileSync(file) : null;
}

function dirFileEntries(dir: string, relPrefix: string): TransferEntry[] {
  const out: TransferEntry[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) out.push({ rel: `${relPrefix}${name}`, data: readFileSync(p) });
  }
  return out;
}

function sessionsEntries(sessionsDir: string, relPrefix: string): TransferEntry[] {
  const out: TransferEntry[] = [];
  if (!existsSync(sessionsDir)) return out;
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith('.json')) continue;
    if (!SESSION_ID_RE.test(name.slice(0, -'.json'.length))) continue;
    const p = join(sessionsDir, name);
    if (existsSync(p) && statSync(p).isFile()) out.push({ rel: `${relPrefix}${name}`, data: readFileSync(p) });
  }
  return out;
}

/** Уровень 2 — настройки приложения: settings/профиль/менеджер + модели (с ключами). */
export function settingsEntries(): TransferEntry[] {
  const out: TransferEntry[] = [];
  for (const f of SETTINGS_FILES) {
    const data = readIfExists(join(DT_HOME, f));
    if (data) out.push({ rel: f, data });
  }
  out.push(...dirFileEntries(MODELS_DIR, 'models/'));
  return out;
}

/** Уровень 3 — один проект: project.json (секреты внутри) + все его разговоры. */
export function projectEntries(id: string): TransferEntry[] {
  const cfg = loadProjectConfig(id);
  if (!cfg) throw new Error(tf('проекта «{id}» нет — см. /project', { id }));
  const dir = join(PROJECTS_DIR, id);
  return [
    { rel: 'project.json', data: readFileSync(join(dir, 'project.json')) },
    ...sessionsEntries(join(dir, 'sessions'), 'sessions/'),
  ];
}

/** Уровень 1 — всё приложение: настройки дома + все проекты с разговорами. */
export function homeEntries(): TransferEntry[] {
  const out: TransferEntry[] = [];
  for (const f of HOME_FILES) {
    const data = readIfExists(join(DT_HOME, f));
    if (data) out.push({ rel: f, data });
  }
  // тула: tools/<id>.ts и прочие файлы — как лежат
  if (existsSync(TOOLS_DIR)) {
    for (const name of readdirSync(TOOLS_DIR)) {
      const p = join(TOOLS_DIR, name);
      if (existsSync(p) && statSync(p).isFile()) out.push({ rel: `tools/${name}`, data: readFileSync(p) });
    }
  }
  out.push(...dirFileEntries(MODELS_DIR, 'models/'));
  out.push(...dirFileEntries(AGENTS_DIR, 'agents/'));
  // все проекты: project.json + разговоры каждого
  for (const p of listProjects()) {
    out.push({ rel: `projects/${p.id}/project.json`, data: readFileSync(join(PROJECTS_DIR, p.id, 'project.json')) });
    out.push(...sessionsEntries(join(PROJECTS_DIR, p.id, 'sessions'), `projects/${p.id}/sessions/`));
  }
  return out;
}

/** Участники разговора без служебных id (manager/user) — только они ездят в архиве. */
function participantIds(s: Session): Set<string> {
  return new Set((s.participants ?? []).filter((id) => id !== 'manager' && id !== 'user'));
}

/** Записи одной сессии: разговор + карточки участников (для влива при импорте).
 *  Всей команды машины в архиве нет — карточки только у участников разговора. */
export function sessionEntriesById(app: App, id: string): TransferEntry[] {
  const s = app.store?.load(id);
  if (!s) throw new Error(tf('разговор «{id}» не читается', { id }));
  const out: TransferEntry[] = [{ rel: 'session.json', data: Buffer.from(JSON.stringify(s, null, 2) + '\n') }];
  const wanted = participantIds(s);
  if (wanted.size === 0 || !existsSync(AGENTS_DIR)) return out;
  const team = loadTeam(AGENTS_DIR);
  for (const a of team.filter((x) => wanted.has(x.id))) {
    const { id: _id, ...card } = a;
    out.push({ rel: `agents/${a.id}.json`, data: Buffer.from(JSON.stringify({ id: a.id, ...card }, null, 2) + '\n') });
  }
  return out;
}

export function packEntriesZip(entries: TransferEntry[]): Buffer {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.rel, e.data);
  return zip.toBuffer();
}

/** Читает zip: относительные имена, служебные записи и «..» отбрасываются (zip-slip мимо). */
export function readZipEntries(data: Buffer): TransferEntry[] {
  const zip = new AdmZip(data);
  const out: TransferEntry[] = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const rel = e.entryName.replace(/^\.?\//, '').replaceAll('\\', '/');
    if (rel.includes('..') || rel.startsWith('/')) continue;
    out.push({ rel, data: e.getData() });
  }
  return out;
}

// ── импорт: модели и менеджер перечитываются одинаково на уровнях 1–2 ────────

/** Заменить settings/профиль/менеджер файлами из архива; вернуть строки отчёта. */
function writeSettingsFiles(entries: TransferEntry[], files: readonly string[]): string[] {
  const report: string[] = [];
  for (const f of files) {
    const e = entries.find((x) => x.rel === f);
    if (!e) continue;
    writeFileSync(join(DT_HOME, f), e.data);
    report.push(tf('{file} — заменён', { file: f }));
  }
  return report;
}

/** Записать карточки моделей из архива; вернуть счётчик. */
function writeModelEntries(entries: TransferEntry[]): number {
  mkdirSync(MODELS_DIR, { recursive: true });
  let n = 0;
  for (const e of entries.filter((x) => x.rel.startsWith('models/'))) {
    const name = e.rel.slice('models/'.length);
    if (!name.endsWith('.json') || name.includes('/') || name.includes('..')) continue;
    writeFileSync(join(MODELS_DIR, name), e.data);
    n++;
  }
  return n;
}

/** Перечитать модели и менеджера в живом приложении; отчёт — в строки. */
function reloadModelsAndManager(app: App, report: string[]): void {
  let modelIds: Iterable<string> = [];
  try {
    const loaded = loadModels(MODELS_DIR);
    app.models = loaded.models;
    app.images = loaded.images;
    modelIds = loaded.models.keys();
    report.push(t('модели перечитаны'));
  } catch (err) {
    report.push(tf('модели не перечитались ({err})', { err: err instanceof Error ? err.message : String(err) }));
  }
  // manager.json заменён — менеджер в памяти перечитываем сразу, иначе он до
  // перезапуска живёт со старым именем и моделью из прежнего дома
  try {
    app.mgr = loadManagerConfig(MANAGER_FILE, modelIds);
  } catch (err) {
    report.push(tf('менеджер не перечитался ({err})', { err: err instanceof Error ? err.message : String(err) }));
  }
}

/** Разговоры из архива (sessions/*.json или projects/<id>/sessions/*.json) в sessions-папку проекта. */
function mergeSessions(sessionsDir: string, entries: TransferEntry[], currentSessionId: string | null): { count: number; reopened: boolean } {
  mkdirSync(sessionsDir, { recursive: true });
  let count = 0;
  let reopened = false;
  for (const e of entries) {
    if (!e.rel.endsWith('.json')) continue;
    try {
      const s = JSON.parse(e.data.toString('utf8')) as Session;
      if (!s || typeof s.id !== 'string' || !SESSION_ID_RE.test(s.id) || !Array.isArray(s.messages)) continue;
      reopened = reopened || s.id === currentSessionId;
      // дата из архива — данные разговора, а не машины: сохраняем как есть
      writeFileSync(join(sessionsDir, `${s.id}.json`), Buffer.from(JSON.stringify({ ...s, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now() }, null, 2) + '\n'));
      count++;
    } catch {
      // мусорная запись — не разговор; в дом ей не место
    }
  }
  return { count, reopened };
}

/**
 * Импорт сессии: разговор как новый (новый id — ничего не перетирается).
 * Из команды архива вливаются ТОЛЬКО участники разговора (participants):
 * agents.json в архиве — вся команда чужой машины, вливать её целиком
 * в локальную команду нельзя.
 */
export function applySessionImport(app: App, entries: TransferEntry[]): string {
  const report: string[] = [];
  const sessionEntry = entries.find((x) => x.rel === 'session.json');
  if (!sessionEntry) throw new Error(t('в архиве нет session.json — это не экспорт сессии'));

  let imported: Session;
  try {
    imported = JSON.parse(sessionEntry.data.toString('utf8')) as Session;
  } catch {
    // битый JSON — тот же честный отказ, что и JSON неправильной формы
    throw new Error(t('session.json в архиве не похож на разговор — импорт отменён'));
  }
  if (!imported || typeof imported !== 'object'
      || !Array.isArray(imported.messages)
      || typeof imported.title !== 'string') {
    throw new Error(t('session.json в архиве не похож на разговор — импорт отменён'));
  }
  const store = app.store;
  if (!store) throw new Error(t('нет открытого проекта — сначала /project new <имя> [папка] или /project open <имя|путь>'));
  const created = store.create();
  const now = Date.now();
  const newSession: Session = {
    ...imported,
    id: created.id,
    // «как новый» — только id; дата создания это данные разговора, а не машины
    createdAt: typeof imported.createdAt === 'number' ? imported.createdAt : now,
    updatedAt: now,
    // памяти команды в архиве сессии нет — «итоги уже в логе» здесь ложный флаг
    digestInLog: false,
  };
  store.save(newSession);
  const list = store.list();
  const pos = list.findIndex((m) => m.id === newSession.id) + 1;
  report.push(tf('разговор импортирован как №{n} («{title}»)', { n: pos, title: newSession.title }));

  const agentEntries = entries.filter((x) => x.rel.startsWith('agents/') && x.rel.endsWith('.json'));
  const wanted = participantIds(imported);
  if (agentEntries.length > 0 && wanted.size > 0) {
    mkdirSync(AGENTS_DIR, { recursive: true });
    const incoming: Agent[] = [];
    for (const e of agentEntries) {
      try {
        const card = JSON.parse(e.data.toString('utf8')) as Agent;
        if (card?.id && wanted.has(card.id)) incoming.push(card);
      } catch { /* мусорная карточка — пропускаем */ }
    }
    // только участники разговора — не вся команда машины-экспортёра
    const added = mergeTeamAgents(AGENTS_DIR, incoming);
    void loadTeam(AGENTS_DIR); // валидность после записи
    report.push(tf('участников влито: {n}', { n: added }));
  } else if (wanted.size === 0) {
    report.push(t('состав разговора не указан — команда не менялась'));
  }
  return tf('Импорт сессии выполнен: {report}', { report: report.join('; ') });
}

/** Уровень 2 — импорт настроек: settings/профиль/менеджер/модели заменяются; проекты не трогаются. */
export function applySettingsImport(app: App, entries: TransferEntry[]): string {
  const report = writeSettingsFiles(entries, SETTINGS_FILES);
  const models = writeModelEntries(entries);
  if (models > 0) report.push(tf('моделей влито: {n}', { n: models }));
  reloadModelsAndManager(app, report);
  return tf('Импорт настроек выполнен: {report}', { report: report.join('; ') });
}

/** Уровень 1 — импорт всего приложения: дом заменяется, проекты вливаются по id. */
export function applyHomeImport(app: App, entries: TransferEntry[]): string {
  const report = writeSettingsFiles(entries, HOME_FILES);
  mkdirSync(TOOLS_DIR, { recursive: true });
  let tools = 0;
  for (const e of entries.filter((x) => x.rel.startsWith('tools/'))) {
    const name = e.rel.slice('tools/'.length);
    if (!name || name.includes('/') || name.includes('..')) continue;
    writeFileSync(join(TOOLS_DIR, name), e.data);
    tools++;
  }
  if (tools > 0) report.push(tf('тулов влито: {n}', { n: tools }));
  const models = writeModelEntries(entries);
  if (models > 0) report.push(tf('моделей влито: {n}', { n: models }));
  // карточки агентов: agents/<id>.json — по файлу на агента
  mkdirSync(AGENTS_DIR, { recursive: true });
  let agents = 0;
  for (const e of entries.filter((x) => x.rel.startsWith('agents/'))) {
    const name = e.rel.slice('agents/'.length);
    if (!name.endsWith('.json') || name.includes('/') || name.includes('..')) continue;
    writeFileSync(join(AGENTS_DIR, name), e.data);
    agents++;
  }
  if (agents > 0) report.push(tf('агентов влито: {n}', { n: agents }));
  // после замены команды перечитываем память команды
  try {
    app.memory = loadTeamMemory(MEMORY_FILE);
  } catch {
    // память необязательна
  }
  reloadModelsAndManager(app, report);
  // проекты: по id — нового создаём целиком, у существующего настройки и
  // секреты остаются локальными, вливаются только разговоры
  let projects = 0;
  let sessions = 0;
  for (const e of entries.filter((x) => x.rel === 'project.json' || x.rel.startsWith('projects/'))) {
    const m = e.rel.match(/^projects\/([^/]+)\/(project\.json|sessions\/.+)$/);
    if (!m) continue;
    const id = m[1];
    if (!SESSION_ID_RE.test(id)) continue;
    if (e.rel.endsWith('project.json')) {
      if (loadProjectConfig(id)) continue; // локальный проект сильнее архива
      try {
        const imported = JSON.parse(e.data.toString('utf8')) as Partial<ProjectConfig>;
        const cfg: ProjectConfig = {
          id,
          createdAt: typeof imported.createdAt === 'number' ? imported.createdAt : Date.now(),
          hosts: imported.hosts && typeof imported.hosts === 'object' ? imported.hosts : {},
          mails: imported.mails && typeof imported.mails === 'object' ? imported.mails : {},
          messengers: imported.messengers && typeof imported.messengers === 'object' ? imported.messengers : {},
        };
        if (typeof imported.path === 'string' && imported.path.trim() && existsSync(imported.path.trim())) cfg.path = imported.path.trim();
        saveProjectConfig(cfg);
        projects++;
      } catch { /* битый project.json — проект пропускаем */ }
    } else {
      const { count, reopened } = mergeSessions(
        join(PROJECTS_DIR, id, 'sessions'),
        [e],
        app.store && app.session ? app.session.id : null,
      );
      sessions += count;
      if (reopened && app.store && app.session) {
        // в архиве был текущий открытый разговор: перечитываем с диска, чтобы
        // память не затёрла влитые данные при следующем сохранении
        const fresh = app.store.load(app.session.id);
        if (fresh) app.session = fresh;
      }
    }
  }
  if (projects > 0) report.push(tf('проектов создано: {n}', { n: projects }));
  if (sessions > 0) report.push(tf('разговоров влито: {n}', { n: sessions }));
  return tf('Импорт приложения выполнен: {report}', { report: report.join('; ') });
}

/** Уровень 3 — импорт проекта: id занят → влив разговоров, свободен → новый проект. */
export function applyProjectImport(app: App, entries: TransferEntry[], idArg?: string): string {
  const entry = entries.find((x) => x.rel === 'project.json');
  if (!entry) throw new Error(t('в архиве нет project.json — это не экспорт проекта'));
  let raw: Partial<ProjectConfig>;
  try {
    raw = JSON.parse(entry.data.toString('utf8')) as Partial<ProjectConfig>;
  } catch {
    throw new Error(t('project.json в архиве не читается — импорт отменён'));
  }
  // имя: аргумент сильнее, иначе — id из архива (имя папки на машине-экспортёре)
  const id = validateProjectId(idArg?.trim() || String(raw.id ?? '') || 'project');
  const existed = Boolean(loadProjectConfig(id));
  const report: string[] = [];
  if (!existed) {
    const cfg: ProjectConfig = {
      id,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      hosts: raw.hosts && typeof raw.hosts === 'object' ? raw.hosts : {},
      mails: raw.mails && typeof raw.mails === 'object' ? raw.mails : {},
      messengers: raw.messengers && typeof raw.messengers === 'object' ? raw.messengers : {},
    };
    // рабочая папка машины-экспортёра здесь может не существовать — не тащим
    // чужой путь вслепую: нет папки на диске → проект остаётся без workspace
    if (typeof raw.path === 'string' && raw.path.trim() && existsSync(raw.path.trim())) cfg.path = raw.path.trim();
    else report.push(t('рабочей папки с машины-экспортёра здесь нет — задайте свою: /project path <папка>'));
    saveProjectConfig(cfg);
    report.push(tf('проект «{id}» создан', { id }));
  } else {
    // локальные настройки и секреты проекта сильнее архива
    report.push(tf('проект «{id}» уже был — настройки сохранены локальные', { id }));
  }
  const { count, reopened } = mergeSessions(
    join(PROJECTS_DIR, id, 'sessions'),
    entries.filter((x) => x.rel.startsWith('sessions/')),
    existed && app.session && PROJECT_DIR && basename(PROJECT_DIR) === id ? app.session.id : null,
  );
  if (count > 0) report.push(tf('разговоров влито: {n}', { n: count }));
  if (reopened && app.store && app.session) {
    // вливали в открытый проект и попали в текущий разговор: перечитываем
    const fresh = app.store.load(app.session.id);
    if (fresh) app.session = fresh;
  }
  return tf('Импорт проекта выполнен: {report}', { report: report.join('; ') });
}
