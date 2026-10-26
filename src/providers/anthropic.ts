import type { LLMProvider, RoundUsage, StreamRequest } from '../types.js';
import { ConfigurationError } from './types.js';
import type { AdapterContract, ProviderConfig, ProviderFactory } from './types.js';
import { sseData, splitSystem, num, withTimeout } from './utils.js';

const REQUEST_TIMEOUT_MS = 120_000;
const API_VERSION = '2023-06-01';

/** Контракт карточки models/<id>.json для адаптера anthropic. */
export const contract: AdapterContract = {
  keys: {
    apiKey: { type: 'string', desc: 'ключ из кабинета Anthropic (нет ключа — статус «не настроен»)' },
    model: { type: 'string', desc: 'по умолчанию claude-sonnet-4-5' },
    baseUrl: { type: 'string', desc: 'по умолчанию https://api.anthropic.com' },
    maxTokens: { type: 'number', desc: 'потолок ответа (по умолчанию 2048)' },
    temperature: { type: 'number' },
    cache: { type: 'boolean', desc: 'кэш промптов (по умолчанию включён)' },
  },
  ref: ['temperature', 'maxTokens'],
};

/**
 * Адаптер Anthropic (Claude). Отличия от OpenAI-протокола учтены здесь:
 * endpoint /v1/messages, заголовок x-api-key, отдельное поле system,
 * обязательный max_tokens, свой формат SSE-событий.
 *
 * Кэш промптов включён по умолчанию (в карточке отключается "cache": false):
 * два брейкпоинта cache_control — на system и на последнем сообщении истории.
 * История между раундами растёт в хвост, поэтому следующий раунд читает
 * префикс из кэша (чтение ~10% цены входа, однократная запись +25%).
 * Мелкие запросы ниже минимума API просто не кэширует — не ошибка.
 *
 * Конфиг: apiKey (ключ из кабинета, прямо в карточке), model, baseUrl
 * (по умолчанию https://api.anthropic.com), maxTokens, cache.
 */
export const anthropicFactory: ProviderFactory = (
  id: string,
  config: ProviderConfig,
): LLMProvider => {
  const baseUrl = String(config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const apiKey = config.apiKey ? String(config.apiKey) : undefined;
  if (!apiKey) {
    throw new ConfigurationError(
      `в карточке провайдера «${id}» нет "apiKey" — впиши ключ из кабинета в providers.json`,
    );
  }
  const model = String(config.model ?? 'claude-sonnet-4-5');
  // Anthropic требует max_tokens в каждом запросе
  const defaultMaxTokens = num(config.maxTokens) ?? 2048;
  const cacheEnabled = config.cache !== false;

  const provider: LLMProvider = {
    id,
    kind: 'anthropic',
    model,

    async *stream(req: StreamRequest, onUsage?: (usage: RoundUsage) => void): AsyncGenerator<string> {
      const { system, messages } = splitSystem(req);
      // Сообщения с картинками превращаем в content-blocks формата Anthropic vision
      let apiMessages: Array<{ role: string; content: unknown }> = messages.map((m) => {
        if (!m.images?.length) return m;
        const blocks: unknown[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const dataUrl of m.images) {
          const match = /^data:([^;,]+);base64,([\s\S]*)$/s.exec(dataUrl);
          blocks.push(
            match
              ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
              : { type: 'text', text: '(картинка в неподдерживаемом формате — не data:URL/base64)' },
          );
        }
        return { role: m.role, content: blocks };
      });
      // Кэш: брейкпоинт на system + на последнем сообщении (префикс раунда N
      // становится кэш-попаданием раунда N+1). Мелкие запросы API молча
      // не кэширует — брейкпоинты безвредны.
      let systemField: unknown = system;
      if (cacheEnabled && system) {
        systemField = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      }
      if (cacheEnabled && apiMessages.length > 0) {
        apiMessages = apiMessages.map((m, i) => {
          if (i !== apiMessages.length - 1) return m;
          if (typeof m.content === 'string') {
            return { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
          }
          if (Array.isArray(m.content)) {
            // vision-блоки: маркер на последний существующий блок, ничего не дописываем
            const blocks = [...(m.content as Record<string, unknown>[])];
            if (blocks.length > 0) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
            return { role: m.role, content: blocks };
          }
          return m;
        });
      }
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? defaultMaxTokens,
          temperature: req.temperature ?? 0.7,
          stream: true,
          ...(systemField ? { system: systemField } : {}),
          messages: apiMessages,
        }),
        signal: withTimeout(req.signal, REQUEST_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        const detail = res.body ? await res.text() : '(пустой ответ)';
        throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
      }
      const usage: RoundUsage = {};
      for await (const data of sseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (!data) continue;
        let event: {
          type?: string;
          delta?: { type?: string; text?: unknown };
          error?: { message?: unknown };
          message?: { usage?: {
            input_tokens?: unknown;
            cache_read_input_tokens?: unknown;
            cache_creation_input_tokens?: unknown;
          } };
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          yield event.delta.text;
        } else if (event.type === 'message_start' && typeof event.message?.usage === 'object') {
          const u = event.message.usage;
          if (typeof u.input_tokens === 'number') usage.promptTokens = u.input_tokens;
          if (typeof u.cache_read_input_tokens === 'number') usage.cachedTokens = u.cache_read_input_tokens;
        } else if (event.type === 'error') {
          throw new Error(String(event.error?.message ?? data.slice(0, 300)));
        } else if (event.type === 'message_stop') {
          break;
        }
      }
      onUsage?.(usage);
    },
  };
  return provider;
};
