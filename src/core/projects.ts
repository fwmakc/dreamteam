/**
 * Реестр проектов — сами папки внутри дома (projects/<id>/): по папке на
 * проект. Внутри project.json — настройки проекта (рабочая папка) и его
 * секреты (ssh-серверы, ящики, боты); переписка — рядом (sessions/).
 * Отдельного файла-реестра нет: список проектов = readdir.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { t, tf } from '../i18n.js';
import { DT_HOME, PROJECTS_DIR } from '../paths.js';

/** project.json: настройки проекта + его секреты (hosts/mails/messengers). */
export interface ProjectConfig {
  /** Имя проекта = имя папки в доме (projects/<id>/) */
  id: string;
  /** Абсолютный путь к рабочей папке (файлы работы); нет — папка ещё не задана */
  path?: string;
  /** Когда проект создан (мс) */
  createdAt: number;
  /** Когда проект последний раз открывали (мс) — для сортировки списка */
  lastOpened?: number;
  /** ssh-серверы проекта (тул ssh): { "prod": { host, user?, password?, … } } */
  hosts: Record<string, unknown>;
  /** Ящики тула mail: { "работа": { user, password, imap, smtp, … } } */
  mails: Record<string, unknown>;
  /** Токены ботов telegram/max: { telegram: { token }, max: { token } } */
  messengers: Record<string, unknown>;
}

/** Итог «/project open <аргумент>»: найденный или только что созданный проект. */
export interface ProjectTarget {
  config: ProjectConfig;
  /** true — папка была незарегистрированной, и её только что записали в дом */
  created: boolean;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function projectFile(id: string): string {
  return join(PROJECTS_DIR, id, 'project.json');
}

/** Прочитать project.json; нет файла или он битый — null (папку пропускаем). */
export function loadProjectConfig(id: string): ProjectConfig | null {
  try {
    const raw = asObject(JSON.parse(readFileSync(projectFile(id), 'utf8')));
    const cfg: ProjectConfig = {
      id,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      hosts: asObject(raw.hosts),
      mails: asObject(raw.mails),
      messengers: asObject(raw.messengers),
    };
    if (typeof raw.path === 'string' && raw.path.trim()) cfg.path = resolve(raw.path.trim());
    if (typeof raw.lastOpened === 'number') cfg.lastOpened = raw.lastOpened;
    return cfg;
  } catch {
    return null;
  }
}

/** Запись project.json: tmp → rename, папка проекта создаётся при необходимости. */
export function saveProjectConfig(cfg: ProjectConfig): void {
  mkdirSync(join(PROJECTS_DIR, cfg.id), { recursive: true });
  const file = projectFile(cfg.id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/** Отметить проект открытым (lastOpened) — для сортировки списка. */
export function touchProject(id: string): void {
  const cfg = loadProjectConfig(id);
  if (!cfg) return;
  cfg.lastOpened = Date.now();
  saveProjectConfig(cfg);
}

/** Список проектов: readdir projects/ + разбор project.json; битые папки пропускаются. */
export function listProjects(): ProjectConfig[] {
  let ids: string[];
  try {
    ids = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // projects/ ещё не создан — проектов нет
  }
  const out: ProjectConfig[] = [];
  for (const id of ids) {
    const cfg = loadProjectConfig(id);
    if (cfg) out.push(cfg);
  }
  // свежие сверху, внутри — по имени
  return out.sort(
    (a, b) => (b.lastOpened ?? b.createdAt) - (a.lastOpened ?? a.createdAt) || a.id.localeCompare(b.id),
  );
}

/** Символы, запрещённые в имени проекта (=имени папки): разделители ОС и пр. */
const PROJECT_ID_BAD = /[\\/:*?"<>|\p{C}]/u;

/** Имя проекта: 1–64 символа без пробелов и служебных символов ОС. */
export function validateProjectId(raw: string): string {
  const id = raw.trim();
  if (!id || id.length > 64 || /\s/.test(id) || PROJECT_ID_BAD.test(id) || id === '.' || id === '..' || id.startsWith('.')) {
    throw new Error(t('имя проекта — 1–64 символа без пробелов: буквы, цифры, точка, дефис, подчёркивание'));
  }
  return id;
}

/** Имя из папки на диске → допустимый id (лишние символы → дефис). */
export function sanitizeProjectId(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(PROJECT_ID_BAD, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 64)
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'project';
}

/** Рабочая папка не может лежать в доме: файловые тулы добрались бы до ключей моделей. */
export function checkWorkspacePath(raw: string): string {
  const abs = resolve(raw);
  const home = resolve(DT_HOME);
  if (abs === home || abs.startsWith(home + sep)) {
    throw new Error(t('рабочая папка не может быть внутри дома приложения — там ключи моделей и настройки'));
  }
  return abs;
}

function writeNewProject(id: string, pathRaw: string | null): ProjectConfig {
  let path: string | undefined;
  if (pathRaw) {
    path = checkWorkspacePath(pathRaw);
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    else if (!statSync(path).isDirectory()) throw new Error(tf('«{path}» — не папка', { path }));
  }
  const cfg: ProjectConfig = { id, createdAt: Date.now(), hosts: {}, mails: {}, messengers: {} };
  if (path) cfg.path = path;
  saveProjectConfig(cfg);
  return cfg;
}

/** project.new: новый проект; рабочая папка создаётся, если её нет. */
export function createProject(idRaw: string, pathRaw: string | null): ProjectConfig {
  const id = validateProjectId(idRaw);
  if (existsSync(join(PROJECTS_DIR, id))) {
    throw new Error(tf('проект «{id}» уже есть — /project open {id}', { id }));
  }
  return writeNewProject(id, pathRaw);
}

/** Авто-регистрация открытой папки: id из имени папки, коллизия → суффикс «-2». */
export function registerWorkspace(ws: string): ProjectConfig {
  const path = checkWorkspacePath(ws);
  const base = sanitizeProjectId(basename(path));
  let id = base;
  for (let n = 2; existsSync(join(PROJECTS_DIR, id)); n++) id = `${base}-${n}`;
  return writeNewProject(id, path);
}

/** Удалить проект из дома (projects/<id>/ целиком); рабочая папка не трогается. */
export function removeProject(id: string, currentDir: string): void {
  const dir = join(PROJECTS_DIR, id);
  if (!existsSync(dir)) throw new Error(tf('проекта «{id}» нет — см. /projects', { id }));
  if (resolve(dir) === resolve(currentDir)) {
    throw new Error(tf('проект «{id}» открыт сейчас — сначала переключитесь на другой (/project open)', { id }));
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Переименовать проект (projects/<id>/ + поле id); id внутри project.json — копия имени папки. */
export function renameProject(oldId: string, newIdRaw: string): ProjectConfig {
  const newId = validateProjectId(newIdRaw);
  if (newId === oldId) return loadProjectConfig(oldId) ?? { id: newId, createdAt: Date.now(), hosts: {}, mails: {}, messengers: {} };
  const from = join(PROJECTS_DIR, oldId);
  const to = join(PROJECTS_DIR, newId);
  if (!existsSync(from)) throw new Error(tf('проекта «{id}» нет — см. /projects', { id: oldId }));
  if (existsSync(to)) throw new Error(tf('проект «{id}» уже есть — выберите другое имя', { id: newId }));
  renameSync(from, to);
  const cfg = loadProjectConfig(newId) ?? { id: newId, createdAt: Date.now(), hosts: {}, mails: {}, messengers: {} };
  cfg.id = newId;
  saveProjectConfig(cfg);
  return cfg;
}

/** Сменить рабочую папку проекта (project.path); папка создаётся, если её нет. */
export function setProjectPath(cfg: ProjectConfig, pathRaw: string): ProjectConfig {
  const path = checkWorkspacePath(pathRaw);
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  else if (!statSync(path).isDirectory()) throw new Error(tf('«{path}» — не папка', { path }));
  cfg.path = path;
  saveProjectConfig(cfg);
  return cfg;
}

/**
 * Аргумент «/project open» и rpc project.open: имя проекта или путь к рабочей
 * папке (абсолютный либо относительный — от текущей папки). Путь к папке,
 * которой нет в реестре, — авто-регистрация (id из имени папки). Ошибка —
 * дружелюбная, с подсказкой.
 */
export function resolveProjectTarget(arg: string, from: string): ProjectTarget {
  const raw = arg.trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error(t('укажите проект: /project open <id|путь> (список — /projects)'));
  const projects = listProjects();
  if (isAbsolute(raw) || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
    const path = resolve(from, raw);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(tf('нет папки «{raw}» — укажите путь или имя из /projects', { raw }));
    }
    const known = projects.find((p) => p.path && p.path === resolve(path));
    if (known) return { config: known, created: false };
    return { config: registerWorkspace(path), created: true };
  }
  const byId = projects.find((p) => p.id.toLowerCase() === raw.toLowerCase());
  if (byId) return { config: byId, created: false };
  const byFolder = projects.find((p) => p.path && basename(p.path).toLowerCase() === raw.toLowerCase());
  if (byFolder) return { config: byFolder, created: false };
  throw new Error(tf('нет проекта «{raw}» — /project new {raw} создаст его, /projects покажет список', { raw }));
}
