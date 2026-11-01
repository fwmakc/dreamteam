/**
 * Проба адаптера GigaChat: полный транспорт против локального HTTPS-стаба
 * (свой самоподписанный сертификат подключён через caCertPath — как
 * сертификаты Минцифры, только наш). Проверяются:
 *  - OAuth: Basic из apiKey или пары clientId/clientSecret, RqUID, scope;
 *  - кэш токена: второй запрос без OAuth; обновление за минуту до истечения;
 *  - чат: payload (model/messages/temperature/max_tokens/stream), SSE-разбор;
 *  - usage из потока; тихий рефреш и повтор после 401; ошибки OAuth и HTTP;
 *  - прерывание по signal; insecureTLS; контракт карточки.
 *
 * Герметично: сеть — 127.0.0.1:0 (случайный порт), сертификат из fixtures/.
 * Запуск: npm run probe:gigachat
 */
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { LLMProvider, RoundUsage, StreamRequest } from '../src/types.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const here = dirname(fileURLToPath(import.meta.url));
const certPath = join(here, 'fixtures', 'gigachat-test-cert.pem');

interface Captured { url?: string; auth?: string; rqUid?: string; contentType?: string; body: string }
const captured: Captured[] = [];

/** SSE-ответ чата: кусочки текста + usage в последнем JSON. */
function sseOk(res: ServerResponse, chunks: string[], usage: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const oauthOk = (token: string, expiresInMs: number) => (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ access_token: token, expires_at: Date.now() + expiresInMs }));
};

let oauthResponder: (res: ServerResponse) => void = oauthOk('tok-1', 25 * 60_000);
let chatResponder: (res: ServerResponse) => void = (res) => sseOk(res, ['Привет', ' мир'], { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } });

const server = createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(join(here, 'fixtures', 'gigachat-test-key.pem')) }, (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    captured.push({
      url: req.url,
      auth: req.headers.authorization as string | undefined,
      rqUid: req.headers.rquid as string | undefined,
      contentType: req.headers['content-type'] as string | undefined,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (req.url === '/oauth') oauthResponder(res);
    else if (req.url?.endsWith('/chat/completions')) chatResponder(res);
    else { res.writeHead(404); res.end(); }
  });
});
const port = await new Promise<number>((done) => { server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)); });
const base = `https://127.0.0.1:${port}`;

const { gigachatFactory } = await import('../src/providers/gigachat.js');
const { ConfigurationError } = await import('../src/providers/types.js');

/** Свежий адаптер на стаб: ключ-карточка как из кабинета (уже base64). */
function make(extra: Record<string, unknown> = {}): LLMProvider {
  return gigachatFactory('giga', {
    provider: 'gigachat',
    apiKey: Buffer.from('id:secret').toString('base64'),
    authUrl: `${base}/oauth`,
    baseUrl: `${base}/api/v1`,
    caCertPath: certPath,
    ...extra,
  });
}

async function collect(p: LLMProvider, req: StreamRequest): Promise<{ text: string; usage: RoundUsage }> {
  let text = '';
  let usage: RoundUsage = {};
  for await (const chunk of p.stream(req, (u) => { usage = u; })) text += chunk;
  return { text, usage };
}

function reset(): void {
  captured.length = 0;
  oauthResponder = oauthOk('tok-1', 25 * 60_000);
  chatResponder = (res) => sseOk(res, ['Привет', ' мир'], { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } });
}

const oauths = (): Captured[] => captured.filter((c) => c.url === '/oauth');
const chats = (): Captured[] => captured.filter((c) => c.url?.endsWith('/chat/completions'));

// ── 1. конфигурация ──────────────────────────────────────────────────────────
{
  let threw = '';
  try { gigachatFactory('g', { provider: 'gigachat' }); } catch (e) { threw = String(e); }
  check('конфиг: без ключа — ConfigurationError с подсказкой', threw.includes('apiKey') && threw.includes('models/g.json'), threw);
  let isConfigErr = false;
  try { gigachatFactory('g', { provider: 'gigachat', apiKey: 'x', caCertPath: join(here, 'no-such.pem') }); } catch (e) { threw = String(e); isConfigErr = e instanceof ConfigurationError; }
  check('конфиг: битый caCertPath — ConfigurationError', isConfigErr && threw.includes('не удалось прочитать сертификат'), threw);

  const { contract } = await import('../src/providers/gigachat.js');
  check('контракт: все заявленные ключи описаны', ['apiKey', 'clientId', 'clientSecret', 'scope', 'baseUrl', 'authUrl', 'caCertPath', 'insecureTLS', 'vision', 'model', 'maxTokens', 'contextWindow', 'temperature'].every((k) => k in contract.keys), JSON.stringify(Object.keys(contract.keys)));
  check('контракт: ref — temperature и maxTokens', JSON.stringify(contract.ref) === '["temperature","maxTokens"]', JSON.stringify(contract.ref));
}

// ── 2. счастливый путь: OAuth → чат → SSE + usage ───────────────────────────
{
  reset();
  const p = make();
  const { text, usage } = await collect(p, { system: 'Ты робот', messages: [{ role: 'user', content: 'привет' }] });
  check('поток: кусочки собраны по порядку', text === 'Привет мир', text);
  check('usage: токены из потока с кэшем', usage.promptTokens === 10 && usage.outputTokens === 5 && usage.cachedTokens === 3, JSON.stringify(usage));

  const o = oauths()[0]!;
  check('oauth: Basic из ключа-карточки', o.auth === `Basic ${Buffer.from('id:secret').toString('base64')}`, o.auth);
  check('oauth: RqUID и форма', Boolean(o.rqUid) && o.contentType === 'application/x-www-form-urlencoded' && o.body === 'scope=GIGACHAT_API_PERS', JSON.stringify({ rqUid: o.rqUid, body: o.body }));

  const c = chats()[0]!;
  check('чат: Bearer полученного токена', c.auth === 'Bearer tok-1', c.auth);
  const payload = JSON.parse(c.body) as Record<string, unknown>;
  check('чат: дефолты payload', payload.model === 'GigaChat' && payload.temperature === 0.7 && payload.max_tokens === 1024 && payload.stream === true, c.body.slice(0, 120));
  const messages = payload.messages as { role: string; content: string }[];
  check('чат: system первым, вопрос следом', messages[0]?.role === 'system' && messages[0]?.content === 'Ты робот' && messages[1]?.content === 'привет', JSON.stringify(messages));

  const before = captured.length;
  await collect(p, { messages: [{ role: 'user', content: 'ещё' }] });
  check('кэш токена: второй чат без OAuth', oauths().length === 1 && captured.length === before + 1, `oauth=${oauths().length} запросов=${captured.length - before}`);
}

// ── 3. пара clientId/clientSecret, свой scope/model/maxTokens ───────────────
{
  reset();
  const p = make({ apiKey: undefined, clientId: 'cid', clientSecret: 'csecret', scope: 'GIGACHAT_API_BIZ', model: 'GigaChat-2', maxTokens: 77 });
  await collect(p, { messages: [{ role: 'user', content: 'x' }], temperature: 0.2 });
  check('пара: Basic построен из id/secret', oauths()[0]!.auth === `Basic ${Buffer.from('cid:csecret').toString('base64')}`, oauths()[0]!.auth);
  check('пара: свой scope в OAuth', oauths()[0]!.body === 'scope=GIGACHAT_API_BIZ', oauths()[0]!.body);
  const payload = JSON.parse(chats()[0]!.body) as Record<string, unknown>;
  check('пара: свой model/maxTokens и температура запроса', payload.model === 'GigaChat-2' && payload.max_tokens === 77 && payload.temperature === 0.2, chats()[0]!.body.slice(0, 120));
}

// ── 4. обновление токена за минуту до истечения ─────────────────────────────
{
  reset();
  oauthResponder = oauthOk('tok-short', 10_000); // живёт меньше минуты — каждый ход обновляет
  const p = make();
  await collect(p, { messages: [{ role: 'user', content: '1' }] });
  await collect(p, { messages: [{ role: 'user', content: '2' }] });
  check('маржа: короткий токен обновляется перед каждым ходом', oauths().length === 2 && chats().every((c) => c.auth === 'Bearer tok-short'), `oauth=${oauths().length}`);
}

// ── 5. 401 от чата: тихий рефреш и повтор ───────────────────────────────────
{
  reset();
  let with401 = true;
  oauthResponder = oauthOk('tok-new', 25 * 60_000);
  chatResponder = (res) => {
    if (with401) { with401 = false; res.writeHead(401); res.end('токен устарел'); }
    else sseOk(res, ['после рефреша'], {});
  };
  const p = make();
  const { text } = await collect(p, { messages: [{ role: 'user', content: 'x' }] });
  check('401: ответ получен после рефреша', text === 'после рефреша', text);
  check('401: OAuth дважды, чат дважды, второй Bearer свежий', oauths().length === 2 && chats().length === 2 && chats()[1]!.auth === 'Bearer tok-new', `oauth=${oauths().length} chat=${chats().length} ${chats()[1]!.auth}`);
}

// ── 6. ошибки: HTTP чата, OAuth ─────────────────────────────────────────────
{
  reset();
  chatResponder = (res) => { res.writeHead(500); res.end('бах'); };
  let err = '';
  try { await collect(make(), { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = String(e); }
  check('чат: HTTP 500 наружу с деталью', err.includes('HTTP 500') && err.includes('бах'), err);

  reset();
  oauthResponder = (res) => { res.writeHead(401); res.end('ключ плохой'); };
  err = '';
  try { await collect(make(), { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = String(e); }
  check('oauth: HTTP 401 наружу', err.includes('OAuth GigaChat: HTTP 401') && err.includes('ключ плохой'), err);

  reset();
  oauthResponder = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>не то</html>'); };
  err = '';
  try { await collect(make(), { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = String(e); }
  check('oauth: мусор в ответе — разбор честно падает', err.includes('не удалось разобрать'), err);

  reset();
  oauthResponder = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"expires_at":1}'); };
  err = '';
  try { await collect(make(), { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = String(e); }
  check('oauth: без access_token — ошибка', err.includes('не удалось разобрать'), err);
}

// ── 7. прерывание и insecureTLS ─────────────────────────────────────────────
{
  reset();
  const ac = new AbortController();
  ac.abort();
  let err = '';
  try { await collect(make(), { messages: [{ role: 'user', content: 'x' }], signal: ac.signal }); } catch (e) { err = String(e); }
  check('прерывание: Esc до запроса — «прервано (Esc)»', err.includes('прервано'), err);

  reset();
  const insecure = make({ caCertPath: undefined, insecureTLS: true });
  const { text } = await collect(insecure, { messages: [{ role: 'user', content: 'x' }] });
  check('insecureTLS: транспорт живёт и без caCertPath', text === 'Привет мир', text);
}

await new Promise<void>((done) => server.close(() => done()));
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
