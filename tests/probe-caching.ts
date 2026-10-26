/**
 * Проба кэша промптов и статистики токенов:
 *  - openai-совместимый поток: usage в финальном чанке (Z.ai/OpenAI-стиль,
 *    prompt_tokens_details.cached_tokens) доезжает до заметки движка
 *    «{cached} из {total} входных токенов — из кэша промпта»;
 *  - anthropic: брейкпоинты cache_control в теле запроса (system + последнее
 *    сообщение), usage из message_start (cache_read_input_tokens), опция
 *    карточки "cache": false убирает маркеры.
 *
 * Герметично: временные DT_HOME/DT_PROJECT, локальный заглушечный сервер.
 * Запуск: npm run probe:caching
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const base = mkdtempSync(join(tmpdir(), 'dt-caching-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
mkdirSync(join(home, 'models'), { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = join(proj, '.dreamteam');
process.chdir(proj);

// ── заглушечный сервер: /v1/chat/completions (openai) и /v1/messages (anthropic)
const bodies: Record<string, string> = {}; // path → последнее тело запроса
const sse = (events: string[]): string => events.join('');
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c; });
  req.on('end', () => {
    bodies[req.url ?? '/'] = raw;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url?.endsWith('/chat/completions')) {
      res.end(sse([
        'data: {"choices":[{"delta":{"content":"Ответ."}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":1240}}}\n\n',
        'data: [DONE]\n\n',
      ]));
    } else {
      res.end(sse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":900,"cache_creation_input_tokens":50}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ок"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]));
    }
  });
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
server.unref();

writeFileSync(
  join(home, 'models', 'fake.json'),
  JSON.stringify({ adapter: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-1' }, null, 2) + '\n',
);
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'fake' } }, null, 2) + '\n');
writeFileSync(
  join(home, 'agents'),
  JSON.stringify({ agents: [{ id: 'kirk', name: 'Кир', role: 'тест', prompt: 'Ты — Кир.' }] }, null, 2) + '\n',
);

const notices: string[] = [];
const errors: string[] = [];
const sink = { delta() {}, done() {} };
const stub = {
  notice(t: string) { notices.push(t); },
  error(t: string) { errors.push(t); },
  turnHeader(_a: unknown) {},
  busy(_l: string) { return { stop() {} }; },
  stream(_l: string) { return sink; },
  turnEnd(_f: string) {},
  say(_t: string) {},
  toolLines(_r: string[]) {},
  attachment(_t: string, _d: string) {},
  async confirm() { return true; },
  async chooseSession() { return null; },
  sessionOpened() {},
};

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
import type { Presenter } from '../src/core/presenter.js';

// ── 1. сквозной раунд: usage из openai-потока → заметка о попадании ──────────
{
  const { app } = await bootstrapApp();
  const engine = new Engine(app, stub as unknown as Presenter);
  app.session.title = 'Проба кэша';
  app.session.participants = ['kirk'];
  app.store.save(app.session);

  await engine.handleMessage('Кир, привет: @kirk', AbortSignal.timeout(30_000));

  const hit = notices.find((n) => n.includes('из кэша промпта'));
  check('заметка о попадании в кэш — в ленте', Boolean(hit), notices.join(' | ').slice(0, 200));
  // toLocaleString('ru-RU') ставит неразрывный пробел между разрядами
  const pretty = (hit ?? '').replace(/\u00A0/g, ' ');
  check('числа из usage: 1240 из 1500', pretty.includes('1 240 из 1 500'), pretty);
  check('без ошибок провайдера', errors.length === 0, errors.join(' | ').slice(0, 200));
}

// ── 2. anthropic: cache_control в теле + usage из message_start ──────────────
{
  const { anthropicFactory } = await import('../src/providers/anthropic.js');
  const provider = anthropicFactory('claude-test', {
    adapter: 'anthropic', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, model: 'claude-x',
  });
  let out = '';
  let usage: { promptTokens?: number; cachedTokens?: number } | undefined;
  for await (const c of provider.stream(
    { system: 'Ты — тест.', messages: [
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: 'привет!' },
      { role: 'user', content: 'как дела?' },
    ] },
    (u) => { usage = u; },
  )) out += c;
  check('anthropic: ответ стримится', out.includes('ок'), out);
  check('anthropic: usage из message_start (900 из 1000)', usage?.cachedTokens === 900 && usage?.promptTokens === 1000, JSON.stringify(usage));
  const body = JSON.parse(bodies['/v1/messages'] ?? '{}') as {
    system?: Array<{ type?: string; cache_control?: unknown }>;
    messages?: Array<{ content: unknown }>;
  };
  const sys = Array.isArray(body.system) ? body.system[0] : undefined;
  check('anthropic: system — блок с cache_control', Boolean(sys?.cache_control), JSON.stringify(body.system).slice(0, 120));
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1] as { content?: Array<{ cache_control?: unknown }> } | undefined;
  const lastBlocks = Array.isArray(last?.content) ? last!.content : [];
  check('anthropic: маркер на последнем сообщении', lastBlocks.length > 0 && Boolean(lastBlocks[lastBlocks.length - 1].cache_control), JSON.stringify(last).slice(0, 160));

  // "cache": false — маркеров нет, system — строка
  const off = anthropicFactory('claude-off', {
    adapter: 'anthropic', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, model: 'claude-x', cache: false,
  });
  for await (const c of off.stream({ system: 'Ты — тест.', messages: [{ role: 'user', content: 'хай' }] })) void c;
  const body2 = JSON.parse(bodies['/v1/messages'] ?? '{}') as { system?: unknown };
  check('anthropic: "cache": false — маркеров нет', !JSON.stringify(body2).includes('cache_control') && typeof body2.system === 'string', JSON.stringify(body2).slice(0, 160));
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
const code = fails === 0 ? 0 : 1;
server.closeAllConnections();
server.close(() => { /* слушатель закрыт — цикл иссякнет сам */ });
setTimeout(() => process.exit(code), 5000);
process.exitCode = code;
