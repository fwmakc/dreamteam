import dotenv from 'dotenv';
import { join } from 'node:path';
import pc from 'picocolors';
import { loadUserProfile } from '../agents.js';
import { loadManagerConfig } from '../manager.js';
import { loadUserTools } from '../tools-registry.js';
import { SessionStore } from '../sessions.js';
import { loadSettings, type SettingsConfig } from '../settings.js';
// пути всех трёх слоёв (пакет / дом / проект) — только в paths.ts
import {
  DT_HOME,
  MANAGER_FILE,
  MEMORY_FILE,
  PROVIDERS_FILE,
  SESSIONS_DIR,
  SETTINGS_FILE,
  TOOLS_DIR,
  USER_FILE,
  migrateLegacy,
} from '../paths.js';
import { ensureLayers } from '../wizard.js';
import { loadProviders, loadImageProviders } from '../providers/registry.js';
import { loadTeamMemory } from '../memory.js';
import { printDim, printError } from '../ui.js';
import type { App } from './engine.js';

/**
 * Общий старт ядра для оболочек (терминал, serve): env дома, миграция,
 * wizard при первом запуске, конфиги, fail-fast на битых файлах. Стартовые
 * заметки печатаются в обычный терминал — оболочка стартует после.
 */
export async function bootstrapApp(): Promise<{ app: App; ui: SettingsConfig }> {
  // ключи провайдеров — ровно один .env, в доме: ни корень проекта, ни папка
  // установки не читаются (не надо гадать, откуда взялась переменная)
  dotenv.config({ path: join(DT_HOME, '.env') });
  // однократная миграция старой схемы (config/ и data/ в корне пакета) на слои
  for (const note of migrateLegacy()) console.log(pc.dim(`  миграция: ${note}`));
  // первый запуск: wizard (нет провайдеров) и скаффолдинг .dreamteam в проекте
  try {
    for (const note of await ensureLayers()) console.log(pc.dim(`  ${note}`));
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  // настройки читаем до всего вывода: ошибка конфига видна в обычном терминале
  const ui = loadSettings(SETTINGS_FILE, process.stdout.columns || 0);
  const store = new SessionStore(SESSIONS_DIR);
  const loaded = loadProviders(PROVIDERS_FILE);
  const images = loadImageProviders(PROVIDERS_FILE);
  // менеджер переговорки: обязательный конфиг, неизвестный провайдер — падение до старта оболочки
  const mgr = loadManagerConfig(MANAGER_FILE, loaded.providers.keys());
  // тула: fail-fast — кривой файл в tools/ или карточка в agents.json видны до старта оболочки
  // (дальше они перечитываются каждый раунд уже с мягкой обработкой)
  await loadUserTools(TOOLS_DIR);
  // при старте продолжаем последний разговор, а не плодим пустые сессии
  const existing = store.list();
  const session = existing.length > 0 ? store.load(existing[0].id) ?? store.create() : store.create();
  const app: App = {
    store,
    session,
    providers: loaded.providers,
    images: images.images,
    defaultProviderId: loaded.defaultId,
    mgr,
    profile: loadUserProfile(USER_FILE),
    memory: loadTeamMemory(MEMORY_FILE),
  };
  return { app, ui };
}
