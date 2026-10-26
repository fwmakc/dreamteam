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
  AGENTS_DIR,
  DT_HOME,
  MANAGER_FILE,
  MEMORY_FILE,
  MODELS_DIR,
  PROJECTS_FILE,
  PROVIDERS_DIR,
  SESSIONS_DIR,
  SETTINGS_FILE,
  TOOLS_DIR,
  USER_FILE,
  WORKSPACE,
} from '../paths.js';
import { ensureLayers } from '../wizard.js';
import { rememberProject } from './projects.js';
import { applyLocale, preloadLocale } from '../i18n.js';
import { loadModels, loadUserAdapters, setUserAdapters } from '../providers/registry.js';
import { loadTeamMemory } from '../memory.js';
import { printDim, printError } from '../ui.js';
import { loadTeamOrEmpty } from '../agents.js';
import type { App } from './engine.js';
import type { Agent } from '../types.js';

/** Ссылки на модели должны указывать на существующие карточки: settings.model,
 *  settings.serviceModel, manager.model, у агентов — model/vision/image. */
function validateModelRefs(
  models: Map<string, unknown>,
  ui: import('../settings.js').SettingsConfig,
  mgr: import('../types.js').ManagerConfig,
  agents: Agent[],
): void {
  const known = [...models.keys()];
  const check = (where: string, ref?: { id?: string }): void => {
    if (!ref?.id) return;
    if (!models.has(ref.id)) {
      throw new Error(
        `${where}: модель «${ref.id}» не найдена — есть: ${known.join(', ') || '(нет)'}`,
      );
    }
  };
  check('settings.json: model', ui.model);
  check('settings.json: serviceModel', ui.serviceModel);
  check('manager.json: model', mgr.model);
  for (const a of agents) {
    check(`агент «${a.id}»: model`, a.model);
    check(`агент «${a.id}»: vision`, a.vision);
    check(`агент «${a.id}»: image`, a.image);
  }
}

/**
 * Общий старт ядра для оболочек (терминал, serve): env дома, миграция,
 * wizard при первом запуске, конфиги, fail-fast на битых файлах. Стартовые
 * заметки печатаются в обычный терминал — оболочка стартует после.
 */
export async function bootstrapApp(): Promise<{ app: App; ui: SettingsConfig }> {
  // переменные дома (.env) — настройки самого приложения: serve читает TOKEN,
  // PORT, HOST. Ровно один .env, в доме: ни корень проекта, ни папка установки
  // не читаются (не надо гадать, откуда взялась переменная)
  dotenv.config({ path: join(DT_HOME, '.env') });
  // язык интерфейса — до мастера и заметок: settings.json уже может существовать
  preloadLocale(SETTINGS_FILE, DT_HOME);
  // первый запуск: wizard (нет провайдеров) и скаффолдинг .dreamteam в проекте
  try {
    for (const note of await ensureLayers()) console.log(pc.dim(`  ${note}`));
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  // настройки читаем до всего вывода: ошибка конфига видна в обычном терминале
  const ui = loadSettings(SETTINGS_FILE, process.stdout.columns || 0);
  // авторитетное применение языка: неизвестный id или битый lang/<id>.json —
  // громкая ошибка со списком доступных (до старта оболочки)
  applyLocale(ui.ui, DT_HOME);
  const store = new SessionStore(SESSIONS_DIR);
  // кастомные адаптеры провайдеров: providers/<id>.ts в доме. До loadModels:
  // битый файл или коллизия со встроенным именем — громкая ошибка до старта
  setUserAdapters(await loadUserAdapters(PROVIDERS_DIR));
  // карточки моделей: models/*.json; контракт адаптера валидирует ключи —
  // отсутствующий обязательный параметр виден здесь, с именем параметра
  const { models, images } = loadModels(MODELS_DIR);
  // менеджер переговорки: обязательный конфиг, неизвестная модель — падение до старта оболочки
  const mgr = loadManagerConfig(MANAGER_FILE, models.keys());
  // тула: fail-fast — кривой файл в tools/ или карточка в agents.json видны до старта оболочки
  // (дальше они перечитываются каждый раунд уже с мягкой обработкой)
  await loadUserTools(TOOLS_DIR);
  // при старте продолжаем последний разговор, а не плодим пустые сессии
  const existing = store.list();
  const session = existing.length > 0 ? store.load(existing[0].id) ?? store.create() : store.create();
  const app: App = {
    store,
    session,
    models,
    images,
    mgr,
    settings: ui,
    profile: loadUserProfile(USER_FILE),
    memory: loadTeamMemory(MEMORY_FILE),
  };
  // ссылки на модели (settings.model.id, агенты, менеджер) должны указывать
  // на существующие карточки — проверяем сразу, с перечнем доступных
  validateModelRefs(models, ui, mgr, loadTeamOrEmpty(AGENTS_DIR));
  // реестр проектов: папка старта — текущий проект (смена — /project open).
  // Не критично для старта: сломанный реестр не должен мешать работе.
  try {
    rememberProject(PROJECTS_FILE, WORKSPACE, true);
  } catch {
    // ignore
  }
  return { app, ui };
}
