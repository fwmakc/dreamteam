/**
 * Слой путей — единственное место, где считаются пути приложения.
 *
 * Два слоя (подробнее — в README, раздел «Три слоя»):
 *  - пакет (APP_ROOT): код приложения, только чтение;
 *  - дом (DT_HOME, по умолчанию ~/.dreamteam): ВСЁ глобальное — ключи, настройки,
 *    профиль, команда (агенты, менеджер, тула), расписание, общая память.
 *    Команда — свойство машины: симулятор команды настраивается один раз.
 *  - проект (DT_PROJECT, по умолчанию <cwd>/.dreamteam): ВСЁ про конкретный
 *    проект — hosts.json (ssh-серверы), почта и боты проекта (mails.json,
 *    messengers.json), переписка (sessions/, transcripts/). Файлы работы
 *    тулов — в текущей папке (WORKSPACE).
 *
 * Переменные окружения DT_HOME и DT_PROJECT переопределяют слои — так работают
 * пробники: указывают во временные папки и гарантированно не трогают реальные
 * данные.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Корень пакета (код приложения, только чтение). */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Версия пакета (package.json) — для баннера TUI и лога serve. */
export const APP_VERSION = (JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

/** Дом: ключи, настройки, профиль, команда целиком. */
export const DT_HOME = process.env.DT_HOME ? resolve(process.env.DT_HOME) : join(homedir(), '.dreamteam');

/** Дом: реестр проектов машины — какие папки открывали и где текущий. */
export const PROJECTS_FILE = join(DT_HOME, 'projects.json');

/** Служебная папка проекта (.dreamteam): hosts.json, почта, переписка.
 *  Проект можно сменить на ходу (/project open) — эти пути пересчитывает
 *  setProjectRoot(); импортёры (named imports) видят обновления — живые
 *  привязки ESM-модулей. До первой смены значения совпадают с DT_HOME/DT_PROJECT
 *  из окружения, поэтому пробники продолжают работать без изменений. */
export let DT_PROJECT = process.env.DT_PROJECT ? resolve(process.env.DT_PROJECT) : join(resolve(process.cwd()), '.dreamteam');

/** Рабочая папка инструментов: папка проекта (меняется вместе с ним). */
export let WORKSPACE = resolve(process.cwd());

/** Сменить проект: рабочая папка → её .dreamteam → все проектные пути.
 *  Env DT_PROJECT с этого момента игнорируется — явная смена важнее. */
export function setProjectRoot(workspaceDir: string): void {
  WORKSPACE = resolve(workspaceDir);
  DT_PROJECT = join(WORKSPACE, '.dreamteam');
  HOSTS_FILE = join(DT_PROJECT, 'hosts.json');
  MAIL_FILE = join(DT_PROJECT, 'mails.json');
  MESSENGERS_FILE = join(DT_PROJECT, 'messengers.json');
  SESSIONS_DIR = join(DT_PROJECT, 'sessions');
}

/** Файлы дом-слоя: машина и команда. */
/** Полка моделей: models/<id>.json — карточки (адаптер, соединение, параметры). */
export const MODELS_DIR = join(DT_HOME, 'models');
export const SETTINGS_FILE = join(DT_HOME, 'settings.json');
export const USER_FILE = join(DT_HOME, 'user.json');
export const AGENTS_FILE = join(DT_HOME, 'agents.json');
export const MANAGER_FILE = join(DT_HOME, 'manager.json');
export const TOOLS_DIR = join(DT_HOME, 'tools');
/** Полка кастомных адаптеров провайдеров: providers/<id>.ts — export default фабрика. */
export const PROVIDERS_DIR = join(DT_HOME, 'providers');
export const SCHEDULE_FILE = join(DT_HOME, 'schedule.json');
export const MEMORY_FILE = join(DT_HOME, 'memory.json');

/** Файлы проект-слоя: конкретный проект (пересчитываются setProjectRoot). */
/** ssh-серверы проекта (тул ssh): { "prod": { "host": "…", … } }. */
export let HOSTS_FILE = join(DT_PROJECT, 'hosts.json');
/** Ящики тула mail — секреты проекта. */
export let MAIL_FILE = join(DT_PROJECT, 'mails.json');
/** Токены ботов telegram/max — секреты проекта. */
export let MESSENGERS_FILE = join(DT_PROJECT, 'messengers.json');
export let SESSIONS_DIR = join(DT_PROJECT, 'sessions');
