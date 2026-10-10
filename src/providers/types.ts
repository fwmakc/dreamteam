import type { LLMProvider, LLMMessage, StreamRequest } from '../types.js';

export type { LLMProvider, LLMMessage, StreamRequest };

/** Описание одного провайдера в config/providers.json */
export interface ProviderConfig {
  /** Имя адаптера из реестра (src/providers/registry.ts) */
  adapter: string;
  model?: string;
  [key: string]: unknown;
}

/** Корень config/providers.json */
export interface ProvidersFile {
  default: string;
  providers: Record<string, ProviderConfig>;
}

/** Фабрика: создаёт провайдера по конфигу. Кидает ConfigurationError, если не хватает настроек/ключей. */
export type ProviderFactory = (id: string, config: ProviderConfig) => LLMProvider;

/** Провайдер настроен неполностью (нет ключа, неверный baseUrl и т.п.) */
export class ConfigurationError extends Error {}
