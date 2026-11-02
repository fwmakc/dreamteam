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
import { contractOf, providerIds } from './providers/registry.js';

export interface FieldSpec {
  /** Путь значения в карточке: «name», «model.temperature» */
  path: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'object' | 'enum' | 'password' | 'model';
  /** Метка поля в форме — русский ключ, переводы в locales en/zh */
  label: string;
  /** Варианты для enum */
  values?: readonly string[];
  /** Подсказка в пустом поле */
  placeholder?: string;
  /** Поле обязательно по контракту — подсказку ставит modelCardSchema */
  required?: boolean;
  /** Описание поля (контракт провайдера): GUI рисует под контролем мелким */
  desc?: string;
}

export interface CardSchema {
  /** Имя сущности: agent / model / session / project */
  entity: string;
  fields: readonly FieldSpec[];
}

/** Скалярные поля агента (верхний уровень) + ссылка на модель целиком и vision/image. */
type AgentPath =
  | 'name' | 'emoji' | 'color' | 'description' | 'prompt' | 'workspace'
  | 'model'
  | 'vision.id' | 'image.id'
  | 'tools';

// компилятор: каждое верхнее поле пути обязано существовать в интерфейсе
type _AgentCheck = Exclude<AgentPath, 'model' | `vision.${string}` | `image.${string}`> extends keyof Agent ? true : never;
type _AgentModelCheck = 'id' extends keyof NonNullable<Agent['model']> ? true : never;
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
      { path: 'description', type: 'string', label: 'Описание' },
      { path: 'prompt', type: 'text', label: 'Промпт (системный)', placeholder: 'от первого лица: кто ты, чем занимаешься, как отвечаешь' },
      {
        path: 'model',
        type: 'model',
        label: 'Модель',
        desc: 'пусто — основная модель дома; выберите карточку или задайте вручную (JSON): {"id": "…", "temperature": 0.3} — id можно опустить, останется переопределение параметров основной',
      },
      {
        path: 'vision.id',
        type: 'model',
        label: 'Модель зрения',
        desc: 'пусто — не менять; выберите зрячую модель (◉) или задайте вручную (JSON): {"id": "…", "temperature": 0.3} — "id" обязателен',
      },
      {
        path: 'image.id',
        type: 'model',
        label: 'Модель генерации изображений',
        desc: 'пусто — не менять; выберите модель картинок или задайте вручную (JSON): {"id": "…"} — "id" обязателен',
      },
      {
        path: 'tools',
        type: 'object',
        label: 'Тулы',
        placeholder: '{"files": {}, "look": {}}',
        desc: 'карта целиком — что в JSON, то в карточке (не дополнение): ключ — тул, значение — его настройки ({} или null — по умолчанию); {} — убрать все; пусто — не менять. Встроенные и свои из tools/ дома',
      },
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

/** Метки полей карточки — имя поля в форме (описание живёт в desc контракта).
 *  Ключ без записи здесь рисуется как есть (кастомные адаптеры). */
const FIELD_TITLES: Record<string, string> = {
  provider: 'Провайдер',
  model: 'Модель (имя у API)',
  baseUrl: 'Адрес API',
  apiKey: 'Ключ API',
  authUrl: 'Адрес авторизации',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  scope: 'Scope',
  caCertPath: 'Сертификаты Минцифры (путь)',
  insecureTLS: 'Не проверять сертификат TLS',
  monitorUrl: 'Адрес мониторинга квот',
  maxTokens: 'Максимум токенов',
  contextWindow: 'Размер контекстного окна (токены)',
  temperature: 'Температура (0–2)',
  thinking: 'Размышления GLM',
  reasoning: 'Глубина размышлений',
  cache: 'Кэш промптов',
  vision: 'Зрение',
  extra: 'Доп. поля тела запроса (JSON)',
  note: 'Заметка',
};

/**
 * Схема формы модели из контракта провайдера: поля, типы, enum-варианты и
 * обязательность — ровно то, что потом примет валидация registry. Провайдер
 * без контракта (кастомный адаптер из providers/) — универсальный набор:
 * перечислить его ключи неоткуда. Секреты (SECRET_KEYS) — тип password:
 * форма GUI рисует точками, а значение присылает только если ввели новое.
 * Метка — имя поля (FIELD_TITLES), описание из контракта — desc (GUI рисует
 * под контролем); provider — селектор всех провайдеров (встроенные + кастомные).
 */
export function modelCardSchema(provider: string): CardSchema {
  const contract = contractOf(provider);
  const keys: Record<string, ModelKeySpec> = contract?.keys ?? UNIVERSAL_KEYS;
  const fields: FieldSpec[] = [{ path: 'provider', type: 'enum', label: FIELD_TITLES.provider, values: providerIds() }];
  for (const [key, spec] of Object.entries(keys)) {
    const label = FIELD_TITLES[key] ?? key;
    const secret = (SECRET_KEYS as readonly string[]).includes(key);
    const placeholder = secret
      ? 'пусто — не менять'
      : spec.required
        ? 'обязательное поле'
        : spec.type === 'object'
          ? '{"поле": "значение"}'
          : undefined;
    const type: FieldSpec['type'] = secret
      ? 'password'
      : spec.type === 'boolean'
        ? 'boolean'
        : spec.type === 'number'
          ? 'number'
          : spec.type === 'object'
            ? 'object'
            : spec.enum
              ? 'enum'
              : 'string';
    fields.push({
      path: key, type, label, placeholder, required: spec.required,
      ...(spec.enum ? { values: spec.enum } : {}),
      ...(spec.desc ? { desc: spec.desc } : {}),
    });
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
