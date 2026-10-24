/**
 * Управление проектами: смена рабочей папки и списка разговоров на ходу.
 *  - paths: setProjectRoot пересчитывает весь проектный слой (живые привязки
 *    ESM: импортёры видят новые пути без перезагрузки модуля);
 *  - реестр проектов (projects.json в доме): запомнить/забыть, резолв имени и
 *    пути, отказ забывать текущий, устойчивость к битому файлу;
 *  - команды ядра: /project (обзор), /project open (по пути, по имени, ошибки),
 *    /project add, /project remove;
 *  - изоляция проектов: разговоры и hosts.json — свои в каждом проекте, команда
 *    и общая память — в доме (общие);
 *  - вливание памяти при смене проекта — в хранилище СТАРОГО проекта (фон не
 *    пишет в чужой магазин);
 *  - менеджер: действие project.open — реплика сохраняется в СТАРЫЙ разговор,
 *    смена применяется после (pendingSwitches); мусорный путь — ✗ без смены;
 *  - подсказки: projectNames в completion (/project open <Tab>);
 *  - serve (WS): rpc project.open/add/remove, поля state.project/knownProjects,
 *    смена командой «/project open …» — паритет TUI и GUI.
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер, порт 0.
 * Запуск: npm run probe:project
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import type { LLMProvider, StreamRequest } from '../src/types.js';
import type { Presenter, SpeakerRef, TurnSink } from '../src/core/presenter.js';
import { rmTemp } from './rm-tmp.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── песочница: дом + папки проектов во временной директории ──────────────────
const base = mkdtempSync(join(tmpdir(), 'dt-project-'));
const home = join(base, 'home');
const p1 = join(base, 'p1');
const p2 = join(base, 'p2');
const p3 = join(base, 'p3');
const p4 = join(base, 'p4');
for (const d of [home, p1, p2, p3, p4]) mkdirSync(d, { recursive: true });
process.env.DT_HOME = home;
// env-проект — в сторону: путь не совпадает ни с WORKSPACE, ни с будущими сменами
process.env.DT_PROJECT = join(base, 'proj-env');
process.chdir(base);

writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify({ default: 'mock', providers: { mock: { adapter: 'mock' } } }, null, 2) + '\n',
);

// src-модули — строго после подмены слоёв: paths.ts вычисляет пути при загрузке
const paths = await import('../src/paths.js');
const { loadProjectRegistry, rememberProject, forgetProject, resolveProjectDir } = await import(
  '../src/core/projects.js'
);

// ═══ 1. paths: смена проектного слоя на живую ════════════════════════════════
{
  check('paths: старт из окружения', paths.WORKSPACE === base && paths.DT_PROJECT === join(base, 'proj-env'));
  paths.setProjectRoot(p1);
  check('paths: setProjectRoot — рабочая папка', paths.WORKSPACE === p1);
  check(
    'paths: служебная папка и файлы пересчитаны',
    paths.DT_PROJECT === join(p1, '.dreamteam') &&
      paths.HOSTS_FILE === join(p1, '.dreamteam', 'hosts.json') &&
      paths.MAIL_FILE === join(p1, '.dreamteam', 'mails.json') &&
      paths.MESSENGERS_FILE === join(p1, '.dreamteam', 'messengers.json') &&
      paths.SESSIONS_DIR === join(p1, '.dreamteam', 'sessions'),
  );
  paths.setProjectRoot(base);
  check(
    'paths: явная смена важнее env DT_PROJECT',
    paths.WORKSPACE === base && paths.DT_PROJECT === join(base, '.dreamteam'),
  );
}

// ═══ 2. реестр проектов как модуль (отдельный файл — изоляция от пробы) ═════
{
  const regFile = join(base, 'reg-test.json');
  check('реестр: нет файла — пусто', loadProjectRegistry(regFile).projects.length === 0);
  writeFileSync(regFile, '{ битый json');
  check('реестр: битый файл — пусто, не падение', loadProjectRegistry(regFile).projects.length === 0);

  rememberProject(regFile, p1, true);
  let reg = loadProjectRegistry(regFile);
  check('реестр: проект запомнен текущим', reg.current === p1 && reg.projects[0]?.path === p1);
  check('реестр: имя — имя папки', reg.projects[0]?.name === 'p1' && typeof reg.projects[0]?.lastOpened === 'number');

  rememberProject(regFile, p1, true);
  reg = loadProjectRegistry(regFile);
  check('реестр: повтор — без дубликата', reg.projects.length === 1);

  rememberProject(regFile, p2, false);
  reg = loadProjectRegistry(regFile);
  check(
    'реестр: без makeCurrent — current не тронут',
    reg.projects.length === 2 && reg.current === p1 && reg.projects[1]?.lastOpened === undefined,
  );

  let threw = '';
  try { forgetProject(regFile, p1, p1); } catch (e) { threw = (e as Error).message; }
  check('реестр: текущий не забыть', threw.includes('открыт сейчас'), threw);
  forgetProject(regFile, p2, p1);
  check('реестр: забыли p2', loadProjectRegistry(regFile).projects.length === 1);
  threw = '';
  try { forgetProject(regFile, p2, p1); } catch (e) { threw = (e as Error).message; }
  check('реестр: забыть чужое — ошибка', threw.includes('нет в реестре'), threw);

  check('резолв: абсолютный путь', resolveProjectDir(p2, p1, reg) === p2);
  check('резолв: относительный от рабочей папки', resolveProjectDir('p2', base, reg) === p2);
  check('резолв: имя из реестра (регистр не важен)', resolveProjectDir('P1', p2, reg) === p1);
  threw = '';
  try { resolveProjectDir('p2', p1, { projects: [] }); } catch (e) { threw = (e as Error).message; }
  check('резолв: нет ни пути, ни имени — подсказка', threw.includes('нет папки проекта'), threw);
  threw = '';
  try { resolveProjectDir('  ', base, reg); } catch (e) { threw = (e as Error).message; }
  check('резолв: пустой аргумент — подсказка', threw.includes('/project open'), threw);
}

// ═══ 3. ядро: скаффолд, команды, изоляция, менеджер ══════════════════════════
// скриптовый LLM: менеджерские ходы — из очереди, остальное — болтовня
const managerReplies: string[] = [];
const requests: { system?: string; user?: string }[] = [];
const fakeProvider: LLMProvider = {
  id: 'mock',
  kind: 'mock',
  model: 'scripted',
  async *stream(req: StreamRequest) {
    requests.push({ system: req.system, user: req.messages.map((m) => m.content).join('\n---\n') });
    const reply = req.system?.startsWith('Ты — менеджер переговорки') ? (managerReplies.shift() ?? '') : 'Принято.';
    if (req.signal?.aborted) return;
    yield reply;
  },
};

const notices: string[] = [];
let opened = 0;
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice(text) { notices.push(text); },
  service(text) { notices.push(text); },
  error() {},
  turnHeader(_agent: SpeakerRef) {},
  busy(_label: string) { return { stop() {} }; },
  stream(_label: string) { return sink; },
  turnEnd(_full: string) {},
  say(_text: string) {},
  toolLines(_results: string[]) {},
  attachment(_title: string, _digest: string) {},
  async confirm() { return false; },
  async chooseSession() { return null; },
  sessionOpened(_session) { opened++; },
};

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { runOperationText } = await import('../src/core/operations.js');
const { MANAGER_ID, parseManagerReply } = await import('../src/manager.js');
const { makeCompleter, hintRowsFor } = await import('../src/completion.js');

const { app } = await bootstrapApp();
const engine = new Engine(app, stub);
for (const p of app.providers.values()) p.provider = fakeProvider;
const signal = () => new AbortController().signal;
const run = (line: string): Promise<string[]> => runOperationText(engine, line);
const flushChain = () => (engine as unknown as { flushChain: Promise<void> }).flushChain;
const registry = () => loadProjectRegistry(paths.PROJECTS_FILE);

// старт: bootstrap запомнил папку запуска как текущий проект
{
  const reg = registry();
  check('старт: bootstrap записал папку запуска в реестр', reg.current === base && reg.projects.some((p) => p.path === base));
}

// разговор в стартовом проекте: 3 реплики = 6 сообщений (порог вливания памяти)
for (const text of ['сообщение один', 'сообщение два', 'сообщение три']) {
  await engine.handleMessage(text, signal());
}
check('старт: разговор в стартовом проекте набрал 6 сообщений', app.session.messages.length >= 6, String(app.session.messages.length));
const baseSessionId = app.session.id;

// ── смена проекта командой: по относительному пути ───────────────────────────
{
  const oldStore = app.store;
  const report = (await run('/project open p1'))[0] ?? '';
  check('project open: отчёт ✓', report.includes('✓') && report.includes(p1), report);
  check('project open: рабочий слой сменился', paths.WORKSPACE === p1 && paths.DT_PROJECT === join(p1, '.dreamteam'));
  check('project open: скаффолд .dreamteam создан', existsSync(join(p1, '.dreamteam', 'sessions')));
  // id разговоров метками секунд — в разных проектах могут совпасть, поэтому
  // подмену магазина проверяем по объекту и по файлу нового разговора на диске
  check(
    'project open: магазин подменён',
    app.store !== oldStore && existsSync(join(p1, '.dreamteam', 'sessions', `${app.session.id}.json`)),
  );
  check('project open: заметки оболочке (проект + разговор)', notices.some((n) => n.includes('Проект: ' + p1)) && opened > 0);
  const reg = registry();
  check('project open: реестр — p1 текущий', reg.current === p1 && reg.projects.some((p) => p.name === 'p1'));
}

// ── вливание памяти: в хранилище СТАРОГО проекта ────────────────────────────
{
  await flushChain();
  const oldFile = join(base, '.dreamteam', 'sessions', `${baseSessionId}.json`);
  const oldRaw = readFileSync(oldFile, 'utf8');
  const oldSession = JSON.parse(oldRaw) as { title?: string; digestInLog?: boolean };
  check('память: итоги старого разговора влиты (digestInLog на диске)', oldSession.digestInLog === true);
  check(
    'память: общий лог команды — в доме, с итогом старого разговора',
    existsSync(join(home, 'memory.json')) && readFileSync(join(home, 'memory.json'), 'utf8').includes(oldSession.title ?? ''),
  );
  check('память: новый проект не получил чужих разговоров', app.store.list().length === 1 && app.session.messages.length === 0);
}

// ── изоляция: hosts.json — по проектам, обзор — про текущий ─────────────────
{
  await run('/project host add prod=10.0.0.9');
  const hosts = JSON.parse(readFileSync(join(p1, '.dreamteam', 'hosts.json'), 'utf8')) as Record<string, { host?: string }>;
  check('изоляция: сервер записан в hosts.json нового проекта', hosts.prod?.host === '10.0.0.9');
  const lines = await run('/project');
  check('project: обзор — текущий с пометкой', lines.some((l) => l.includes('p1') && l.includes('← текущий')));
  check('project: обзор — стартовый проект в списке', lines.some((l) => l.includes(basename(base))));
  check('project: обзор — серверы текущего проекта', lines.some((l) => l.includes('prod: 10.0.0.9')));
}

// ── смена туда-обратно: по имени из реестра, «уже открыт», ошибки ───────────
{
  const report = (await run(`/project open ${p2}`))[0] ?? '';
  check('project open p2: сменился (абсолютный путь)', report.includes('✓') && paths.WORKSPACE === p2);
  const same = (await run('/project open .'))[0] ?? '';
  check('project open «.»: уже открыт', same.includes('уже открыт'), same);
  const back = (await run(`/project open ${basename(base)}`))[0] ?? '';
  check('project open: назад по имени из реестра', back.includes('✓') && paths.WORKSPACE === base);
  check('project open: разговор продолжился (тот же id)', app.session.id === baseSessionId);

  let threw = '';
  try { await run('/project open нет-такой-папки'); } catch (e) { threw = (e as Error).message; }
  check('project open: нет папки — ошибка вызывающему', threw.includes('нет папки проекта'), threw);
  check('project open: после ошибки проект не менялся', paths.WORKSPACE === base);
}

// ── /project add и /project remove ──────────────────────────────────────────
{
  const report = (await run('/project add p3'))[0] ?? '';
  check(
    'project add: запомнен без переключения',
    report.includes('✓') && registry().projects.some((p) => p.name === 'p3') && paths.WORKSPACE === base,
  );
  const dup = (await run('/project add p3'))[0] ?? '';
  check('project add: повтор — «уже в реестре»', dup.includes('уже в реестре'), dup);

  const gone = (await run('/project remove p3'))[0] ?? '';
  check('project remove: забыт', gone.includes('забыт') && !registry().projects.some((p) => p.name === 'p3'));
  let curThrew = '';
  try { await run(`/project remove ${basename(base)}`); } catch (e) { curThrew = (e as Error).message; }
  check('project remove: текущий не забыть', curThrew.includes('открыт сейчас') && registry().projects.some((p) => p.path === base), curThrew);
  let threw = '';
  try { await run('/project remove призрак'); } catch (e) { threw = (e as Error).message; }
  check('project remove: неизвестный — ошибка резолва', threw.includes('нет папки проекта'), threw);
}

// ── подсказки: имена проектов в Tab и панели ────────────────────────────────
{
  await run('/project add p3'); // вернём для проверки подсказок
  const ctx = {
    sessions: () => [],
    teamNames: () => [],
    chatAgents: () => [],
    providerIds: () => [],
    managerName: () => 'Менеджер',
    projectNames: () => registry().projects.map((p) => p.name),
  };
  // неоднозначному вводу Tab по дизайну не вставляет ничего (варианты в панели),
  // поэтому проверяем уникальный префикс: дополнение до полного имени
  const name = basename(base);
  const [hits] = makeCompleter(ctx)(`/project open ${name.slice(0, 9)}`);
  check('подсказки: Tab дополняет уникальное имя проекта', Array.isArray(hits) && hits[0] === name, JSON.stringify(hits));
  const rows = hintRowsFor('/project open ', ctx) ?? [];
  check('подсказки: панель показывает имена', rows.some((r) => r.includes('p3')), JSON.stringify(rows));
}

// ── менеджер: действие project.open ─────────────────────────────────────────
{
  const before = app.session;
  managerReplies.push('Переключаюсь.\n{"say":"Переключаюсь.","actions":[{"op":"project.open","path":"p2"}]}');
  await engine.handleMessage('@менеджер открой проект p2', signal());
  check('менеджер: проект открыт', paths.WORKSPACE === p2 && paths.DT_PROJECT === join(p2, '.dreamteam'));
  check(
    'менеджер: реплика сохранилась в СТАРЫЙ разговор',
    before.messages.some((m) => m.authorId === MANAGER_ID && m.text.includes('Переключаюсь на проект «p2»')),
  );
  check('менеджер: смена применена после реплики (pendingSwitches)', app.session !== before);
  check('менеджер: реестр — p2 текущий', registry().current === p2);
  check('менеджер: снимок знает известные проекты', requests.at(-1)?.user?.includes('Известные проекты') ?? false);

  // мусорный путь — ✗ в отчёте, смена не прошла
  const beforeFail = app.session;
  managerReplies.push('Не выйдет.\n{"say":"Не выйдет.","actions":[{"op":"project.open","path":"нет-такой-папки"}]}');
  await engine.handleMessage('@менеджер открой чушь', signal());
  check('менеджер: неверный путь — ✗, проект не менялся', paths.WORKSPACE === p2 && app.session.id === beforeFail.id);
  check('менеджер: отчёт об ошибке в разговоре', beforeFail.messages.some((m) => m.authorId === MANAGER_ID && m.text.includes('✗')));
}

// ── парсер: project.open с пустым путём отсеивается ─────────────────────────
{
  const r = parseManagerReply('{"say":"делаю","actions":[{"op":"project.open","path":"  "},{"op":"project.open","path":"ok"}]}');
  check(
    'парсер: пустой path отброшен, валидный остался',
    r.actions.length === 1 && (r.actions[0] as { path: string }).path === 'ok',
    JSON.stringify(r.actions),
  );
}

// ═══ 4. serve: rpc и state через WS ═══════════════════════════════════════════
type Client = {
  next(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  send(obj: unknown): void;
  close(): void;
};
function makeClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue: Record<string, unknown>[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];
    ws.on('error', reject);
    ws.on('message', (data: RawData) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
      queue.push(m);
    });
    ws.on('open', () =>
      resolve({
        next(pred, ms = 30_000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('событие не пришло')), ms);
            waiters.push({ pred, resolve: res, timer });
          });
        },
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: () => ws.close(),
      }),
    );
  });
}

type Snap = {
  project?: { path: string; name: string };
  knownProjects?: { path: string; name: string }[];
  sessions?: { id: string }[];
};

{
  const { startServe } = await import('../src/serve.js');
  // ядро фазы 3 осталось в p2 — serve стартует в нём и переключается по rpc
  const handle = await startServe({ port: 0 });
  const c = await makeClient(handle.port);
  const st0 = (await c.next((m) => m.type === 'state')).state as Snap;
  check('ws: state знает текущий проект', st0.project?.path === p2, JSON.stringify(st0.project));
  check('ws: state знает реестр проектов', (st0.knownProjects ?? []).some((p) => p.name === 'p2'));

  // project.add по rpc — без переключения
  c.send({ type: 'rpc', id: 'r1', method: 'project.add', args: { path: p4 } });
  const add = await c.next((m) => m.type === 'rpc_result' && m.id === 'r1');
  check('ws: project.add — отчёт', String((add.result as { text: string }).text).includes('✓'));
  const st1 = (await c.next((m) => m.type === 'state')).state as Snap;
  check('ws: project.add — в state.reестре', (st1.knownProjects ?? []).some((p) => p.name === 'p4'));
  check('ws: project.add — проект не менялся', st1.project?.path === p2);

  // project.open по rpc — смена и свежий state
  c.send({ type: 'rpc', id: 'r2', method: 'project.open', args: { name: 'p4' } });
  const open = await c.next((m) => m.type === 'rpc_result' && m.id === 'r2');
  check('ws: project.open — отчёт ✓', String((open.result as { text: string }).text).includes('✓'));
  const st2 = (await c.next((m) => m.type === 'state' && (m.state as Snap).project?.path === p4)).state as Snap;
  check('ws: project.open — state переключился', st2.project?.name === 'p4');
  check('ws: project.open — разговоры нового проекта', (st2.sessions ?? []).length === 1);

  // неверный путь — rpc_error
  c.send({ type: 'rpc', id: 'r3', method: 'project.open', args: { path: 'нет-такой-папки' } });
  const err = await c.next((m) => m.type === 'rpc_error' && m.id === 'r3');
  check('ws: project.open мимо — rpc_error с подсказкой', String(err.error).includes('нет папки проекта'), String(err.error));

  // смена обычной командой /project — тот же путь, что и в терминале
  c.send({ type: 'command', text: '/project open p2' });
  await c.next((m) => m.type === 'state' && (m.state as Snap).project?.path === p2);
  check('ws: /project open командой — работает', true);

  // /project обзор командой — заметки со списком доходят до клиента
  c.send({ type: 'command', text: '/project' });
  await c.next((m) => m.type === 'notice' && String(m.text).includes('← текущий'));
  check('ws: /project обзор — заметки со списком', true);

  // project.remove по rpc: текущий не забудется, чужой забудется
  c.send({ type: 'rpc', id: 'r4', method: 'project.remove', args: { name: 'p2' } });
  const rmCur = await c.next((m) => m.type === 'rpc_error' && m.id === 'r4');
  check('ws: project.remove текущего — отказ', String(rmCur.error).includes('открыт сейчас'), String(rmCur.error));
  c.send({ type: 'rpc', id: 'r5', method: 'project.remove', args: { name: 'p4' } });
  const rm = await c.next((m) => m.type === 'rpc_result' && m.id === 'r5');
  check('ws: project.remove — отчёт', String((rm.result as { text: string }).text).includes('забыт'));
  // из очереди может прийти и устаревший state — ждём именно свежий, без p4
  await c.next((m) => m.type === 'state' && !((m.state as Snap).knownProjects ?? []).some((p) => p.name === 'p4'));
  check('ws: project.remove — ушёл из state', true);

  c.close();
  await handle.close();
}

process.chdir(tmpdir()); // Windows не даёт удалить каталог процесса
rmTemp(base);
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
