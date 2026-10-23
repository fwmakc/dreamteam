/**
 * Мессенджеры: Telegram и MAX — общая механика для тулов `telegram` и `max`.
 * Токены живут в ~/.dreamteam/messengers.json (секреты в доме, не в карточках):
 *
 *   { "telegram": { "token": "123456:ABC-DEF…" },
 *     "max":      { "token": "…" },
 *     "api":      { "telegram": "http://127.0.0.1:8081", "max": "http://127.0.0.1:8082" } }
 *
 * "api" — необязательная подмена базового адреса: для проб с локальным
 * mock-сервером и для корпоративных прокси. По умолчанию Telegram —
 * https://api.telegram.org (Bot API: bot<token>/METHOD), MAX —
 * https://platform-api2.max.ru (заголовок Authorization: <токен>).
 *
 * MAX-вложения: GET /uploads?type=file → {url}; файл POST-ом в этот url →
 * {token}; в сообщении attachment {type, payload: {token}}. Telegram: файлы
 * уходят multipart-ом в sendDocument, текст — JSON-ом в sendMessage.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DT_HOME } from './paths.js';

export const MESSENGERS_FILE = join(DT_HOME, 'messengers.json');

export const TELEGRAM_API = 'https://api.telegram.org';
export const MAX_API = 'https://platform-api2.max.ru';

export interface MessengerAccount {
  token: string;
  api?: string;
}

export interface MessengersConfig {
  telegram?: MessengerAccount;
  max?: MessengerAccount;
  api?: { telegram?: string; max?: string };
}

/** Читает и валидирует messengers.json; нет файла — отказ с примером. */
export function loadMessengers(file = MESSENGERS_FILE): MessengersConfig {
  if (!existsSync(file)) {
    throw new Error(
      `нет файла ${file} — опишите ботов, например:\n` +
      '{ "telegram": { "token": "123456:ABC…" }, "max": { "token": "…" } }\n' +
      'токен Telegram — @BotFather, токен MAX — dev.max.ru (раздел «Чат-боты»)',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} — кривой JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} — ожидается объект`);
  const cfg = raw as Record<string, unknown>;
  for (const key of ['telegram', 'max'] as const) {
    if (cfg[key] === undefined) continue;
    const acc = cfg[key] as Record<string, unknown>;
    const extra = Object.keys(acc).filter((f) => !['token', 'api'].includes(f));
    if (extra.length > 0) {
      throw new Error(`${file}: "${key}" — неизвестные поля ${extra.map((f) => `"${f}"`).join(', ')} (разрешены: "token", "api")`);
    }
    if (!String(acc.token ?? '').trim()) throw new Error(`${file}: "${key}" — пустой "token"`);
  }
  return cfg as unknown as MessengersConfig;
}

/** Аккаунт мессенджера: токен из его блока, api — из блока или из общего "api". */
export function pickMessenger(cfg: MessengersConfig, key: 'telegram' | 'max', defaultApi: string): { token: string; api: string } {
  const acc = cfg[key];
  if (!acc) throw new Error(`в messengers.json нет блока "${key}" — добавьте { "${key}": { "token": "…" } }`);
  return { token: acc.token, api: acc.api ?? cfg.api?.[key] ?? defaultApi };
}

/** Пароль/токен в тексте ошибки не светим. */
function authError(who: string, err: unknown): Error {
  return new Error(`${who} не отвечает: ${err instanceof Error ? err.message : err}`);
}

/** GET JSON с токеном; не-2xx — ошибка с телом. */
export async function apiGet(base: string, path: string, auth?: { header?: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      headers: auth?.header ? { Authorization: auth.header } : {},
      signal: AbortSignal.timeout(35_000),
    });
  } catch (err) {
    throw authError(base, err);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} от ${base}${path}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** POST JSON с токеном. */
export async function apiPost(base: string, path: string, body: unknown, auth?: { header?: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth?.header ? { Authorization: auth.header } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (err) {
    throw authError(base, err);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} от ${base}${path}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Telegram-вызов: bot<token>/METHOD; не ok:true — error_description. */
export async function telegramCall(api: string, token: string, method: string, init?: { body?: unknown; form?: FormData }): Promise<unknown> {
  const url = `${api.replace(/\/+$/, '')}/bot${token}/${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      ...(init?.form
        ? { body: init.form }
        : init?.body
          ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
          : {}),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw authError('Telegram', err);
  }
  const text = await res.text();
  let json: { ok?: boolean; result?: unknown; description?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    /* не JSON — покажем текст как есть */
  }
  if (!res.ok || json.ok === false) {
    throw new Error(`Telegram ${method}: HTTP ${res.status}${json.description ? ` — ${json.description}` : ` — ${text.slice(0, 300)}`}`);
  }
  return json.result ?? json;
}

/** multipart в Telegram: файл в поле document. */
export async function telegramSendFile(api: string, token: string, chatId: string, filePath: string, caption?: string): Promise<unknown> {
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption);
  const data = readFileSync(filePath);
  form.append('document', new Blob([data]), basename(filePath));
  return telegramCall(api, token, 'sendDocument', { form });
}

/** Тело send: строки «файлы: п1, п2» в начале — вложения, остальное — текст. */
export function parseSendText(text: string): { files: string[]; body: string } {
  const lines = text.replace(/^\r?\n/, '').split(/\r?\n/);
  const files: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i]!.match(/^[ \t]*файлы[ \t]*:[ \t]*(.*)$/);
    if (!m) break;
    files.push(...m[1]!.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return { files, body: lines.slice(i).join('\n').trim() };
}

/** Загрузка файла в MAX: /uploads → POST файла → token. */
export async function maxUploadToken(api: string, token: string, kind: 'image' | 'file', filePath: string): Promise<{ type: string; payload: { token: string } }> {
  const up = (await apiGet(api, `/uploads?type=${kind}`, { header: token })) as { url?: string };
  if (!up?.url) throw new Error(`MAX /uploads не вернул url — не могу загрузить ${basename(filePath)}`);
  let res: Response;
  try {
    const form = new FormData();
    form.append('data', new Blob([readFileSync(filePath)]), basename(filePath));
    res = await fetch(up.url, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw authError('MAX uploads', err);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`MAX загрузка файла: HTTP ${res.status} — ${text.slice(0, 200)}`);
  let json: { token?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    /* ниже — внятная ошибка */
  }
  if (!json.token) throw new Error(`MAX загрузка не вернула token (ответ: ${text.slice(0, 200)})`);
  return { type: kind, payload: { token: json.token } };
}
