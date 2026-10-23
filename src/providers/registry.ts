import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ImageProvider, LLMProvider } from '../types.js';
import type { ProviderConfig, ProviderFactory, ProvidersFile } from './types.js';
import { openAiCompatibleFactory } from './openai-compatible.js';
import { anthropicFactory } from './anthropic.js';
import { gigachatFactory } from './gigachat.js';
import { mockFactory, unconfiguredProvider } from './mock.js';
import { imageAdapters } from './images.js';

/**
 * Реестр адаптеров. Свой API = файл в src/providers/, реализующий
 * интерфейс LLMProvider, + одна строка здесь.
 */
const adapters: Record<string, ProviderFactory> = {
  'openai-compatible': openAiCompatibleFactory,
  anthropic: anthropicFactory,
  gigachat: gigachatFactory,
  mock: mockFactory,
};

export function registerAdapter(name: string, factory: ProviderFactory): void {
  adapters[name] = factory;
}

export interface ProviderStatus {
  provider: LLMProvider;
  /** false = не хватает настроек/ключа, провайдер отвечает заглушкой */
  ok: boolean;
  note?: string;
  /** true = провайдеру можно слать картинки (инструмент look) */
  vision?: boolean;
  /** Исходная карточка из providers.json — для правки (provider.update) и подсказок GUI */
  config?: ProviderConfig;
}

export interface LoadedProviders {
  defaultId: string;
  providers: Map<string, ProviderStatus>;
}

export interface ImageProviderStatus {
  provider: ImageProvider;
  ok: boolean;
  note?: string;
}

export interface LoadedImages {
  images: Map<string, ImageProviderStatus>;
}

function readProvidersFile(file: string): ProvidersFile {
  return JSON.parse(readFileSync(file, 'utf8')) as ProvidersFile;
}

export function loadProviders(file: string): LoadedProviders {
  const raw = readProvidersFile(file);
  const providers = new Map<string, ProviderStatus>();

  for (const [pid, cfg] of Object.entries(raw.providers ?? {})) {
    const adapterName = String(cfg?.adapter ?? '');
    if (adapterName in imageAdapters) continue; // это image-провайдер, не LLM — берёт loadImageProviders
    const factory = adapters[adapterName];
    if (!factory) {
      const reason = `неизвестный адаптер «${adapterName}»`;
      providers.set(pid, {
        provider: unconfiguredProvider(pid, reason),
        ok: false,
        note: reason,
        config: cfg,
      });
      continue;
    }
    try {
      providers.set(pid, {
        provider: factory(pid, cfg),
        ok: true,
        // mock «видит» картинки по-своему (заготовка) — demо look работает без моделей
        vision: cfg.vision === true || adapterName === 'mock',
        config: cfg,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      providers.set(pid, {
        provider: unconfiguredProvider(pid, reason),
        ok: false,
        note: reason,
      });
    }
  }

  const defaultId = raw.default ?? [...providers.keys()][0] ?? '';
  return { defaultId, providers };
}

/** Image-провайдеры из того же providers.json (адаптеры openai-images, mock-images). */
export function loadImageProviders(file: string): LoadedImages {
  const raw = readProvidersFile(file);
  const images = new Map<string, ImageProviderStatus>();

  const broken = (id: string, reason: string): ImageProvider => ({
    id,
    kind: 'unconfigured',
    model: '—',
    async generate() {
      return { ok: false, images: [], error: `image-провайдер «${id}» не настроен: ${reason}` };
    },
  });

  for (const [pid, cfg] of Object.entries(raw.providers ?? {})) {
    const adapterName = String(cfg?.adapter ?? '');
    if (!(adapterName in imageAdapters)) continue; // это LLM, не image-провайдер
    const factory = imageAdapters[adapterName]!;
    try {
      images.set(pid, { provider: factory(pid, cfg), ok: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      images.set(pid, { provider: broken(pid, reason), ok: false, note: reason });
    }
  }

  return { images };
}


// ─── Правка providers.json из GUI (rpc): добавление и удаление провайдеров ──

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,}$/;

/**
 * Добавляет провайдера в providers.json: id, адаптер и поля карточки.
 * Запись — tmp → валидация loadProviders → rename; неудача файл не портит.
 * Возвращает отчёт.
 */
export function addProviderConfig(
  file: string,
  id: string,
  config: Record<string, unknown>,
): string {
  const pid = String(id ?? '').trim();
  if (!PROVIDER_ID_RE.test(pid)) {
    throw new Error(`неверный id провайдера «${id}» — строчные буквы/цифры/-/_ от 2 символов`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('карточка провайдера — объект (adapter, model, baseUrl…)');
  }
  const adapter = String(config.adapter ?? '').trim();
  if (adapter === '') throw new Error('не указан adapter');
  if (!(adapter in adapters)) {
    throw new Error(`адаптер «${adapter}» неизвестен — доступны: ${Object.keys(adapters).join(', ')}`);
  }
  const raw = readProvidersFile(file);
  if (raw.providers[pid] !== undefined) throw new Error(`провайдер «${pid}» уже есть`);
  raw.providers[pid] = { adapter, ...config } as ProviderConfig;
  writeFileProviders(file, raw);
  return `✓ провайдер «${pid}» (${adapter}) добавлен`;
}

/** Удаляет провайдера; защищённые id (основной, менеджерский) не трогаются. */
export function removeProviderConfig(file: string, id: string, protectedIds: string[]): string {
  const raw = readProvidersFile(file);
  if (raw.providers[id] === undefined) throw new Error(`провайдера «${id}» нет`);
  if (protectedIds.includes(id)) {
    throw new Error(`провайдер «${id}» — основной или менеджерский: сначала назначьте другой основным`);
  }
  delete raw.providers[id];
  writeFileProviders(file, raw);
  return `✓ провайдер «${id}» удалён`;
}

/** Правка карточки существующего провайдера по белому списку полей; валидация+откат общие. */
export function updateProviderConfig(
  file: string,
  id: string,
  fields: Record<string, unknown>,
): string {
  const pid = String(id ?? '').trim();
  const raw = readProvidersFile(file);
  if (raw.providers[pid] === undefined) throw new Error(`провайдера «${pid}» нет`);
  const changes: string[] = [];
  const merged: Record<string, unknown> = { ...raw.providers[pid] };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!['adapter', 'model', 'baseUrl', 'apiKey', 'clientId', 'clientSecret', 'maxTokens', 'temperature', 'vision', 'note'].includes(key)) continue;
    if (key === 'adapter') {
      const adapter = String(value ?? '').trim();
      if (!(adapter in adapters)) {
        throw new Error(`адаптер «${adapter}» неизвестен — доступны: ${Object.keys(adapters).join(', ')}`);
      }
      merged.adapter = adapter;
    } else if (value === '' || value === undefined) {
      delete merged[key]; // пустое значение — убрать поле (например, baseUrl)
    } else {
      merged[key] = value;
    }
    changes.push(`${key}="${String(merged[key] ?? '')}"`);
  }
  if (changes.length === 0) throw new Error('не понятно, что менять — в полях нет узнаваемых имён');
  raw.providers[pid] = merged as ProviderConfig;
  writeFileProviders(file, raw);
  return `✓ провайдер «${pid}»: ${changes.join(', ')}`;
}

/** Запись providers.json: tmp → валидация loadProviders → rename (откат при ошибке). */
function writeFileProviders(file: string, raw: ProvidersFile): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  loadProviders(tmp); // валидация; бросает — файл не тронут
  renameSync(tmp, file);
}
