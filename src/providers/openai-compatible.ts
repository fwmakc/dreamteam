import type { LLMMessage, LLMProvider, ModelRef, RoundUsage, StreamRequest } from '../types.js';
import { ConfigurationError } from './types.js';
import type { AdapterContract, ProviderConfig, ProviderFactory } from './types.js';
import { openAiDeltaText, sseData, num, withTimeout } from './utils.js';

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Контракт карточки models/<id>.json: обязательные и опциональные ключи,
 * подмножество для переопределения ссылкой (ModelRef). Источник для
 * валидации реестром, форм GUI и подсказок.
 */
export const contract: AdapterContract = {
  keys: {
    baseUrl: { type: 'string', required: true, desc: 'адрес API вместе с /v1 (Z.ai — /api/paas/v4 или /api/coding/paas/v4)' },
    model: { type: 'string', required: true, desc: 'имя модели у API' },
    apiKey: { type: 'string', desc: 'ключ API; для локальных API можно опустить' },
    maxTokens: { type: 'number', desc: 'потолок ответа' },
    temperature: { type: 'number', desc: '0 — строже, 1 — креативнее' },
    thinking: { type: 'string', enum: ['enabled', 'disabled'], desc: 'размышления GLM (биллятся)' },
    reasoning: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'max'], desc: 'глубина размышлений' },
    extra: { type: 'object', desc: 'словарь дополнительных полей тела запроса' },
  },
  ref: ['temperature', 'maxTokens', 'thinking', 'reasoning'],
};

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

    async *stream(req: StreamRequest, onUsage?: (usage: RoundUsage) => void): AsyncGenerator<string> {
      const messages: LLMMessage[] = req.system
        ? [{ role: 'system', content: req.system }, ...req.messages]
        : req.messages;
      const body: Record<string, unknown> = {
        model,
        messages: toApiMessages(messages),
        stream: true,
        temperature: req.temperature ?? defaultTemperature,
        // статистика токенов в последнем чанке потока (OpenAI-расширение;
        // серверы, которые его не знают, молча игнорируют)
        stream_options: { include_usage: true },
      };
      const maxTokens = req.maxTokens ?? defaultMaxTokens;
      if (maxTokens) body.max_tokens = maxTokens;
      // размышления GLM: из ссылки (req) или из карточки
      const thinking = req.thinking ?? (config.thinking === 'disabled' || config.thinking === 'enabled' ? config.thinking : undefined);
      if (thinking) body.thinking = { type: thinking };
      const reasoning = req.reasoning ?? (typeof config.reasoning === 'string' ? config.reasoning : undefined);
      if (reasoning) body.reasoning_effort = reasoning;
      if (config.extra && typeof config.extra === 'object' && !Array.isArray(config.extra)) {
        Object.assign(body, config.extra);
      }

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
      const usage: RoundUsage = {};
      for await (const data of sseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
        const text = openAiDeltaText(data);
        if (text) yield text;
        // usage идёт в финальном чанке (choices пустой): префиксный кэш
        // (Z.ai GLM, OpenAI, DeepSeek…) отчитывается в prompt_tokens_details
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data) as {
            usage?: {
              prompt_tokens?: unknown;
              completion_tokens?: unknown;
              prompt_tokens_details?: { cached_tokens?: unknown };
            };
          };
          if (typeof json.usage?.prompt_tokens === 'number') usage.promptTokens = json.usage.prompt_tokens;
          if (typeof json.usage?.completion_tokens === 'number') usage.outputTokens = json.usage.completion_tokens;
          if (typeof json.usage?.prompt_tokens_details?.cached_tokens === 'number') {
            usage.cachedTokens = json.usage.prompt_tokens_details.cached_tokens;
          }
        } catch { /* не JSON — не usage */ }
      }
      onUsage?.(usage);
    },
  };
  return provider;
};
