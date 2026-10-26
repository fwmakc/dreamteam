import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ImageProvider, LLMProvider, ModelRef } from '../types.js';
import type { AdapterContract, ImageAdapterFactory, ProviderConfig, ProviderFactory } from './types.js';
import { checkKeySpec } from './types.js';
import { openAiCompatibleFactory, contract as openAiCompatibleContract } from './openai-compatible.js';
import { anthropicFactory, contract as anthropicContract } from './anthropic.js';
import { gigachatFactory, contract as gigachatContract } from './gigachat.js';
import { mockFactory, unconfiguredProvider, contract as mockContract } from './mock.js';
import { openAiImagesFactory, contract as openAiImagesContract } from './openai-images.js';
import { mockImagesFactory, contract as mockImagesContract } from './mock-images.js';
import { tf } from '../i18n.js';

/**
 * Реестр моделей. Карточка модели — файл models/<id>.json в доме: адаптер,
 * соединение и имя модели (+ параметры генерации по контракту адаптера).
 * Встроенные адаптеры — файл в src/providers/ + строка ниже; кастомные —
 * файл providers/<id>.ts (export default фабрика), имя файла = имя адаптера.
 *
 * Контракт адаптера (contract.keys/ref) — единственный источник валидации:
 * обязательные ключи → громкая ошибка с именем параметра и путём файла;
 * неизвестные ключи → отказ с перечнем. Ссылка ModelRef (у агента/тула)
 * валидируется по contract.ref целевой модели.
 */
const adapters: Record<string, ProviderFactory> = {
  'openai-compatible': openAiCompatibleFactory,
  anthropic: anthropicFactory,
  gigachat: gigachatFactory,
  mock: mockFactory,
};

const contracts: Record<string, AdapterContract> = {
  'openai-compatible': openAiCompatibleContract,
  anthropic: anthropicContract,
  gigachat: gigachatContract,
  mock: mockContract,
};

const imageAdapters: Record<string, ImageAdapterFactory> = {
  'openai-images': openAiImagesFactory,
  'mock-images': mockImagesFactory,
};

const imageContracts: Record<string, AdapterContract> = {
  'openai-images': openAiImagesContract,
  'mock-images': mockImagesContract,
};

/** Кастомные адаптеры из providers/ дома (заполняет bootstrap до loadModels). */
let userAdapters: Map<string, ProviderFactory> = new Map();

export function setUserAdapters(map: Map<string, ProviderFactory>): void {
  userAdapters = map;
}

function resolveAdapter(name: string): ProviderFactory | undefined {
  return adapters[name] ?? userAdapters.get(name);
}

function adapterIds(): string[] {
  return [...Object.keys(adapters), ...userAdapters.keys()];
}

function contractOf(adapter: string): AdapterContract | undefined {
  return contracts[adapter] ?? imageContracts[adapter];
}

/**
 * Читает кастомные адаптеры из providers/ дома: имя файла (без .ts/.js) — имя
 * адаптера. Папки может не быть — тогда кастомных нет; кривое имя, коллизия
 * со встроенным адаптером (включая image-) или файл без export default —
 * ошибка с путём (fail-fast, как у остальных конфигов).
 */
export async function loadUserAdapters(dir: string): Promise<Map<string, ProviderFactory>> {
  const map = new Map<string, ProviderFactory>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return map;
  }
  for (const name of names.filter((f) => f.endsWith('.ts') || f.endsWith('.js'))) {
    const id = name.replace(/\.(ts|js)$/, '');
    if (!PROVIDER_ID_RE.test(id)) {
      throw new Error(`providers/${name}: «${id}» — id адаптера: строчные буквы/цифры/-/_ от 2 символов`);
    }
    if (id in adapters || id in imageAdapters) {
      throw new Error(`providers/${name}: «${id}» — имя занято встроенным адаптером, переименуйте файл`);
    }
    const url = pathToFileURL(join(dir, name)).href;
    const mod = (await import(`${url}?v=${Date.now()}-${Math.random().toString(36).slice(2)}`)) as {
      default?: unknown;
    };
    if (typeof mod.default !== 'function') {
      throw new Error(`providers/${name}: нужен export default — фабрика (id, config) => LLMProvider`);
    }
    map.set(id, mod.default as ProviderFactory);
  }
  return map;
}

export interface ProviderStatus {
  provider: LLMProvider;
  /** false = не хватает настроек/ключа, провайдер отвечает заглушкой */
  ok: boolean;
  note?: string;
  /** true = провайдеру можно слать картинки (инструмент look) */
  vision?: boolean;
  /** Исходная карточка из models/<id>.json — для правки и подсказок GUI */
  config?: ProviderConfig;
}

export interface ImageProviderStatus {
  provider: ImageProvider;
  ok: boolean;
  note?: string;
}

/** Карточку модели валидирует контракт её адаптера: ключи, типы, обязательное. */
function validateCard(file: string, raw: unknown): { config: ProviderConfig; image: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: ожидается объект-карточка модели`);
  }
  const cfg = raw as Record<string, unknown>;
  const adapter = String(cfg.adapter ?? '').trim();
  if (!adapter) throw new Error(`${file}: не указан "adapter"`);
  const contract = contractOf(adapter);
  const isCustom = !contract && Boolean(resolveAdapter(adapter));
  if (!contract && !isCustom) {
    throw new Error(`${file}: адаптер «${adapter}» неизвестен — доступны: ${adapterIds().join(', ')}`);
  }
  if (contract) {
    for (const [k, v] of Object.entries(cfg)) {
      if (k === 'adapter') continue;
      const spec = contract.keys[k];
      if (!spec) {
        throw new Error(
          `${file}: неизвестный параметр "${k}" — адаптер «${adapter}» разрешает: ${Object.keys(contract.keys).join(', ')}`,
        );
      }
      const err = checkKeySpec(k, spec, v);
      if (err) throw new Error(`${file}: ${err}`);
    }
    for (const [k, spec] of Object.entries(contract.keys)) {
      if (spec.required && cfg[k] === undefined) {
        throw new Error(`${file}: не задан обязательный параметр "${k}"`);
      }
    }
  }
  return { config: cfg as ProviderConfig, image: adapter in imageAdapters };
}

export interface LoadedModels {
  models: Map<string, ProviderStatus>;
  images: Map<string, ImageProviderStatus>;
}

/**
 * Читает все карточки models/*.json дома. Папки может не быть (первый запуск
 * до мастера) — тогда моделей нет; битая карточка или нарушение контракта
 * адаптера — громкая ошибка с путём файла и именем параметра.
 */
export function loadModels(dir: string): LoadedModels {
  const models = new Map<string, ProviderStatus>();
  const images = new Map<string, ImageProviderStatus>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { models, images };
  }
  for (const name of names.filter((f) => f.endsWith('.json')).sort()) {
    const id = name.replace(/\.json$/, '');
    const path = join(dir, name);
    if (!PROVIDER_ID_RE.test(id)) {
      throw new Error(`${path}: «${id}» — id модели: строчные буквы/цифры/-/_ от 2 символов`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(
        `${path}: не удалось прочитать карточку модели (${err instanceof Error ? err.message : err})`,
      );
    }
    const { config, image } = validateCard(path, raw);
    const adapter = String(config.adapter);
    try {
      if (image) {
        const factory = imageAdapters[adapter];
        if (!factory) throw new Error(`адаптер «${adapter}» не найден`);
        images.set(id, { provider: factory(id, config), ok: true });
      } else {
        const factory = resolveAdapter(adapter);
        if (!factory) throw new Error(`адаптер «${adapter}» не найден`);
        models.set(id, {
          provider: factory(id, config),
          ok: true,
          // mock «видит» картинки по-своему (заготовка) — demo look работает без моделей
          vision: config.vision === true || adapter === 'mock',
          config,
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (image) {
        images.set(id, {
          provider: {
            id,
            kind: 'unconfigured',
            model: '—',
            async generate() {
              return { ok: false, images: [], error: `image-модель «${id}» не настроена: ${reason}` };
            },
          },
          ok: false,
          note: reason,
        });
      } else {
        models.set(id, { provider: unconfiguredProvider(id, reason), ok: false, note: reason });
      }
    }
  }
  return { models, images };
}

/** id модели из ссылки: явный id или fallback (settings.model.id). Пусто — громко. */
export function resolveRefId(ref: ModelRef | undefined, fallbackId: string | undefined): string {
  const id = (typeof ref?.id === 'string' && ref.id.trim()) || (fallbackId ?? '').trim();
  if (!id) {
    throw new Error('не указана модель — задай "model": {"id": …} в карточке или settings.model.id');
  }
  return id;
}

/**
 * Провайдер статуса с параметрами ссылки поверх карточки: ключи ограничены
 * contract.ref целевой модели, типы — контрактом. Фабрика вызывается заново —
 * фабрики дешёвые (замыкания над строками).
 */
export function instantiateModel(id: string, status: ProviderStatus, ref?: ModelRef): ProviderStatus {
  const overrides = Object.entries(ref ?? {}).filter(([k, v]) => k !== 'id' && v !== undefined);
  if (overrides.length === 0) return status;
  const adapter = String(status.config?.adapter ?? '');
  const contract = contractOf(adapter);
  if (!contract) return status;
  const merged: ProviderConfig = { ...(status.config ?? {}) } as ProviderConfig;
  for (const [k, v] of overrides) {
    if (!contract.ref.includes(k)) {
      throw new Error(
        `модель «${id}»: параметр "${k}" нельзя переопределять ссылкой — разрешены: ${contract.ref.join(', ')}`,
      );
    }
    const spec = contract.keys[k];
    const err = spec ? checkKeySpec(k, spec, v) : `неизвестный адаптер «${adapter}»`;
    if (err) throw new Error(`модель «${id}»: ${err}`);
    merged[k] = v as never;
  }
  const factory = resolveAdapter(String(merged.adapter));
  if (!factory) return status;
  try {
    return {
      provider: factory(id, merged),
      ok: true,
      vision: merged.vision === true || merged.adapter === 'mock',
      config: merged,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { provider: unconfiguredProvider(id, reason), ok: false, note: reason };
  }
}

// ─── Правка models/*.json: добавление, правка, удаление (rpc и операции) ────

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,}$/;

function modelPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** Добавляет модель: файл models/<id>.json. Контракт адаптера валидирует. */
export function addModelConfig(dir: string, id: string, config: Record<string, unknown>): string {
  const mid = String(id ?? '').trim();
  if (!PROVIDER_ID_RE.test(mid)) {
    throw new Error(`неверный id модели «${id}» — строчные буквы/цифры/-/_ от 2 символов`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('карточка модели — объект (adapter, model, baseUrl…)');
  }
  const path = modelPath(dir, mid);
  if (existsSync(path)) throw new Error(`модель «${mid}» уже есть`);
  const { config: checked } = validateCard(path, config);
  mkdirModels(dir);
  writeFileSync(path, `${JSON.stringify(checked, null, 2)}\n`, 'utf8');
  return tf('✓ модель «{id}» ({adapter}) добавлена', { id: mid, adapter: String(checked.adapter) });
}

function mkdirModels(dir: string): void {
  if (!existsSync(dir)) {
    // рекурсивно: дом может ещё не существовать (первый запуск из GUI)
    mkdirSync(dir, { recursive: true });
  }
}

/** Правит карточку модели по контрактным ключам; файл перезаписывается целиком. */
export function updateModelConfig(dir: string, id: string, fields: Record<string, unknown>): string {
  const mid = String(id ?? '').trim();
  const path = modelPath(dir, mid);
  if (!existsSync(path)) throw new Error(`модели «${mid}» нет`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const changes: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key === 'adapter') {
      const adapter = String(value ?? '').trim();
      if (!resolveAdapter(adapter) && !(adapter in imageAdapters)) {
        throw new Error(`адаптер «${adapter}» неизвестен — доступны: ${adapterIds().join(', ')}`);
      }
      raw.adapter = adapter;
    } else if (value === '' || value === undefined) {
      delete raw[key]; // пустое значение — убрать поле
    } else {
      raw[key] = value;
    }
    changes.push(`${key}="${String(raw[key] ?? '')}"`);
  }
  if (changes.length === 0) throw new Error('не понятно, что менять — в полях нет узнаваемых имён');
  validateCard(path, raw);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return tf('✓ модель «{id}»: {changes}', { id: mid, changes: changes.join(', ') });
}

/** Удаляет карточку модели; защищённые id (основная, служебная, менеджерская) не трогаются. */
export function removeModelConfig(dir: string, id: string, protectedIds: string[]): string {
  const mid = String(id ?? '').trim();
  const path = modelPath(dir, mid);
  if (!existsSync(path)) throw new Error(`модели «${mid}» нет`);
  if (protectedIds.includes(mid)) {
    throw new Error(`модель «${mid}» — основная или менеджерская: сначала назначьте другую`);
  }
  rmSync(path);
  return tf('✓ модель «{id}» удалена', { id: mid });
}
