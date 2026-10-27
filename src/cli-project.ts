/**
 * Формы запуска с проектом — общий разбор для терминала и serve:
 *
 *   dreamteam        — без проекта (человек откроет сам, /project)
 *   dreamteam <путь> — сахар к open: путь к рабочей папке
 *
 * bin/dreamteam.js валидирует форму мгновенно (до загрузки tsx и мастера
 * первого запуска) и кладёт хвост argv в DT_PROJECT_ARGS (JSON-массив);
 * здесь — разбор в структуру для index.ts и serve.ts.
 */
import { t, tf } from './i18n.js';

export type CliProjectForm =
  | { kind: 'none' }
  | { kind: 'open'; target: string }
  | { kind: 'error'; message: string };

/** Похоже ли на путь к папке: «.», «..», с разделителем или абсолютный. */
export const looksLikePath = (a: string): boolean =>
  a === '.' || a === '..' || a.includes('/') || a.includes('\\');

/** Хвост argv, переданный bin-ом через DT_PROJECT_ARGS; без env — пусто. */
export function cliProjectArgs(): string[] {
  const raw = process.env.DT_PROJECT_ARGS;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Аргументы → форма проекта. Ошибки формы bin отсекает сам (fail-fast до
 * загрузки приложения) — здесь страховка для прямых запусков через tsx.
 */
export function parseCliProject(args: string[]): CliProjectForm {
  const rest = args.filter((a) => a !== '--open'); // флаг serve — к проекту не относится
  if (rest.length === 0) return { kind: 'none' };
  const [head, second] = rest;
  if (second) return { kind: 'error', message: tf('Лишний аргумент «{a}» — укажите один путь: dreamteam <путь>.', { a: second }) };
  if (!looksLikePath(head)) {
    return { kind: 'error', message: tf('«{a}» не похоже на путь — папку пишите как ./имя или полным путём; открыть проект по имени можно командой /project open {a} внутри приложения.', { a: head }) };
  }
  return { kind: 'open', target: head };
}
