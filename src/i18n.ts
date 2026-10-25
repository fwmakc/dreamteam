/**
 * Языки интерфейса. Исходные строки приложения — русские; словарь локали
 * переводит их на лету: t('исходная строка') → перевод, а без перевода —
 * сама строка. Поэтому русский словарь пуст (тождество), английский и
 * китайский — встроенные (src/locales/), а свои языки кладутся файлами в
 * дом: ~/.dreamteam/lang/<id>.json — как tools/, только данные вместо кода:
 *
 *   {
 *     "name": "Deutsch",
 *     "translations": { "Разговоров пока нет.": "Noch keine Gespräche." }
 *   }
 *
 * id языка — имя файла без .json (латиница/цифры/-/_); файлы с «_» в начале
 * игнорируются (шаблоны). Выбор — при первом запуске (мастер) и потом
 * /settings set ui=<id>; поле "ui" в settings.json. Неизвестный id или битый
 * файл — громкая ошибка при старте, как у остальных конфигов.
 *
 * Не переводится (осознанно): системные промты агентов и менеджера (языком
 * ответов управляет settings.language), названия аргументов команд (часть
 * синтаксиса), диагностические ошибки конфигов (fail-fast слой).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { en } from './locales/en.js';
import { zh } from './locales/zh.js';

/** Словарь: русская исходная строка → перевод. */
type Dict = Record<string, string>;

export interface LanguageInfo {
  id: string;
  name: string;
  /** true — встроенный (en, ru, zh); false — файл из lang/ дома */
  builtIn: boolean;
}

/** Встроенные локали. ru — исходный язык, словарь пустой (тождество). */
const BUILT_IN: Record<string, { name: string; dict: Dict }> = {
  ru: { name: 'Русский', dict: {} },
  en: { name: 'English', dict: en },
  zh: { name: '中文', dict: zh },
};

const LANG_FILE_RE = /^([a-z0-9][a-z0-9_-]*)\.json$/;

let current: Dict = {};
let currentId = 'ru';

/** Перевод строки интерфейса; нет перевода — исходная русская строка. */
export function t(s: string): string {
  return current[s] ?? s;
}

/** Перевод с подстановкой значений: tf('создал {file}', { file }) — плейсхолдеры
 *  {имя} в словаре позволяют менять порядок слов (важно для zh). */
export function tf(key: string, vars: Record<string, string | number>): string {
  let s = t(key);
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** id активной локали. */
export function localeId(): string {
  return currentId;
}

/** Словарь активной локали — сервер отдаёт его веб-оболочке в state.ui. */
export function localeDict(): Dict {
  return current;
}

/** Внешние языки из lang/ дома: читает и валидирует все файлы сразу. */
function loadExternalLanguages(homeDir: string): { id: string; name: string; dict: Dict }[] {
  const dir = join(homeDir, 'lang');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // папки нет — внешних языков нет (норма)
  }
  const out: { id: string; name: string; dict: Dict }[] = [];
  for (const file of names) {
    if (file.startsWith('_')) continue; // _template.json и прочие шаблоны
    const m = LANG_FILE_RE.exec(file);
    if (!m) continue; // не <id>.json — не наш файл, не трогаем
    const id = m[1]!;
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`${path}: не удалось прочитать язык (${err instanceof Error ? err.message : err})`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${path}: ожидается объект { "name": "…", "translations": { "…": "…" } }`);
    }
    const obj = raw as { name?: unknown; translations?: unknown };
    if (typeof obj.name !== 'string' || obj.name.trim() === '') {
      throw new Error(`${path}: поле "name" — непустая строка (название языка для меню)`);
    }
    if (!obj.translations || typeof obj.translations !== 'object' || Array.isArray(obj.translations)) {
      throw new Error(`${path}: поле "translations" — объект «исходная строка»: «перевод»`);
    }
    const dict: Dict = {};
    for (const [k, v] of Object.entries(obj.translations)) {
      if (typeof v !== 'string') throw new Error(`${path}: перевод «${k}» — не строка`);
      dict[k] = v;
    }
    if (id in BUILT_IN) {
      throw new Error(`${path}: id «${id}» занят встроенным языком — переименуйте файл`);
    }
    out.push({ id, name: obj.name.trim(), dict });
  }
  return out;
}

/** Список известных языков: встроенные + внешние (для меню, настроек, ошибок). */
export function knownLanguages(homeDir: string): LanguageInfo[] {
  const builtIn = Object.entries(BUILT_IN).map(([id, v]) => ({ id, name: v.name, builtIn: true }));
  const external = loadExternalLanguages(homeDir).map((l) => ({ id: l.id, name: l.name, builtIn: false }));
  return [...builtIn, ...external];
}

/**
 * Включить локаль по id (встроенный или файл из lang/ дома). Неизвестный id —
 * ошибка со списком доступных; битый файл языка — ошибка с путём (громко,
 * как остальные конфиги: молча оставить русский — нечестно).
 */
export function applyLocale(id: string, homeDir: string): void {
  const builtIn = BUILT_IN[id];
  if (builtIn) {
    currentId = id;
    current = builtIn.dict;
    return;
  }
  const external = loadExternalLanguages(homeDir).find((l) => l.id === id);
  if (!external) {
    const ids = knownLanguages(homeDir).map((l) => l.id).join(', ');
    throw new Error(`язык «${id}» не известен — доступны: ${ids} (свой — файл lang/<id>.json в доме)`);
  }
  currentId = id;
  current = external.dict;
}

/**
 * Лёгкое чтение поля "ui" из settings.json до мастера (заметки скаффолдинга
 * и вопросы мастера уже на языке пользователя). Битый файл/поле здесь не
 * валидируем: чуть позже loadSettings/applyLocale уронят с внятной ошибкой.
 */
export function preloadLocale(settingsFile: string, homeDir: string): void {
  try {
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as { ui?: unknown };
    if (typeof raw.ui === 'string' && raw.ui.trim() !== '') applyLocale(raw.ui.trim(), homeDir);
  } catch {
    // нет файла или не читается — остаётся русский, дальше разберётся bootstrap
  }
}
