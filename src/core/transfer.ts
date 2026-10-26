/**
 * Импорт-экспорт: упаковка/разбор zip-переносов для домашних настроек и
 * отдельных разговоров. Формат — обычный zip (adm-zip, как в тулe arch):
 * дом — settings/user/providers + agents/manager + память/расписание +
 * tools/ + sessions/ (все разговоры текущего проекта); сессия — session.json
 * + карточки участников (agents.json, и только они — архив сессии уезжает
 * к чужим людям).
 *
 * Экспорт — снимок дома для переезда на другую машину: настройки, команда,
 * провайдеры вместе с ключами карточек (apiKey…) и все разговоры текущего
 * проекта. Не переносится только .env: это настройки самой машины (TOKEN,
 * PORT, HOST для serve), на новом месте дом создаст его из примера.
 * Транскрипты в архив не пакуются — это производный кэш, они перегенерируются
 * из session.json при первом же сохранении.
 *
 * Импорт дома: настройки/профиль/провайдеры/менеджер заменяются, разговоры
 * вливаются в текущий проект по id (совпавшие — заменяются, открытый
 * разговор перечитывается с диска). Импорт сессии: разговор разворачивается
 * КАК НОВАЯ сессия (новый id — ничего не перетирается), участники вливаются
 * по id (новые добавляются, совпавшие не трогаются); дата создания
 * сохраняется, digestInLog сбрасывается — памяти команды в архиве сессии нет.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { loadModels } from '../providers/registry.js';
import { loadTeam } from '../agents.js';
import { loadTeamMemory } from '../memory.js';
import {
  AGENTS_FILE,
  DT_HOME,
  MANAGER_FILE,
  MEMORY_FILE,
  MODELS_DIR,
  TOOLS_DIR,
  USER_FILE,
} from '../paths.js';
import { loadManagerConfig, mergeTeamAgents } from '../manager.js';
import { t, tf } from '../i18n.js';
import type { App } from './engine.js';
import type { Agent, Session } from '../types.js';

export interface TransferEntry {
  rel: string;
  data: Buffer;
}

const HOME_FILES = ['settings.json', 'user.json', 'agents.json', 'manager.json', 'memory.json', 'schedule.json'] as const;
/** id разговора — метка времени; из архива путь строится только из такого id (zip-slip мимо). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Записи домашнего слоя + все разговоры текущего проекта; .env — вещь машины. */
export function homeEntries(app: App): TransferEntry[] {
  const out: TransferEntry[] = [];
  for (const f of HOME_FILES) {
    const p = join(DT_HOME, f);
    if (existsSync(p)) out.push({ rel: f, data: readFileSync(p) });
  }
  if (existsSync(TOOLS_DIR)) {
    for (const name of readdirSync(TOOLS_DIR)) {
      const p = join(TOOLS_DIR, name);
      if (existsSync(p) && statSync(p).isFile()) out.push({ rel: `tools/${name}`, data: readFileSync(p) });
    }
  }
  // карточки моделей: models/<id>.json — по файлу на модель
  if (existsSync(MODELS_DIR)) {
    for (const name of readdirSync(MODELS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const p = join(MODELS_DIR, name);
      if (existsSync(p) && statSync(p).isFile()) out.push({ rel: `models/${name}`, data: readFileSync(p) });
    }
  }
  for (const meta of app.store.list()) {
    const s = app.store.load(meta.id);
    if (s && SESSION_ID_RE.test(s.id)) out.push({ rel: `sessions/${s.id}.json`, data: Buffer.from(JSON.stringify(s, null, 2) + '\n') });
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
  const s = app.store.load(id);
  if (!s) throw new Error(tf('разговор «{id}» не читается', { id }));
  const out: TransferEntry[] = [{ rel: 'session.json', data: Buffer.from(JSON.stringify(s, null, 2) + '\n') }];
  const wanted = participantIds(s);
  if (wanted.size === 0 || !existsSync(AGENTS_FILE)) return out;
  const team = JSON.parse(readFileSync(AGENTS_FILE, 'utf8')) as Agent[];
  const cards = team.filter((a) => wanted.has(a.id));
  if (cards.length > 0) out.push({ rel: 'agents.json', data: Buffer.from(JSON.stringify(cards, null, 2) + '\n') });
  return out;
}

/** Записи одной сессии по номеру списка (свежие сверху). Номер резолвится один
 *  раз — архив и его имя всегда про один и тот же разговор. */
export function sessionEntries(app: App, n: number): TransferEntry[] {
  const meta = app.store.list()[n - 1];
  if (!meta) throw new Error(tf('не нашёл разговор №{n} — см. /sessions', { n }));
  return sessionEntriesById(app, meta.id);
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

/** Импорт домашнего слоя: настройки/профиль/провайдеры/команда — замена (разговоры импортируются отдельно, /session import). */
export function applyHomeImport(app: App, entries: TransferEntry[]): string {
  const report: string[] = [];
  for (const f of HOME_FILES) {
    const e = entries.find((x) => x.rel === f);
    if (!e) continue;
    writeFileSync(join(DT_HOME, f), e.data);
    report.push(tf('{file} — заменён', { file: f }));
  }
  mkdirSync(TOOLS_DIR, { recursive: true });
  let tools = 0;
  for (const e of entries.filter((x) => x.rel.startsWith('tools/'))) {
    const name = e.rel.slice('tools/'.length);
    if (!name || name.includes('/') || name.includes('..')) continue;
    writeFileSync(join(TOOLS_DIR, name), e.data);
    tools++;
  }
  if (tools > 0) report.push(tf('тулов влито: {n}', { n: tools }));
  // карточки моделей: models/<id>.json — по файлу на модель
  mkdirSync(MODELS_DIR, { recursive: true });
  let models = 0;
  for (const e of entries.filter((x) => x.rel.startsWith('models/'))) {
    const name = e.rel.slice('models/'.length);
    if (!name.endsWith('.json') || name.includes('/') || name.includes('..')) continue;
    writeFileSync(join(MODELS_DIR, name), e.data);
    models++;
  }
  if (models > 0) report.push(tf('моделей влито: {n}', { n: models }));
  // после замены команды перечитываем память команды
  try {
    app.memory = loadTeamMemory(MEMORY_FILE);
  } catch {
    // память необязательна
  }
  // модели: перечитываем и обновляем карты приложения
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
  // разговоры текущего проекта: влив по id, совпавшие заменяются. Транскрипты
  // перегенерируются при сохранении. Кривые записи пропускаем молча (в отчёте — счёт).
  let sessions = 0;
  let reopened = false;
  for (const e of entries) {
    if (!e.rel.startsWith('sessions/') || !e.rel.endsWith('.json')) continue;
    try {
      const s = JSON.parse(e.data.toString('utf8')) as Session;
      if (!s || typeof s.id !== 'string' || !SESSION_ID_RE.test(s.id) || !Array.isArray(s.messages)) continue;
      reopened = reopened || s.id === app.session.id;
      // дата из архива — данные разговора, а не машины: сохраняем как есть
      app.store.save({ ...s, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now() }, { touch: false });
      sessions++;
    } catch {
      // мусорная запись — не разговор; в дом ей не место
    }
  }
  if (sessions > 0) {
    report.push(tf('разговоров влито: {n}', { n: sessions }));
    if (reopened) {
      // в архиве был текущий открытый разговор: перечитываем с диска, чтобы
      // память не затёрла влитые данные при следующем сохранении
      const fresh = app.store.load(app.session.id);
      if (fresh) app.session = fresh;
    }
  }
  return tf('Импорт дома выполнен: {report}', { report: report.join('; ') });
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
  const created = app.store.create();
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
  app.store.save(newSession);
  const list = app.store.list();
  const pos = list.findIndex((m) => m.id === newSession.id) + 1;
  report.push(tf('разговор импортирован как №{n} («{title}»)', { n: pos, title: newSession.title }));

  const agentsEntry = entries.find((x) => x.rel === 'agents.json');
  const wanted = participantIds(imported);
  if (agentsEntry && wanted.size > 0) {
    const wholeTeam = JSON.parse(agentsEntry.data.toString('utf8')) as Agent[];
    // только участники разговора — не вся команда машины-экспортёра
    const incoming = wholeTeam.filter((a) => wanted.has(a.id));
    const added = mergeTeamAgents(AGENTS_FILE, incoming);
    void loadTeam(AGENTS_FILE); // валидность после записи
    report.push(tf('участников влито: {n}', { n: added }));
  } else if (wanted.size === 0) {
    report.push(t('состав разговора не указан — команда не менялась'));
  }
  return tf('Импорт сессии выполнен: {report}', { report: report.join('; ') });
}

/** Пересобрать мету текущего списка (для GUI-сортировки не нужна — утилита). */
export function metasOf(app: App): SessionMetaLike[] {
  return app.store.list();
}
export interface SessionMetaLike {
  id: string;
  title: string;
}
