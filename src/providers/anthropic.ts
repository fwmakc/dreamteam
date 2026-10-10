import type { LLMProvider, StreamRequest } from '../types.js';
import { ConfigurationError } from './types.js';
import type { ProviderConfig, ProviderFactory } from './types.js';
import { sseData, splitSystem, num, withTimeout } from './utils.js';

const REQUEST_TIMEOUT_MS = 120_000;
const API_VERSION = '2023-06-01';

/**
 * Адаптер Anthropic (Claude). Отличия от OpenAI-протокола учтены здесь:
 * endpoint /v1/messages, заголовок x-api-key, отдельное поле system,
 * обязательный max_tokens, свой формат SSE-событий.
 *
 * Конфиг: apiKeyEnv (по умолчанию ANTHROPIC_API_KEY), model, baseUrl
 * (по умолчанию https://api.anthropic.com), maxTokens.
 */
export const anthropicFactory: ProviderFactory = (
  id: string,
  config: ProviderConfig,
): LLMProvider => {
  const baseUrl = String(config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const apiKeyEnv = config.apiKeyEnv ? String(config.apiKeyEnv) : 'ANTHROPIC_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new ConfigurationError(
      `не задана переменная окружения ${apiKeyEnv} (провайдер «${id}»)`,
    );
  }
  const model = String(config.model ?? 'claude-sonnet-4-5');
  // Anthropic требует max_tokens в каждом запросе
  const defaultMaxTokens = num(config.maxTokens) ?? 2048;

  const provider: LLMProvider = {
    id,
    kind: 'anthropic',
    model,

    async *stream(req: StreamRequest): AsyncGenerator<string> {
      const { system, messages } = splitSystem(req);
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
          ...(system ? { system } : {}),
          messages,
        }),
        signal: withTimeout(req.signal, REQUEST_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        const detail = res.body ? await res.text() : '(пустой ответ)';
        throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
      }
      for await (const data of sseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (!data) continue;
        let event: {
          type?: string;
          delta?: { type?: string; text?: unknown };
          error?: { message?: unknown };
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
        } else if (event.type === 'error') {
          throw new Error(String(event.error?.message ?? data.slice(0, 300)));
        } else if (event.type === 'message_stop') {
          break;
        }
      }
    },
  };
  return provider;
};
