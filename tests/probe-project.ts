/**
 * Управление проектами: проекты живут в доме (projects/<id>/), один уровень
 * владения, .dreamteam нигде не создаётся.
 *  - paths: старт «без проекта» (PROJECT_DIR и WORKSPACE пусты), живые
 *    привязки ESM — setProjectRoot/clearProjectRoot пересчитывают весь слой;
 *  - реестр = сами папки: createProject (рабочая папка создаётся), список
 *    (битые папки пропускаются), авто-регистрация открытой папки (суффикс
 *    «-2»), remove/rename/path, запрет рабочей папки внутри дома, резолв
 *    имени и пути;
 *  - команды ядра: старт без проекта — внятные подсказки вместо падений,
 *    /project new (создаёт и открывает), /project open (имя/путь/ошибки),
 *    /project rename, /project path, /project remove (текущий не удалить);
 *  - изоляция: разговоры и hosts (поле project.json) — по проектам, общая
 *    память и memory.json — в доме;
 *  - вливание памяти при смене проекта — в хранилище СТАРОГО проекта (фон не
 *    пишет в чужой магазин);
 *  - менеджер: действие project.open — реплика сохраняется в СТАРЫЙ разговор,
 *    смена применяется после (pendingSwitches); мусорный путь — ✗ без смены;
 *  - подсказки: projectNames из папок дома в completion (/project open <Tab>);
 *  - serve (WS): rpc project.list/new/open/remove/rename/path, поля
 *    state.project/knownProjects, смена командой «/project open …» — паритет
 *    TUI и GUI.
 * Герметично: временный DT_HOME, mock-провайдер, порт 0.
 * Запуск: npm run probe:project
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeModels } from './models.js';
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

// ── песочница: дом + папки рабочих областей во временной директории ──────────
const base = mkdtempSync(join(tmpdir(), 'dt-project-'));
const home = join(base, 'home');
const p1 = join(base, 'p1');
const p2 = join(base, 'p2');
const p3 = join(base, 'p3');
const p4 = join(base, 'p4');
const p5 = join(base, 'p5');
const p6 = join(base, 'p6');
mkdirSync(home, { recursive: true });
for (const d of [p1, p2]) mkdirSync(d, { recursive: true });
process.env.DT_HOME = home;
process.chdir(base);

writeModels(home, { mock: { adapter: 'mock' } });
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

// src-модули — строго после подмены слоёв: paths.ts вычисляет пути при загрузке
const paths = await import('../src/paths.js');
const projects = await import('../src/core/projects.js');

// ═══ 1. paths: старт без проекта и живые привязки ════════════════════════════
{
  check('paths: старт без проекта — PROJECT_DIR пуст', paths.PROJECT_DIR === '');
  check('paths: реестр — папка projects/ в доме', paths.PROJECTS_DIR === join(home, 'projects'));
  paths.setProjectRoot(join(home, 'projects', 'x'), p1);
  check(
    'paths: setProjectRoot пересчитал весь слой',
    paths.PROJECT_DIR === join(home, 'projects', 'x') &&
      paths.PROJECT_FILE === join(home, 'projects', 'x', 'project.json') &&
      paths.SESSIONS_DIR === join(home, 'projects', 'x', 'sessions') &&
      paths.WORKSPACE === p1,
  );
  paths.setProjectRoot(join(home, 'projects', 'x'), '');
  check('paths: пустая рабочая папка — WORKSPACE пуст', paths.WORKSPACE === '' && paths.PROJECT_FILE !== '');
  paths.clearProjectRoot();
  check(
    'paths: clearProjectRoot — снова «без проекта»',
    paths.PROJECT_DIR === '' && paths.PROJECT_FILE === '' && paths.WORKSPACE === '' && paths.SESSIONS_DIR === '',
  );
}

// ═══ 2. реестр = папки: create/list/register/remove/rename/path/резолв ═══════
{
  const made = join(base, 'made');
  const cfg = projects.createProject('maker', made);
  check(
    'create: папка проекта в доме, project.json на месте',
    existsSync(join(home, 'projects', 'maker', 'project.json')),
  );
  check('create: рабочая папка создана на диске', existsSync(made));
  check(
    'create: поля секретов пустые объекты',
    cfg.id === 'maker' && cfg.path === made && Object.keys(cfg.hosts).length === 0 && Object.keys(cfg.mails).length === 0,
  );

  let threw = '';
  try { projects.createProject('maker', p1); } catch (e) { threw = (e as Error).message; }
  check('create: повтор — «уже есть» с подсказкой open', threw.includes('уже есть') && threw.includes('/project open'), threw);

  for (const bad of ['', 'a b', 'a/b', '.hidden', 'a'.repeat(65)]) {
    threw = '';
    try { projects.validateProjectId(bad); } catch (e) { threw = (e as Error).message; }
    check(`validate: «${bad.length > 10 ? `${bad.length} симв.` : bad || '(пусто)'}» — отказ`, threw.includes('имя проекта'), threw);
  }

  mkdirSync(join(home, 'projects', 'broken'), { recursive: true });
  const ids = () => projects.listProjects().map((p) => p.id);
  check('list: битая папка без project.json пропущена', ids().includes('maker') && !ids().includes('broken'));

  check('register: id из имени папки', projects.registerWorkspace(p2).id === 'p2');
  check('register: коллизия — суффикс «-2»', projects.registerWorkspace(p2).id === 'p2-2');
  const messy = join(base, 'my work');
  mkdirSync(messy, { recursive: true });
  check('register: пробелы и точки вычищены', projects.registerWorkspace(messy).id === 'my-work');

  threw = '';
  try { projects.checkWorkspacePath(join(home, 'inner')); } catch (e) { threw = (e as Error).message; }
  check('path: рабочая папка внутри дома запрещена', threw.includes('внутри дома'), threw);

  threw = '';
  try { projects.removeProject('призрак', ''); } catch (e) { threw = (e as Error).message; }
  check('remove: неизвестный — «нет — см. /project»', threw.includes('нет — см. /project'), threw);

  projects.renameProject('p2-2', 'p2x');
  check('rename: папка переименована, id обновлён', existsSync(join(home, 'projects', 'p2x')) && projects.loadProjectConfig('p2x')?.id === 'p2x');
  threw = '';
  try { projects.renameProject('p2x', 'p2'); } catch (e) { threw = (e as Error).message; }
  check('rename: на занятое имя — отказ', threw.includes('уже есть'), threw);

  const cfgP2 = projects.loadProjectConfig('p2')!;
  const fresh = join(base, 'fresh-ws');
  projects.setProjectPath(cfgP2, fresh);
  check('path: папка создана и записана', existsSync(fresh) && projects.loadProjectConfig('p2')?.path === fresh);
  threw = '';
  try { projects.setProjectPath(cfgP2, join(home, 'inner2')); } catch (e) { threw = (e as Error).message; }
  check('path: внутрь дома — отказ', threw.includes('внутри дома'), threw);

  const target = projects.resolveProjectTarget('MAKER', base);
  check('резолв: имя проекта (регистр не важен)', target.config.id === 'maker' && !target.created);
  const abs = projects.resolveProjectTarget(p2, base);
  check('резолв: известный путь — без регистрации', abs.config.path === p2 && !abs.created);
  const unknownDir = join(base, 'fresh-dir');
  mkdirSync(unknownDir, { recursive: true });
  const reg = projects.resolveProjectTarget(unknownDir, base);
  check('резолв: незнакомая папка — авто-регистрация', reg.created && reg.config.id === 'fresh-dir');
  check('резолв: авто-регистрация запомнила путь', reg.config.path === unknownDir);
  threw = '';
  try { projects.resolveProjectTarget('нет-такого', base); } catch (e) { threw = (e as Error).message; }
  check('резолв: неизвестное имя — подсказка /project new', threw.includes('/project new'), threw);
  threw = '';
  try { projects.resolveProjectTarget('  ', base); } catch (e) { threw = (e as Error).message; }
  check('резолв: пустой аргумент — подсказка', threw.includes('/project open'), threw);

  // приберём тестовые проекты — фаза 3 живёт в чистом доме
  for (const id of ['maker', 'p2', 'p2x', 'my-work', 'fresh-dir']) projects.removeProject(id, '');
  rmSync(join(home, 'projects', 'broken'), { recursive: true, force: true });
  check('уборка: реестр пуст', projects.listProjects().length === 0);
}

// ═══ 3. ядро: старт без проекта, команды, изоляция, менеджер ═════════════════
// скриптовый LLM: менеджерские ходы — из очереди, остальное — болтовня
const managerReplies: string[] = [];
const fakeProvider: LLMProvider = {
  id: 'mock',
  kind: 'mock',
  model: 'scripted',
  async *stream(req: StreamRequest) {
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
for (const p of app.models.values()) p.provider = fakeProvider;
const signal = () => new AbortController().signal;
const run = (line: string): Promise<string[]> => runOperationText(engine, line);
const flushChain = () => (engine as unknown as { flushChain: Promise<void> }).flushChain;

// старт: приложение без проекта, но не падает
{
  check('старт: bootstrap не выбрал проект', app.store === null && app.session === null);
  const hint = (await run('/sessions'))[0] ?? '';
  check('гейт: /sessions без проекта — подсказка', hint.includes('нет открытого проекта') && hint.includes('/project new'), hint);
  const gate = (await run('/project host add x=1.2.3.4'))[0] ?? '';
  check('гейт: секреты без проекта — та же подсказка', gate.includes('нет открытого проекта'), gate);
  const list = await run('/project');
  check('обзор: работает и без проекта', list.some((l) => l.includes('/project new')), list.join(' | '));
}

// ── project new: создаёт проект в доме, рабочую папку и открывает ────────────
{
  const report = (await run(`/project new alpha ${p1}`))[0] ?? '';
  check('project new: отчёт ✓ с путём', report.includes('✓') && report.includes('alpha'), report);
  check(
    'project new: слой путей в новом проекте',
    paths.PROJECT_DIR === join(home, 'projects', 'alpha') && paths.WORKSPACE === p1,
  );
  check('project new: разговор создан в projects/alpha/sessions', existsSync(join(paths.SESSIONS_DIR, `${app.session?.id}.json`)));
  const cfg = JSON.parse(readFileSync(join(home, 'projects', 'alpha', 'project.json'), 'utf8')) as { id?: string };
  check('project new: project.json знает id', cfg.id === 'alpha');
  check('project new: заметки оболочке (проект + разговор)', notices.some((n) => n.includes('Проект:')) && opened > 0);
  // маркер рабочей папки: удаление проекта из дома не трогает файлы работы
  writeFileSync(join(p1, 'файл-работы.txt'), 'рабочие файлы не принадлежат приложению');
  // второй проект — для смен (без открытия)
  projects.createProject('beta', p2);
}

// разговор в alpha: 3 реплики = 6 сообщений (порог вливания памяти)
for (const text of ['сообщение один', 'сообщение два', 'сообщение три']) {
  await engine.handleMessage(text, signal());
}
check('чат: разговор в alpha набрал 6 сообщений', (app.session?.messages.length ?? 0) >= 6);
const alphaSessionId = app.session?.id ?? '';

// ── изоляция: hosts — поле project.json проекта ──────────────────────────────
{
  await run('/project host add prod=10.0.0.9');
  const cfg = JSON.parse(readFileSync(join(home, 'projects', 'alpha', 'project.json'), 'utf8')) as {
    hosts?: Record<string, { host?: string }>;
  };
  check('изоляция: сервер в поле hosts проекта', cfg.hosts?.prod?.host === '10.0.0.9');
  const lines = await run('/project');
  check('project: обзор — текущий с пометкой', lines.some((l) => l.includes('alpha') && l.includes('← текущий')));
  check('project: обзор — beta в списке', lines.some((l) => l.includes('beta')));
  check('project: обзор — серверы текущего проекта', lines.some((l) => l.includes('prod: 10.0.0.9')));
}

// ── смена проекта: вливание памяти в СТАРЫЙ проект, свежий магазин ───────────
{
  const oldStore = app.store;
  const report = (await run('/project open beta'))[0] ?? '';
  check('project open beta: отчёт ✓', report.includes('✓') && report.includes('beta'), report);
  check('project open: рабочий слой сменился', paths.PROJECT_DIR === join(home, 'projects', 'beta') && paths.WORKSPACE === p2);
  check('project open: магазин подменён', app.store !== oldStore && (app.session?.messages.length ?? -1) === 0);

  await flushChain();
  const oldRaw = JSON.parse(readFileSync(join(home, 'projects', 'alpha', 'sessions', `${alphaSessionId}.json`), 'utf8')) as {
    title?: string;
    digestInLog?: boolean;
  };
  check('память: итоги старого разговора влиты (digestInLog в alpha)', oldRaw.digestInLog === true);
  check(
    'память: общий лог команды — в доме, с итогом старого разговора',
    existsSync(join(home, 'memory.json')) && readFileSync(join(home, 'memory.json'), 'utf8').includes(oldRaw.title ?? ''),
  );
}

// ── смена туда-обратно: «уже открыт», по имени, ошибки ───────────────────────
{
  const same = (await run('/project open beta'))[0] ?? '';
  check('project open: повтор — «уже открыт»', same.includes('уже открыт'), same);
  const back = (await run('/project open alpha'))[0] ?? '';
  check('project open: назад по имени', back.includes('✓') && paths.WORKSPACE === p1);
  check('project open: разговор продолжился (тот же id)', app.session?.id === alphaSessionId);

  let threw = '';
  try { await run('/project open нет-такого'); } catch (e) { threw = (e as Error).message; }
  check('project open: нет проекта — ошибка с подсказкой new', threw.includes('/project new'), threw);
  check('project open: после ошибки проект не менялся', paths.WORKSPACE === p1);
}

// ── rename и path текущего, remove ───────────────────────────────────────────
{
  const rn = (await run('/project rename gamma'))[0] ?? '';
  check(
    'rename: папка и слой путей переехали',
    rn.includes('gamma') &&
      paths.PROJECT_DIR === join(home, 'projects', 'gamma') &&
      existsSync(join(home, 'projects', 'gamma', 'project.json')),
    rn,
  );
  const list = await run('/project');
  check('rename: обзор показывает новое имя текущим', list.some((l) => l.includes('gamma') && l.includes('← текущий')));

  await run('/project open beta');
  const rp = (await run(`/project path ${p3}`))[0] ?? '';
  check('path: папка создана, WORKSPACE переехал', rp.includes('✓') && paths.WORKSPACE === p3 && existsSync(p3), rp);
  const cfg = JSON.parse(readFileSync(join(home, 'projects', 'beta', 'project.json'), 'utf8')) as { path?: string };
  check('path: project.json обновлён', cfg.path === p3);

  let curThrew = '';
  try { await run('/project remove beta'); } catch (e) { curThrew = (e as Error).message; }
  check('remove: текущий не удалить', curThrew.includes('открыт сейчас'), curThrew);
  const gone = (await run('/project remove gamma'))[0] ?? '';
  check(
    'remove: проект удалён из дома, рабочая папка цела',
    gone.includes('удалён из дома') &&
      !existsSync(join(home, 'projects', 'gamma')) &&
      existsSync(join(p1, 'файл-работы.txt')),
    gone,
  );
  let threw = '';
  try { await run('/project remove призрак'); } catch (e) { threw = (e as Error).message; }
  check('remove: неизвестный — ошибка резолва', threw.includes('нет — см. /project'), threw);
}

// ── подсказки: имена проектов из папок дома ──────────────────────────────────
{
  const ctx = {
    sessions: () => [],
    teamNames: () => [],
    chatAgents: () => [],
    modelIds: () => [],
    managerName: () => 'Менеджер',
    projectNames: () => projects.listProjects().map((p) => p.id),
  };
  const [hits] = makeCompleter(ctx)('/project open be');
  check('подсказки: Tab дополняет имя проекта', Array.isArray(hits) && hits[0] === 'beta', JSON.stringify(hits));
  const rows = hintRowsFor('/project open ', ctx) ?? [];
  check('подсказки: панель показывает имена', rows.some((r) => r.includes('beta')), JSON.stringify(rows));
}

// ── менеджер: действие project.open ──────────────────────────────────────────
{
  projects.createProject('delta', p4);
  const before = app.session;
  managerReplies.push('Переключаюсь.\n{"say":"Переключаюсь.","actions":[{"op":"project.open","path":"delta"}]}');
  await engine.handleMessage('@менеджер открой проект delta', signal());
  check('менеджер: проект открыт', paths.PROJECT_DIR === join(home, 'projects', 'delta') && paths.WORKSPACE === p4);
  check(
    'менеджер: реплика сохранилась в СТАРЫЙ разговор',
    (before?.messages ?? []).some((m) => m.authorId === MANAGER_ID && m.text.includes('Переключаюсь на проект «delta»')),
  );
  check('менеджер: смена применена после реплики (pendingSwitches)', app.session !== before);

  // текущий путь — «и так открыт», без смены
  const same = app.session;
  managerReplies.push('Уже здесь.\n{"say":"Уже здесь.","actions":[{"op":"project.open","path":"' + p4.replace(/\\/g, '\\\\') + '"}]}');
  await engine.handleMessage('@менеджер открой ту же папку', signal());
  check(
    'менеджер: текущий проект — «и так открыт», без смены',
    (same?.messages ?? []).some((m) => m.text.includes('и так открыт')) && app.session === same,
  );

  // мусорный путь — ✗ в отчёте, смена не прошла
  const beforeFail = app.session;
  managerReplies.push('Не выйдет.\n{"say":"Не выйдет.","actions":[{"op":"project.open","path":"нет-такой-папки"}]}');
  await engine.handleMessage('@менеджер открой чушь', signal());
  check('менеджер: неверный путь — ✗, проект не менялся', paths.WORKSPACE === p4 && app.session?.id === beforeFail?.id);
  check('менеджер: отчёт об ошибке в разговоре', (beforeFail?.messages ?? []).some((m) => m.authorId === MANAGER_ID && m.text.includes('✗')));
}

// ── парсер: project.open с пустым путём отсеивается ──────────────────────────
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
  project?: { id: string; name: string; path: string } | null;
  knownProjects?: { name: string; path: string }[];
  sessions?: { id: string }[];
};
const rpc = (c: Client, id: string, method: string, args: Record<string, unknown> = {}): void =>
  c.send({ type: 'rpc', id, method, args });

{
  const { startServe } = await import('../src/serve.js');
  // ядро фазы 3 осталось в delta — serve стартует в нём и переключается по rpc
  const handle = await startServe({ port: 0 });
  const c = await makeClient(handle.port);
  const st0 = (await c.next((m) => m.type === 'state')).state as Snap;
  check('ws: state знает текущий проект', st0.project?.id === 'delta' && st0.project?.path === p4, JSON.stringify(st0.project));
  check('ws: state знает проекты дома', (st0.knownProjects ?? []).some((p) => p.name === 'beta') && (st0.knownProjects ?? []).some((p) => p.name === 'delta'));

  rpc(c, 'r0', 'project.list');
  const lst = await c.next((m) => m.type === 'rpc_result' && m.id === 'r0');
  const known = (lst.result as { known: { name: string }[]; current: { id: string } | null }).known;
  check('ws: project.list — список и текущий', known.some((p) => p.name === 'beta') && (lst.result as { current: { id: string } }).current?.id === 'delta');

  // project.new по rpc — создание и сразу открытие
  rpc(c, 'r1', 'project.new', { name: 'eps', path: p5 });
  const created = await c.next((m) => m.type === 'rpc_result' && m.id === 'r1');
  check('ws: project.new — отчёт ✓', String((created.result as { text: string }).text).includes('✓'));
  const st1 = (await c.next((m) => m.type === 'state' && (m.state as Snap).project?.id === 'eps')).state as Snap;
  check('ws: project.new — state переключился на новый', st1.project?.path === p5 && existsSync(join(home, 'projects', 'eps')));

  // project.open по имени — возврат в delta
  rpc(c, 'r2', 'project.open', { name: 'delta' });
  const open = await c.next((m) => m.type === 'rpc_result' && m.id === 'r2');
  check('ws: project.open — отчёт ✓', String((open.result as { text: string }).text).includes('✓'));
  await c.next((m) => m.type === 'state' && (m.state as Snap).project?.id === 'delta');
  check('ws: project.open — вернулись в delta', true);

  // неизвестное имя: смена идёт через runRound — ошибка уходит событием error,
  // rpc завершается обычным результатом (GUI покажет ✗ в журнале)
  rpc(c, 'r3', 'project.open', { name: 'нет-такого' });
  const res3 = await c.next((m) => m.type === 'rpc_result' && m.id === 'r3');
  check('ws: project.open мимо — rpc завершился', typeof (res3.result as { text?: string }).text === 'string');
  const errEv = await c.next((m) => m.type === 'error' && String(m.text).includes('нет проекта'));
  check('ws: project.open мимо — событие error с подсказкой', String(errEv.text).includes('/project new'), String(errEv.text));

  // rename текущего
  rpc(c, 'r4', 'project.rename', { name: 'delta2' });
  const r4 = await c.next((m) => (m.type === 'rpc_result' || m.type === 'rpc_error') && m.id === 'r4');
  check('ws: project.rename — отчёт ✓', r4.type === 'rpc_result' && String((r4.result as { text: string }).text).includes('delta2'), String(r4.error ?? (r4.result as { text: string }).text));

  // path текущего
  rpc(c, 'r5', 'project.path', { path: p6 });
  await c.next((m) => m.type === 'rpc_result' && m.id === 'r5');
  const st5 = (await c.next((m) => m.type === 'state' && (m.state as Snap).project?.path === p6)).state as Snap;
  check('ws: project.path — state с новой рабочей папкой', st5.project?.path === p6);

  // remove: текущий не удалится, чужой удалится
  rpc(c, 'r6', 'project.remove', { name: 'delta2' });
  const rmCur = await c.next((m) => m.type === 'rpc_error' && m.id === 'r6');
  check('ws: project.remove текущего — отказ', String(rmCur.error).includes('открыт сейчас'), String(rmCur.error));
  rpc(c, 'r7', 'project.remove', { name: 'eps' });
  const rm = await c.next((m) => m.type === 'rpc_result' && m.id === 'r7');
  check('ws: project.remove — отчёт', String((rm.result as { text: string }).text).includes('удалён из дома'));
  // из очереди может прийти и устаревший state — ждём именно свежий, без eps
  await c.next((m) => m.type === 'state' && !((m.state as Snap).knownProjects ?? []).some((p) => p.name === 'eps'));
  check('ws: project.remove — ушёл из state', true);

  // смена обычной командой /project — тот же путь, что и в терминале
  c.send({ type: 'command', text: '/project open beta' });
  await c.next((m) => m.type === 'state' && (m.state as Snap).project?.id === 'beta');
  check('ws: /project open командой — работает', true);

  // /project обзор командой — заметки со списком доходят до клиента
  c.send({ type: 'command', text: '/project' });
  await c.next((m) => m.type === 'notice' && String(m.text).includes('← текущий'));
  check('ws: /project обзор — заметки со списком', true);

  c.close();
  await handle.close();
}

process.chdir(tmpdir()); // Windows не даёт удалить каталог процесса
rmTemp(base);
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
