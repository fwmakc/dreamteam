/**
 * Регрессия цикла тулов: встроенный тул (docs), выданный агенту, должен
 * исполняться движком из блока ```docs — как file/run/ssh/look/image.
 * Провал = модель пишет тул-блоки вхолостую (был именно такой баг: в
 * parseActions уходили только имена пользовательских tools/*.ts).
 *
 * Герметично: временные DT_HOME/DT_PROJECT, вместо API — локальный
 * openai-compatible сервер с двумя заготовленными ответами (реплика с
 * тул-блоком, потом «готово»). Запуск: npm run probe:toolloop
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const base = mkdtempSync(join(tmpdir(), 'dt-toolloop-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = join(proj, '.dreamteam');
process.chdir(proj); // рабочая папка инструментов = cwd

// ── фейковый провайдер: два ответа по числу запросов ─────────────────────────
const FIRST_REPLY =
  'Пишу PDF.\n\n```docs write proba.pdf\nПривет из пробы цикла тулов.\n```\n';
const FOLLOWUP_REPLY = 'Готово: proba.pdf создан.';
let calls = 0;
const sse = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void req;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(sse(calls === 0 ? FIRST_REPLY : FOLLOWUP_REPLY));
  calls++;
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
server.unref(); // не держим процесс: завершаемся по итогу проверок

writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify(
    { default: 'fake', providers: { fake: { adapter: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-1' } } },
    null, 2,
  ) + '\n',
);
writeFileSync(
  join(home, 'agents.json'),
  JSON.stringify(
    { agents: [{ id: 'kirk', name: 'Кир', role: 'документы', prompt: 'Ты — Кир.', tools: { files: {}, docs: {} } }] },
    null, 2,
  ) + '\n',
);

const notices: string[] = [];
const errors: string[] = [];
const toolRows: string[] = [];
const reply = { text: '' };
const sink = { delta() {}, done() {} };
const stub = {
  notice(t: string) { notices.push(t); },
  error(t: string) { errors.push(t); },
  turnHeader(_a: unknown) {},
  busy(_l: string) { return { stop() {} }; },
  stream(_l: string) { return sink; },
  turnEnd(full: string) { reply.text += full; },
  say(t: string) { reply.text += t; },
  toolLines(rows: string[]) { toolRows.push(...rows); },
  attachment(_t: string, _d: string) {},
  async confirm() { return true; },
  async chooseSession() { return null; },
  sessionOpened() {},
};

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
import type { Presenter } from '../src/core/presenter.js';

const { app } = await bootstrapApp();
const engine = new Engine(app, stub as unknown as Presenter);
app.session.title = 'Проба цикла тулов'; // без генерации имени — она тоже тратит вызов
app.session.participants = ['kirk'];
app.store.save(app.session);

await engine.handleMessage('Кир, создай pdf: @kirk', AbortSignal.timeout(30_000));

const pdf = join(proj, 'proba.pdf');
check('тул-блок ```docs исполнен: proba.pdf на диске', existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === '%PDF-',
  existsSync(pdf) ? `${readFileSync(pdf).length} байт` : 'файла нет');
check('в истории есть ответ инструментов', app.session.messages.some((m) => m.authorId === 'tool' && m.text.includes('✅')),
  JSON.stringify(app.session.messages.map((m) => m.authorId)));
// договорачка идёт мимо turnEnd — итог читаем из истории сессии
const lastAgent = [...app.session.messages].reverse().find((m) => m.authorId === 'kirk');
check('агент договорился после результата тула', (lastAgent?.text ?? '').includes('Готово'), (lastAgent?.text ?? '').slice(0, 120));
check('было два обращения к провайдеру (ход + договорачка)', calls === 2, `вызовов: ${calls}`);
check('без ошибок провайдера', errors.length === 0, errors.join(' | ').slice(0, 200));

process.chdir(tmpdir());
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
