/**
 * Проба цели (Session.goal): цикл «крутить, пока не решится».
 *  - раунды-продолжения: модель отвечает ```goal done — цель закрыта с итогом;
 *  - бюджет: roundsDone ≥ maxRounds → статус budget, цикл остановлен;
 *  - подтверждения: 'ask' при активной цели решается сам («🎯 цель: разрешаю»),
 *    presenter.confirm не зовётся;
 *  - auto.on как цель без текста: продолжение autoMessage из настроек,
 *    исчерпание ходов — прежнее «автономный режим завершён» + отмена;
 *  - менеджер: goal.set/goal.cancel в execManagerAction;
 *  - рестарт: цель персистится в session.json — новый Engine её подхватывает
 *    (startGoalRound, как тикер serve);
 *  - операции /goal set|status|done|cancel.
 *
 * Герметично: временный DT_HOME, вместо API — локальный openai-compatible
 * сервер с заготовленными ответами. Запуск: tsx tests/probe-goal.ts
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Presenter } from '../src/core/presenter.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${String(detail).slice(0, 300)}`));
  if (!cond) fails++;
}

const root = mkdtempSync(join(tmpdir(), 'dt-goal-'));
const home = join(root, 'home');
const proj = join(root, 'proj');
const fix = join(root, 'fix');
mkdirSync(join(home, 'agents'), { recursive: true });
mkdirSync(join(home, 'models'), { recursive: true });
mkdirSync(proj, { recursive: true });
mkdirSync(fix, { recursive: true });
process.env.DT_HOME = home;
process.chdir(proj);
const sl = (p: string): string => p.replace(/\\/g, '/');
writeFileSync(join(fix, 'write.js'),
  `require('fs').writeFileSync(process.argv[2], 'ok');\n`);
const AUTO_MSG = 'Продолжай на своё усмотрение.';
writeFileSync(join(home, 'settings.json'),
  JSON.stringify({ ui: 'ru', width: 100, model: { id: 'fake' }, autoMessage: AUTO_MSG, goalMaxRounds: 12 }, null, 2) + '\n');

// ── заготовленные ответы по числу вызовов провайдера ─────────────────────────
const WRITE_JS = sl(join(fix, 'write.js'));
const OUT_TXT = sl(join(proj, 'goal-auto.txt'));
// Расклад по вызовам провайдера: budget считает раунды-ПРОДОЛЖЕНИЯ, поэтому
// B (maxRounds=1) съедает два вызова — раунд 1 и продолжение без вердикта;
// auto.on N = N продолжений после первого хода, т.е. N+1 вызовов.
const REPLIES: string[] = [
  /* 0: A раунд 1 */ 'Работаю над целью.',
  /* 1: A продолжение */ 'Второй раунд — готово.\n\n```goal done\nЗадача решена полностью\n```\n',
  /* 2: B раунд 1 */ 'Ещё работаю.',
  /* 3: B продолжение — без вердикта → бюджет */ 'Всё ещё работаю, результата нет.',
  /* 4: C раунд с ```run */ `Пишу файл.\n\n\`\`\`run\nnode ${WRITE_JS} ${OUT_TXT}\n\`\`\`\n`,
  /* 5: C договорачка */ 'Готово.\n\n```goal done\nавто-разрешение сработало\n```\n',
  /* 6: D раунд 1 */ 'Шаг первый.',
  /* 7: D продолжение 1 */ 'Шаг второй.',
  /* 8: D продолжение 2 — лимит исчерпан */ 'Шаг третий.',
  /* 9: F рестарт */ 'После рестарта закончил.\n\n```goal done\nрестарт пережит\n```\n',
];
let calls = 0;
const sse = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
// служебные ходы (рефлексия памяти, слияния, конспект) живут своей жизнью:
// получают болванку и не съедают сценарные реплики
const SERVICE_RE = /личную память|память о других разговорах|общую память команды|Сожми историю|краткий конспект/;
const SERVICE_STUB = '{"task":"проба идёт","towardUser":"ок","ties":{},"otherChats":""}';
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c: Buffer) => { body += c.toString(); });
  req.on('end', () => {
    let reply = 'заглушка';
    try {
      const j = JSON.parse(body) as { messages?: { role: string; content: string }[] };
      const all = (j.messages ?? []).map((m) => String(m.content)).join('\n');
      if (!SERVICE_RE.test(all)) {
        reply = REPLIES[calls] ?? 'заглушка';
        calls++;
      } else {
        reply = SERVICE_STUB;
      }
    } catch {
      // не JSON — отвечаем заглушкой
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(reply));
  });
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
server.unref();

writeFileSync(join(home, 'models', 'fake.json'),
  JSON.stringify({ provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-1' }, null, 2) + '\n');
writeFileSync(join(home, 'agents', 'kirk.json'),
  JSON.stringify({ name: 'Кир', prompt: 'Ты — Кир.', tools: { shell: {} } }, null, 2) + '\n');

const notices: string[] = [];
const errors: string[] = [];
const sink = { delta() {}, done() {} };
let confirmCalls = 0;
const stub: Presenter = {
  notice(t: string) { notices.push(t); },
  error(t: string) { errors.push(t); },
  turnHeader() {},
  busy() { return { stop() {} }; },
  stream() { return sink; },
  turnEnd() {},
  say() {},
  toolLines() {},
  attachment() {},
  async confirm() { confirmCalls++; return true; },
  async chooseSession() { return null; },
  sessionOpened() {},
};

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { setProjectRoot } = await import('../src/paths.js');
setProjectRoot(proj, proj);
const { app } = await bootstrapApp();
const engine = new Engine(app, stub);
engine.newProject('dev', proj);
app.session!.title = 'Проба цели';
app.session!.participants = ['kirk'];
app.store!.save(app.session!);

// ── A. раунды → ```goal done ─────────────────────────────────────────────────
{
  const report = engine.setGoal('реши пробную задачу', 5);
  check('set: отчёт с текстом и бюджетом', report.includes('Цель задана') && report.includes('реши пробную задачу') && report.includes('5'), report);
  check('set: цель активна в сессии', app.session!.goal?.status === 'active' && app.session!.goal.text === 'реши пробную задачу');

  await engine.handleMessage('Поехали', AbortSignal.timeout(30_000));
  const g = app.session!.goal!;
  check('done: вердикт из блока — статус done с итогом', g.status === 'done' && g.result === 'Задача решена полностью', JSON.stringify(g));
  check('done: один раунд-продолжение израсходован', g.roundsDone === 1, `roundsDone=${g.roundsDone}`);
  check('done: заметка «Цель достигнута»', notices.some((n) => n.includes('Цель достигнута') && n.includes('Задача решена полностью')), notices.join(' | ').slice(-200));
  check('done: продолжающий промпт ушёл как реплика цели (authorId goal)',
    app.session!.messages.some((m) => m.authorId === 'goal' && m.text.includes('Цель: реши пробную задачу')),
    JSON.stringify(app.session!.messages.map((m) => m.authorId)));
  check('done: ровно два вызова провайдера (ход + продолжение)', calls === 2, `вызовов: ${calls}`);
}

// ── B. бюджет: продолжение без вердикта исчерпывает лимит ────────────────────
{
  engine.setGoal('вторая цель', 1);
  await engine.handleMessage('Снова поехали', AbortSignal.timeout(30_000));
  const g = app.session!.goal!;
  check('budget: после продолжения без вердикта — статус budget', g.status === 'budget' && g.roundsDone === 1, JSON.stringify(g));
  check('budget: заметка с подсказкой перезапуска', notices.some((n) => n.includes('Бюджет цели исчерпан')), notices.join(' | ').slice(-200));
  check('budget: цикл остановлен — ровно два вызова (ход + продолжение)', calls === 4, `вызовов: ${calls}`);
}

// ── C. ask при цели разрешается сам ──────────────────────────────────────────
{
  engine.setGoal('цель с правами', 5);
  await engine.handleMessage('Запусти запись файла', AbortSignal.timeout(30_000));
  check('ask: node не в белых списках — но confirm не звался (авто-разрешение)', confirmCalls === 0, `confirm: ${confirmCalls}`);
  check('ask: команда всё же исполнена', existsSync(join(proj, 'goal-auto.txt')), 'файла нет');
  const g = app.session!.goal!;
  check('ask: цель закрыта вердиктом из договорачки', g.status === 'done' && g.result === 'авто-разрешение сработало', JSON.stringify(g));
  check('ask: провайдер звали дважды (ход с тулом + договорачка)', calls === 6, `вызовов: ${calls}`);
}

// ── D. auto.on как цель без текста ───────────────────────────────────────────
{
  engine.setAutoMode(true, 2);
  const g = app.session!.goal!;
  check('auto: цель без текста активна, бюджет = ходы', g.status === 'active' && g.text === undefined && g.maxRounds === 2, JSON.stringify(g));
  check('auto: совместимость — autoMode и счётчик на месте', engine.autoMode === true && engine.autoLeft === 2);

  await engine.handleMessage('Работай сам', AbortSignal.timeout(30_000));
  check('auto: два хода израсходованы — autoMode выключен', engine.autoMode === false && engine.autoLeft === 0, `left=${engine.autoLeft}`);
  check('auto: цель отменена при исчерпании', app.session!.goal?.status === 'cancelled', JSON.stringify(app.session!.goal));
  check('auto: заметка «автономный режим завершён»', notices.some((n) => n.includes('автономный режим завершён')), notices.join(' | ').slice(-200));
  check('auto: продолжение — autoMessage из настроек, как раньше (authorId user)',
    app.session!.messages.some((m) => m.authorId === 'user' && m.text === AUTO_MSG),
    JSON.stringify(app.session!.messages.map((m) => m.authorId)));
  check('auto: три вызова — ход + два продолжения (лимит 2)', calls === 9, `вызовов: ${calls}`);

  engine.setAutoMode(false, 0); // уже выключен — идемпотентно
}

// ── E. менеджер: goal.set / goal.cancel ──────────────────────────────────────
{
  const eng = engine as unknown as {
    execManagerAction(a: unknown, team: unknown[], pending: (() => unknown)[]): Promise<string>;
  };
  const setReport = await eng.execManagerAction({ op: 'goal.set', text: 'цель от менеджера', maxRounds: 3 }, [], []);
  const g = app.session!.goal!;
  check('менеджер: goal.set задал цель с бюджетом',
    setReport.includes('Цель задана') && g.status === 'active' && g.text === 'цель от менеджера' && g.maxRounds === 3,
    `${setReport} / ${JSON.stringify(g)}`);
  await eng.execManagerAction({ op: 'goal.cancel' }, [], []);
  check('менеджер: goal.cancel снял цель', app.session!.goal?.status === 'cancelled', JSON.stringify(app.session!.goal));
}

// ── F. рестарт: цель переживает смену Engine ─────────────────────────────────
{
  engine.setGoal('цель для рестарта', 5);
  app.store!.save(app.session!);
  const fresh = app.store!.load(app.session!.id)!;
  app.session = fresh; // как после перезапуска приложения
  const engine2 = new Engine(app, stub);
  const g = engine2.goalState();
  check('рестарт: новый Engine видит активную цель из session.json', g?.status === 'active' && g.text === 'цель для рестарта', JSON.stringify(g));

  await engine2.startGoalRound(AbortSignal.timeout(30_000));
  const g2 = engine2.goalState();
  check('рестарт: продолжающий раунд закрыл цель вердиктом', g2?.status === 'done' && g2.result === 'рестарт пережит', JSON.stringify(g2));
  check('рестарт: провайдер звал один раз (продолжение)', calls === 10, `вызовов: ${calls}`);
}

// ── G. операции /goal ────────────────────────────────────────────────────────
{
  const { runOperationText } = await import('../src/core/operations.js');
  const run = (line: string): Promise<string[]> => runOperationText(engine, line);

  const lines = await run('/goal set операция из команды 4');
  const g = engine.goalState();
  check('оп: goal set — бюджет последним числом, текст без него',
    g?.status === 'active' && g.text === 'операция из команды' && g.maxRounds === 4 && lines[0]?.includes('Цель задана'),
    `${JSON.stringify(g)} / ${lines.join(' | ')}`);

  const status = await run('/goal status');
  const statusAll = status.join('\n');
  check('оп: goal status — 🎯, бюджет и текст (многострочно)', statusAll.includes('🎯') && statusAll.includes('(раундов 0/4)') && statusAll.includes('операция из команды'), status.join(' | '));

  await run('/goal done');
  check('оп: goal done — цель закрыта вручную', engine.goalState()?.status === 'done' && engine.goalState()?.result === 'подтверждено пользователем', JSON.stringify(engine.goalState()));

  await run('/goal set промежуточная 2');
  await run('/goal cancel');
  check('оп: goal cancel — цель снята', engine.goalState()?.status === 'cancelled', JSON.stringify(engine.goalState()));

  const noArgs = await run('/goal set');
  check('оп: goal set без аргументов — синтаксис', noArgs.some((l) => l.includes('Синтаксис')), noArgs.join(' | '));
}

server.closeAllConnections();
server.close();
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // Windows недолюбливает удаление свежих tmp-каталогов (антивирус/keep-alive) — не беда
}
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
const code = fails === 0 ? 0 : 1;
setTimeout(() => process.exit(code), 5000);
process.exitCode = code;
