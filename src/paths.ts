/**
 * Слой путей — единственное место, где считаются пути приложения.
 *
 * Один уровень владения — дом (DT_HOME, по умолчанию ~/.dreamteam) это ВСЁ
 * приложение: ключи, настройки, профиль, команда (агенты, менеджер, тулы),
 * расписание, общая память — и проекты. Проект — папка в доме (projects/<id>/):
 * project.json (рабочая папка, ssh-серверы, почта, боты) и переписка
 * (sessions/, transcripts/); рядом — прикладное проекта: inbox (файлы от
 * человека через GUI) и архивы экспорта. В рабочей папке проекта (поле path
 * в project.json) лежат только файлы работы — код и документы; папка
 * .dreamteam нигде не создаётся.
 *
 * Переменная окружения DT_HOME переопределяет дом — так работают пробники:
 * указывают во временную папку и гарантированно не трогают реальные данные.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Корень пакета (код приложения, только чтение). */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Версия пакета (package.json) — для баннера TUI и лога serve. */
export const APP_VERSION = (JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

/** Дом: ключи, настройки, профиль, команда, проекты — всё приложение. */
export const DT_HOME = process.env.DT_HOME ? resolve(process.env.DT_HOME) : join(homedir(), '.dreamteam');

/** Реестр проектов — сами папки внутри projects/: по папке на проект. */
export const PROJECTS_DIR = join(DT_HOME, 'projects');

/** Активный проект: папка в доме, его project.json, рабочая папка, переписка.
 *  Пустая строка — проект не выбран: приложение стартует без проекта, его
 *  выбирает человек (/project new | /project open). Меняются только через
 *  setProjectRoot()/clearProjectRoot(); импортёры (named imports) видят
 *  обновления — живые привязки ESM-модулей. */
export let PROJECT_DIR = '';
/** project.json активного проекта: { id, path, hosts, mails, messengers, … }. */
export let PROJECT_FILE = '';
/** Рабочая папка инструментов (поле path в project.json; пусто — нет проекта). */
export let WORKSPACE = '';
/** Переписка активного проекта (sessions/; пусто — нет проекта). */
export let SESSIONS_DIR = '';

/** Выбрать активный проект: папка в доме + рабочая папка из его project.json. */
export function setProjectRoot(projectDir: string, workspace: string): void {
  PROJECT_DIR = resolve(projectDir);
  PROJECT_FILE = join(PROJECT_DIR, 'project.json');
  SESSIONS_DIR = join(PROJECT_DIR, 'sessions');
  WORKSPACE = workspace ? resolve(workspace) : '';
}

/** Сбросить активный проект — состояние «без проекта». */
export function clearProjectRoot(): void {
  PROJECT_DIR = '';
  PROJECT_FILE = '';
  SESSIONS_DIR = '';
  WORKSPACE = '';
}

/** Файлы дом-слоя: машина и команда. */
/** Полка моделей: models/<id>.json — карточки (адаптер, соединение, параметры). */
export const MODELS_DIR = join(DT_HOME, 'models');
export const SETTINGS_FILE = join(DT_HOME, 'settings.json');
export const USER_FILE = join(DT_HOME, 'user.json');
/** Полка агентов: agents/<id>.json — по файлу на агента, ростер по алфавиту id. */
export const AGENTS_DIR = join(DT_HOME, 'agents');
export const MANAGER_FILE = join(DT_HOME, 'manager.json');
export const TOOLS_DIR = join(DT_HOME, 'tools');
/** Полка кастомных адаптеров провайдеров: providers/<id>.ts — export default фабрика. */
export const PROVIDERS_DIR = join(DT_HOME, 'providers');
export const SCHEDULE_FILE = join(DT_HOME, 'schedule.json');
export const MEMORY_FILE = join(DT_HOME, 'memory.json');
