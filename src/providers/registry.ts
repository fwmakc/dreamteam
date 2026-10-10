import { readFileSync } from 'node:fs';
import type { LLMProvider } from '../types.js';
import type { ProviderConfig, ProviderFactory, ProvidersFile } from './types.js';
import { openAiCompatibleFactory } from './openai-compatible.js';
import { anthropicFactory } from './anthropic.js';
import { gigachatFactory } from './gigachat.js';
import { mockFactory, unconfiguredProvider } from './mock.js';

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
}

export interface LoadedProviders {
  defaultId: string;
  providers: Map<string, ProviderStatus>;
}

export function loadProviders(file: string): LoadedProviders {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as ProvidersFile;
  const providers = new Map<string, ProviderStatus>();

  for (const [pid, cfg] of Object.entries(raw.providers ?? {})) {
    const adapterName = String(cfg?.adapter ?? '');
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
      providers.set(pid, { provider: factory(pid, cfg), ok: true });
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
