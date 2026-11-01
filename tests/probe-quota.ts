/**
 * Проба квот провайдера: необязательный метод LLMProvider.quota() и слой
 * src/core/quota.ts поверх него.
 *  - контракт: QuotaWindow/ProviderQuota в типах, quota отсутствует у «плоских»
 *    провайдеров — fetchQuota отвечает null без сетевого вызова;
 *  - zai-coding-plan: монитор /api/monitor/usage/quota/limit размечается в
 *    окна 5h/week/mcp (unit 3/6, TIME_LIMIT), план, resetAt, порядок показа;
 *  - авторизация монитора: сперва «Bearer <ключ>», при code:401 — повтор
 *    «голым» ключом (недокументированный эндпоинт — встречаются оба);
 *  - транспорт: POST /v1/messages с x-api-key и anthropic-version, thinking
 *    из карточки уходит в тело, SSE стримится, usage доходит до onUsage;
 *  - fetchQuota: TTL-кеш по id, force игнорирует кеш, сбой сети отдаёт
 *    протухшее в пределах grace; сброс — resetQuotaCache;
 *  - quotaBar/worstWindow: остаток в %, цвет по самому низкому окну;
 *  - mock: демо-квота без настоящих API.
 *
 * Герметично: всё на локальном http-сервере 127.0.0.1, дом не трогается.
 * Запуск: npm run probe:quota
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchQuota, cachedQuota, resetQuotaCache, worstWindow } from '../src/core/quota.js';
import { quotaBar } from '../src/ui.js';
import { MockProvider } from '../src/providers/mock.js';
import { zaiCodingPlanFactory } from '../src/providers/zai-coding-plan.js';
import type { LLMProvider, ProviderQuota } from '../src/types.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

// ── локальный монитор: каноничный ответ /api/monitor/usage/quota/limit ───────

interface Hit {
  url: string;
  method: string;
  auth: string;
  xApiKey: string;
  anthropicVersion: string;
  body: string;
}

/** Ответ монитора в зависимости от сценария: null — ответить 500. */
let monitorReply: ((req: IncomingMessage, body: string) => unknown | null) | null = null;
const hits: Hit[] = [];

const CANNED = {
  code: 200,
  success: true,
  data: {
    level: 'pro',
    // mcp первым — проверяем сортировку показа (5h, week, month, mcp)
    limits: [
      { type: 'TIME_LIMIT', unit: 5, usage: 100, currentValue: 12, remaining: 88, percentage: 12, nextResetTime: 1793600000000 },
      { type: 'CREDIT_LIMIT', unit: 3, usage: 12000, currentValue: 360, remaining: 11640, percentage: 3, nextResetTime: '2026-11-01T22:20:00+08:00' },
      { type: 'CREDIT_LIMIT', unit: 6, usage: 60000, currentValue: 11400, remaining: 48600, percentage: 19, nextResetTime: 1793600000 },
    ],
  },
};

const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
  req.on('end', () => {
    hits.push({
      url: req.url ?? '',
      method: req.method ?? '',
      auth: String(req.headers.authorization ?? ''),
      xApiKey: String(req.headers['x-api-key'] ?? ''),
      anthropicVersion: String(req.headers['anthropic-version'] ?? ''),
      body: raw,
    });
    if (req.url?.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4}}}\n\n');
      res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Привет"}}\n\n');
      res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":15,"output_tokens":16}}\n\n');
      res.write('data: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }
    const reply = monitorReply ? monitorReply(req, raw) : CANNED;
    if (reply === null) { // сценарий «сервер лёг»
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"code":500,"msg":"boom"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

// ── 1. маппинг монитора: окна, план, resetAt, порядок ────────────────────────
resetQuotaCache();
hits.length = 0;
{
  const p = zaiCodingPlanFactory('glm', { provider: 'zai-coding-plan', apiKey: 'sk-zai', monitorUrl: base });
  check('kind адаптера — zai-coding-plan', p.kind === 'zai-coding-plan', p.kind);
  const q = await fetchQuota(p); // через общий слой — заодно наполняет кеш
  check('квота размечена', q !== null && q.windows.length === 3, JSON.stringify(q));
  const keys = (q?.windows ?? []).map((w) => w.key).join(',');
  check('порядок окон 5h,week,mcp (mcp из середины ответа)', keys === '5h,week,mcp', keys);
  const five = q?.windows.find((w) => w.key === '5h');
  check('5h: использовано 3%', five?.usedPercent === 3, JSON.stringify(five));
  check('5h: кредиты + остаток из ответа', five?.kind === 'credits' && five?.limit === 12000 && five?.remaining === 11640, JSON.stringify(five));
  check('5h: resetAt из ISO-строки', typeof five?.resetAt === 'number' && five.resetAt! > 1_700_000_000_000, String(five?.resetAt));
  const week = q?.windows.find((w) => w.key === 'week');
  check('week: resetAt из epoch-секунд → мс', week?.resetAt === 1_793_600_000_000, String(week?.resetAt));
  check('week: использовано 19%', week?.usedPercent === 19, JSON.stringify(week));
  const mcp = q?.windows.find((w) => w.key === 'mcp');
  check('mcp: TIME_LIMIT → окно вызовов', mcp?.kind === 'calls' && mcp?.usedPercent === 12, JSON.stringify(mcp));
  check('план из data.level', q?.plan === 'pro', q?.plan);
  check('fetchedAt проставлен', typeof q?.fetchedAt === 'number' && Math.abs(Date.now() - q.fetchedAt) < 5_000);
  check('монитор ходит с Bearer-ключом', hits[0]?.auth === 'Bearer sk-zai', hits[0]?.auth);
  check('кеш заполнен по id', cachedQuota('glm')?.plan === 'pro');
}

// ── 2. авторизация: Bearer отвергнут (code:401) → повтор «голым» ключом ─────
resetQuotaCache();
hits.length = 0;
{
  monitorReply = (_req, _body) => {
    // сервер-двойник: с Bearer — отказ как у живого API (HTTP 200, code 401), без — ответ
    return _req.headers.authorization === 'Bearer sk-zai' ? { code: 401, msg: 'token expired or incorrect', success: false } : CANNED;
  };
  const p = zaiCodingPlanFactory('glm', { provider: 'zai-coding-plan', apiKey: 'sk-zai', monitorUrl: base });
  const q = await p.quota!();
  check('после 401 повтор «голым» ключом — квота есть', q?.windows.length === 3, JSON.stringify(q));
  check('два запроса: Bearer, затем голый', hits.length === 2 && hits[0].auth === 'Bearer sk-zai' && hits[1].auth === 'sk-zai', hits.map((h) => h.auth).join(' | '));
  monitorReply = null;
}

// ── 3. транспорт: POST /v1/messages, x-api-key, thinking, SSE, usage ─────────
resetQuotaCache();
hits.length = 0;
{
  const p = zaiCodingPlanFactory('glm', {
    provider: 'zai-coding-plan',
    apiKey: 'sk-zai',
    baseUrl: base, // транспорт — на локальный сервер
    monitorUrl: base,
    thinking: 'enabled',
  });
  const usage: { promptTokens?: number; outputTokens?: number; cachedTokens?: number } = {};
  let text = '';
  for await (const chunk of p.stream({ messages: [{ role: 'user', content: 'привет' }] }, (u) => {
    usage.promptTokens = u.promptTokens;
    usage.outputTokens = u.outputTokens;
    usage.cachedTokens = u.cachedTokens;
  })) {
    text += chunk;
  }
  check('стрим антропосовместимого эндпоинта собран', text === 'Привет', text);
  check('usage: input/output из message_delta (форма z.ai)', usage.promptTokens === 19 && usage.outputTokens === 16, JSON.stringify(usage));
  check('кэш-чтение из message_start в cachedTokens', usage.cachedTokens === 4, JSON.stringify(usage));
  const msg = hits.find((h) => h.url === '/v1/messages');
  check('запрос на /v1/messages', msg !== undefined);
  check('ключ в x-api-key + anthropic-version', msg?.xApiKey === 'sk-zai' && msg?.anthropicVersion === '2023-06-01', `${msg?.xApiKey} / ${msg?.anthropicVersion}`);
  const body = JSON.parse(msg!.body) as {
    model?: unknown;
    thinking?: { type?: unknown };
    max_tokens?: unknown;
  };
  check('thinking из карточки ушёл в тело', body.thinking?.type === 'enabled', JSON.stringify(body.thinking));
  check('max_tokens обязателен (антропо-формат)', typeof body.max_tokens === 'number');
}

// ── 4. сбои: 500 и не-JSON — quota() гасится в null ──────────────────────────
resetQuotaCache();
{
  monitorReply = () => null;
  const p = zaiCodingPlanFactory('glm', { provider: 'zai-coding-plan', apiKey: 'sk-zai', monitorUrl: base });
  check('HTTP 500 → null', (await p.quota!()) === null);
  monitorReply = (_req, _b) => '<html>not json</html>';
  check('не-JSON → null', (await p.quota!()) === null);
  monitorReply = () => ({ code: 200, success: true, data: {} });
  check('ответ без limits → null', (await p.quota!()) === null);
  monitorReply = null;
  let threw = false;
  try {
    zaiCodingPlanFactory('glm', { provider: 'zai-coding-plan' });
  } catch (err) {
    threw = err instanceof Error && /apiKey/.test(err.message);
  }
  check('без ключа — ConfigurationError', threw);
}

// ── 5. fetchQuota: TTL-кеш, force, stale при сбое, провайдер без quota ───────
resetQuotaCache();
hits.length = 0;
{
  const p = zaiCodingPlanFactory('glm', { provider: 'zai-coding-plan', apiKey: 'sk-zai', monitorUrl: base });
  const first = await fetchQuota(p);
  check('первый опрос — сетевой', hits.length === 1 && first !== null);
  await fetchQuota(p);
  check('в пределах TTL — из кеша, сервер не дёргается', hits.length === 1);
  const forced = await fetchQuota(p, { force: true });
  check('force — новый опрос', hits.length === 2 && forced !== null);
  monitorReply = () => null; // сервер «лёг»
  const stale = await fetchQuota(p, { force: true });
  check('сбой сети — протухший кеш в пределах grace', stale !== null && stale.plan === 'pro', JSON.stringify(stale));
  monitorReply = null;
  const flat: LLMProvider = { id: 'flat', kind: 'mock', model: 'x', async *stream() {} }; // без quota()
  check('нет метода quota — null без запроса', (await fetchQuota(flat)) === null && hits.length === 3);
}

// ── 6. quotaBar/worstWindow: остаток и цвет по самому низкому ────────────────
{
  const quota: ProviderQuota = {
    plan: 'pro',
    windows: [
      { key: '5h', kind: 'tokens', usedPercent: 27 },
      { key: 'week', kind: 'tokens', usedPercent: 41 },
      { key: 'mcp', kind: 'calls', usedPercent: 88 },
    ],
    fetchedAt: Date.now(),
  };
  check('worstWindow — минимум остатка', worstWindow(quota)?.key === 'mcp');
  const bar = quotaBar(quota);
  check('квотбар: остаток в %, метки окон', bar.includes('Q 5ч 73% · нед 59% · mcp 12%'), JSON.stringify(bar));
  const bad = quotaBar({ plan: 'pro', windows: [{ key: '5h', kind: 'tokens', usedPercent: 95 }], fetchedAt: 0 });
  check('квотбар: <20% — красный (picocolors гаснет без TTY — проверяем текст)', bad.includes('5ч 5%'), JSON.stringify(bad));
}

// ── 7. mock: демо-квота без настоящих API ────────────────────────────────────
{
  const mock = new MockProvider('mock');
  const q = await mock.quota!();
  check('mock.quota: три окна, план demo', q?.plan === 'demo' && q.windows.length === 3, JSON.stringify(q));
  check('mock через fetchQuota тоже виден', (await fetchQuota(mock))?.plan === 'demo');
}

// keep-alive сокеты undici держат цикл событий: рвём их до закрытия
server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
console.log(fails === 0 ? '\nпроба квот: всё ок' : `\nпроба квот: провалов ${fails}`);
// не process.exit: он на Windows роняет процесс ассертом libuv, пока ручки
// закрываются; exitCode + естественный drain цикла событий — как в probe-web
process.exitCode = fails === 0 ? 0 : 1;
