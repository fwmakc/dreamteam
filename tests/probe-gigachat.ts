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
  check('конфиг: без ключа — ConfigurationError с подсказкой', threw.includes('apiKey') && threw.includes('clientId'), threw);
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

  // файл с цепочкой (несколько PEM-блоков, как root+sub у gu-st.ru): Node из
  // одной multi-cert строки берёт в доверие только последний сертификат —
  // адаптер обязан разрезать файл и передавать блоки массивом (бой это поймал)
  reset();
  const { writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const chainCert = join(tmpdir(), 'gigachat-probe-chain.pem');
  writeFileSync(chainCert, readFileSync(certPath, 'utf8') + readFileSync(certPath, 'utf8'));
  const chained = make({ caCertPath: chainCert });
  const { text: chainText } = await collect(chained, { messages: [{ role: 'user', content: 'x' }] });
  check('caCertPath: файл-цепочка (2 PEM-блока) работает', chainText === 'Привет мир', chainText);
}

// ── 8. нативный function calling: запрос ────────────────────────────────────
// Тулы агента как ToolSpec (те же собирает functionSpecs из actions.ts).
const toolsSpec = [
  { name: 'run', description: 'Команда локальной оболочки.', parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] } },
  { name: 'file', description: 'Записать файл.', parameters: { type: 'object', properties: { arg: { type: 'string' }, body: { type: 'string' }, project: { type: 'string' } }, required: ['arg', 'body'] } },
];
const jsonOk = (obj: unknown) => (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
{
  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: 'Привет' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  const p = make();
  await collect(p, {
    system: 'Ты робот',
    messages: [{ role: 'user', content: 'покажи контейнеры' }],
    tools: toolsSpec,
  });
  const payload = JSON.parse(chats()[0]!.body) as Record<string, unknown>;
  check('функции: stream:false, function_call:auto', payload.stream === false && payload.function_call === 'auto', chats()[0]!.body.slice(0, 160));
  const fns = payload.functions as { name: string; description: string; parameters: Record<string, unknown> }[];
  check('функции: обе переданы, имена/схемы без искажений', fns.length === 2 && fns[0]!.name === 'run' && fns[1]!.name === 'file' && fns[0]!.parameters.type === 'object', JSON.stringify(fns));
  const msgs = payload.messages as { role: string; content: string | null }[];
  check('функции: system первым', msgs[0]?.role === 'system' && msgs[0]?.content === 'Ты робот', JSON.stringify(msgs));
}

// ── 9. function_call из ответа → тул-блок движка ────────────────────────────
{
  reset();
  chatResponder = jsonOk({
    choices: [{ message: { role: 'assistant', content: null, function_call: { name: 'run', arguments: { body: 'docker ps' } } }, finish_reason: 'function_call' }],
    usage: { prompt_tokens: 30, completion_tokens: 12 },
  });
  const p = make();
  const { text, usage } = await collect(p, { messages: [{ role: 'user', content: 'x' }], tools: toolsSpec });
  check('вызов: конвертирован в тул-блок ```run', text === '```run docker ps\n```', JSON.stringify(text));
  check('вызов: usage из полного ответа', usage.promptTokens === 30 && usage.outputTokens === 12, JSON.stringify(usage));

  // блок действительно понимается движком: parseActions вытаскивает действие
  const { parseActions } = await import('../src/actions.js');
  const actions = parseActions(text, ['run']);
  check('вызов: блок разбирается движком', actions.length === 1 && actions[0]!.kind === 'run' && actions[0]!.command === 'docker ps', JSON.stringify(actions));
}

// ── 10. аргументы строкой и мусором ─────────────────────────────────────────
{
  const p = make();
  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: null, function_call: { name: 'file', arguments: '{"project":"shop","arg":"a/b.txt","body":"привет"}' } }, finish_reason: 'function_call' }] });
  const { text } = await collect(p, { messages: [{ role: 'user', content: 'x' }], tools: toolsSpec });
  check('строка-JSON аргументов: блок file с префиксом проекта', text === '```file shop:a/b.txt\nпривет\n```', JSON.stringify(text));

  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: 'Смотрю.', function_call: { name: 'run', arguments: 'ls -la' } } }] });
  const { text: text2 } = await collect(p, { messages: [{ role: 'user', content: 'x' }], tools: toolsSpec });
  check('мусор-аргументы: текст реплики + блок с командой в body', text2 === 'Смотрю.\n\n```run ls -la\n```', JSON.stringify(text2));

  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: null, function_call: { name: 'restart_server', arguments: { cmd: 'x' } } } }] });
  const { text: text3 } = await collect(p, { messages: [{ role: 'user', content: 'x' }], tools: toolsSpec });
  check('неизвестная функция: текст-предупреждение вместо блока', text3.includes('неизвестную функцию «restart_server»') && !text3.includes('```'), text3);

  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: 'Просто отвечаю текстом.' }, finish_reason: 'stop' }] });
  const { text: text4 } = await collect(p, { messages: [{ role: 'user', content: 'x' }], tools: toolsSpec });
  check('ответ без вызова: обычный текст, блоков нет', text4 === 'Просто отвечаю текстом.', text4);
}

// ── 11. история: пара «блок → результаты» в нативные роли ───────────────────
{
  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: 'Готово.' }, finish_reason: 'stop' }] });
  const p = make();
  await collect(p, {
    messages: [
      { role: 'user', content: 'Пользователь: собери статус' },
      { role: 'user', content: 'Глеб: ```run\ndocker ps\n```' },
      { role: 'user', content: '⚙ Результаты твоих действий:\n✅ CONTAINER ID …' },
      { role: 'user', content: 'Модератор передаёт слово тебе. Ответь по существу.' },
    ],
    tools: toolsSpec,
  });
  const msgs = (JSON.parse(chats()[0]!.body) as { messages: { role: string; content: string | null; name?: string; function_call?: { name?: string; arguments?: unknown } }[] }).messages;
  check('история: 4 сообщения (пара стала нативной, соседи на месте)', msgs.length === 4, JSON.stringify(msgs));
  check('история: assistant с function_call на месте блока', msgs[1]?.role === 'assistant' && msgs[1]?.content === '' && msgs[1]?.function_call?.name === 'run', JSON.stringify(msgs[1]));
  check('история: аргументы функции из блока (объект по схеме)', typeof msgs[1]?.function_call?.arguments === 'object' && JSON.stringify(msgs[1]!.function_call!.arguments) === '{"body":"docker ps"}', String(msgs[1]?.function_call?.arguments));
  let funcResult: unknown;
  try {
    funcResult = JSON.parse(msgs[2]?.content ?? '');
  } catch {
    funcResult = null;
  }
  check('история: роль function с результатом сразу за вызовом', msgs[2]?.role === 'function' && msgs[2]?.name === 'run' && typeof msgs[2]?.content === 'string' && funcResult !== null && (funcResult as { result?: unknown }).result === '✅ CONTAINER ID …', JSON.stringify(msgs[2]));
  check('история: соседние user-сообщения не тронуты', msgs[0]?.role === 'user' && msgs[3]?.role === 'user', JSON.stringify([msgs[0], msgs[3]]));

  // пример ```run в разговоре (не вызов: после него нет результатов) остаётся текстом
  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: 'ок' } }] });
  await collect(p, {
    messages: [
      { role: 'user', content: 'Глеб: вот пример:\n```run\ndocker ps\n```\nработает так' },
      { role: 'user', content: 'Яна: поняла' },
    ],
    tools: toolsSpec,
  });
  const msgs2 = (JSON.parse(chats()[0]!.body) as { messages: { role: string }[] }).messages;
  check('история: пример блока без результатов остаётся user (склеен)', msgs2.length === 1 && msgs2[0]?.role === 'user', JSON.stringify(msgs2));
}

// ── 11b. functions_state_id: с живого ответа → в replay (проверено боем:
// без id модель продолжает разговор сломанно — мусор или повторный вызов) ───
{
  const p = make();
  // раунд A: модель вызывает run, сервер возвращает свой идентификатор
  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: null, function_call: { name: 'run', arguments: { body: 'docker ps' } }, functions_state_id: 'sid-1' }, finish_reason: 'function_call' }] });
  await collect(p, { messages: [{ role: 'user', content: 'Пользователь: собери статус' }], tools: toolsSpec });
  // раунд B: та же пара «блок → результаты» в истории — replay несёт id
  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: 'Готово.' }, finish_reason: 'stop' }] });
  await collect(p, {
    messages: [
      { role: 'user', content: 'Пользователь: собери статус' },
      { role: 'user', content: 'Глеб: ```run\ndocker ps\n```' },
      { role: 'user', content: '⚙ Результаты твоих действий:\n✅ CONTAINER ID …' },
      { role: 'user', content: 'Прочитай результат и ответь.' },
    ],
    tools: toolsSpec,
  });
  const msgs = (JSON.parse(chats()[0]!.body) as { messages: { role: string; functions_state_id?: string; function_call?: { arguments?: unknown } }[] }).messages;
  check('state-id: assistant в replay несёт functions_state_id с ответа', msgs[1]?.functions_state_id === 'sid-1', JSON.stringify(msgs[1]));
  check('state-id: аргументы совпали с запомненным вызовом', JSON.stringify(msgs[1]?.function_call?.arguments) === '{"body":"docker ps"}', JSON.stringify(msgs[1]?.function_call?.arguments));

  // другой вызов (аргументы не совпадают) — id не подставляется
  reset();
  chatResponder = jsonOk({ choices: [{ message: { role: 'assistant', content: 'ок' }, finish_reason: 'stop' }] });
  await collect(p, {
    messages: [
      { role: 'user', content: 'Глеб: ```run\ndocker compose up -d\n```' },
      { role: 'user', content: '⚙ Результаты твоих действий:\n✅ Started' },
      { role: 'user', content: 'Продолжай.' },
    ],
    tools: toolsSpec,
  });
  const msgs3 = (JSON.parse(chats()[0]!.body) as { messages: { role: string; functions_state_id?: string }[] }).messages;
  check('state-id: чужой вызов без идентификатора (мягкий промах)', msgs3[1]?.role === 'assistant' && msgs3[1]?.functions_state_id === undefined, JSON.stringify(msgs3[1]));
}

// ── 12. грамматика: blockFromCall → parseActions → callFromBlock ────────────
{
  const mod = await import('../src/actions.js');
  const kinds = ['run', 'file', 'ssh', 'look', 'git', 'arch', 'docs', 'ocr', 'web', 'mail', 'telegram', 'max', 'pdf.export'];
  type Call = { kind: string; args: Record<string, string | number> };
  // действие движка обратно в вид блока (проект — в строку блока, как в грамматике)
  const argsOf = (a: ReturnType<typeof mod.parseActions>[number]): { kind: string; line: string; body: string } => {
    const pfx = 'project' in a && a.project ? `${a.project}:` : '';
    if (a.kind === 'file') return { kind: 'file', line: pfx + a.path, body: a.content };
    if (a.kind === 'look') return { kind: 'look', line: pfx + a.path, body: a.question };
    if (a.kind === 'ssh') return { kind: 'ssh', line: a.host, body: a.command };
    if (a.kind === 'run') return { kind: 'run', line: pfx, body: a.command };
    if (a.kind === 'image') return { kind: 'image', line: a.project ? `${a.project}:` : '', body: '' };
    return { kind: a.tool, line: pfx, body: a.command }; // остались кастомные тулы
  };
  const canon = (args: Record<string, unknown>): string => JSON.stringify(Object.entries(args).sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  const cases: Call[] = [
    { kind: 'run', args: { body: 'docker ps' } },
    { kind: 'run', args: { project: 'shop', body: 'docker compose up -d' } },
    { kind: 'file', args: { project: 'shop', arg: 'a/b.txt', body: 'привет' } },
    { kind: 'file', args: { arg: 'notes.md', body: '# план' } },
    { kind: 'ssh', args: { arg: 'prod', body: 'systemctl status nginx' } },
    { kind: 'ssh', args: { arg: 'shop:prod', body: 'uptime' } },
    { kind: 'look', args: { arg: 'images/кот.png', body: 'что на картинке?' } },
    { kind: 'git', args: { body: 'log --oneline -5' } },
    { kind: 'docs', args: { body: 'read отчёт.pdf' } },
    { kind: 'pdf.export', args: { project: 'shop', body: 'тело запроса' } },
  ];
  for (const c of cases) {
    const block = mod.blockFromCall(c);
    const actions = mod.parseActions(block ?? '', kinds);
    let back: Call | null = null;
    if (actions.length === 1) {
      const r = argsOf(actions[0]!);
      back = mod.callFromBlock(r.kind, r.line, r.body);
    }
    // ssh «проект:хост» парсится в project+arg — сравниваем нормализованно
    const want: Record<string, unknown> = { ...c.args };
    if (c.kind === 'ssh' && typeof want.arg === 'string' && want.arg.includes(':') && !('project' in want)) {
      const [p, ...rest] = want.arg.split(':');
      want.project = p;
      want.arg = rest.join(':');
    }
    check(
      `блок↔функция: ${c.kind} ${JSON.stringify(c.args)}`,
      block !== null && actions.length === 1 && back !== null && back.kind === c.kind && canon(back.args) === canon(want),
      `block=${JSON.stringify(block)} actions=${JSON.stringify(actions)} back=${JSON.stringify(back)}`,
    );
  }
  // image: свой набор параметров и парсинг тела
  const img = mod.blockFromCall({ kind: 'image', args: { project: 'shop', prompt: 'кот в шляпе', size: '512x512', n: 2, refs: 'images/a.png, images/b.png' } });
  const imgActions = mod.parseActions(img ?? '', ['image']);
  check(
    'блок↔функция: image с параметрами',
    img !== null && imgActions.length === 1 && imgActions[0]!.kind === 'image' && imgActions[0]!.params.prompt === 'кот в шляпе' && imgActions[0]!.params.size === '512x512' && imgActions[0]!.params.n === 2 && imgActions[0]!.project === 'shop' && imgActions[0]!.params.refs?.length === 2,
    `img=${JSON.stringify(img)} actions=${JSON.stringify(imgActions)}`,
  );
  check('пустой вызов: блока нет', mod.blockFromCall({ kind: 'run', args: {} }) === null, String(mod.blockFromCall({ kind: 'run', args: {} })));
  check('image без промпта: блока нет', mod.blockFromCall({ kind: 'image', args: { size: '512x512' } }) === null, String(mod.blockFromCall({ kind: 'image', args: { size: '512x512' } })));
}

// ── 13. functionSpecs: объявления функций из тулов агента ───────────────────
{
  const { functionSpecs } = await import('../src/actions.js');
  const specs = functionSpecs({ tools: { files: null, shell: null, git: null, ssh: null, look: null, image: null, 'pdf.export': null } } as never) ?? [];
  const names = specs.map((s) => s.name);
  check('specs: виды блоков всех включённых тулов', JSON.stringify(names) === JSON.stringify(['file', 'run', 'git', 'ssh', 'look', 'image', 'pdf.export']), JSON.stringify(names));
  check('specs: описания и схемы заполнены', specs.every((s) => s.description.length > 10 && s.parameters.type === 'object'), JSON.stringify(specs.map((s) => s.name)));
  const imgSpec = specs.find((s) => s.name === 'image')!;
  check('specs: image — свои параметры с обязательным prompt', Array.isArray((imgSpec.parameters as { required?: string[] }).required) && (imgSpec.parameters as { required: string[] }).required.includes('prompt'), JSON.stringify(imgSpec.parameters));
  check('specs: без тулов — undefined', functionSpecs({ tools: null } as never) === undefined, String(functionSpecs({ tools: null } as never)));
}

await new Promise<void>((done) => server.close(() => done()));
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
