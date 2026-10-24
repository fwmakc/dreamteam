/**
 * Импорт-экспорт: упаковка/разбор zip-переносов для домашних настроек и
 * отдельных разговоров. Формат — обычный zip (adm-zip, как в тулe arch):
 * дом — settings/user/providers + agents/manager + tools/ + sessions/ (все
 * разговоры текущего проекта); сессия — session.json + agents.json.
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
 * КАК НОВАЯ сессия (новый id — ничего не перетирается), агенты вливаются
 * по id (новые добавляются, совпавшие не трогаются).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { loadProviders } from '../providers/registry.js';
import { loadTeam } from '../agents.js';
import { loadTeamMemory } from '../memory.js';
import {
  AGENTS_FILE,
  DT_HOME,
  MANAGER_FILE,
  MEMORY_FILE,
  PROVIDERS_FILE,
  TOOLS_DIR,
  USER_FILE,
} from '../paths.js';
import { loadManagerConfig, mergeTeamAgents } from '../manager.js';
import type { App } from './engine.js';
import type { Agent, Session } from '../types.js';

export interface TransferEntry {
  rel: string;
  data: Buffer;
}

const HOME_FILES = ['settings.json', 'user.json', 'providers.json', 'agents.json', 'manager.json'] as const;
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
  for (const meta of app.store.list()) {
    const s = app.store.load(meta.id);
    if (s && SESSION_ID_RE.test(s.id)) out.push({ rel: `sessions/${s.id}.json`, data: Buffer.from(JSON.stringify(s, null, 2) + '\n') });
  }
  return out;
}

/** Записи одной сессии: разговор + состав команды (для влива участников при импорте). */
export function sessionEntries(app: App, n: number): TransferEntry[] {
  const meta = app.store.list()[n - 1];
  if (!meta) throw new Error(`не нашёл разговор №${n} — см. /sessions`);
  const s = app.store.load(meta.id);
  if (!s) throw new Error(`разговор №${n} не читается`);
  const out: TransferEntry[] = [{ rel: 'session.json', data: Buffer.from(JSON.stringify(s, null, 2) + '\n') }];
  if (existsSync(AGENTS_FILE)) out.push({ rel: 'agents.json', data: readFileSync(AGENTS_FILE) });
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

/** Импорт домашнего слоя: настройки/профиль/провайдеры/команда — замена (разговоры импортируются отдельно, /session import). */
export function applyHomeImport(app: App, entries: TransferEntry[]): string {
  const report: string[] = [];
  for (const f of HOME_FILES) {
    const e = entries.find((x) => x.rel === f);
    if (!e) continue;
    writeFileSync(join(DT_HOME, f), e.data);
    report.push(`${f} — заменён`);
  }
  mkdirSync(TOOLS_DIR, { recursive: true });
  let tools = 0;
  for (const e of entries.filter((x) => x.rel.startsWith('tools/'))) {
    const name = e.rel.slice('tools/'.length);
    if (!name || name.includes('/') || name.includes('..')) continue;
    writeFileSync(join(TOOLS_DIR, name), e.data);
    tools++;
  }
  if (tools > 0) report.push(`тулов влито: ${tools}`);
  // после замены команды перечитываем память команды
  try {
    app.memory = loadTeamMemory(MEMORY_FILE);
  } catch {
    // память необязательна
  }
  // провайдеры: перечитываем и обновляем карту приложения (ключи теперь в карточках)
  let providerIds: Iterable<string> = [];
  try {
    const loaded = loadProviders(PROVIDERS_FILE);
    for (const [k, v] of loaded.providers) app.providers.set(k, v);
    for (const k of [...app.providers.keys()]) if (!loaded.providers.has(k)) app.providers.delete(k);
    app.defaultProviderId = loaded.defaultId;
    providerIds = loaded.providers.keys();
    report.push('провайдеры перечитаны');
  } catch (err) {
    report.push(`провайдеры не перечитались (${err instanceof Error ? err.message : err})`);
  }
  // manager.json заменён — менеджер в памяти перечитываем сразу, иначе он до
  // перезапуска живёт со старым именем и провайдером из прежнего дома
  try {
    app.mgr = loadManagerConfig(MANAGER_FILE, providerIds);
  } catch (err) {
    report.push(`менеджер не перечитался (${err instanceof Error ? err.message : err})`);
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
      app.store.save({ ...s, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now() });
      sessions++;
    } catch {
      // мусорная запись — не разговор; в дом ей не место
    }
  }
  if (sessions > 0) {
    report.push(`разговоров влито: ${sessions}`);
    if (reopened) {
      // в архиве был текущий открытый разговор: перечитываем с диска, чтобы
      // память не затёрла влитые данные при следующем сохранении
      const fresh = app.store.load(app.session.id);
      if (fresh) app.session = fresh;
    }
  }
  return `Импорт дома выполнен: ${report.join('; ')}`;
}

/** Импорт сессии: разговор как новый (новый id), агенты вливаются по id. */
export function applySessionImport(app: App, entries: TransferEntry[]): string {
  const report: string[] = [];
  const sessionEntry = entries.find((x) => x.rel === 'session.json');
  if (!sessionEntry) throw new Error('в архиве нет session.json — это не экспорт сессии');

  const imported = JSON.parse(sessionEntry.data.toString('utf8')) as Session;
  const created = app.store.create();
  const newSession: Session = {
    ...imported,
    id: created.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  app.store.save(newSession);
  const list = app.store.list();
  const pos = list.findIndex((m) => m.id === newSession.id) + 1;
  report.push(`разговор импортирован как №${pos} («${newSession.title}»)`);

  const agentsEntry = entries.find((x) => x.rel === 'agents.json');
  if (agentsEntry) {
    const incoming = JSON.parse(agentsEntry.data.toString('utf8')) as Agent[];
    const file = AGENTS_FILE;
    const added = mergeTeamAgents(file, incoming);
    void loadTeam(file); // валидность после записи
    report.push(`агентов добавлено: ${added}`);
  }
  return `Импорт сессии выполнен: ${report.join('; ')}`;
}

/** Пересобрать мету текущего списка (для GUI-сортировки не нужна — утилита). */
export function metasOf(app: App): SessionMetaLike[] {
  return app.store.list();
}
export interface SessionMetaLike {
  id: string;
  title: string;
}
