import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LLMProvider, RoundUsage, StreamRequest } from '../types.js';
import { ConfigurationError } from './types.js';
import type { AdapterContract, ProviderConfig, ProviderFactory } from './types.js';
import { openAiDeltaText, sseData, splitSystem, num } from './utils.js';

/** Контракт карточки models/<id>.json для адаптера gigachat. */
export const contract: AdapterContract = {
  keys: {
    apiKey: { type: 'string', desc: 'ключ из кабинета GigaChat (нет ключа — статус «не настроен»)' },
    clientId: { type: 'string', desc: 'пара с clientSecret вместо apiKey' },
    clientSecret: { type: 'string' },
    scope: { type: 'string', desc: 'по умолчанию GIGACHAT_API_PERS' },
    baseUrl: { type: 'string' },
    authUrl: { type: 'string' },
    caCertPath: { type: 'string', desc: 'путь к сертификатам Минцифры' },
    insecureTLS: { type: 'boolean', desc: 'не проверять сертификат (только тесты)' },
    model: { type: 'string', desc: 'по умолчанию GigaChat' },
    maxTokens: { type: 'number' },
    temperature: { type: 'number' },
    vision: { type: 'boolean', desc: 'модель видит картинки — тулу look (GigaChat Vision)' },
  },
  ref: ['temperature', 'maxTokens'],
};

const REQUEST_TIMEOUT_MS = 120_000;
/** Обновляем токен за минуту до истечения, а не на каждом запросе */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface TlsOptions {
  ca?: string;
  rejectUnauthorized?: boolean;
}

/** Прерывание запроса извне (Esc во время раунда): signal → destroy сокета */
function bindAbort(req: ClientRequest, signal?: AbortSignal): void {
  if (!signal) return;
  const destroy = () => req.destroy(new Error('прервано (Esc)'));
  if (signal.aborted) destroy();
  else signal.addEventListener('abort', destroy, { once: true });
}

function readAll(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    res.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    res.on('end', () => resolve(text));
    res.on('error', reject);
  });
}

function postStream(
  url: string,
  tls: TlsOptions,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'POST', ...tls, headers },
      (res) => resolve(res),
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('таймаут запроса')));
    bindAbort(req, signal);
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Адаптер Сбер GigaChat. Берёт на себя всё, ради чего обычно поднимают
 * отдельный прокси-сервис:
 *
 * 1. Сам получает access_token по API-ключу (OAuth2: Basic auth + RqUID + scope).
 * 2. Кэширует токен и обновляет заранее — за минуту до истечения (~30 мин жизни).
 * 3. Single-flight: параллельные запросы в момент рефреша не плодят несколько обновлений.
 * 4. При внезапном 401 — один тихий рефреш и повтор запроса.
 * 5. Российские TLS-сертификаты: опция caCertPath (путь к корневому сертификату
 *    Минцифры) или insecureTLS: true для быстрой проверки (небезопасно).
 *
 * Конфиг: apiKey (ключ из кабинета, готовая Basic-строка — прямо в карточке)
 * Либо пара clientId + clientSecret — тогда Basic строится из неё.
 * scope (по умолчанию GIGACHAT_API_PERS), model (по умолчанию GigaChat),
 * authUrl / baseUrl — endpoints, caCertPath, insecureTLS, maxTokens.
 */
export const gigachatFactory: ProviderFactory = (
  id: string,
  config: ProviderConfig,
): LLMProvider => {
  const scope = String(config.scope ?? 'GIGACHAT_API_PERS');
  const baseUrl = String(
    config.baseUrl ?? 'https://gigachat.devices.sberbank.ru/api/v1',
  ).replace(/\/+$/, '');
  const authUrl = String(
    config.authUrl ?? 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
  );
  const model = String(config.model ?? 'GigaChat');
  const defaultMaxTokens = num(config.maxTokens) ?? 1024;

  // --- авторизация: либо готовый ключ из кабинета, либо пара id/secret ---
  const clientId = config.clientId ? String(config.clientId) : undefined;
  const clientSecret = config.clientSecret ? String(config.clientSecret) : undefined;

  let basicAuth: string;
  if (clientId && clientSecret) {
    basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  } else {
    const key = config.apiKey ? String(config.apiKey) : undefined;
    if (!key) {
      throw new ConfigurationError(
        `в карточке провайдера «${id}» нет "apiKey" (или пары "clientId"/"clientSecret") — впиши ключ из кабинета в карточку models/${id}.json`,
      );
    }
    // Ключ из личного кабинета GigaChat — это уже base64(client_id:secret)
    basicAuth = key;
  }

  // --- TLS: сертификаты Минцифры или явное отключение проверки ---
  const tls: TlsOptions = {};
  const caCertPath = config.caCertPath ? String(config.caCertPath) : undefined;
  if (caCertPath) {
    try {
      tls.ca = readFileSync(caCertPath, 'utf8');
    } catch (err) {
      throw new ConfigurationError(
        `не удалось прочитать сертификат ${caCertPath} — скачайте его по инструкции ` +
        `GigaChat или уберите caCertPath/поставьте insecureTLS: true (${err instanceof Error ? err.message : err})`,
      );
    }
  }
  if (config.insecureTLS === true) tls.rejectUnauthorized = false;

  // --- жизненный цикл токена ---
  let token: { value: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  function fetchToken(signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({ scope }).toString();
      const req = httpsRequest(
        authUrl,
        {
          method: 'POST',
          ...tls,
          headers: {
            authorization: `Basic ${basicAuth}`,
            rqUid: randomUUID(),
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
        },
        async (res) => {
          const text = await readAll(res);
          if (res.statusCode !== 200) {
            reject(
              new Error(`OAuth GigaChat: HTTP ${res.statusCode}: ${text.slice(0, 300)}`),
            );
            return;
          }
          try {
            const json = JSON.parse(text) as { access_token?: string; expires_at?: number };
            if (!json.access_token) throw new Error('нет access_token в ответе');
            token = {
              value: json.access_token,
              expiresAt: Number(json.expires_at ?? Date.now() + 25 * 60_000),
            };
            resolve(token.value);
          } catch (err) {
            reject(
              new Error(
                `OAuth GigaChat: не удалось разобрать ответ: ${text.slice(0, 200)} (${err instanceof Error ? err.message : err})`,
              ),
            );
          }
        },
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('таймаут OAuth')));
      bindAbort(req, signal);
      req.on('error', reject);
      req.end(body);
    });
  }

  async function getToken(force = false, signal?: AbortSignal): Promise<string> {
    if (!force && token && Date.now() < token.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return token.value;
    }
    // single-flight: все ждут одно и то же обновление
    refreshing ??= fetchToken(signal).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const provider: LLMProvider = {
    id,
    kind: 'gigachat',
    model,

    async *stream(req: StreamRequest, onUsage?: (usage: RoundUsage) => void): AsyncGenerator<string> {
      const { system, messages } = splitSystem(req);
      const payloadMessages = system
        ? [{ role: 'system' as const, content: system }, ...messages]
        : messages;
      const payload = JSON.stringify({
        model,
        messages: payloadMessages,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? defaultMaxTokens,
        stream: true,
      });
      const headers = {
        authorization: '',
        'content-type': 'application/json',
        accept: 'application/json',
      };

      let bearer = await getToken(false, req.signal);
      let res = await postStream(`${baseUrl}/chat/completions`, tls, {
        ...headers,
        authorization: `Bearer ${bearer}`,
      }, payload, req.signal);

      // токен отозвали/просрочился раньше времени — тихо обновляем и повторяем
      if (res.statusCode === 401) {
        res.resume();
        bearer = await getToken(true, req.signal);
        res = await postStream(`${baseUrl}/chat/completions`, tls, {
          ...headers,
          authorization: `Bearer ${bearer}`,
        }, payload, req.signal);
      }

      if (res.statusCode !== 200) {
        const text = await readAll(res);
        throw new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
      }

      // GigaChat совместим с OpenAI по формату SSE; usage (если отдаёт) —
      // читаем тем же защитным разбором: кэш-токены появятся, когда появятся
      const usage: RoundUsage = {};
      for await (const data of sseData(res)) {
        const text = openAiDeltaText(data);
        if (text) yield text;
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
