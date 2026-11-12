import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import {
  blockFromCall,
  callFromBlock,
  firstBlockOfKind,
  TOOL_RESULT_HEADER,
} from '../actions.js';
import type { LLMMessage, LLMProvider, RoundUsage, StreamRequest, ToolSpec } from '../types.js';
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
    contextWindow: { type: 'number', desc: 'Размер контекстного окна (токены)' },
    temperature: { type: 'number' },
    vision: { type: 'boolean', desc: 'модель видит картинки — тулу look (GigaChat Vision)' },
  },
  ref: ['temperature', 'maxTokens'],
};

const REQUEST_TIMEOUT_MS = 120_000;
/** Обновляем токен за минуту до истечения, а не на каждом запросе */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface TlsOptions {
  ca?: string | string[];
  rejectUnauthorized?: boolean;
}

/** Прерывание запроса извне (Esc во время раунда): signal → destroy сокета */
function bindAbort(req: ClientRequest, signal?: AbortSignal): void {
  if (!signal) return;
  const destroy = () => req.destroy(new Error('прервано (Esc)'));
  if (signal.aborted) destroy();
  else signal.addEventListener('abort', destroy, { once: true });
}

/**
 * PEM-файл → массив сертификатов. Файл с цепочкой (root + sub CA — так
 * раздаёт их gu-st.ru) одной строкой Node не осиливает: из multi-cert
 * строки в доверие попадает только последний сертификат, и верификация
 * падает с SELF_SIGNED_CERT_IN_CHAIN — поэтому каждый блок отдельно.
 */
function loadCa(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  const blocks = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return blocks && blocks.length > 0 ? blocks : [raw.trim()];
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

// ── нативный function calling ───────────────────────────────────────────────
// GigaChat повторяет легаси-формат OpenAI: в запросе массив functions
// (имя, описание, JSON Schema) и function_call: "auto"; модель отвечает
// choices[0].message.function_call {name, arguments} + finish_reason
// "function_call"; результат возвращается сообщением role: "function".
// Replay истории выверен по OpenAPI-схеме (api.yml на developers.sber.ru):
// arguments в function_call — JSON-объект, content у assistant-вызова —
// обязательная строка (пустая при вызове), результат функции — «обернутый
// в строку JSON-объект». Входящий arguments читаем толерантно: доки в
// описании до сих пор упоминают строку-легаси, схема — объект.
// С функциями SSE-стриминг не используем (доки подтверждают, что он есть —
// имя и аргументы приходят одним фрагментом, — но полный ответ надёжнее).
// functions_state_id (серверное состояние вызовов, нужно встроенным функциям
// вроде text2image) не применяем — свою историю вызовов передаём честно,
// конвертируя пару «сообщение с тул-блоком → результаты» в нативные роли.

/** Сообщение нативного протокола (супермножество LLMMessage). */
interface GigaMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string | null;
  name?: string;
  function_call?: { name?: string; arguments?: unknown };
  functions_state_id?: string;
}

interface GigaUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

interface GigaResponse {
  choices?: { message?: { content?: string | null; function_call?: GigaMessage['function_call']; functions_state_id?: unknown } }[];
  usage?: GigaUsage;
}

/** Имя функции API: латиница/цифры/дефис/подчёркивание (у тулов бывают точки
 *  и кириллица). Дедупликация — суффиксом; карта обратно в вид тул-блока. */
function safeNameMaps(specs: ToolSpec[]): { toSafe: Map<string, string>; toKind: Map<string, string> } {
  const toSafe = new Map<string, string>();
  const toKind = new Map<string, string>();
  for (const spec of specs) {
    let safe = spec.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
    if (/^[0-9_-]/.test(safe)) safe = `t${safe}`;
    while (toKind.has(safe)) safe += '_';
    toSafe.set(spec.name, safe);
    toKind.set(safe, spec.name);
  }
  return { toSafe, toKind };
}

/**
 * Подпись вызова функции: безопасное имя + аргументы с сортировкой ключей.
 * Ключ карты «вызов → functions_state_id»: reconstruct из блока и вызов
 * из ответа модели должны давать одну и ту же строку.
 */
function callSignature(name: string, args: Record<string, string | number>): string {
  const sorted = Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${name} ${JSON.stringify(sorted)}`;
}

/**
 * История движка → нативная: пара «сообщение с тул-блоком → ⚙ Результаты…»
 * становится «assistant с function_call → function с результатом» (роль
 * function обязана идти сразу за вызовом). Остальные сообщения — как есть,
 * роль user. Проза вокруг блока не переносится: нативный вызов у нас —
 * чистый блок без текста. Работает по сырой истории движка — ДО склейки
 * одинаковых ролей, иначе пара «блок → результаты» исчезает.
 *
 * stateIds — карта «вызов → functions_state_id» с живых ответов: сервер
 * возвращает идентификатор при вызове функции, и без него в replay модель
 * продолжает разговор сломанно (проверено боем: мусорный ответ или повторный
 * вызов); с ним — нормальный ответ. Промах по карте — идём без id.
 */
function convertHistory(
  messages: LLMMessage[],
  toSafe: Map<string, string>,
  stateIds?: Map<string, string>,
): GigaMessage[] {
  const kinds = [...toSafe.keys()];
  const out: GigaMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const next = messages[i + 1];
    const block = next && next.content.startsWith(TOOL_RESULT_HEADER)
      ? firstBlockOfKind(m.content, kinds)
      : null;
    if (block) {
      const safe = toSafe.get(block.kind)!;
      const call = callFromBlock(block.kind, block.line, block.body);
      const stateId = stateIds?.get(callSignature(block.kind, call.args));
      out.push({
        role: 'assistant',
        // по OpenAPI-схеме content — обязательная строка («поле будет пустым»
        // при вызове), arguments — JSON-объект
        content: '',
        function_call: { name: safe, arguments: call.args },
        ...(stateId ? { functions_state_id: stateId } : {}),
      });
      // результат функции — «обернутый в строку JSON-объект» (требование доков)
      out.push({ role: 'function', name: safe, content: JSON.stringify({ result: next.content.slice(TOOL_RESULT_HEADER.length).replace(/^\n/, '') }) });
      i++;
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** Чередование ролей для GigaChat (как normalizeAlternating, но с ролью
 *  function): подряд одинаковые склеиваются, по краям — служебные сообщения. */
function gigaNormalize(messages: GigaMessage[]): GigaMessage[] {
  const merged: GigaMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = (last.content ?? '') + '\n\n' + (m.content ?? '');
    } else {
      merged.push({ ...m });
    }
  }
  if (merged.length === 0) return [{ role: 'user', content: 'Ответь на сообщение.' }];
  if (merged[0]!.role !== 'user') merged.unshift({ role: 'user', content: '(начало беседы)' });
  if (merged[merged.length - 1]!.role !== 'user') merged.push({ role: 'user', content: 'Продолжай.' });
  return merged;
}

/** Аргументы функции: объект — как есть (только строки/числа), строка — JSON
 *  или голый текст команды (body), ничего внятного — null. */
function parseCallArgs(raw: unknown): Record<string, string | number> | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return { body: s };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Ответ модели → текст для движка: обычная реплика и/или тул-блок. */
function responseToText(message: { content?: string | null; function_call?: GigaMessage['function_call'] }, toKind: Map<string, string>): string {
  const parts: string[] = [];
  if (typeof message.content === 'string' && message.content.trim()) parts.push(message.content);
  const call = message.function_call;
  if (call?.name) {
    const kind = toKind.get(call.name);
    if (!kind) {
      parts.push(`⚙ модель вызвала неизвестную функцию «${call.name}» — среди тулов агента её нет`);
    } else {
      const args = parseCallArgs(call.arguments);
      const block = args ? blockFromCall({ kind, args }) : null;
      parts.push(block ?? `⚙ модель вызвала «${kind}» без аргументов — нечего исполнять`);
    }
  }
  return parts.join('\n\n');
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
 * 6. Нативный function calling: тулы агента уходят массивом functions, вызов
 *    функции из ответа конвертируется в тул-блок движка, результаты возвращаются
 *    сообщением role: "function" (см. convertHistory/responseToText).
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
        `нет "apiKey" (или пары "clientId"/"clientSecret") — впиши ключ из кабинета`,
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
      tls.ca = loadCa(caCertPath);
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

  // вызовы функций этого провайдера → серверные functions_state_id: ответ
  // модели запоминаем, при replay истории возвращаем модели её же id
  // (см. convertHistory); крышка — чтобы карта не росла вечно
  const stateIds = new Map<string, string>();

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
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json',
      };

      // POST чата; токен отозвали/просрочился раньше времени — тихий рефреш и повтор
      const sendChat = async (payload: string): Promise<IncomingMessage> => {
        let bearer = await getToken(false, req.signal);
        let res = await postStream(`${baseUrl}/chat/completions`, tls, {
          ...headers,
          authorization: `Bearer ${bearer}`,
        }, payload, req.signal);
        if (res.statusCode === 401) {
          res.resume();
          bearer = await getToken(true, req.signal);
          res = await postStream(`${baseUrl}/chat/completions`, tls, {
            ...headers,
            authorization: `Bearer ${bearer}`,
          }, payload, req.signal);
        }
        return res;
      };
      const requireOk = async (res: IncomingMessage): Promise<string> => {
        if (res.statusCode !== 200) {
          const text = await readAll(res);
          throw new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
        }
        return readAll(res);
      };
      const toUsage = (u: GigaUsage | undefined): RoundUsage => {
        const usage: RoundUsage = {};
        if (typeof u?.prompt_tokens === 'number') usage.promptTokens = u.prompt_tokens;
        if (typeof u?.completion_tokens === 'number') usage.outputTokens = u.completion_tokens;
        if (typeof u?.prompt_tokens_details?.cached_tokens === 'number') {
          usage.cachedTokens = u.prompt_tokens_details.cached_tokens;
        }
        return usage;
      };

      // Нативный function calling: тулы агента уходят массивом functions,
      // ответ приходит целиком (без SSE) — вызов функции конвертируется
      // в тул-блок движка, дальше конвейер (parseActions → check → run) прежний.
      if (req.tools && req.tools.length > 0) {
        const { toSafe, toKind } = safeNameMaps(req.tools);
        // сырая история движка: пары «блок → результаты» конвертируются ДО
        // склейки ролей, иначе normalizeAlternating их перемешает
        const native = gigaNormalize(
          convertHistory(req.messages.filter((m) => m.role !== 'system'), toSafe, stateIds),
        );
        const payload = JSON.stringify({
          model,
          messages: system ? [{ role: 'system' as const, content: system }, ...native] : native,
          temperature: req.temperature ?? 0.7,
          max_tokens: req.maxTokens ?? defaultMaxTokens,
          stream: false,
          functions: req.tools.map((spec) => ({
            name: toSafe.get(spec.name),
            description: spec.description,
            parameters: spec.parameters,
          })),
          function_call: 'auto',
        });
        const res = await sendChat(payload);
        const raw = await requireOk(res);
        let json: GigaResponse;
        try {
          json = JSON.parse(raw) as GigaResponse;
        } catch (err) {
          throw new Error(
            `не удалось разобрать ответ GigaChat: ${raw.slice(0, 200)} (${err instanceof Error ? err.message : err})`,
          );
        }
        const message = json.choices?.[0]?.message;
        // запоминаем серверный идентификатор вызова: подпись — вид тула (не
        // безопасное имя) + аргументы, ровно как их соберёт callFromBlock
        if (typeof message?.functions_state_id === 'string' && message.function_call?.name) {
          const args = parseCallArgs(message.function_call.arguments);
          const kind = toKind.get(message.function_call.name);
          if (args && kind) {
            stateIds.set(callSignature(kind, args), message.functions_state_id);
            if (stateIds.size > 64) {
              const oldest = stateIds.keys().next();
              if (oldest.done !== true) stateIds.delete(oldest.value);
            }
          }
        }
        const text = message ? responseToText(message, toKind) : '';
        if (text) yield text;
        onUsage?.(toUsage(json.usage));
        return;
      }

      // Обычный режим: SSE-поток.
      const payload = JSON.stringify({
        model,
        messages: payloadMessages,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? defaultMaxTokens,
        stream: true,
      });
      const res = await sendChat(payload);
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
          const json = JSON.parse(data) as { usage?: GigaUsage };
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
