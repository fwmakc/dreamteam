/**
 * Слой путей — единственное место, где считаются пути приложения.
 *
 * Два слоя (подробнее — в README, раздел «Три слоя»):
 *  - пакет (APP_ROOT): код приложения, только чтение;
 *  - дом (DT_HOME, по умолчанию ~/.dreamteam): ВСЁ глобальное — ключи, настройки,
 *    профиль, команда (агенты, менеджер, тула), расписание, общая память.
 *    Команда — свойство машины: симулятор команды настраивается один раз.
 *  - проект (DT_PROJECT, по умолчанию <cwd>/.dreamteam): ВСЁ про конкретный
 *    проект — project.json (ssh-серверы), почта и боты проекта (mail.json,
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

/** Служебная папка проекта (.dreamteam): project.json, переписка. */
export const DT_PROJECT = process.env.DT_PROJECT ? resolve(process.env.DT_PROJECT) : join(resolve(process.cwd()), '.dreamteam');

/** Рабочая папка инструментов: всегда текущая папка (проект = где запущено). */
export const WORKSPACE = resolve(process.cwd());

/** Файлы дом-слоя: машина и команда. */
export const PROVIDERS_FILE = join(DT_HOME, 'providers.json');
export const SETTINGS_FILE = join(DT_HOME, 'settings.json');
export const USER_FILE = join(DT_HOME, 'user.json');
export const AGENTS_FILE = join(DT_HOME, 'agents.json');
export const MANAGER_FILE = join(DT_HOME, 'manager.json');
export const TOOLS_DIR = join(DT_HOME, 'tools');
export const SCHEDULE_FILE = join(DT_HOME, 'schedule.json');
export const MEMORY_FILE = join(DT_HOME, 'memory.json');

/** Файлы проект-слоя: конкретный проект. */
export const PROJECT_FILE = join(DT_PROJECT, 'project.json');
/** Ящики тула mail — секреты проекта. */
export const MAIL_FILE = join(DT_PROJECT, 'mail.json');
/** Токены ботов telegram/max — секреты проекта. */
export const MESSENGERS_FILE = join(DT_PROJECT, 'messengers.json');
export const SESSIONS_DIR = join(DT_PROJECT, 'sessions');
