import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Общие настройки приложения: config/settings.json — файл обязателен, битый
 * JSON или кривое поле — внятная ошибка (явное лучше неявного). Здесь живёт
 * всё, что не про команду и не про проекты: экран и лимиты инструментов.
 */
export interface SettingsConfig {
  /** Логическая ширина экрана (обрезается по ширине терминала) */
  width: number;
  /** Отступы по краям экрана в колонках/строках (0–10) */
  margin: number;
  /** false — прежний readline-интерфейс без альтернативного экрана */
  screen: boolean;
  /** Путь из конфига, как написано: общая рабочая папка инструментов */
  workspace: string;
  /** Тот же путь, разрешённый относительно корня приложения (папка config/..) */
  workspaceAbs: string;
  /** Таймаут команды (```run / ```ssh), мс */
  runTimeoutMs: number;
  /** До скольких символов обрезается вывод команды */
  maxOutputChars: number;
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
  const workspace = raw.workspace;
  if (workspace !== undefined && (typeof workspace !== 'string' || !workspace.trim())) {
    throw new Error(`${file}: поле "workspace" — путь к рабочей папке или убери поле`);
  }
  const runTimeoutMs = raw.runTimeoutMs;
  if (runTimeoutMs !== undefined && (typeof runTimeoutMs !== 'number' || runTimeoutMs <= 0)) {
    throw new Error(`${file}: поле "runTimeoutMs" — положительное число миллисекунд`);
  }
  const maxOutputChars = raw.maxOutputChars;
  if (maxOutputChars !== undefined && (typeof maxOutputChars !== 'number' || maxOutputChars <= 0)) {
    throw new Error(`${file}: поле "maxOutputChars" — положительное число символов`);
  }
  const ws = typeof workspace === 'string' && workspace.trim() ? workspace.trim() : '.';
  return {
    width: termCols > 0 ? Math.min(width, termCols) : width,
    margin: typeof margin === 'number' ? margin : 2,
    screen: screen !== false,
    workspace: ws,
    // путь из config/settings.json разрешается от корня приложения (config/..)
    workspaceAbs: resolve(join(dirname(file), '..'), ws),
    runTimeoutMs: typeof runTimeoutMs === 'number' ? runTimeoutMs : 180000,
    maxOutputChars: typeof maxOutputChars === 'number' ? maxOutputChars : 4000,
  };
}

/** Путь к config/settings.json от корня приложения. */
export function settingsFile(root: string): string {
  return join(root, 'config', 'settings.json');
}
