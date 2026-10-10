import type { LLMMessage, StreamRequest } from '../types.js';

/** Пауза (для mock-режима, имитация «печатает...») */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Совмещает внешний сигнал отмены (Esc во время раунда) с таймаутом запроса.
 * Вручную, а не через AbortSignal.any — он появился только в Node 20.3.
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const combined = new AbortController();
  const relay = () => combined.abort(signal.aborted ? signal.reason : undefined);
  if (signal.aborted) relay();
  else signal.addEventListener('abort', relay, { once: true });
  timeout.addEventListener('abort', relay, { once: true });
  return combined.signal;
}

/**
 * Разбирает поток байт (SSE-ответ HTTP) на data-нагрузки протокола
 * Server-Sent Events: строки вида "data: {...}".
 */
export async function* sseData(
  chunks: AsyncIterable<Uint8Array | Buffer>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
      buffer = buffer.slice(newlineIdx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

/** Достаёт текст из delta-чанка OpenAI-совместимого SSE. reasoning-поля игнорирует. */
export function openAiDeltaText(payload: string): string {
  if (!payload || payload === '[DONE]') return '';
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    const content = json.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

/**
 * Приводит историю к чередующимся ролям user/assistant — так требуют
 * Anthropic и GigaChat. Подряд идущие одинаковые роли склеиваются,
 * при необходимости добавляются служебные сообщения по краям.
 */
export function normalizeAlternating(messages: LLMMessage[]): LLMMessage[] {
  const merged: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // system передаётся отдельным полем
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.content;
    } else {
      merged.push({ ...m });
    }
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: 'Ответь на сообщение.' }];
  }
  if (merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '(начало беседы)' });
  }
  if (merged[merged.length - 1].role !== 'user') {
    merged.push({ role: 'user', content: 'Продолжай.' });
  }
  return merged;
}

/** Отделяет system-сообщения от остальной истории (для API с отдельным полем system). */
export function splitSystem(req: StreamRequest): {
  system?: string;
  messages: LLMMessage[];
} {
  let system = req.system;
  const rest: LLMMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else {
      rest.push(m);
    }
  }
  return { system, messages: normalizeAlternating(rest) };
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
