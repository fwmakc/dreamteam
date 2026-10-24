/**
 * Реестр проектов машины: какие папки открывали в приложении и где текущий.
 * Лежит в доме (projects.json) — папки проектов меняются, машина одна.
 * Хранит только пути: всё содержимое проекта живёт в самой папке
 * (.dreamteam внутри неё), поэтому «забыть» проект — безболезненно.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

/** Один проект в реестре: папка на диске + короткое имя. */
export interface ProjectRecord {
  /** Абсолютный путь к рабочей папке проекта */
  path: string;
  /** Короткое имя (имя папки) — по нему можно открывать (/project open) */
  name: string;
  /** Когда проект последний раз открывали (мс) */
  lastOpened?: number;
}

/** Файл projects.json в доме. */
export interface ProjectRegistry {
  /** Папка, открытая последней (совет, а не запрет: реальность — paths.ts) */
  current?: string;
  /** Известные проекты, от старых к новым */
  projects: ProjectRecord[];
}

/** Прочитать реестр; битый или отсутствующий файл = пустой реестр. */
export function loadProjectRegistry(file: string): ProjectRegistry {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectRegistry>;
    if (!raw || typeof raw !== 'object') return { projects: [] };
    const seen = new Set<string>();
    const projects = (Array.isArray(raw.projects) ? raw.projects : [])
      .filter((p): p is ProjectRecord => Boolean(p && typeof p.path === 'string'))
      .map((p) => ({
        path: resolve(p.path),
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : basename(resolve(p.path)),
        lastOpened: typeof p.lastOpened === 'number' ? p.lastOpened : undefined,
      }))
      .filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
    return { current: typeof raw.current === 'string' ? resolve(raw.current) : undefined, projects };
  } catch {
    return { projects: [] };
  }
}

function saveRegistry(file: string, reg: ProjectRegistry): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/** Короткое имя проекта = имя папки. */
export function projectLabel(dir: string): string {
  return basename(resolve(dir));
}

/** Запомнить папку проекта; makeCurrent — отметить текущей и освежить дату. */
export function rememberProject(file: string, dir: string, makeCurrent: boolean): void {
  const path = resolve(dir);
  const reg = loadProjectRegistry(file);
  const rec = reg.projects.find((p) => p.path === path);
  if (rec) {
    if (makeCurrent) rec.lastOpened = Date.now();
  } else {
    reg.projects.push({ path, name: projectLabel(path), lastOpened: makeCurrent ? Date.now() : undefined });
  }
  if (makeCurrent) reg.current = path;
  saveRegistry(file, reg);
}

/** Забыть проект в реестре (файлы на диске не трогаются). */
export function forgetProject(file: string, dir: string, currentWorkspace: string): void {
  const path = resolve(dir);
  if (path === resolve(currentWorkspace)) {
    throw new Error(`проект «${projectLabel(path)}» открыт сейчас — сначала переключитесь на другой (/project open)`);
  }
  const reg = loadProjectRegistry(file);
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.path !== path);
  if (reg.projects.length === before) throw new Error(`проекта «${dir}» нет в реестре — см. /project`);
  if (reg.current === path) delete reg.current;
  saveRegistry(file, reg);
}

/**
 * Аргумент «/project open» и действия менеджера: абсолютный или относительный
 * путь, либо имя из реестра. Относительные пути — от текущей рабочей папки.
 * Ошибка — дружелюбная, с подсказкой.
 */
export function resolveProjectDir(arg: string, from: string, registry: ProjectRegistry): string {
  const raw = arg.trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('укажите папку проекта: /project open <имя|путь> (список — /project)');
  const candidates: string[] = [];
  if (isAbsolute(raw)) candidates.push(resolve(raw));
  else {
    candidates.push(resolve(from, raw));
    const byName = registry.projects.find(
      (p) => p.name.toLowerCase() === raw.toLowerCase() || projectLabel(p.path).toLowerCase() === raw.toLowerCase(),
    );
    if (byName) candidates.push(byName.path);
  }
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  throw new Error(`нет папки проекта «${raw}» — укажите путь или имя из /project`);
}
