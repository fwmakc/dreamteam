import type { ImageProvider, LLMProvider, LLMMessage, StreamRequest } from '../types.js';

export type { LLMProvider, LLMMessage, StreamRequest };

/** Карточка модели models/<id>.json: провайдер, соединение, имя модели. */
export interface ProviderConfig {
  /** Имя провайдера (адаптера) из реестра (src/providers/registry.ts) */
  provider: string;
  model?: string;
  [key: string]: unknown;
}

/** Фабрика: создаёт провайдера по конфигу. Кидает ConfigurationError, если не хватает настроек/ключей. */
export type ProviderFactory = (id: string, config: ProviderConfig) => LLMProvider;

/** Фабрика image-провайдера (генерация/перерисовка картинок) — та же карта конфигов. */
export type ImageAdapterFactory = (id: string, config: ProviderConfig) => ImageProvider;

/** Описание одного ключа карточки модели — часть контракта адаптера. */
export interface ModelKeySpec {
  type: 'string' | 'number' | 'boolean' | 'object';
  /** Не задан → громкая ошибка при загрузке models/ с именем параметра */
  required?: boolean;
  /** Для строк: допустимые значения */
  enum?: string[];
  /** Человекочитаемое описание (подсказки GUI/CLI) */
  desc?: string;
}

/**
 * Контракт адаптера: какие ключи бывают в карточке models/<id>.json,
 * какие обязательны, какое подмножество переопределяется ссылкой ModelRef.
 * Единственный источник истины для валидации (registry), форм GUI и подсказок.
 */
export interface AdapterContract {
  keys: Record<string, ModelKeySpec>;
  /** Ключи карточки, которые разрешено переопределять в ModelRef */
  ref: string[];
}

/** Проверка значения по спецификации ключа; возвращает текст ошибки или null. */
export function checkKeySpec(
  name: string,
  spec: ModelKeySpec,
  value: unknown,
): string | null {
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `параметр "${name}" — число`;
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return `параметр "${name}" — true или false`;
  } else if (spec.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `параметр "${name}" — объект`;
  } else {
    if (typeof value !== 'string') return `параметр "${name}" — строка`;
    if (spec.enum && !spec.enum.includes(value)) {
      return `параметр "${name}" — одно из: ${spec.enum.join(', ')}`;
    }
  }
  return null;
}

/** Провайдер настроен неполностью (нет ключа, неверный baseUrl и т.п.) */
export class ConfigurationError extends Error {}
