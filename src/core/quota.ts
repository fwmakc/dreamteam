import type { LLMProvider, ProviderQuota, QuotaWindow } from '../types.js';

/**
 * Универсальный слой квот поверх необязательного provider.quota(): TTL-кеш по
 * id модели (инстансы провайдера пересоздаются фабрикой на каждый раунд —
 * кешировать по объекту нельзя). Потребители — статус-бар TUI и снапшот serve:
 * опрос фоновый, не чаще TTL; сбой сети гасится протухшим кешем в пределах
 * grace, потом null («лимитов нет») — индикатор просто исчезает.
 */

const DEFAULT_TTL_MS = 60_000;
const STALE_GRACE_MS = 10 * 60_000;

interface CacheEntry {
  quota: ProviderQuota;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProviderQuota | null>>();

export interface FetchQuotaOpts {
  /** сколько валиден свежий опрос (по умолчанию 60 с) */
  ttlMs?: number;
  /** опросить despite свежего кеша (результат всё равно попадёт в кеш) */
  force?: boolean;
}

/**
 * Опрашивает provider.quota() с кешированием. Нет метода — null без запроса.
 * Ошибка адаптера (сеть, 401) — протухший кеш в пределах grace, иначе null.
 */
export async function fetchQuota(
  provider: LLMProvider,
  opts: FetchQuotaOpts = {},
): Promise<ProviderQuota | null> {
  if (typeof provider.quota !== 'function') return null;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const entry = cache.get(provider.id);
  if (!opts.force && entry && Date.now() - entry.at < ttl) return entry.quota;
  const pending = inflight.get(provider.id);
  if (pending) return pending;
  const query = (async (): Promise<ProviderQuota | null> => {
    try {
      const quota = await provider.quota!();
      if (quota) cache.set(provider.id, { quota, at: Date.now() });
      return quota;
    } catch {
      return null; // адаптеры сами гасят ошибки, но перестрахуемся
    } finally {
      inflight.delete(provider.id);
    }
  })();
  inflight.set(provider.id, query);
  const fresh = await query;
  if (fresh) return fresh;
  if (entry && Date.now() - entry.at < STALE_GRACE_MS) return entry.quota;
  return null;
}

/** Кеш без сетевых вызовов — для синхронной отрисовки статус-баров. */
export function cachedQuota(id: string): ProviderQuota | null {
  return cache.get(id)?.quota ?? null;
}

/** Сброс кеша — герметичным пробам (и смене дома в тестах). */
export function resetQuotaCache(): void {
  cache.clear();
  inflight.clear();
}

/** Окно с минимальным остатком — кандидат на «самое горящее» в UI. */
export function worstWindow(quota: ProviderQuota): QuotaWindow | null {
  let worst: QuotaWindow | null = null;
  for (const w of quota.windows) {
    if (!worst || 100 - w.usedPercent < 100 - worst.usedPercent) worst = w;
  }
  return worst;
}
