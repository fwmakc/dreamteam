import { readFileSync } from 'node:fs';
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
      });
      continue;
    }
    try {
      providers.set(pid, {
        provider: factory(pid, cfg),
        ok: true,
        // mock «видит» картинки по-своему (заготовка) — demо look работает без моделей
        vision: cfg.vision === true || adapterName === 'mock',
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
