/**
 * Схема карточек дома — единый источник формы «Изменить» в GUI и списков
 * редактируемых полей. Живёт рядом с интерфейсами types.ts: пути полей
 * сверяются с интерфейсами на компиляции (проверки _Check ниже). Служебные
 * поля (id, createdAt, история сообщений, секреты тулов) в схему не входят —
 * они редактируются операциями (rename) или тулами.
 *
 * Карточка МОДЕЛИ в CARD_SCHEMAS не входит намеренно: её поля — контракт
 * провайдера (у openai-compatible их девять, у gigachat двенадцать), поэтому
 * форма строится на лету — modelCardSchema(provider), а в GUI приезжает
 * rpc-ом model.get вместе с карточкой.
 */
import type { Agent, Session } from './types.js';
import type { ProjectConfig } from './core/projects.js';
import type { ModelKeySpec } from './providers/types.js';
import { contractOf } from './providers/registry.js';

export interface FieldSpec {
  /** Путь значения в карточке: «name», «model.temperature» */
  path: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'object' | 'enum' | 'password';
  /** Метка поля в форме — русский ключ, переводы в locales en/zh */
  label: string;
  /** Варианты для enum */
  values?: readonly string[];
  /** Подсказка в пустом поле */
  placeholder?: string;
  /** Поле обязательно по контракту — подсказку ставит modelCardSchema */
  required?: boolean;
}

export interface CardSchema {
  /** Имя сущности: agent / model / session / project */
  entity: string;
  fields: readonly FieldSpec[];
}

/** Скалярные поля агента (верхний уровень) + вложенные ссылки model.* и vision/image. */
type AgentPath =
  | 'name' | 'emoji' | 'color' | 'role' | 'description' | 'prompt' | 'temperature' | 'workspace'
  | 'model.id' | 'model.temperature' | 'model.maxTokens' | 'model.thinking' | 'model.reasoning'
  | 'vision.id' | 'image.id';

// компилятор: каждое верхнее поле пути обязано существовать в интерфейсе
type _AgentCheck = Exclude<AgentPath, `model.${string}` | `vision.${string}` | `image.${string}`> extends keyof Agent ? true : never;
type _AgentModelCheck = 'id' extends keyof NonNullable<Agent['model']> ? ('temperature' extends keyof NonNullable<Agent['model']> ? ('maxTokens' extends keyof NonNullable<Agent['model']> ? ('thinking' extends keyof NonNullable<Agent['model']> ? ('reasoning' extends keyof NonNullable<Agent['model']> ? true : never) : never) : never) : never) : never;
type _AgentRefCheck = 'id' extends keyof NonNullable<Agent['vision']> ? ('id' extends keyof NonNullable<Agent['image']> ? true : never) : never;
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
      { path: 'model.thinking', type: 'enum', label: 'размышления GLM (биллятся)', values: ['enabled', 'disabled'] },
      { path: 'model.reasoning', type: 'enum', label: 'глубина размышлений', values: ['minimal', 'low', 'medium', 'high', 'max'] },
      { path: 'vision.id', type: 'string', label: 'Модель зрения (id из models/)' },
      { path: 'image.id', type: 'string', label: 'Модель картинок (id из models/)' },
      { path: 'workspace', type: 'string', label: 'Рабочая папка (подпапка рабочей или путь)' },
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

/** Секретные ключи карточки модели: в GUI уходят пустыми («пусто — не менять»). */
const SECRET_KEYS = ['apiKey', 'clientSecret'] as const;

/** Универсальный набор для провайдера без контракта (кастомный адаптер из providers/). */
const UNIVERSAL_KEYS: Record<string, ModelKeySpec> = {
  model: { type: 'string' },
  baseUrl: { type: 'string' },
  apiKey: { type: 'string' },
  note: { type: 'string' },
};

/** Метки для ключей без desc в контракте провайдера. */
const FALLBACK_LABELS: Record<string, string> = {
  model: 'Модель',
  baseUrl: 'Адрес API',
  apiKey: 'Ключ API',
  maxTokens: 'Максимум токенов',
  temperature: 'Температура (0–2)',
  authUrl: 'Адрес авторизации',
  clientSecret: 'Client secret',
  note: 'Заметка',
};

/**
 * Схема формы модели из контракта провайдера: поля, типы, enum-варианты и
 * обязательность — ровно то, что потом примет валидация registry. Провайдер
 * без контракта (кастомный адаптер из providers/) — универсальный набор:
 * перечислить его ключи неоткуда. Секреты (SECRET_KEYS) — тип password:
 * форма GUI рисует точками, а значение присылает только если ввели новое.
 */
export function modelCardSchema(provider: string): CardSchema {
  const contract = contractOf(provider);
  const keys: Record<string, ModelKeySpec> = contract?.keys ?? UNIVERSAL_KEYS;
  const fields: FieldSpec[] = [{ path: 'provider', type: 'string', label: 'Провайдер' }];
  for (const [key, spec] of Object.entries(keys)) {
    const label = spec.desc ?? FALLBACK_LABELS[key] ?? key;
    const secret = (SECRET_KEYS as readonly string[]).includes(key);
    const placeholder = secret
      ? 'пусто — не менять'
      : spec.required
        ? 'обязательное поле'
        : undefined;
    if (secret) fields.push({ path: key, type: 'password', label, placeholder, required: spec.required });
    else if (spec.type === 'boolean') fields.push({ path: key, type: 'boolean', label, placeholder, required: spec.required });
    else if (spec.type === 'number') fields.push({ path: key, type: 'number', label, placeholder, required: spec.required });
    else if (spec.type === 'object') fields.push({ path: key, type: 'object', label, placeholder, required: spec.required });
    else if (spec.enum) fields.push({ path: key, type: 'enum', label, values: spec.enum, placeholder, required: spec.required });
    else fields.push({ path: key, type: 'string', label, placeholder, required: spec.required });
  }
  return { entity: 'model', fields };
}

/** Карточка модели для браузера: секреты — пустыми строками (форма их не перешлёт). */
export function maskModelCard(card: Record<string, unknown>): Record<string, unknown> {
  const out = { ...card };
  for (const key of SECRET_KEYS) if (key in out) out[key] = '';
  return out;
}

// проверки живут до первой сборки: при рассинхроне tsc упадёт здесь
const _checks: [_AgentCheck, _AgentModelCheck, _AgentRefCheck, _SessionCheck, _ProjectCheck] = [true, true, true, true, true];
void _checks;
