import type { LLMMessage, LLMProvider, StreamRequest } from '../types.js';
import { ConfigurationError } from './types.js';
import type { ProviderConfig, ProviderFactory } from './types.js';
import { openAiDeltaText, sseData, num, withTimeout } from './utils.js';

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Универсальный адаптер для любых OpenAI-совместимых API:
 * Z.ai (GLM), OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio и т.д.
 *
 * Конфиг: baseUrl (обязателен, вместе с /v1 или /v4), model,
 * apiKey (ключ прямо в карточке; для локальных API можно опустить),
 * maxTokens, temperature (необязательно).
 */
export const openAiCompatibleFactory: ProviderFactory = (
  id: string,
  config: ProviderConfig,
): LLMProvider => {
  const baseUrl = String(config.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new ConfigurationError(`не задан baseUrl (провайдер «${id}»)`);
  }
  const model = String(config.model ?? '');
  if (!model) {
    throw new ConfigurationError(`не задана модель (провайдер «${id}»)`);
  }
  const apiKey = config.apiKey ? String(config.apiKey) : undefined;
  const defaultMaxTokens = num(config.maxTokens);
  const defaultTemperature = num(config.temperature) ?? 0.7;

  /** Сообщения с картинками превращаем в content-parts формата OpenAI vision */
  const toApiMessages = (messages: LLMMessage[]): unknown[] =>
    messages.map((m) => {
      if (!m.images?.length) return m;
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      };
    });

  const provider: LLMProvider = {
    id,
    kind: 'openai-compatible',
    model,

    async *stream(req: StreamRequest): AsyncGenerator<string> {
      const messages: LLMMessage[] = req.system
        ? [{ role: 'system', content: req.system }, ...req.messages]
        : req.messages;
      const body: Record<string, unknown> = {
        model,
        messages: toApiMessages(messages),
        stream: true,
        temperature: req.temperature ?? defaultTemperature,
      };
      const maxTokens = req.maxTokens ?? defaultMaxTokens;
      if (maxTokens) body.max_tokens = maxTokens;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: withTimeout(req.signal, REQUEST_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        const detail = res.body ? await res.text() : '(пустой ответ)';
        throw new Error(
          `HTTP ${res.status}: ${detail.slice(0, 300)}`,
        );
      }
      for await (const data of sseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
        const text = openAiDeltaText(data);
        if (text) yield text;
      }
    },
  };
  return provider;
};
