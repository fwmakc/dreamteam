import type { LLMProvider, ProviderQuota, QuotaWindow } from '../types.js';
import { ConfigurationError } from './types.js';
import type { AdapterContract, ProviderConfig, ProviderFactory } from './types.js';
import { anthropicFactory } from './anthropic.js';
import { num, withTimeout } from './utils.js';

const DEFAULT_API_BASE = 'https://api.z.ai/api/anthropic';
const DEFAULT_MONITOR_BASE = 'https://api.z.ai';
const MONITOR_TIMEOUT_MS = 10_000;

/** Контракт карточки models/<id>.json для адаптера zai-coding-plan. */
export const contract: AdapterContract = {
  keys: {
    apiKey: { type: 'string', desc: 'ключ Z.ai coding plan (нет ключа — статус «не настроен»)' },
    model: { type: 'string', desc: 'по умолчанию glm-5-turbo' },
    baseUrl: { type: 'string', desc: 'по умолчанию https://api.z.ai/api/anthropic' },
    monitorUrl: { type: 'string', desc: 'база монитор-эндпоинтов квот (по умолчанию https://api.z.ai)' },
    maxTokens: { type: 'number', desc: 'потолок ответа (по умолчанию 2048)' },
    contextWindow: { type: 'number', desc: 'Размер контекстного окна (токены)' },
    temperature: { type: 'number' },
    thinking: { type: 'string', enum: ['enabled', 'disabled'], desc: 'размышления GLM (биллятся)' },
    cache: { type: 'boolean', desc: 'кэш промптов (по умолчанию включён)' },
    vision: { type: 'boolean', desc: 'модель видит картинки — тулу look (glm-4.6v, Qwen-VL…)' },
  },
  ref: ['temperature', 'maxTokens'],
};

/**
 * Отдельный провайдер GLM Coding Plan от Z.ai: тот же транспорт, что у
 * anthropic-адаптера (endpoint /v1/messages, x-api-key, SSE, кэш промптов),
 * но свой дефолт адреса, метка kind и метод quota() — статистика лимитов
 * тарифа из статус-бара (5-часовое окно, недельное, MCP-вызовы).
 *
 * КВОТА: эндпоинты /api/monitor/usage/* — НЕ задокументированы Z.AI
 * (docs.z.ai знает только биллинг в личном кабинете); формат снят с живого
 * API и может измениться без предупреждения — любая ошибка гасится в null.
 * Авторизация в экосистеме встречается в двух вариантах (с Bearer и без),
 * поэтому сперва пробуем Bearer, при отказе повторяем «голым» ключом.
 */
export const zaiCodingPlanFactory: ProviderFactory = (
  id: string,
  config: ProviderConfig,
): LLMProvider => {
  const apiKey = config.apiKey ? String(config.apiKey).trim() : '';
  if (!apiKey) {
    throw new ConfigurationError(
      `в карточке провайдера «${id}» нет "apiKey" — впиши ключ Z.ai coding plan в карточку models/${id}.json`,
    );
  }
  const monitorUrl = String(config.monitorUrl ?? DEFAULT_MONITOR_BASE).replace(/\/+$/, '');
  const base = anthropicFactory(id, { ...config, baseUrl: config.baseUrl ?? DEFAULT_API_BASE });
  return { ...base, kind: 'zai-coding-plan', quota: () => fetchQuota(monitorUrl, apiKey) };
};

// ── монитор квот: GET /api/monitor/usage/quota/limit ────────────────────────

type MonitorReply = {
  code?: number;
  success?: boolean;
  data?: { limits?: unknown; level?: unknown };
};

/** Одна запись limits[] ответа монитора (поля сняты с живого API). */
interface MonitorLimit {
  type?: unknown;
  /** окно лимита: 3 — 5 часов, 6 — неделя, 7 — месяц */
  unit?: unknown;
  /** весь лимит окна (в кредитах/токенах/вызовах) */
  usage?: unknown;
  /** использовано */
  currentValue?: unknown;
  remaining?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

/** Имена окон в порядке показа в статус-баре. */
const WINDOW_ORDER = ['5h', 'week', 'month', 'mcp'];

const UNIT_TO_KEY: Record<number, string> = { 3: '5h', 6: 'week', 7: 'month' };

type FetchResult = { ok: true; body: MonitorReply } | { ok: false };

async function fetchMonitor(monitorUrl: string, apiKey: string, useBearer: boolean): Promise<FetchResult> {
  try {
    const res = await fetch(`${monitorUrl}/api/monitor/usage/quota/limit`, {
      headers: {
        authorization: useBearer ? `Bearer ${apiKey}` : apiKey,
        accept: 'application/json',
      },
      signal: withTimeout(undefined, MONITOR_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    return { ok: true, body: (await res.json()) as MonitorReply };
  } catch {
    return { ok: false }; // сеть/таймаут/не-JSON — квоты просто нет
  }
}

/** epoch-миллисекунды из числа/строки (сервер шлёт ms, изредка сек. или ISO). */
function toEpochMs(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function windowOf(limit: MonitorLimit): QuotaWindow | null {
  const used = num(limit.percentage) ?? usedFromCounts(limit);
  if (used === undefined) return null;
  const resetAt = toEpochMs(limit.nextResetTime);
  const type = String(limit.type ?? '');
  if (type === 'TIME_LIMIT') {
    // квота вызовов тулов/MCP — отдельный счётчик с месячным сбросом
    return { key: 'mcp', kind: 'calls', usedPercent: clamp(used), resetAt, ...counts(limit) };
  }
  const unit = num(limit.unit);
  const key = unit !== undefined ? (UNIT_TO_KEY[unit] ?? `u${unit}`) : '5h'; // до поля unit окно был 5-часовой
  const kind: QuotaWindow['kind'] = type === 'CREDIT_LIMIT' ? 'credits' : 'tokens';
  return { key, kind, usedPercent: clamp(used), resetAt, ...counts(limit) };
}

/** percentage нет в ответе — считаем из usage/currentValue/remaining. */
function usedFromCounts(limit: MonitorLimit): number | undefined {
  const total = num(limit.usage);
  const used = num(limit.currentValue);
  if (total && total > 0 && used !== undefined) return Math.round((used / total) * 100);
  const remaining = num(limit.remaining);
  if (total && total > 0 && remaining !== undefined) return Math.round(((total - remaining) / total) * 100);
  return undefined;
}

/** Абсолютные значения окна, если сервер их прислал. */
function counts(limit: MonitorLimit): Pick<QuotaWindow, 'limit' | 'remaining'> {
  const out: Pick<QuotaWindow, 'limit' | 'remaining'> = {};
  const total = num(limit.usage);
  const remaining = num(limit.remaining);
  if (total !== undefined) out.limit = total;
  if (remaining !== undefined) out.remaining = remaining;
  return out;
}

function clamp(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function parseQuota(body: MonitorReply): ProviderQuota | null {
  const limits = body.data?.limits;
  if (!Array.isArray(limits)) return null;
  const windows = limits
    .filter((x): x is MonitorLimit => Boolean(x) && typeof x === 'object')
    .map(windowOf)
    .filter((w): w is QuotaWindow => w !== null)
    .sort((a, b) => {
      const ia = WINDOW_ORDER.indexOf(a.key);
      const ib = WINDOW_ORDER.indexOf(b.key);
      return (ia === -1 ? WINDOW_ORDER.length : ia) - (ib === -1 ? WINDOW_ORDER.length : ib);
    });
  const plan = typeof body.data?.level === 'string' ? body.data.level : undefined;
  return { plan, windows, fetchedAt: Date.now() };
}

/** Опрос монитора: Bearer → (при отказе авторизации) голый ключ → parse. Любая беда — null. */
async function fetchQuota(monitorUrl: string, apiKey: string): Promise<ProviderQuota | null> {
  let res = await fetchMonitor(monitorUrl, apiKey, true);
  if (res.ok && res.body.code === 401) res = await fetchMonitor(monitorUrl, apiKey, false);
  if (!res.ok) return null;
  return parseQuota(res.body);
}
