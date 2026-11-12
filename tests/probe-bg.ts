/**
 * Проба фоновых задач (BgTask): диспетчер src/core/bg.ts и тул ```bg.
 *  - parseBgDuration/parseBgSpawn: «30»/«30m»/«600s»/«2h», опции timeout=/check=/title=,
 *    кавычки в title, неопознанный первый токен = команда целиком, многострочные команды;
 *  - spawnBg: done/failed с кодами, лог-файл bglogs/<id>.log, bg.json, уведомления
 *    в очередь с персистентным notified (без дублей при повторном drain);
 *  - bgDrain: фильтр по разговору — чужие уведомления остаются в очереди;
 *  - таймаут (bgTick + killTree) и bgKill (killed, вежливые отказы);
 *  - обрезка лога на cap: truncated, счётчик байтов, хвост в файле;
 *  - bgBoot: мёртвый pid → lost, живой → adopted (поллинг → «код выхода неизвестен»);
 *  - bgTick: пинг по checkMinutes, «лог не рос»;
 *  - сквозная: mock-сервер отвечает блоком ```bg — тул запускает задачу
 *    («Запущено: id=…»), завершение → уведомление authorId 'bg' в истории.
 *
 * Герметично: временный DT_HOME, сети нет (кроме локального mock-сервера).
 * Запуск: tsx tests/probe-bg.ts
 */
import { spawn as rawSpawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Presenter } from '../src/core/presenter.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${String(detail).slice(0, 300)}`));
  if (!cond) fails++;
}
/** Ждёт cond() до ms мс (поллинг 100 мс) — процессы завершаются асинхронно. */
async function until(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

const root = mkdtempSync(join(tmpdir(), 'dt-bg-'));
const home = join(root, 'home');
const proj = join(root, 'proj');
const fix = join(root, 'fix');
mkdirSync(join(home, 'agents'), { recursive: true });
mkdirSync(join(home, 'models'), { recursive: true });
mkdirSync(proj, { recursive: true });
mkdirSync(fix, { recursive: true });
process.env.DT_HOME = home;
writeFileSync(join(home, 'settings.json'),
  JSON.stringify({ ui: 'ru', width: 100, model: { id: 'fake' }, bgCheckMinutes: 5, bgTimeoutMinutes: 0 }, null, 2) + '\n');

// помощники-процессы: без quoting-страшностей — команды ссылаются на файлы
const sl = (p: string): string => p.replace(/\\/g, '/');
writeFileSync(join(fix, 'sleep.js'),
  `const ms = Number(process.argv[2] ?? 1000);\nif (process.argv[3]) console.log(process.argv[3]);\nsetTimeout(() => process.exit(Number(process.argv[4] ?? 0)), ms);\n`);
writeFileSync(join(fix, 'boom.js'), `console.error('бум-ошибка');\nprocess.exit(3);\n`);
writeFileSync(join(fix, 'big.js'), `for (let i = 0; i < 60000; i++) console.log('x'.repeat(50));\n`);
const SLEEP = (ms: number, log = '', code = 0): string =>
  `node ${sl(join(fix, 'sleep.js'))} ${ms}${log ? ` ${log}` : ''}${code ? ` ${code}` : ''}`;

// ── 1. парсеры ───────────────────────────────────────────────────────────────
{
  const { parseBgDuration, parseBgSpawn } = await import('../src/core/bg.js');

  check('парсер: «30» — минуты', parseBgDuration('30') === 30 * 60_000);
  check('парсер: «30m» — минуты', parseBgDuration('30m') === 30 * 60_000);
  check('парсер: «600s» — секунды', parseBgDuration('600s') === 600_000);
  check('парсер: «2h» — часы', parseBgDuration('2h') === 7_200_000);
  check('парсер: «15ч» — русская единица', parseBgDuration('15ч') === 15 * 3_600_000);
  check('парсер: мусор — undefined', parseBgDuration('abc') === undefined);

  const full = parseBgSpawn('timeout=30m check=2m title="долгая сборка" npm run build');
  check('парсер: опции и команда разделились',
    full.timeoutMs === 1_800_000 && full.checkMinutes === 2 && full.title === 'долгая сборка' && full.command === 'npm run build',
    JSON.stringify(full));
  const plain = parseBgSpawn('npm run build key=1');
  check('парсер: неопознанный первый токен — вся строка команда',
    plain.command === 'npm run build key=1' && plain.timeoutMs === undefined && plain.title === undefined,
    JSON.stringify(plain));
  const multi = parseBgSpawn('title=x\nnode one\necho two');
  check('парсер: многострочная команда сохраняет переносы', multi.command === 'node one\necho two', JSON.stringify(multi));
  const titleOnly = parseBgSpawn('title=сборка');
  check('парсер: только опции — команда пуста', titleOnly.title === 'сборка' && titleOnly.command === '', JSON.stringify(titleOnly));
}

// ── 2. проект на диск: PROJECT_DIR/live binding ──────────────────────────────
{
  const { setProjectRoot } = await import('../src/paths.js');
  setProjectRoot(proj, proj);
  const { bgFile } = await import('../src/core/bg.js');
  check('хранилище: bg.json в папке проекта', bgFile() === join(proj, 'bg.json'), bgFile());
}

// ── 3. spawnBg: done/failed, лог, bg.json, уведомления ───────────────────────
{
  const bg = await import('../src/core/bg.js');

  const okTask = bg.spawnBg({ sessionId: 'sess-1', by: 'user', command: SLEEP(700, 'фоновый-лог') });
  check('spawn: id вида bg-…', /^bg-[a-z0-9]+-[a-z0-9]{4}$/.test(okTask.id), okTask.id);
  check('spawn: статус running, дефолт пингов из настроек (5 мин)', okTask.status === 'running' && okTask.checkMinutes === 5);
  check('spawn: без таймаута (bgTimeoutMinutes=0)', !okTask.timeoutMs);

  const okDone = await until(() => bg.bgGet(okTask.id)?.status === 'done');
  check('spawn: сон завершился — done, код 0', okDone && bg.bgGet(okTask.id)?.exitCode === 0, JSON.stringify(bg.bgGet(okTask.id)));
  check('spawn: лог дописан в файл', existsSync(join(proj, 'bglogs', `${okTask.id}.log`))
    && (await import('node:fs')).readFileSync(join(proj, 'bglogs', `${okTask.id}.log`), 'utf8').includes('фоновый-лог'));

  const boomTask = bg.spawnBg({ sessionId: 'sess-1', by: 'user', command: `node ${sl(join(fix, 'boom.js'))}` });
  await until(() => bg.bgGet(boomTask.id)?.status === 'failed');
  const boomFinal = bg.bgGet(boomTask.id)!;
  check('spawn: не-нулевой код — failed с кодом и stderr в логе',
    boomFinal.status === 'failed' && boomFinal.exitCode === 3 && bg.bgLog(boomTask.id).includes('бум-ошибка'),
    JSON.stringify(boomFinal));

  const onDisk = bg.loadBg(proj);
  check('bg.json: обе задачи персистятся со статусами',
    onDisk.length === 2 && onDisk.every((t) => t.status !== 'running'), JSON.stringify(onDisk.map((t) => t.status)));

  const notes = bg.bgDrain('sess-1');
  check('уведомления: две финальных, текст с маркером и хвостом лога',
    notes.length === 2 && notes.every((n) => n.text.includes('[⚙ фоновая задача')) && notes.some((n) => n.text.includes('фоновый-лог')),
    JSON.stringify(notes.map((n) => n.text.slice(0, 80))));
  check('уведомления: notified персистится в bg.json', bg.loadBg(proj).every((t) => t.notified === true), JSON.stringify(bg.loadBg(proj).map((t) => t.notified)));
  check('уведомления: повторный drain пуст — дублей нет', bg.bgDrain('sess-1').length === 0);
  const rest = bg.bgDrain();
  check('уведомления: drain без фильтра тоже пуст', rest.length === 0);
}

// ── 4. bgDrain: чужой разговор ждёт своей сессии ─────────────────────────────
{
  const bg = await import('../src/core/bg.js');
  const t = bg.spawnBg({ sessionId: 'sess-other', by: 'user', command: SLEEP(300) });
  await until(() => bg.bgGet(t.id)?.status === 'done');
  check('drain: чужая сессия не забирает уведомление', bg.bgDrain('sess-1').length === 0);
  const drained = bg.bgDrain('sess-other');
  check('drain: своя сессия забирает', drained.length === 1 && drained[0]!.sessionId === 'sess-other', JSON.stringify(drained));
}

// ── 5. таймаут и bgKill ──────────────────────────────────────────────────────
{
  const bg = await import('../src/core/bg.js');

  const tmo = bg.spawnBg({ sessionId: 'sess-1', by: 'user', command: SLEEP(60_000), timeoutMs: 1200 });
  // сторож живёт в тикере serve — проба тикает сама
  const timedOut = await until(() => {
    bg.bgTick();
    return bg.bgGet(tmo.id)?.status === 'timeout';
  }, 12_000);
  check('таймаут: bgTick остановил и пометил timeout', timedOut, JSON.stringify(bg.bgGet(tmo.id)));
  check('таймаут: уведомление в очереди с «превысила таймаут»',
    bg.bgDrain('sess-1').some((n) => n.text.includes('превысила таймаут')));

  const killed = bg.spawnBg({ sessionId: 'sess-1', by: 'user', command: SLEEP(60_000) });
  const stopText = bg.bgKill(killed.id);
  const killedOk = await until(() => bg.bgGet(killed.id)?.status === 'killed');
  check('kill: живой процесс остановлен — killed', killedOk && stopText.includes('останавливаю'), `${stopText} / ${JSON.stringify(bg.bgGet(killed.id))}`);
  bg.bgDrain('sess-1');

  check('kill: неизвестный id — вежливо', bg.bgKill('bg-нет-такой').includes('нет фоновой задачи'));
  check('kill: завершённая — «уже завершилась»', bg.bgKill(killed.id).includes('уже завершилась'));

  const delRunning = bg.spawnBg({ sessionId: 'sess-1', by: 'user', command: SLEEP(60_000) });
  check('delete: работающую не удаляет', bg.bgDelete(delRunning.id).includes('ещё выполняется'));
  bg.bgKill(delRunning.id);
  await until(() => bg.bgGet(delRunning.id)?.status === 'killed');
  const delText = bg.bgDelete(delRunning.id);
  check('delete: завершённую удаляет вместе с логом', delText.includes('удалена')
    && !existsSync(join(proj, 'bglogs', `${delRunning.id}.log`)) && !bg.bgGet(delRunning.id), delText);
  bg.bgDrain();
}

// ── 6. обрезка лога на cap ───────────────────────────────────────────────────
{
  const bg = await import('../src/core/bg.js');
  const t = bg.spawnBg({ sessionId: 'sess-1', by: 'user', command: `node ${sl(join(fix, 'big.js'))}` });
  const done = await until(() => bg.bgGet(t.id)?.status === 'done', 30_000);
  const final = bg.bgGet(t.id)!;
  check('cap: truncated=true, счётчик больше cap', done && final.truncated === true && final.logBytes > 2_000_000,
    JSON.stringify({ truncated: final.truncated, logBytes: final.logBytes }));
  const logAll = (await import('node:fs')).readFileSync(join(proj, 'bglogs', `${t.id}.log`), 'utf8');
  check('cap: в файле хвост с пометкой обрезки (головка файла)', logAll.startsWith('(головка вывода обрезана'), logAll.slice(0, 120));
  bg.bgDrain();
}

// ── 7. bgBoot: lost и adopted ────────────────────────────────────────────────
{
  const bg = await import('../src/core/bg.js');
  const { spawnSync } = await import('node:child_process');

  // pid гарантированно мёртвый: короткий child, дожидаемся его выхода
  const dead = spawnSync(process.execPath, [join(fix, 'sleep.js'), '50']);
  void dead;
  const deadProbe = rawSpawn(process.execPath, [join(fix, 'sleep.js'), '50']);
  const deadPid = deadProbe.pid!;
  await until(() => deadProbe.exitCode !== null);
  const now = Date.now();
  writeFileSync(join(proj, 'bg.json'), JSON.stringify([
    { id: 'bg-lost1-zzzz', dir: proj, sessionId: 'sess-lost', by: 'user', title: 'умершая', command: SLEEP(50),
      status: 'running', pid: deadPid, startedAt: now - 5000, checkMinutes: 0, lastCheckAt: now, lastOutputAt: now, logBytes: 0 },
  ], null, 2));
  bg.bgBoot(proj);
  const lost = await until(() => bg.bgGet('bg-lost1-zzzz')?.status === 'lost');
  check('boot: мёртвый pid — lost с причиной', lost && bg.bgGet('bg-lost1-zzzz')?.error?.includes('не найден') === true,
    JSON.stringify(bg.bgGet('bg-lost1-zzzz')));
  check('boot: lost попадает в очередь уведомлений',
    bg.bgDrain('sess-lost').some((n) => n.text.includes('не найдена после перезапуска')));

  // живой процесс без хендла: переусыновление и поллинг
  const live = rawSpawn(process.execPath, [join(fix, 'sleep.js'), '30_000']);
  const livePid = live.pid!;
  writeFileSync(join(proj, 'bg.json'), JSON.stringify([
    { id: 'bg-adopt1-wwww', dir: proj, sessionId: 'sess-adopt', by: 'user', title: 'живая', command: SLEEP(30_000),
      status: 'running', pid: livePid, startedAt: Date.now(), checkMinutes: 0, lastCheckAt: Date.now(), lastOutputAt: Date.now(), logBytes: 0 },
  ], null, 2));
  bg.bgBoot(proj);
  check('boot: живой pid переусыновлён (adopted)', bg.bgGet('bg-adopt1-wwww')?.adopted === true, JSON.stringify(bg.bgGet('bg-adopt1-wwww')));
  bg.bgTick(); // жив — никого не финализирует
  check('boot: живой после тика всё ещё running', bg.bgGet('bg-adopt1-wwww')?.status === 'running');
  live.kill();
  const finished = await until(() => {
    bg.bgTick();
    return bg.bgGet('bg-adopt1-wwww')?.status === 'done';
  });
  const adoptedFinal = bg.bgGet('bg-adopt1-wwww')!;
  check('boot: умер после переусыновления — done «код выхода неизвестен»',
    finished && adoptedFinal.exitCode === undefined && adoptedFinal.error?.includes('неизвестен') === true,
    JSON.stringify(adoptedFinal));
  check('boot: уведомление об этом в очереди',
    bg.bgDrain('sess-adopt').some((n) => n.text.includes('фоновая задача bg-adopt1-wwww')));
}

// ── 8. bgTick: пинги и «лог не рос» ──────────────────────────────────────────
{
  const bg = await import('../src/core/bg.js');
  const t = bg.spawnBg({ sessionId: 'sess-ping', by: 'kirk', command: SLEEP(60_000), checkMinutes: 5 });
  const task = bg.bgGet(t.id)!;
  task.lastCheckAt = Date.now() - 10 * 60_000; // срок пинга давно прошёл
  task.lastOutputAt = Date.now() - 4 * 60_000; // и лог стоит 4 минуты (STALL 3 мин)
  const pings = bg.bgTick().filter((n) => n.taskId === t.id);
  check('пинг: подошёл срок — один пинг в свою сессию',
    pings.length === 1 && pings[0]!.sessionId === 'sess-ping', JSON.stringify(pings));
  check('пинг: текст с «идёт», простоем и подсказками',
    pings[0]!.text.includes('идёт') && pings[0]!.text.includes('лог не рос') && pings[0]!.text.includes('Ждать дальше'),
    pings[0]?.text.slice(0, 160));
  const silent = bg.bgTick().filter((n) => n.taskId === t.id); // срок только что сдвинули
  check('пинг: до следующего срока — тихо', silent.length === 0, JSON.stringify(silent));
  bg.bgKill(t.id);
  await until(() => bg.bgGet(t.id)?.status === 'killed');
  bg.bgDrain();
}

// ── 9. сквозная: ```bg в ответе модели → тул → уведомление authorId 'bg' ─────
{
  const proj2 = join(root, 'proj2');
  mkdirSync(proj2, { recursive: true });
  process.chdir(proj2);

  const FIRST_REPLY =
    'Запускаю в фоне.\n\n```bg\ntitle="проба сна" ' + SLEEP(1200, 'фоновый-лог') + '\n```\n';
  const FOLLOWUP_REPLY = 'Принял: фоновая задача завершилась, лог видел.';
  let calls = 0;
  const { createServer } = await import('node:http');
  const sse = (text: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(calls === 0 ? FIRST_REPLY : FOLLOWUP_REPLY));
    calls++;
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  server.unref();

  writeFileSync(join(home, 'models', 'fake.json'),
    JSON.stringify({ provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-1' }, null, 2) + '\n');
  writeFileSync(join(home, 'agents', 'kirk.json'),
    JSON.stringify({ name: 'Кир', prompt: 'Ты — Кир.', tools: { bg: { allow: ['node *'] } } }, null, 2) + '\n');

  const notices: string[] = [];
  const errors: string[] = [];
  const sink = { delta() {}, done() {} };
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
    async confirm() { return true; },
    async chooseSession() { return null; },
    sessionOpened() {},
  };
  const { bootstrapApp } = await import('../src/core/bootstrap.js');
  const { Engine } = await import('../src/core/engine.js');
  const { app } = await bootstrapApp();
  const engine = new Engine(app, stub);
  engine.newProject('dev', proj2);
  app.session!.title = 'Проба фоновой задачи';
  app.session!.participants = ['kirk'];
  app.store!.save(app.session!);
  const sid = app.session!.id;

  await engine.handleMessage('Кир, запусти сон в фоне', AbortSignal.timeout(30_000));

  const bg = await import('../src/core/bg.js');
  // newProject ставит PROJECT_DIR в дом (projects/<id>/), не в рабочую папку —
  // bg.json живёт там; список берём дефолтный
  const launched = bg.bgList();
  const bgJson = bg.bgFile();
  check('e2e: тул запустил задачу от агента (by=kirk)',
    launched.length === 1 && launched[0]!.by === 'kirk' && launched[0]!.title === 'проба сна',
    `${JSON.stringify(launched)} / ${bgJson}`);
  check('e2e: в истории тул-результат «Запущено: id=…»',
    app.session!.messages.some((m) => m.authorId === 'tool' && m.text.includes('Запущено: id=')),
    JSON.stringify(app.session!.messages.map((m) => m.authorId)));

  const done = await until(() => bg.bgGet(launched[0]!.id)?.status === 'done');
  check('e2e: сон завершился — done', done, JSON.stringify(bg.bgGet(launched[0]!.id)));

  const notes = bg.bgDrain(sid);
  check('e2e: уведомление адресовано разговору и содержит хвост лога',
    notes.length === 1 && notes[0]!.sessionId === sid && notes[0]!.text.includes('фоновый-лог'),
    JSON.stringify(notes.map((n) => n.text.slice(0, 100))));

  await engine.deliverBgNote(notes[0]!.text, AbortSignal.timeout(30_000));
  const msgs = app.session!.messages;
  const bgIdx = msgs.findIndex((m) => m.authorId === 'bg');
  const after = bgIdx >= 0 ? [...msgs.slice(bgIdx + 1)].find((m) => m.authorId === 'kirk') : undefined;
  check('e2e: в истории реплика authorId bg с маркером задачи', bgIdx >= 0 && msgs[bgIdx]!.text.includes('[⚙ фоновая задача'),
    bgIdx >= 0 ? msgs[bgIdx]!.text.slice(0, 100) : 'реплики нет');
  check('e2e: после уведомления модель ответила (раунд доставки)', after?.text.includes('Принял') === true, after?.text.slice(0, 100));
  check('e2e: провайдер звали трижды (запуск + договорачка тула + доставка)', calls === 3, `вызовов: ${calls}`);
  check('e2e: без ошибок', errors.length === 0, errors.join(' | '));
  server.closeAllConnections();
  server.close();
  process.chdir(tmpdir());
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
// мягкий выход: гасим оставшиеся фоновые процессы (libuv на Windows роняет
// process.exit с живыми хэндлами)
{
  const bg = await import('../src/core/bg.js');
  for (const t of bg.bgList()) if (t.status === 'running') bg.bgKill(t.id);
}
const code = fails === 0 ? 0 : 1;
setTimeout(() => process.exit(code), 5000);
process.exitCode = code;
