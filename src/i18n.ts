/**
 * Языки интерфейса. Ключи — идентификаторы вида NO_DISCUSSIONS_YET (латиница
 * верхнего регистра, цифры, _); словарь локали переводит их на лету:
 * t(KEY) → перевод, промах — русский (исходник), потом сам ключ. Русский —
 * полный словарь src/locales/ru.ts (KEY → строка), английский и китайский —
 * встроенные (src/locales/), а свои языки кладутся файлами в дом:
 * ~/.dreamteam/lang/<id>.json — как tools/, только данные вместо кода:
 *
 *   {
 *     "name": "Deutsch",
 *     "translations": { "NO_DISCUSSIONS_YET": "Noch keine Gespräche." }
 *   }
 *
 * Файлы старого формата (ключи — русские строки, до 0.0.21) читаются тоже:
 * русские ключи автоматически перебиваются в наши KEY по словарю ru.ts;
 * строка без соответствия — громкая ошибка со списком при старте.
 *
 * id языка — имя файла без .json (латиница/цифры/-/_); файлы с «_» в начале
 * игнорируются (шаблоны). Выбор — при первом запуске (мастер) и потом
 * /settings set ui=<id>; поле "ui" в settings.json. Неизвестный id или битый
 * файл — громкая ошибка при старте, как у остальных конфигов.
 *
 * Не переводится (осознанно): системные промты агентов и менеджера (языком
 * ответов управляет settings.language; пустой — язык интерфейса), названия
 * аргументов команд (часть синтаксиса), диагностические ошибки конфигов
 * (fail-fast слой).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { en } from './locales/en.js';
import { ru } from './locales/ru.js';
import { zh } from './locales/zh.js';

/** Словарь: KEY → перевод. */
type Dict = Record<string, string>;

/** Формат ключей перевода. */
const KEY_RE = /^[A-Z0-9_]+$/;

/** id файла языка: латиница/цифры/-/_ (шаблоны с «_» отсеяны раньше). */
const LANG_FILE_RE = /^([a-z0-9][a-z0-9_-]*)\.json$/;

export interface LanguageInfo {
  id: string;
  name: string;
  /** true — встроенный (en, ru, zh); false — файл из lang/ дома */
  builtIn: boolean;
}

/** Встроенные локали. ru — исходный язык: полный словарь KEY → русский. */
const BUILT_IN: Record<string, { name: string; dict: Dict }> = {
  ru: { name: 'Русский', dict: ru },
  en: { name: 'English', dict: en },
  zh: { name: '中文', dict: zh },
};

/** Обратный индекс русского словаря: строка → KEY (автоконвертация легаси). */
const RU_KEY_BY_STRING = new Map(Object.entries(ru).map(([k, v]) => [v, k]));

let current: Dict = {};
let currentId = 'ru';

/** Перевод строки интерфейса: активная локаль → русский → сам ключ. */
export function t(s: string): string {
  return current[s] ?? BUILT_IN.ru.dict[s] ?? s;
}

/** Перевод с подстановкой значений: tf('CREATED_FILE', { file }) — плейсхолдеры
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

/** BCP 47-тег активной локали — для toLocaleString / Intl. */
export function localeTag(): string {
  return { ru: 'ru-RU', en: 'en-US', zh: 'zh-CN' }[currentId] ?? 'ru-RU';
}

/** Дата и время в активной локали. */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(localeTag());
}

/** Только время в активной локали. */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(localeTag());
}

/** Словарь активной локали с русским фолбэком — сервер отдаёт его веб-оболочке
 *  в state.ui: один lookup на клиенте, промах остаётся читаемым русским. */
export function localeDict(): Dict {
  return { ...BUILT_IN.ru.dict, ...current };
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
      throw new Error(`${path}: поле "translations" — объект «KEY»: «перевод»`);
    }
    const dict: Dict = {};
    const orphans: string[] = [];
    for (const [k, v] of Object.entries(obj.translations)) {
      if (typeof v !== 'string') throw new Error(`${path}: перевод «${k}» — не строка`);
      if (KEY_RE.test(k)) { dict[k] = v; continue; }
      // старый формат (до 0.0.21): ключ — русская строка; перебиваем в наш KEY
      const key = RU_KEY_BY_STRING.get(k);
      if (key) dict[key] = v;
      else orphans.push(k);
    }
    if (orphans.length) {
      throw new Error(
        `${path}: ключи не в формате KEY ([A-Z0-9_]) и без соответствия в русском словаре — ` +
        `обновите файл: ${orphans.map((k) => JSON.stringify(k.slice(0, 60))).join(', ')}`,
      );
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

/** Язык общения по id языка интерфейса — фолбэк пустого settings.language
 *  (ядро, одинаково для TUI и веб-оболочки). Встроенные — как принято в
 *  промтах: «русский», english, 中文; свой язык — его name из lang/<id>.json
 *  («Deutsch»); неизвестный id — сам id: нейросети понятны и такие записи,
 *  а битый lang/ уронит applyLocale при старте раньше. */
const CONVERSATION_NAMES: Record<string, string> = { ru: 'русский', en: 'english', zh: '中文' };
export function conversationLanguage(id: string, homeDir: string): string {
  const name = CONVERSATION_NAMES[id];
  if (name) return name;
  try {
    const own = loadExternalLanguages(homeDir).find((l) => l.id === id);
    if (own) return own.name;
  } catch {
    // битый файл в lang/ — громко упадёт applyLocale при старте
  }
  return id;
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
