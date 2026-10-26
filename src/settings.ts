import { readFileSync } from 'node:fs';
import type { ModelRef } from './types.js';

/**
 * Общие настройки приложения: settings.json в дом-слое (~/.dreamteam) — файл
 * обязателен, битый JSON или кривое поле — внятная ошибка (явное лучше
 * неявного). Здесь живёт всё, что не про команду и не про серверы: экран
 * и лимиты инструментов. Рабочая папка инструментов тут не задаётся —
 * это всегда папка, из которой запущено приложение.
 */
export interface SettingsConfig {
  /** Логическая ширина экрана (обрезается по ширине терминала) */
  width: number;
  /** Язык общения команды: попадает в системные промты как есть
   *  («russian», «ru-RU», «русский» — нейросети поймут любую запись) */
  language: string;
  /** Язык интерфейса (en, ru, zh или свой из ~/.dreamteam/lang/<id>.json);
   *  отсутствует поле — русский (интерфейс старых установок) */
  ui: string;
  /** Автоответ в автономном режиме: отправляется вместо ожидания человека */
  autoMessage: string;
  /** Максимальное число отвечающих за раунд (0 — без ограничения) */
  maxTurns: number;
  /** Отступы по краям экрана в колонках/строках (0–10) */
  margin: number;
  /** false — прежний readline-интерфейс без альтернативного экрана */
  screen: boolean;
  /** Таймаут команды (```run / ```ssh), мс */
  runTimeoutMs: number;
  /** До скольких символов обрезается вывод команды */
  maxOutputChars: number;
  /** Модель по умолчанию: ссылка {id, temperature…} — агенты без своей модели берут её */
  model?: ModelRef;
  /** Служебная модель (модератор, нейминг, сжатие, память); пусто — model */
  serviceModel?: ModelRef;
}

/** Читает settings.json по пути; termCols > 0 — width обрезается по терминалу. */
export function loadSettings(file: string, termCols: number): SettingsConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`не удалось прочитать ${file}: ${err instanceof Error ? err.message : err}`);
  }
  const width = raw.width;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 40 || width > 500) {
    throw new Error(`${file}: поле "width" — целое число от 40 до 500`);
  }
  const margin = raw.margin;
  if (margin !== undefined && (typeof margin !== 'number' || !Number.isInteger(margin) || margin < 0 || margin > 10)) {
    throw new Error(`${file}: поле "margin" — целое число от 0 до 10`);
  }
  const screen = raw.screen;
  if (screen !== undefined && typeof screen !== 'boolean') {
    throw new Error(`${file}: поле "screen" — true или false`);
  }
  if (raw.workspace !== undefined) {
    throw new Error(
      `${file}: поле "workspace" удалено — рабочая папка это всегда папка, из которой запущено приложение; убери поле`,
    );
  }
  const runTimeoutMs = raw.runTimeoutMs;
  if (runTimeoutMs !== undefined && (typeof runTimeoutMs !== 'number' || runTimeoutMs <= 0)) {
    throw new Error(`${file}: поле "runTimeoutMs" — положительное число миллисекунд`);
  }
  const maxOutputChars = raw.maxOutputChars;
  if (maxOutputChars !== undefined && (typeof maxOutputChars !== 'number' || maxOutputChars <= 0)) {
    throw new Error(`${file}: поле "maxOutputChars" — положительное число символов`);
  }
  const language = raw.language;
  if (language !== undefined && (typeof language !== 'string' || language.trim() === '')) {
    throw new Error(`${file}: поле "language" — непустая строка («russian», «ru-RU», «русский» — как угодно)`);
  }
  // язык интерфейса: тип проверяем здесь, существование локали — applyLocale
  // (нужен дом, чтобы увидеть lang/<id>.json); пусто — русский (старые установки)
  const ui = raw.ui;
  if (ui !== undefined && (typeof ui !== 'string' || ui.trim() === '')) {
    throw new Error(`${file}: поле "ui" — непустая строка: en, ru, zh или id из ~/.dreamteam/lang/`);
  }
  const autoMessage = raw.autoMessage;
  if (autoMessage !== undefined && (typeof autoMessage !== 'string' || autoMessage.trim() === '')) {
    throw new Error(`${file}: поле "autoMessage" — непустая строка`);
  }
  const maxTurns = raw.maxTurns;
  if (maxTurns !== undefined && (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 0)) {
    throw new Error(`${file}: поле "maxTurns" — целое число ≥ 0 (0 — без ограничения)`);
  }
  const model = checkModelRef(file, 'model', raw.model);
  const serviceModel = checkModelRef(file, 'serviceModel', raw.serviceModel);
  return {
    width: termCols > 0 ? Math.min(width, termCols) : width,
    language: typeof language === 'string' ? language.trim() : 'русский',
    ui: typeof ui === 'string' ? ui.trim() : 'ru',
    autoMessage: typeof autoMessage === 'string' ? autoMessage.trim() : 'Решите вопрос на своё усмотрение.',
    maxTurns: typeof maxTurns === 'number' ? maxTurns : 3,
    margin: typeof margin === 'number' ? margin : 2,
    screen: screen !== false,
    runTimeoutMs: typeof runTimeoutMs === 'number' ? runTimeoutMs : 180000,
    maxOutputChars: typeof maxOutputChars === 'number' ? maxOutputChars : 4000,
    model,
    serviceModel,
  };
}

/** Ссылка на модель в settings.json: объект {id?, …}; форма проверяется здесь,
 *  существование id в models/ — при разрешении в реестре (громко). */
function checkModelRef(file: string, field: string, raw: unknown): ModelRef | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: поле "${field}" — объект {"id": "…", "temperature": …}`);
  }
  const ref = { ...(raw as Record<string, unknown>) };
  if (ref.id !== undefined && (typeof ref.id !== 'string' || ref.id.trim() === '')) {
    throw new Error(`${file}: поле "${field}.id" — непустая строка (id карточки из models/)`);
  }
  if (ref.temperature !== undefined && typeof ref.temperature !== 'number') {
    throw new Error(`${file}: поле "${field}.temperature" — число`);
  }
  if (ref.maxTokens !== undefined && (typeof ref.maxTokens !== 'number' || ref.maxTokens <= 0)) {
    throw new Error(`${file}: поле "${field}.maxTokens" — положительное число`);
  }
  return ref as ModelRef;
}
