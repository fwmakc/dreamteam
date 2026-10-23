/**
 * Импорт-экспорт: упаковка/разбор zip-переносов для домашних настроек и
 * отдельных разговоров. Формат — обычный zip (adm-zip, как в тулe arch):
 * settings/user/providers + sessions/ + transcripts/ для дома;
 * session.json + agents.json + settings.json для сессии.
 *
 * Секреты сознательно не переносятся: .env в архив не попадает, а из
 * providers.json при упаковке вырезаются ключи карточек (apiKey, clientId,
 * clientSecret) — после импорта их вписывают заново, отчёт об этом напомнит.
 *
 * Импорт дома: настройки/профиль/провайдеры заменяются, разговоры вливаются
 * по id (совпавшие — заменяются). Импорт сессии: разговор разворачивается
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
  MEMORY_FILE,
  PROVIDERS_FILE,
  SETTINGS_FILE,
  TOOLS_DIR,
  USER_FILE,
} from '../paths.js';
import { mergeTeamAgents } from '../manager.js';
import type { App } from './engine.js';
import type { Agent, Session } from '../types.js';

export interface TransferEntry {
  rel: string;
  data: Buffer;
}

const HOME_FILES = ['settings.json', 'user.json', 'providers.json', 'agents.json', 'manager.json'] as const;

/** Секретные поля карточек провайдеров: в архив не включаются. */
const PROVIDER_SECRET_FIELDS = ['apiKey', 'clientId', 'clientSecret'] as const;

/**
 * providers.json без секретов: конфиг (адаптер, модель, baseUrl) едет,
 * ключи остаются на машине.
 */
function providersWithoutSecrets(): Buffer {
  const raw = JSON.parse(readFileSync(join(DT_HOME, 'providers.json'), 'utf8')) as {
    providers?: Record<string, Record<string, unknown>>;
  };
  for (const card of Object.values(raw.providers ?? {})) {
    if (!card || typeof card !== 'object') continue;
    for (const f of PROVIDER_SECRET_FIELDS) delete card[f];
  }
  return Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
}

/** Записи домашнего слоя: настройки, профиль, провайдеры (карточки без ключей), команда и тула; .env не переносится. */
export function homeEntries(): TransferEntry[] {
  const out: TransferEntry[] = [];
  for (const f of HOME_FILES) {
    const p = join(DT_HOME, f);
    if (!existsSync(p)) continue;
    out.push({ rel: f, data: f === 'providers.json' ? providersWithoutSecrets() : readFileSync(p) });
  }
  for (const name of readdirSync(TOOLS_DIR)) {
    const p = join(TOOLS_DIR, name);
    if (existsSync(p) && statSync(p).isFile()) out.push({ rel: `tools/${name}`, data: readFileSync(p) });
  }
  return out;
}

/** Записи одной сессии: разговор, состав команды проекта, настройки. */
export function sessionEntries(app: App, n: number): TransferEntry[] {
  const meta = app.store.list()[n - 1];
  if (!meta) throw new Error(`не нашёл разговор №${n} — см. /sessions`);
  const s = app.store.load(meta.id);
  if (!s) throw new Error(`разговор №${n} не читается`);
  const out: TransferEntry[] = [{ rel: 'session.json', data: Buffer.from(JSON.stringify(s, null, 2) + '\n') }];
  if (existsSync(AGENTS_FILE)) out.push({ rel: 'agents.json', data: readFileSync(AGENTS_FILE) });
  if (existsSync(SETTINGS_FILE)) out.push({ rel: 'settings.json', data: readFileSync(SETTINGS_FILE) });
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
  // после замены команды перечитываем её — агенты в текущем разговоре могли измениться
  try {
    app.memory = loadTeamMemory(MEMORY_FILE);
  } catch {
    // память необязательна
  }
  // провайдеры: перечитываем и обновляем карту приложения
  try {
    const loaded = loadProviders(PROVIDERS_FILE);
    for (const [k, v] of loaded.providers) app.providers.set(k, v);
    for (const k of [...app.providers.keys()]) if (!loaded.providers.has(k)) app.providers.delete(k);
    app.defaultProviderId = loaded.defaultId;
    report.push('провайдеры перечитаны');
    if (entries.some((x) => x.rel === 'providers.json')) {
      report.push('ключи провайдеров в архив не входят — впиши "apiKey" в карточки providers.json');
    }
  } catch (err) {
    report.push(`провайдеры не перечитались (${err instanceof Error ? err.message : err})`);
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
