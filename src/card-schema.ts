/**
 * Схема карточек дома — единый источник формы «Изменить» в GUI и списков
 * редактируемых полей. Живёт рядом с интерфейсами types.ts: пути полей
 * сверяются с интерфейсами на компиляции (проверки _Check ниже), а проба
 * schemas сверяет их с реальными карточками дома. Служебные поля (id,
 * createdAt, история сообщений, секреты тулов) в схему не входят — они
 * редактируются операциями (rename) или тулами.
 */
import type { Agent, Session } from './types.js';
import type { ProjectConfig } from './core/projects.js';

export interface FieldSpec {
  /** Путь значения в карточке: «name», «model.temperature» */
  path: string;
  type: 'string' | 'text' | 'number' | 'enum' | 'password';
  /** Метка поля в форме — русский ключ, переводы в locales en/zh */
  label: string;
  /** Варианты для enum */
  values?: readonly string[];
  /** Подсказка в пустом поле */
  placeholder?: string;
}

export interface CardSchema {
  /** Имя сущности: agent / model / session / project */
  entity: string;
  fields: readonly FieldSpec[];
}

/** Скалярные поля агента (верхний уровень) + вложенные ссылки model.*. */
type AgentPath =
  | 'name' | 'emoji' | 'color' | 'role' | 'description' | 'prompt' | 'temperature' | 'workspace'
  | 'model.id' | 'model.temperature' | 'model.maxTokens';

// компилятор: каждое верхнее поле пути обязано существовать в интерфейсе
type _AgentCheck = Exclude<AgentPath, `model.${string}`> extends keyof Agent ? true : never;
type _AgentModelCheck = 'id' extends keyof NonNullable<Agent['model']> ? ('temperature' extends keyof NonNullable<Agent['model']> ? ('maxTokens' extends keyof NonNullable<Agent['model']> ? true : never) : never) : never;
type _SessionCheck = 'title' extends keyof Session ? true : never;
type _ProjectCheck = 'path' extends keyof ProjectConfig ? true : never;

/** Собирает FieldSpec, не выпуская path за пределы заданного типа путей. */
function fields<P extends string>(specs: readonly (Omit<FieldSpec, 'path'> & { path: P })[]): FieldSpec[] {
  return specs.map((s) => ({ ...s }));
}

const COLOR_VALUES = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'] as const;

export const CARD_SCHEMAS: Record<string, CardSchema> = {
  agent: {
    entity: 'agent',
    fields: fields<AgentPath>([
      { path: 'name', type: 'string', label: 'Имя' },
      { path: 'emoji', type: 'string', label: 'Emoji' },
      { path: 'color', type: 'enum', label: 'Цвет', values: COLOR_VALUES },
      { path: 'role', type: 'string', label: 'Роль' },
      { path: 'description', type: 'string', label: 'Описание' },
      { path: 'prompt', type: 'text', label: 'Промпт (системный)' },
      { path: 'temperature', type: 'number', label: 'Температура (0–2)' },
      { path: 'model.id', type: 'string', label: 'Модель (id из models/)' },
      { path: 'model.temperature', type: 'number', label: 'Температура модели (0–2)' },
      { path: 'model.maxTokens', type: 'number', label: 'Максимум токенов' },
      { path: 'workspace', type: 'string', label: 'Рабочая папка (подпапка рабочей или путь)' },
    ]),
  },
  model: {
    entity: 'model',
    fields: fields([
      { path: 'provider', type: 'string', label: 'Провайдер', placeholder: 'встроенные: openai-compatible / anthropic-compatible / gigachat / mock; кастомные — из providers/' },
      { path: 'model', type: 'string', label: 'Модель' },
      { path: 'baseUrl', type: 'string', label: 'baseUrl' },
      { path: 'apiKey', type: 'password', label: 'Ключ API (пусто — не менять)' },
    ]),
  },
  session: {
    entity: 'session',
    fields: fields<'title'>([
      { path: 'title', type: 'string', label: 'Название разговора' },
    ]),
  },
  project: {
    entity: 'project',
    fields: fields<'path'>([
      { path: 'path', type: 'string', label: 'Рабочая папка (создастся, если нет)' },
    ]),
  },
};

// проверки живут до первой сборки: при рассинхроне tsc упадёт здесь
const _checks: [_AgentCheck, _AgentModelCheck, _SessionCheck, _ProjectCheck] = [true, true, true, true];
void _checks;
