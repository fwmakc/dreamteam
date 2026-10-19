/**
 * Слой путей — единственное место, где считаются пути приложения.
 *
 * Три слоя (см. plan.md):
 *  - пакет (APP_ROOT): код приложения, только чтение;
 *  - дом (DT_HOME, по умолчанию ~/.dreamteam): провайдеры с ключами, настройки,
 *    профиль пользователя, все разговоры и транскрипты — вещь машины, не проекта;
 *  - проект (DT_PROJECT, по умолчанию <cwd>/.dreamteam): команда, менеджер,
 *    реестр серверов, память команды, пользовательские тула.
 *
 * Переменные окружения DT_HOME и DT_PROJECT переопределяют слои — так работают
 * пробники: указывают во временные папки и гарантированно не трогают реальные
 * данные. Рабочая папка инструментов (WORKSPACE) — всегда текущая папка:
 * приложение запускается внутри проекта и работает в нём же.
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень пакета (код приложения, только чтение). */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Дом: ключи провайдеров, настройки, профиль, разговоры. */
export const DT_HOME = process.env.DT_HOME ? resolve(process.env.DT_HOME) : join(homedir(), '.dreamteam');

/** Служебная папка проекта (.dreamteam): команда, менеджер, серверы, память, тула. */
export const DT_PROJECT = process.env.DT_PROJECT ? resolve(process.env.DT_PROJECT) : join(resolve(process.cwd()), '.dreamteam');

/** Рабочая папка инструментов: всегда текущая папка (проект = где запущено). */
export const WORKSPACE = resolve(process.cwd());

/** Файлы дом-слоя. */
export const PROVIDERS_FILE = join(DT_HOME, 'providers.json');
export const SETTINGS_FILE = join(DT_HOME, 'settings.json');
export const USER_FILE = join(DT_HOME, 'user.json');
export const SESSIONS_DIR = join(DT_HOME, 'sessions');

/** Файлы проект-слоя. */
export const AGENTS_FILE = join(DT_PROJECT, 'agents.json');
export const MANAGER_FILE = join(DT_PROJECT, 'manager.json');
export const PROJECTS_FILE = join(DT_PROJECT, 'projects.json');
export const MEMORY_FILE = join(DT_PROJECT, 'memory.json');
export const TOOLS_DIR = join(DT_PROJECT, 'tools');

/**
 * Однократная миграция старой схемы (config/ и data/ в корне пакета) на слои.
 * Вызывается на старте до чтения конфигов; возвращает список человекочитаемых
 * заметок о переносах (печатает вызывающий). Когда заданы DT_HOME/DT_PROJECT —
 * молча ничего не делает: это пробник, реальные данные трогать нельзя.
 * Переносит только то, что ещё не перенесено; каталоги не удаляет —
 * после переноса они остаются пустыми как архив.
 */
export function migrateLegacy(root: string = APP_ROOT): string[] {
  if (process.env.DT_HOME || process.env.DT_PROJECT) return [];
  const notes: string[] = [];
  const legacyConfig = join(root, 'config');
  const legacyData = join(root, 'data');
  if (!existsSync(legacyConfig) && !existsSync(legacyData)) return notes;

  const moveFile = (from: string, to: string): void => {
    if (!existsSync(from) || existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    notes.push(`${from} → ${to}`);
  };

  // config/: ключи и настройки — в дом, команда и серверы — в проект
  moveFile(join(legacyConfig, 'providers.json'), PROVIDERS_FILE);
  moveFile(join(legacyConfig, 'settings.json'), SETTINGS_FILE);
  moveFile(join(legacyConfig, 'user.json'), USER_FILE);
  moveFile(join(legacyConfig, 'agents.json'), AGENTS_FILE);
  moveFile(join(legacyConfig, 'manager.json'), MANAGER_FILE);
  moveFile(join(legacyConfig, 'projects.json'), PROJECTS_FILE);

  // data/: разговоры и транскрипты — в дом, память команды — в проект
  for (const [sub, dest] of [
    ['sessions', SESSIONS_DIR],
    ['transcripts', join(DT_HOME, 'transcripts')],
  ] as const) {
    const src = join(legacyData, sub);
    if (!existsSync(src)) continue;
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) moveFile(join(src, name), join(dest, name));
    notes.push(`${src} → ${dest}`);
  }
  moveFile(join(legacyData, 'memory.json'), MEMORY_FILE);

  if (notes.length > 0) {
    notes.push(`устаревшие каталоги ${legacyConfig} и ${legacyData} остались на месте (архив) — можно удалить`);
  }
  return notes;
}
