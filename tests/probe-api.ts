/**
 * Проверка локального API (dreamteam serve) без LLM и терминала:
 *  - HTTP: /health, статика 404 до появления gui-dist/;
 *  - WS: первичный state, раунд через mock-провайдера (менеджер: team.add,
 *    chat.add, статус), rpc (sessions.list, session.new с приветствием,
 *    session.agent.add/delete, settings.update, session.delete, неизвестный метод);
 *  - rpc-операции GUI: агент и его тула, свои тула, модель, переименование
 *    проекта, серверы/почта/боты проекта, авто-режим, fs.dirs, session.update/
 *    close, schedule.toggle мимо, manager.update; снимок проекта с хостами,
 *    ящиками (пароль — только флагом) и ботами;
 *  - экспорт четырёх уровней и импорт с живым подтверждением (отмена и
 *    применение), отказы на чужих архивах;
 *  - http: /api/upload без открытого проекта — 404; сервер с TOKEN —
 *    авторизация первым сообщением, проект из аргументов запуска;
 *  - ServerPresenter: вопрос без клиентов — сразу отказ, ответ клиента —
 *    подтверждение, выбор разговора, таймаут-отказ.
 *
 * Герметичность: DT_HOME выставляется до импорта serve (пути замораживаются
 * на импорте) во временный каталог; сервер — на порту 0; проект открывается
 * rpc-ом, тем же ходом, что и GUI.
 * Запуск: npm run probe:api
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { rmTemp } from './rm-tmp.js';
import { writeModels } from './models.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- песочница: дом во временном каталоге, провайдер только mock ---
const base = mkdtempSync(join(tmpdir(), 'dt-api-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true }); // project.open открывает существующую папку (создание — project.new)
process.env.DT_HOME = home;
// рабочая папка инструментов = cwd на момент импорта: уводим процесс в tmp,
// чтобы mock-демонстрация писала файлы в песочницу, а не в репозиторий
process.chdir(base);
writeModels(home, { mock: { provider: 'mock' } }, 'mock');
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

const { startServe, ServerPresenter } = await import('../src/serve.js');

/** WS-клиент с очередью событий и поиском по предикату. */
function makeClient(port: number): Promise<{
  send(obj: unknown): void;
  sendRaw(s: string): void;
  next(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  stateCount(): number;
  waitState(n: number, ms?: number): Promise<void>;
  raw(): Record<string, unknown>[];
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue: Record<string, unknown>[] = [];
    let waiters: {
      pred: (m: Record<string, unknown>) => boolean;
      resolve: (m: Record<string, unknown>) => void;
      timer: NodeJS.Timeout;
    }[] = [];
    let states = 0; // счётчик state-событий: конец раунда = «state №N пришёл»
    let lastState: Record<string, unknown> | null = null;
    const trace: string[] = [];
    let opened = false;
    ws.on('error', (e) => {
      if (!opened) reject(e);
      else trace.push(`ОШИБКА:${(e as Error).message}`);
    });
    ws.on('close', (code) => trace.push(`ЗАКРЫТ:${code}`));
    ws.on('message', (data: RawData) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(data)) as Record<string, unknown>;
      } catch (err) {
        trace.push(`НЕ-JSON:${String(data).length}б:${err instanceof Error ? err.message.slice(0, 60) : ''}`);
        return;
      }
      trace.push(String(m.type));
      if (trace.length > 25) trace.shift();
      if (m.type === 'state') {
        states++;
        lastState = m;
      }
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
      queue.push(m);
    });
    ws.on('open', () => {
      opened = true;
      resolve({
        send: (obj) => ws.send(JSON.stringify(obj)),
        sendRaw: (s: string) => ws.send(s),
        // mock печатает с задержкой на токен — раунды не мгновенные, ждём щедро
        next(pred, ms = 30_000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('ждать нечего: событие не пришло')), ms);
            waiters.push({ pred, resolve: res, timer });
          });
        },
        stateCount: () => states,
        // дождаться state №n (конец раунда, начавшегося после «states === n-1»)
        async waitState(n: number, ms = 30_000) {
          const t0 = Date.now();
          while (states < n) {
            if (Date.now() - t0 > ms) {
              let health = 'fetch упал';
              try {
                health = String((await (await fetch(`http://127.0.0.1:${port}/health`)).status));
              } catch (e) {
                health = `fetch упал: ${e instanceof Error ? e.message : e}`;
              }
              const tail = queue.slice(-8).map((e) => {
                const brief = JSON.stringify({ ...e, state: undefined }) ?? '';
                return `${String(e.type)}:${brief.length > 220 ? `${brief.slice(0, 220)}…` : brief}`;
              });
              throw new Error(`state №${n} не пришёл за ${ms} мс (health=${health}, states=${states}, ws=${ws.readyState}, сессий=${JSON.stringify((lastState?.state as { sessions?: unknown[] })?.sessions?.length)} сообщ=${JSON.stringify((lastState?.state as { session?: { messages?: unknown[] } })?.session?.messages?.length)}, след: ${trace.join(',')}), хвост: ${tail.join(' | ')})`);
            }
            await new Promise((r) => setTimeout(r, 50));
          }
        },
        raw: () => queue,
        close: () => ws.close(),
      });
    },
  );
  });
}

const handle = await startServe({ port: 0 });

// --- HTTP ---
{
  const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
  check('http: /health отвечает ok', health.status === 200 && ((await health.json()) as { ok: boolean }).ok === true);
  const missing = await fetch(`http://127.0.0.1:${handle.port}/no-such-file.js`);
  check('http: нет файла — 404', missing.status === 404);
  const index = await fetch(`http://127.0.0.1:${handle.port}/`);
  check('http: / отдаёт оболочку (text/html)', index.status === 200 && (index.headers.get('content-type') ?? '').includes('text/html'));
  // ассеты оболочки берём из отработанного index: vanilla gui/ ссылается на
  // app.js/style.css, собранный gui-dist/ — на /assets/index-*.js/css
  const assets = [...(await index.text()).matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const jsHref = assets.find((a) => a.endsWith('.js'));
  const cssHref = assets.find((a) => a.endsWith('.css'));
  check('http: оболочка ссылается на js- и css-ассеты', Boolean(jsHref && cssHref));
  for (const [href, mime] of [[jsHref, 'javascript'], [cssHref, 'text/css']] as const) {
    if (!href) continue;
    const res = await fetch(`http://127.0.0.1:${handle.port}/${href.replace(/^\//, '')}`);
    check(`http: ассет ${href} отдаётся (${mime})`, res.status === 200 && (res.headers.get('content-type') ?? '').includes(mime));
  }
  const escape = await fetch(`http://127.0.0.1:${handle.port}/../package.json`);
  check('http: выход за gui/ не проходит', escape.status === 403 || escape.status === 404);
  const deep = await fetch(`http://127.0.0.1:${handle.port}/deep/nested.css`);
  check('http: вложенный путь — 404', deep.status === 404);
  const trav = await fetch(`http://127.0.0.1:${handle.port}/..%2F..%2Fpackage.json`);
  check('http: закодированный «..» — не проходит', trav.status === 404 || trav.status === 403);
  const dotdot = await fetch(`http://127.0.0.1:${handle.port}/%2e%2e/package.json`);
  check('http: %2e%2e — не проходит', dotdot.status === 404 || dotdot.status === 403);
  const healthType = await fetch(`http://127.0.0.1:${handle.port}/health`);
  check('http: /health — json', (healthType.headers.get('content-type') ?? '').includes('application/json'));
}

// --- WS: консьерж-сценарий на mock-провайдере ---
const client = await makeClient(handle.port);
{
  const first = await client.next((m) => m.type === 'state');
  const st0 = first.state as { session?: unknown; project?: unknown; knownProjects?: unknown; team?: unknown[]; teamError?: string | null; models?: { id: string; isDefault: boolean }[] };
  // старт без проекта: ни разговора, ни проекта — GUI обязан показать выбор проекта
  check('ws: старт без проекта — session и project пусты', st0.session === null && st0.project === null, JSON.stringify({ session: st0.session, project: st0.project }));
  check('ws: известные проекты дома — пустой список', Array.isArray(st0.knownProjects) && st0.knownProjects.length === 0);
  const st0team = (st0.team ?? []) as { id: string }[];
  check('ws: стартовая команда — пять агентов', st0team.length === 5, JSON.stringify(st0team.map((a) => a.id)));
  check(
    'ws: ids стартовой команды',
    ['analyst', 'secretary', 'developer', 'designer', 'writer'].every((id) => st0team.some((a) => a.id === id)),
    JSON.stringify(st0team.map((a) => a.id)),
  );
  check('ws: нет agents/ — без ошибки в state', st0.teamError == null);
  check('ws: модель mock — основная', (st0.models ?? []).some((p) => p.id === 'mock' && p.isDefault));

  // открываем проект rpc-ом — тем же ходом, что и GUI (папка не была
  // зарегистрирована — авто-регистрация; пустой разговор создаётся сам)
  client.send({ type: 'rpc', id: 'open0', method: 'project.open', args: { path: proj } });
  // пустой разговор — консьерж здоровается сам (как на старте терминала)
  await client.next((m) => m.type === 'say' && String(m.text).includes('менеджер переговорки'));
  const opened = await client.next(
    (m) => m.type === 'state' && (m.state as { session?: { messages: unknown[] } | null }).session?.messages.length === 1,
  );
  const stOpen = opened.state as { project: { id: string } | null; session: { messages: unknown[] } };
  check('ws: project.open — разговор создан, консьерж поздоровался', stOpen.project?.id === 'proj' && stOpen.session.messages.length === 1, JSON.stringify(stOpen.project));

  client.send({ type: 'hello' });
  const again = await client.next((m) => m.type === 'state');
  check('ws: hello возвращает свежий state', Boolean((again.state as { session?: unknown }).session));

  // первая реплика уходит менеджеру: mock исполняет team.add Тест
  client.send({ type: 'user_message', text: 'привет, команда' });
  const header = await client.next((m) => m.type === 'turn_header');
  check('ws: заголовок реплики менеджера', (header.agent as { name: string }).name === 'Менеджер');
  const say = await client.next((m) => m.type === 'say');
  check('ws: менеджер ответил заготовкой', String(say.text).includes('Позываю'));
  const report = await client.next((m) => m.type === 'notice' && String(m.text).includes('Тест'));
  check('ws: отчёт о действии пришёл', String(report.text).includes('Тест'));
  // ждём состояние ПОСЛЕ раунда: «Тест» уже в команде (промежуточные state
  // раунда насеяны в очередь — по сообщениям только не отличить)
  const state1 = await client.next(
    (m) => m.type === 'state' && (m.state as { team: { id: string }[] }).team.some((a) => a.id === 'test_probe'),
  );
  const st1 = state1.state as { session: { messages: { authorId: string }[] }; team: { id: string }[] };
  check('ws: реплика менеджера в истории', st1.session.messages.some((m) => m.authorId === 'manager'));
  check('ws: «Тест» появился в команде', st1.team.some((a) => a.id === 'test_probe'));
  check('ws: agents/ дома получил карточку «Теста»', existsSync(join(home, 'agents', 'test_probe.json')));

  // chat.add менеджером (обращение явное: в чате уже есть Тест — без @ раунд ушёл бы модератору)
  client.send({ type: 'user_message', text: '!менеджер, позови Теста в чат' });
  const joined = await client.next(
    (m) =>
      m.type === 'state' &&
      (m.state as { session: { messages: { authorId: string; text: string }[] } }).session.messages.some(
        (mm) => mm.authorId === 'manager' && mm.text.includes('присоединился к чат'),
      ),
  );
  check(
    'ws: chat.add исполнен — событием в хронике, не заметкой',
    Boolean(joined),
  );

  // статус команды — менеджер отвечает без действий
  client.send({ type: 'user_message', text: '@менеджер, дай статус команды' });
  const status = await client.next((m) => m.type === 'say' && String(m.text).includes('Команда на месте'));
  check('ws: статус команды — ответ без действий', Boolean(status));

  // --- WS: команды через протокол (тот же набор, что и в терминале) ---
  {
    const stateCmd = await client.next(
      (m) => m.type === 'state' && Boolean((m.state as { completion?: { operations?: unknown[] } }).completion),
    );
    const commands = (stateCmd.state as { completion: { operations: { cmd: string }[] } }).completion.operations;
    check('ws: state несёт манифест операций', commands.length > 0 && commands.some((c) => c.cmd === '/session open'));

    client.send({ type: 'rpc', id: 'rc0', method: 'state' });
    const snap = await client.next((m) => m.type === 'rpc_result' && m.id === 'rc0');
    const beforeCmd = (snap.result as { session: { messages: unknown[] } }).session.messages.length;
    client.send({ type: 'command', text: '/help' });
    const help = await client.next((m) => m.type === 'notice' && String(m.text).includes('/session new'));
    check('ws: /help — справка notice-событием', Boolean(help));
    const stHelp = await client.next((m) => m.type === 'state');
    check(
      'ws: команды не пишутся в историю',
      (stHelp.state as { session: { messages: unknown[] } }).session.messages.length === beforeCmd,
    );

    client.send({ type: 'command', text: '/session agent add test_probe' });
    const again = await client.next((m) => m.type === 'notice' && String(m.text).includes('уже в чате'));
    check('ws: /session agent add — отчёт о составе чата', Boolean(again));
    const sAdd = client.stateCount();
    client.send({ type: 'command', text: '/foobar' });
    const unknown = await client.next((m) => m.type === 'notice' && String(m.text).includes('Неизвестная команда'));
    check('ws: неизвестная команда — отказ', Boolean(unknown));
    await client.waitState(sAdd + 1); // оба раунда (/add и /foobar) закрылись
    const sExit = client.stateCount();
    client.send({ type: 'command', text: '/exit' });
    const tui = await client.next((m) => m.type === 'notice' && String(m.text).includes('терминала'));
    check('ws: /exit — только терминал', Boolean(tui));
    await client.waitState(sExit + 1);

    client.send({ type: 'command', text: '/profile update name=Иванов role=инженер' });
    const stMe = await client.next(
      (m) => m.type === 'state' && (m.state as { profile: { name: string } }).profile.name === 'Иванов',
    );
    check('ws: /profile update меняет профиль в state', ((stMe.state as { profile: { role?: string } }).profile.role) === 'инженер');

    // user_message с `/…` исполняется так же (перехват в ядре)
    client.send({ type: 'user_message', text: '/models' });
    const prov = await client.next((m) => m.type === 'notice' && String(m.text).includes('• mock'));
    check('ws: /… в user_message тоже команда', Boolean(prov));
    await client.next((m) => m.type === 'state');
  }

  // rpc: список разговоров
  client.send({ type: 'rpc', id: 'r1', method: 'sessions.list' });
  const list = await client.next((m) => m.type === 'rpc_result' && m.id === 'r1');
  check('rpc: список разговоров', ((list.result as { sessions: unknown[] }).sessions.length === 1));
  const firstId = (list.result as { sessions: { id: string }[] }).sessions[0].id;

  // rpc: новый разговор — приветствие консьержа
  client.send({ type: 'rpc', id: 'r2', method: 'session.new' });
  const greeted = await client.next((m) => m.type === 'say' && String(m.text).includes('менеджер переговорки'));
  check('rpc: session.new — приветствие консьержа', Boolean(greeted));
  const st2 = await client.next(
    (m) => m.type === 'state' && (m.state as { session: { messages: unknown[] } }).session.messages.length === 1,
  );
  const sess2 = (st2.state as { session: { id: string; messages: unknown[] } }).session;
  check('rpc: session.new — разговор сменился', Boolean(sess2.id));
  check('rpc: session.new — новый разговор пуст, кроме приветствия', sess2.messages.length === 1);

  // rpc: состав чата туда-обратно; state берём свежим rpc-снимком —
  // в очереди могут висеть state-события прошлых раундов
  client.send({ type: 'rpc', id: 'r3', method: 'session.agent.add', args: { id: 'test_probe' } });
  const add = await client.next((m) => m.type === 'rpc_result' && m.id === 'r3');
  check('rpc: session.agent.add — текст отчёта', String((add.result as { text: string }).text).includes('присоединился'));
  client.send({ type: 'rpc', id: 'snap1', method: 'state' });
  const snap1 = await client.next((m) => m.type === 'rpc_result' && m.id === 'snap1');
  const after3 = snap1.result as { team: { id: string; inChat: boolean }[]; session: { messages: { authorId: string; text: string }[] } };
  check('rpc: после chat.add — inChat true', after3.team.some((a) => a.id === 'test_probe' && a.inChat));
  check(
    'rpc: событие chat.add — реплика менеджера в хронике',
    after3.session.messages.at(-1)?.authorId === 'manager' && (after3.session.messages.at(-1)?.text.includes('присоединился') ?? false),
    JSON.stringify(after3.session.messages.at(-1)),
  );

  client.send({ type: 'rpc', id: 'r4', method: 'session.agent.delete', args: { id: 'test_probe' } });
  const rem = await client.next((m) => m.type === 'rpc_result' && m.id === 'r4');
  check('rpc: session.agent.delete — текст отчёта', String((rem.result as { text: string }).text).includes('покинул'));
  client.send({ type: 'rpc', id: 'snap2', method: 'state' });
  const snap2 = await client.next((m) => m.type === 'rpc_result' && m.id === 'snap2');
  const after4 = snap2.result as { session: { messages: { authorId: string; text: string }[] } };
  check(
    'rpc: событие chat.remove — реплика менеджера в хронике',
    after4.session.messages.at(-1)?.authorId === 'manager' && (after4.session.messages.at(-1)?.text.includes('покинул') ?? false),
    JSON.stringify(after4.session.messages.at(-1)),
  );

  // rpc: user_set — профиль через форму настроек (обе оболочки ходят rpc-методом)
  client.send({ type: 'rpc', id: 'r9', method: 'profile.update', args: { name: 'Профиль', role: 'тест' } });
  const us = await client.next((m) => m.type === 'rpc_result' && m.id === 'r9');
  check('rpc: profile.update — профиль обновлён', String((us.result as { text: string }).text).includes('Профиль'));
  // то же клиентским сообщением (канал без rpc) — и вернуть профиль как был
  client.send({ type: 'rpc', id: 'r9b', method: 'profile.update', args: { name: 'Пользователь' } });
  await client.next((m) => m.type === 'rpc_result' && m.id === 'r9b');

  // rpc: schedule.list — задачи расписания (секция «Расписание» в GUI)
  client.send({ type: 'rpc', id: 'r13', method: 'schedule.list' });
  const sch = await client.next((m) => m.type === 'rpc_result' && m.id === 'r13');
  check('rpc: schedule.list — задачи расписания', Array.isArray((sch.result as { tasks?: unknown[] }).tasks));

  // rpc: model.update — правка карточки существующей модели
  client.send({ type: 'rpc', id: 'r14', method: 'model.update', args: { id: 'mock', fields: { model: 'mock-2' } } });
  const pu = await client.next((m) => m.type === 'rpc_result' && m.id === 'r14');
  check('rpc: model.update — карточка правится', String((pu.result as { text: string }).text).includes('mock-2'));
  client.send({ type: 'rpc', id: 'r15', method: 'model.update', args: { id: 'mock', fields: { provider: 'неттакого' } } });
  const puErr = await client.next((m) => m.type === 'rpc_error' && m.id === 'r15');
  check('rpc: model.update — неизвестный адаптер — rpc_error', String(puErr.error).includes('неттакого'));
  client.send({ type: 'rpc', id: 'r16', method: 'model.update', args: { id: 'mock', fields: { model: 'mock' } } });
  await client.next((m) => m.type === 'rpc_result' && m.id === 'r16');

  // rpc: расписание — полный цикл записи в schedule.json проекта
  client.send({ type: 'rpc', id: 'r10', method: 'schedule.add', args: { message: 'Напоминание', intervalMinutes: 30 } });
  const sa = await client.next((m) => m.type === 'rpc_result' && m.id === 'r10');
  const added = (sa.result as { tasks: { id: string; message: string; enabled: boolean }[] }).tasks;
  check('rpc: schedule_add — задача записана', added.length === 1 && added[0].message === 'Напоминание' && added[0].enabled === true);
  const taskId = added[0].id;
  client.send({ type: 'rpc', id: 'r11', method: 'schedule.toggle', args: { id: taskId } });
  const stg = await client.next((m) => m.type === 'rpc_result' && m.id === 'r11');
  check('rpc: schedule_toggle — выключена', (stg.result as { tasks: { enabled: boolean }[] }).tasks[0].enabled === false);
  client.send({ type: 'rpc', id: 'r12', method: 'schedule.delete', args: { id: taskId } });
  const sd = await client.next((m) => m.type === 'rpc_result' && m.id === 'r12');
  check('rpc: schedule_delete — задача удалена', (sd.result as { tasks: unknown[] }).tasks.length === 0);

  // rpc: ошибки — честные сообщения
  client.send({ type: 'rpc', id: 'r5', method: 'settings.update', args: { patch: { model: { id: 'nope' } } } });
  const err1 = await client.next((m) => m.type === 'rpc_error' && m.id === 'r5');
  check('rpc: неизвестная модель — rpc_error', String(err1.error).includes('nope'));
  client.send({ type: 'rpc', id: 'r6', method: 'совсем-неизвестное' });
  const err2 = await client.next((m) => m.type === 'rpc_error' && m.id === 'r6');
  check('rpc: неизвестный метод — rpc_error', String(err2.error).includes('совсем-неизвестное'));

  // rpc: текущий разговор удалить нельзя (но state после попытки всё равно уходит)
  client.send({ type: 'rpc', id: 'r7', method: 'session.delete', args: { id: sess2.id } });
  const del = await client.next((m) => m.type === 'rpc_result' && m.id === 'r7');
  check('rpc: текущий разговор не удаляется', String((del.result as { text: string }).text).includes('нельзя'));

  // rpc: другой разговор удаляется — отчёт и свежий state (список короче)
  client.send({ type: 'rpc', id: 'r8', method: 'session.delete', args: { id: firstId } });
  const del2 = await client.next((m) => m.type === 'rpc_result' && m.id === 'r8');
  check('rpc: другой разговор удаляется', !String((del2.result as { text: string }).text).includes('нельзя'));
  const st4 = await client.next(
    (m) => m.type === 'state' && (m.state as { sessions: unknown[] }).sessions.length === 1,
  );
  check('rpc: после удаления — свежий state (список короче)', Boolean(st4.state));

  // abort без активного раунда — просто не падает
  client.send({ type: 'abort' });
  await wait(150);
  check('ws: abort без раунда — молча и без падений', true);

  // --- ГЛУБИННАЯ ПРОВЕРКА state: форма снапшота — контракт GUI ---
  {
    client.send({ type: 'rpc', id: 'd0', method: 'state' });
    const d0 = await client.next((m) => m.type === 'rpc_result' && m.id === 'd0');
    const st = d0.result as Record<string, unknown>;
    check(
      'state: ключи верхнего уровня',
      JSON.stringify(Object.keys(st).sort()) ===
        JSON.stringify(['auto', 'completion', 'images', 'knownProjects', 'manager', 'memory', 'models', 'profile', 'project', 'projects', 'providers', 'schemas', 'session', 'sessions', 'settings', 'team', 'teamError', 'ui']),
    );
    const providers = st.providers as unknown[] | undefined;
    check('state: providers — имена провайдеров (селектор в GUI)', Array.isArray(providers) && providers.includes('mock') && providers.every((p) => typeof p === 'string'), JSON.stringify(providers));
    const models = st.models as { id?: string; kind?: string; ok?: boolean; isDefault?: boolean }[] | undefined;
    check('state: models — карточки с id/kind/ok/isDefault', Array.isArray(models) && models.length > 0 && models.every((m) => typeof m.id === 'string' && typeof m.ok === 'boolean'), JSON.stringify(models));
    const uiSt = st.ui as { id?: unknown; strings?: unknown } | undefined;
    check('state: ui — id активной локали и словарь строк', Boolean(uiSt) && uiSt!.id === 'ru' && typeof uiSt!.strings === 'object');
    const proj = st.project as { name?: unknown; path?: unknown } | undefined;
    check('state: проект — path+name, известные проекты — реестр', Boolean(proj) && typeof proj!.path === 'string' && typeof proj!.name === 'string' && Array.isArray(st.knownProjects) && (st.knownProjects as Record<string, unknown>[]).every((p) => typeof p.path === 'string' && typeof p.name === 'string'));
    const sess = st.session as Record<string, unknown>;
    check('state: session = id+title+messages', JSON.stringify(Object.keys(sess).sort()) === JSON.stringify(['id', 'messages', 'title']));
    const msg = (sess.messages as { authorId: string; text: string; ts: number }[])[0];
    check('state: поля сообщения', Boolean(msg) && typeof msg.ts === 'number' && typeof msg.text === 'string');
    const meta = (st.sessions as Record<string, unknown>[])[0];
    check('state: разговор в списке — id/title/createdAt/updatedAt/count', Boolean(meta) && ['count', 'createdAt', 'id', 'title', 'updatedAt'].every((k) => k in meta!));
    const team = st.team as Record<string, unknown>[];
    check('state: участник — id/name/role/emoji/color/inChat', team.length > 0 && ['color', 'emoji', 'id', 'inChat', 'name', 'role'].every((k) => k in team[0]));
    const mgr = st.manager as Record<string, unknown>;
    check('state: менеджер — name/emoji/color/model', Boolean(mgr) && ['color', 'emoji', 'model', 'name'].every((k) => k in mgr));
    const prov = (st.models as Record<string, unknown>[])[0];
    check(
      'state: модель — id/kind/model/ok/isDefault/isManager',
      Boolean(prov) && ['id', 'isDefault', 'isManager', 'kind', 'model', 'ok'].every((k) => k in prov!),
    );
    check('state: images — массив', Array.isArray(st.images));
    const ops = (st.completion as { operations: { cmd: string; help: string }[] }).operations;
    check('state: completion.operations — манифест без алиасов', ops.length >= 30 && ops.some((c) => c.cmd === '/session open') && ops.every((c) => !c.cmd.includes('_aliases')));
    check('state: profile — имя', typeof (st.profile as { name: string }).name === 'string');
  }

  // --- КРАЯ ПРОТОКОЛА: сервер обязан выжить в любом мусоре ---
  {
    client.sendRaw('banana, вообще не json');
    const bad = await client.next((m) => m.type === 'error' && String(m.text).includes('кривое'));
    check('ws: не-JSON — честная ошибка', Boolean(bad));

    client.sendRaw('[1,2,3]');
    const arr = await client.next((m) => m.type === 'error' && String(m.text).includes('не объект'));
    check('ws: JSON-массив — кривое сообщение', Boolean(arr));

    client.sendRaw('null');
    const nul = await client.next((m) => m.type === 'error' && String(m.text).includes('не объект'));
    check('ws: null не роняет сервер', Boolean(nul));

    client.sendRaw('42');
    const num = await client.next((m) => m.type === 'error' && String(m.text).includes('не объект'));
    check('ws: число — кривое сообщение', Boolean(num));

    client.send({ type: 'совсем-типа-нет' });
    const unk = await client.next((m) => m.type === 'error' && String(m.text).includes('совсем-типа-нет'));
    check('ws: неизвестный тип — ошибка с его именем', Boolean(unk));

    // пустой ввод игнорируется целиком: ни state, ни ошибки
    const beforeIgnore = client.raw().length;
    client.send({ type: 'user_message', text: '   ' });
    client.send({ type: 'command', text: '' });
    client.send({ type: 'rpc', id: 'ig1', method: 'state' });
    await client.next((m) => m.type === 'rpc_result' && m.id === 'ig1');
    check('ws: пустые user_message/command игнорируются', client.raw().length === beforeIgnore);

    client.send({ type: 'hello' });
    const hello = await client.next((m) => m.type === 'state');
    check('ws: hello — свежий state', Boolean(hello.state));

    const h = await fetch(`http://127.0.0.1:${handle.port}/health`);
    check('http: /health жив после краёв', h.status === 200);
  }

  // --- МУЛЬТИ-КЛИЕНТ ---
  {
    const b = await makeClient(handle.port);
    const bState = await b.next((m) => m.type === 'state');
    check('multi: второй клиент получил state при подключении', Boolean(bState.state));

    const sMulti = client.stateCount(); // до отправки: иначе быстрый раунд обгонит захват
    client.send({ type: 'command', text: '/sessions' });
    const aN = await client.next((m) => m.type === 'notice' && String(m.text).includes('Разговоры'));
    const bN = await b.next((m) => m.type === 'notice' && String(m.text).includes('Разговоры'));
    check('multi: события вещаются всем', Boolean(aN && bN));
    await client.waitState(sMulti + 1);

    client.send({ type: 'rpc', id: 'm1', method: 'sessions.list' });
    await client.next((m) => m.type === 'rpc_result' && m.id === 'm1');
    await wait(200);
    check('multi: rpc_result не уходит чужим клиентам', !b.raw().some((m) => m.type === 'rpc_result' && m.id === 'm1'));

    b.close();
    await wait(100);
    client.send({ type: 'command', text: '/models' });
    const provN = await client.next((m) => m.type === 'notice' && String(m.text).includes('★ основной'));
    check('multi: после отключения B сервер работает с A', Boolean(provN));
    await client.next((m) => m.type === 'state');
  }

  // --- CONFIRM ЖИВОГО РАУНДА: у Теста shell с узким allow — echo уйдёт в вопрос ---
  {
    const cardFile = join(home, 'agents', 'test_probe.json');
    type TeamAgent = { tools?: Record<string, unknown> };
    const card = JSON.parse(readFileSync(cardFile, 'utf8')) as TeamAgent;
    card.tools = { files: {}, shell: { allow: ['git *'] } };
    writeFileSync(cardFile, JSON.stringify(card, null, 2));

    client.send({ type: 'rpc', id: 'c9', method: 'session.agent.add', args: { id: 'test_probe' } });
    await client.next((m) => m.type === 'rpc_result' && m.id === 'c9');

    const sRound = client.stateCount();
    client.send({ type: 'user_message', text: 'покажи, что умеешь' });
    const tools1 = await client.next((m) => m.type === 'tool_results');
    check('confirm: демо-файл записан молча (files — свободно)', (tools1.results as string[]).some((r) => r.startsWith('✅')));
    const ask = await client.next((m) => m.type === 'confirm');
    check(
      'confirm: echo мимо allow — вопрос человеку',
      typeof ask.label === 'string' && ask.label.length > 0 && (ask.who as { name: string }).name === 'Тест',
    );
    client.send({ type: 'confirm_response', id: ask.id, approved: true });
    const tools2 = await client.next((m) => m.type === 'tool_results');
    check(
      'confirm: после «разрешить» — echo исполнен',
      (tools2.results as string[]).some((r) => r.startsWith('✅')),
      `пришло: ${JSON.stringify(tools2.results).slice(0, 200)}`,
    );
    await client.waitState(sRound + 1); // раунд с подтверждением закрылся
    check('confirm: демо-файл на диске песочницы', readFileSync(join(proj, 'demo-agent.txt'), 'utf8').includes('mock-агента'));

    // «отказать»: в новом разговоре ступеньки демо сбрасываются
    const sNew = client.stateCount();
    client.send({ type: 'rpc', id: 'c10', method: 'session.new' });
    const greeted = await client.next(
      (m) => (m.type === 'say' && String(m.text).includes('менеджер переговорки')) || m.type === 'error',
    );
    check('confirm: session.new — менеджер приветствует', greeted.type === 'say');
    await client.waitState(sNew + 1);
    client.send({ type: 'rpc', id: 'c11', method: 'session.agent.add', args: { id: 'test_probe' } });
    await client.next((m) => m.type === 'rpc_result' && m.id === 'c11');
    const sDeny = client.stateCount();
    client.send({ type: 'user_message', text: 'покажи, что умеешь' });
    await client.next((m) => m.type === 'tool_results');
    const ask2 = await client.next((m) => m.type === 'confirm');
    client.send({ type: 'confirm_response', id: ask2.id, approved: false });
    const denied = await client.next(
      (m) => m.type === 'tool_results' && JSON.stringify(m.results).includes('отклонено пользователем'),
    );
    check('confirm: «отказать» — действие отменено с отчётом', Boolean(denied));
    await client.waitState(sDeny + 1);
  }

  // --- @session: интерактивный выбор и отмена ---
  {
    const sCh = client.stateCount();
    client.send({ type: 'user_message', text: '@session что в том разговоре?' });
    const choose = await client.next((m) => m.type === 'choose_session');
    const items = choose.items as { title: string; count: number }[];
    check('choose: список других разговоров', Array.isArray(items) && items.length >= 1);
    client.send({ type: 'choose_response', id: choose.id, index: 0 });
    const att = await client.next((m) => m.type === 'attachment');
    check('choose: конспект приложен', String(att.title).length > 0 && String(att.digest).includes('Разговор'));
    await client.waitState(sCh + 1); // раунд с приложением должен закончиться до следующего

    const sCh2 = client.stateCount();
    client.send({ type: 'user_message', text: '@session ещё раз, но без приложения' });
    const choose2 = await client.next((m) => m.type === 'choose_session');
    client.send({ type: 'choose_response', id: choose2.id, index: null });
    const cont = await client.next((m) => m.type === 'notice' && String(m.text).includes('продолжаю без приложения'));
    check('choose: отмена — продолжаем без конспекта', Boolean(cont));
    await client.waitState(sCh2 + 1);
  }

  // --- УПРАВЛЕНИЕ ЧЕРЕЗ КОМАНДЫ WS: /agent, /project ---
  {
    const sAg = client.stateCount();
    client.send({ type: 'command', text: '/agent new api_guy name=Аписька role=тестировщик' });
    const addA = await client.next((m) => m.type === 'notice' && String(m.text).includes('api_guy'));
    check('ws: /agent new — отчёт', Boolean(addA));
    await client.waitState(sAg + 1);
    client.send({ type: 'rpc', id: 'dTeam', method: 'state' });
    const stA = await client.next((m) => m.type === 'rpc_result' && m.id === 'dTeam');
    check('ws: /agent add — появился в state.team', ((stA.result as { team: { id: string }[] }).team).some((a) => a.id === 'api_guy'));

    const sGrant = client.stateCount();
    client.send({ type: 'command', text: '/agent tool add api_guy files' });
    const g = await client.next((m) => m.type === 'notice' && String(m.text).includes('files'));
    check('ws: /agent tool add — отчёт', Boolean(g));
    await client.waitState(sGrant + 1);

    const sProj = client.stateCount();
    client.send({ type: 'command', text: '/project host add main' });
    await client.next((m) => m.type === 'notice' && String(m.text).includes('main'));
    client.send({ type: 'command', text: '/project host update main host=127.0.0.1 user=root port=2223' });
    const p = await client.next((m) => m.type === 'notice' && String(m.text).includes('port=2223'));
    check('ws: /project host update — отчёт', Boolean(p));
    const pcfg = JSON.parse(readFileSync(join(home, 'projects', 'proj', 'project.json'), 'utf8')) as { hosts?: Record<string, { host?: string; user?: string; port?: number }> };
    check('ws: /project host — hosts в project.json', pcfg.hosts?.main?.host === '127.0.0.1' && pcfg.hosts?.main?.user === 'root' && pcfg.hosts?.main?.port === 2223, JSON.stringify(pcfg.hosts));
    await client.waitState(sProj + 2);

    const sHost = client.stateCount();
    client.send({ type: 'command', text: '/project host add reserve' });
    const ph = await client.next((m) => m.type === 'notice' && String(m.text).includes('reserve'));
    check('ws: /project host add — отчёт', Boolean(ph));
    await client.waitState(sHost + 1);

    const sBad = client.stateCount();
    client.send({ type: 'command', text: '/agent update api_guy foo=bar' });
    const badSet = await client.next((m) => m.type === 'error' && String(m.text).includes('не понятно, что менять'));
    check('ws: /agent set с мусорным полем — честная ошибка', Boolean(badSet));
    await client.waitState(sBad + 1);
  }

  // --- RPC-ОПЕРАЦИИ: формы GUI ходят тем же rpc-ом — агент и его тула,
  // свои тула, модель, проект, серверы/почта/боты, авто-режим; экспорт и
  // импорт с живым подтверждением; прикреплённые файлы к сообщению ---
  {
    let rpcSeq = 0;
    const rpc = async (method: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const rid = `q${rpcSeq++}`;
      client.send({ type: 'rpc', id: rid, method, ...(args ? { args } : {}) });
      const m = await client.next((mm) => (mm.type === 'rpc_result' || mm.type === 'rpc_error') && mm.id === rid);
      if (m.type === 'rpc_error') throw new Error(`rpc ${method}: ${String(m.error)}`);
      return (m.result ?? {}) as Record<string, unknown>;
    };
    const rpcErr = async (method: string, args?: Record<string, unknown>): Promise<string> => {
      const rid = `q${rpcSeq++}`;
      client.send({ type: 'rpc', id: rid, method, ...(args ? { args } : {}) });
      const m = await client.next((mm) => (mm.type === 'rpc_result' || mm.type === 'rpc_error') && mm.id === rid);
      return m.type === 'rpc_error' ? String(m.error) : '';
    };
    const takeZip = async (type: string, args?: Record<string, unknown>, errMark?: string): Promise<{ name: string; dataB64: string; error?: string }> => {
      client.send({ type, ...(args ?? {}) });
      const m = await client.next((mm) => mm.type === 'export_data' || (errMark !== undefined && mm.type === 'error' && String(mm.text).includes(errMark)));
      return m.type === 'export_data'
        ? { name: String(m.name), dataB64: String(m.dataB64) }
        : { name: '', dataB64: '', error: String((m as { text?: unknown }).text ?? m.error ?? '') };
    };
    // подтверждение с живым клиентом: вопрос → ответ → заметка с отчётом
    const importFlow = async (type: string, dataB64: string, approved: boolean, reportMark: string): Promise<string> => {
      client.send({ type, dataB64 });
      const ask = await client.next((m) => m.type === 'confirm');
      client.send({ type: 'confirm_response', id: ask.id, approved });
      const n = await client.next((m) => m.type === 'notice' && String(m.text).includes(approved ? reportMark : 'Импорт отменён'));
      return String(n.text);
    };

    // прикрепления: имена из inbox уходят в раунд вместе с текстом
    const sAtt = client.stateCount();
    client.send({ type: 'user_message', text: 'что в этих файлах?', attachments: ['заметка.txt', '', '  '] });
    await client.waitState(sAtt + 1);
    const stAtt = await rpc('state');
    check(
      'rpc: user_message с attachments — сообщение в разговоре',
      ((stAtt.session as { messages: { authorId: string; text: string }[] }).messages ?? []).some((mm) => mm.authorId === 'user' && mm.text.includes('что в этих файлах?')),
      JSON.stringify(stAtt.session).slice(0, 150),
    );

    // fs.dirs — браузер путей для форм проекта
    const dirs = (await rpc('fs.dirs', { path: base })) as { path: string; dirs: { name: string }[] };
    check('rpc: fs.dirs — подпапки каталога', dirs.path === base && dirs.dirs.some((d) => d.name === 'home') && dirs.dirs.some((d) => d.name === 'proj'), JSON.stringify(dirs.dirs));
    const noDir = await rpcErr('fs.dirs', { path: join(base, 'нет-такой') });
    check('rpc: fs.dirs мимо — честная ошибка', noDir.includes('нет'), noDir);

    // session.update: переименование разговора
    await rpc('session.update', { title: 'Пробное имя' });
    const lstU = await rpc('sessions.list');
    check('rpc: session.update — имя в списке', (lstU.sessions as { title: string }[]).some((s) => s.title === 'Пробное имя'), JSON.stringify((lstU.sessions as { title: string }[]).map((s) => s.title)));

    // агент: карточка, тула, правка полей
    const got = await rpc('agent.get', { id: 'test_probe' });
    check('rpc: agent.get — карточка агента', JSON.stringify(got).includes('test_probe'), JSON.stringify(got).slice(0, 150));
    const tools0 = await rpc('agent.tools', { id: 'test_probe' });
    check('rpc: agent.tools — базовые тула', (tools0.tools as string[]).includes('files') && (tools0.tools as string[]).includes('shell'), JSON.stringify(tools0.tools));
    const noAgent = await rpcErr('agent.get', { id: 'нет-такого' });
    check('rpc: agent.get мимо — честная ошибка', noAgent.includes('нет агента'), noAgent);

    await rpc('agent.update', { id: 'test_probe', fields: { role: 'инженер-проб' } });
    const card = JSON.parse(readFileSync(join(home, 'agents', 'test_probe.json'), 'utf8')) as { role?: string };
    check('rpc: agent.update — роль в карточке', card.role === 'инженер-проб', card.role);

    await rpc('agent.tool.add', { agent: 'test_probe', tool: 'docs' });
    const tools1 = await rpc('agent.tools', { id: 'test_probe' });
    check('rpc: agent.tool.add — docs включён', (tools1.tools as string[]).includes('docs'), JSON.stringify(tools1.tools));
    await rpc('agent.tool.update', { agent: 'test_probe', tool: 'docs', fields: { description: 'читать документы' } });
    const docsCard = JSON.parse(readFileSync(join(home, 'agents', 'test_probe.json'), 'utf8')) as { tools?: Record<string, { description?: string }> };
    check('rpc: agent.tool.update — карточка тула правится', docsCard.tools?.docs?.description === 'читать документы', JSON.stringify(docsCard.tools));
    await rpc('agent.tool.delete', { agent: 'test_probe', tool: 'docs' });
    const tools2 = await rpc('agent.tools', { id: 'test_probe' });
    check('rpc: agent.tool.delete — docs выключен', (tools2.tools as string[]).includes('docs') === false, JSON.stringify(tools2.tools));

    // свои тула: new → update → delete
    const tn = await rpc('tool.new', { tool: ['dt_probe_tool'] });
    check('rpc: tool.new — свой тул создан', String(tn.text).includes('dt_probe_tool'), String(tn.text));
    const tu = await rpc('tool.update', { tool: 'dt_probe_tool', fields: { description: 'пробный тул' } });
    check('rpc: tool.update — карточка переписана', String(tu.text).includes('dt_probe_tool') && String(tu.text).includes('description'), String(tu.text));
    const td = await rpc('tool.delete', { id: 'dt_probe_tool' });
    check('rpc: tool.delete — удалён', String(td.text).length > 0, String(td.text));

    // авто-режим
    const on = await rpc('auto.on', { n: 2 });
    const stOn = await rpc('state');
    check('rpc: auto.on — режим в снимке', on.ok === true && (stOn.auto as { mode: boolean }).mode === true, JSON.stringify(stOn.auto));
    await rpc('auto.off');
    const stOff = await rpc('state');
    check('rpc: auto.off — выключен', (stOff.auto as { mode: boolean }).mode === false, JSON.stringify(stOff.auto));

    // модель: создать и удалить; дефолтную не отдаём
    const mn = await rpc('model.new', { id: 'mock2', config: { provider: 'mock' } });
    check('rpc: model.new — карточка создана', String(mn.text).includes('mock2'), String(mn.text));
    const stM = await rpc('state');
    check('rpc: model.new — модель в снимке', (stM.models as { id: string }[]).some((m) => m.id === 'mock2'), JSON.stringify((stM.models as { id: string }[]).map((m) => m.id)));
    const md = await rpc('model.delete', { id: 'mock2' });
    check('rpc: model.delete — удалена', String(md.text).includes('mock2'), String(md.text));
    const delDef = await rpcErr('model.delete', { id: 'mock' });
    check('rpc: model.delete дефолтной — отказ', delDef.length > 0, delDef);

    // проект: переименование текущего
    const ren = await rpc('project.update', { name: 'probe-main' });
    check('rpc: project.update — переименован', String(ren.text).includes('probe-main'), String(ren.text));
    const stR = await rpc('state');
    check('rpc: project.update — имя в снимке', (stR.project as { name?: string }).name === 'probe-main', JSON.stringify(stR.project));

    // серверы проекта: полная запись, пустая, правка, удаление
    const ha = await rpc('project.host.add', { id: 'rpc-host', host: 'example.org', user: 'u', password: 'p', dir: '/srv', port: 22 });
    check('rpc: project.host.add — полный', String(ha.text).includes('rpc-host'), String(ha.text));
    const he = await rpc('project.host.add', { id: 'rpc-empty' });
    check('rpc: project.host.add — пустая запись', String(he.text).includes('rpc-empty'), String(he.text));
    const hu = await rpc('project.host.update', { id: 'rpc-host', user: 'u2', port: 2222 });
    check('rpc: project.host.update — правка', String(hu.text).includes('2222'), String(hu.text));
    const hd = await rpc('project.host.delete', { id: 'rpc-empty' });
    check('rpc: project.host.delete — удалён', String(hd.text).length > 0, String(hd.text));
    const noHost = await rpcErr('project.host.update', { id: 'нет-хоста', user: 'x' });
    check('rpc: project.host.update мимо — честная ошибка', noHost.length > 0, noHost);

    // почта: готовый ящик и пустая запись, правка, удаление
    const ma = await rpc('project.mail.add', { id: 'box1', user: 'a@b.c', password: 'pw', imap: 'imap.example.org', smtp: 'smtp.example.org', port: 993, smtpPort: 465, tlsNoVerify: true });
    check('rpc: project.mail.add — готовый ящик', String(ma.text).includes('box1'), String(ma.text));
    const mr = await rpc('project.mail.add', { id: 'box2' });
    check('rpc: project.mail.add — пустая запись', String(mr.text).includes('box2'), String(mr.text));
    const mu = await rpc('project.mail.update', { id: 'box2', fields: { user: 'd@e.f' } });
    check('rpc: project.mail.update — правка', String(mu.text).length > 0, String(mu.text));
    const mdl = await rpc('project.mail.delete', { id: 'box2' });
    check('rpc: project.mail.delete — удалён', String(mdl.text).length > 0, String(mdl.text));

    // боты мессенджеров: с токеном и пустая, правка, удаление (ключи — telegram/max)
    const mb = await rpc('project.messenger.add', { key: 'telegram', token: '1:AAA' });
    check('rpc: project.messenger.add — с токеном', String(mb.text).includes('telegram'), String(mb.text));
    const me = await rpc('project.messenger.add', { key: 'max' });
    check('rpc: project.messenger.add — пустая запись', String(me.text).includes('max'), String(me.text));
    await rpc('project.messenger.update', { key: 'max', token: '2:BBB' });
    const mdel = await rpc('project.messenger.delete', { key: 'max' });
    check('rpc: project.messenger.delete — удалён', String(mdel.text).length > 0, String(mdel.text));

    // снимок проекта — контракт GUI: секреты только флагом «задан»
    const stP = await rpc('state');
    const prj = (stP.projects as {
      id: string;
      hosts: { name: string; port?: number; user?: string; hasPassword: boolean }[];
      mails: { id: string; hasPassword: boolean; port?: number; tlsNoVerify: boolean }[];
      messengers: { key: string; hasToken: boolean }[];
    }[])[0];
    check('rpc: снимок проекта — хост с портом и флагом пароля', prj.hosts.some((h) => h.name === 'rpc-host' && h.port === 2222 && h.user === 'u2' && h.hasPassword), JSON.stringify(prj.hosts));
    check('rpc: снимок проекта — ящик с портом и флагом', prj.mails.some((b) => b.id === 'box1' && b.hasPassword && b.port === 993 && b.tlsNoVerify), JSON.stringify(prj.mails));
    check('rpc: снимок проекта — бот с флагом токена', prj.messengers.some((b) => b.key === 'telegram' && b.hasToken), JSON.stringify(prj.messengers));

    // агент: создать и удалить rpc-ом
    const an = await rpc('agent.new', { id: 'rpc_guy', name: 'Рпц', role: 'гость' });
    check('rpc: agent.new — карточка создана', String(an.text).includes('rpc_guy'), String(an.text));
    const ad = await rpc('agent.delete', { id: 'rpc_guy' });
    check('rpc: agent.delete — карточка удалена', String(ad.text).includes('rpc_guy'), String(ad.text));

    // model.get: маскированная карточка со схемой формы
    const mg = (await rpc('model.get', { id: 'mock' })) as { card?: { provider?: string; apiKey?: string }; schema?: unknown };
    check('rpc: model.get — карточка со схемой', mg.card?.provider === 'mock' && mg.card?.apiKey === undefined && typeof mg.schema === 'object', JSON.stringify(mg.card));

    // manager.show / settings.show — формы настроек
    const ms = (await rpc('manager.show')) as { manager?: { name?: string } };
    const ss = (await rpc('settings.show')) as { settings?: { ui?: string } };
    check('rpc: manager.show/settings.show — формы', typeof ms.manager?.name === 'string' && ss.settings?.ui === 'ru', JSON.stringify(ms.manager) + ' ' + JSON.stringify(ss.settings));

    // session.history: срез разговора; session.agents: состав чата и запас
    const hist = (await rpc('session.history', { from: 1, to: 2 })) as { messages?: unknown[] };
    check('rpc: session.history — срез сообщений', Array.isArray(hist.messages) && hist.messages.length > 0, JSON.stringify(hist).slice(0, 120));
    const ags = (await rpc('session.agents')) as { inChat?: { id: string }[]; outside?: unknown[] };
    check('rpc: session.agents — в чате и в запасе', (ags.inChat ?? []).some((a) => a.id === 'test_probe') && Array.isArray(ags.outside), JSON.stringify(ags).slice(0, 150));

    // file: 📎-канал GUI — с defer файл просто кладётся в inbox, без — сразу раунд
    client.send({ type: 'file', name: 'проба.txt', dataB64: Buffer.from('привет, файл!').toString('base64'), defer: true });
    await wait(150);
    check('rpc: file (defer) — файл в inbox без раунда', existsSync(join(home, 'projects', 'probe-main', 'inbox', 'проба.txt')));
    const sFile = client.stateCount();
    client.send({ type: 'file', name: 'проба2.txt', dataB64: Buffer.from('сразу в раунд').toString('base64'), text: 'глянь файл' });
    await client.waitState(sFile + 1);

    // file_ref: файл уже на сервере — копируется в inbox; мимо — честная ошибка
    writeFileSync(join(proj, 'референс.txt'), 'уже на диске');
    client.send({ type: 'file_ref', path: 'референс.txt', defer: true });
    await wait(150);
    check('rpc: file_ref — копия в inbox', existsSync(join(home, 'projects', 'probe-main', 'inbox', 'референс.txt')));
    client.send({ type: 'file_ref', path: 'нет-такого.txt', defer: true });
    const badRef = await client.next((m) => m.type === 'error' && String(m.text).includes('файл не найден'));
    check('rpc: file_ref мимо — честная ошибка', Boolean(badRef));

    // экспорт четырёх уровней — zip по проводу (это WS-типы, не rpc)
    const homeZip = await takeZip('export_home');
    check('rpc: export_home — zip-архив', homeZip.name.startsWith('home-') && homeZip.dataB64.startsWith('UEs'), homeZip.name);
    const setZip = await takeZip('export_settings');
    check('rpc: export_settings — zip-архив', setZip.name.startsWith('settings-') && setZip.dataB64.startsWith('UEs'), setZip.name);
    const projZip = await takeZip('export_project', { id: 'probe-main' });
    check('rpc: export_project по id — zip-архив', projZip.name.includes('probe-main') && projZip.dataB64.startsWith('UEs'), projZip.name);
    const curZip = await takeZip('export_project');
    check('rpc: export_project текущий — zip-архив', curZip.name.startsWith('project-') && curZip.dataB64.startsWith('UEs'), curZip.name);
    const badExp = await takeZip('export_session', { id: 'нет-такого' }, 'не нашёл разговор');
    check('rpc: export_session мимо — честная ошибка', (badExp.error ?? '').includes('не нашёл разговор'), badExp.error);
    const sessId = ((await rpc('sessions.list')).sessions as { id: string }[])[0].id;
    const sessZip = await takeZip('export_session', { id: sessId });
    check('rpc: export_session — zip-архив', sessZip.name.startsWith('session-') && sessZip.dataB64.startsWith('UEs'), sessZip.name);

    // импорт: отмена и применение с живым подтверждением
    const canceled = await importFlow('import_home', homeZip.dataB64, false, '');
    check('rpc: import_home отмена — «Импорт отменён»', canceled.includes('Импорт отменён'), canceled);
    const doneHome = await importFlow('import_home', homeZip.dataB64, true, 'Импорт');
    check('rpc: import_home — отчёт', doneHome.includes('Импорт'), doneHome);
    const doneSet = await importFlow('import_settings', setZip.dataB64, true, 'Импорт');
    check('rpc: import_settings — отчёт', doneSet.includes('Импорт'), doneSet);

    // чужой архив — отказ до подтверждения
    client.send({ type: 'import_project', dataB64: setZip.dataB64 });
    const errP = await client.next((m) => m.type === 'error' && String(m.text).includes('project.json'));
    check('rpc: import_project без project.json — отказ', Boolean(errP));
    client.send({ type: 'import_session', dataB64: setZip.dataB64 });
    const errS = await client.next((m) => m.type === 'error' && String(m.text).includes('session.json'));
    check('rpc: import_session без session.json — отказ', Boolean(errS));

    // импорт проекта копией под новым id → удаление копии rpc-ом
    client.send({ type: 'import_project', id: 'proj-copy', dataB64: curZip.dataB64 });
    const askP = await client.next((m) => m.type === 'confirm');
    client.send({ type: 'confirm_response', id: askP.id, approved: true });
    const nP = await client.next((m) => m.type === 'notice' && String(m.text).includes('proj-copy'));
    check('rpc: import_project копией — создан', Boolean(nP));
    const delCopy = await rpc('project.delete', { id: 'proj-copy' });
    check('rpc: project.delete — копия удалена', existsSync(join(home, 'projects', 'proj-copy')) === false, String(delCopy.text));

    // импорт разговора: session.json в архиве есть — вливается
    client.send({ type: 'import_session', dataB64: sessZip.dataB64 });
    const nS = await client.next((m) => m.type === 'notice' && String(m.text).includes('Импорт'));
    check('rpc: import_session — разговор влит', Boolean(nS));

    // session.open: переключение на другой разговор — всем свежий state
    const curId = ((await rpc('state')).session as { id: string }).id;
    const otherId = ((await rpc('sessions.list')).sessions as { id: string }[]).find((s) => s.id !== curId)?.id;
    if (otherId) {
      const so = await rpc('session.open', { id: otherId });
      check('rpc: session.open — переключился', so.ok === true, JSON.stringify(so));
    }

    // отмена импорта настроек и проекта — те же ветки «Импорт отменён»
    const cancelSet = await importFlow('import_settings', setZip.dataB64, false, '');
    check('rpc: import_settings отмена', cancelSet.includes('Импорт отменён'), cancelSet);
    client.send({ type: 'import_project', dataB64: curZip.dataB64 });
    const askC = await client.next((m) => m.type === 'confirm');
    client.send({ type: 'confirm_response', id: askC.id, approved: false });
    const nC = await client.next((m) => m.type === 'notice' && String(m.text).includes('Импорт отменён'));
    check('rpc: import_project отмена', Boolean(nC));

    // края: schedule.toggle мимо, settings.update патчи, manager.update
    const before = await rpc('schedule.list');
    await rpc('schedule.toggle', { id: 'нет-такой' });
    const after = await rpc('schedule.list');
    check('rpc: schedule.toggle мимо — список не тронут', JSON.stringify(before.tasks) === JSON.stringify(after.tasks), '');
    const uiSet = await rpc('settings.update', { patch: { ui: 'ru' } });
    const modelSet = await rpc('settings.update', { patch: { model: { id: 'mock' } } });
    check('rpc: settings.update ui+model — ок', uiSet.ok === true && modelSet.ok === true, JSON.stringify(uiSet));
    const mgr = await rpc('manager.update', { fields: { temperature: 0.5 } });
    check('rpc: manager.update — отчёт', String(mgr.text).length > 0, String(mgr.text));

    // session.close: разговор закрыт, проект остаётся; session.new возвращает с приветствием
    const sc = await rpc('session.close');
    check('rpc: session.close — отчёт', String(sc.text).includes('Разговор закрыт'), String(sc.text));
    const sRe = client.stateCount();
    await rpc('session.new');
    await client.waitState(sRe + 1);

    // project.new: дом создаёт проект и здоровается; projects.list видит оба
    const pn = await rpc('project.new', { id: 'rpc-proj' });
    check('rpc: project.new — создан и открыт', String(pn.text).includes('rpc-proj'), String(pn.text));
    const pl = (await rpc('projects.list')) as { known?: { name?: string }[]; current?: { id?: string } };
    check(
      'rpc: projects.list — известные и текущий',
      (pl.known ?? []).some((p) => p.name === 'probe-main') && (pl.known ?? []).some((p) => p.name === 'rpc-proj') && pl.current?.id === 'rpc-proj',
      JSON.stringify(pl).slice(0, 200),
    );
    // вернуться в переименованный проект, затем удалить новый целиком
    await rpc('project.open', { id: 'probe-main' });
    const pdel = await rpc('project.delete', { id: 'rpc-proj' });
    check('rpc: project.delete — новый удалён целиком', existsSync(join(home, 'projects', 'rpc-proj')) === false, String(pdel.text));
    const sFin = client.stateCount();
    await rpc('session.new');
    await client.waitState(sFin + 1);
  }

  // --- ЮНИКОД И БОЛЬШИЕ СООБЩЕНИЯ ---
  {
    const big = 'ёёё 🎬🛎 — «кавычки» и <script>alert(1)</script> ' + 'х'.repeat(8000);
    const sent = '@менеджер ' + big; // менеджеру: раунд без демо-тулов и живых вопросов
    client.send({ type: 'user_message', text: sent });
    const stBig = await client.next(
      (m) => m.type === 'state' && (m.state as { session?: { messages?: { text: string }[] } | null }).session?.messages?.some((x) => x.text.includes('ёёё')) === true,
    );
    const saved = (stBig.state as { session: { messages: { text: string }[] } }).session.messages.find((x) => x.text.includes('ёёё'));
    check('ws: юникод, html и 8КБ — дошли без искажений', saved?.text === sent);
  }

  // --- БИТАЯ КАРТОЧКА в agents/: команда не может молча исчезнуть (в конце —
  // чтобы наши hello не глотали state-события идущих раундов; предикаты
  // прицельные: в очереди к этому месту копятся несвежие state прошлых секций) ---
  {
    const broken = join(home, 'agents', 'broken.json');
    writeFileSync(broken, '{ это не json');
    client.send({ type: 'hello' });
    const bad = await client.next((m) => m.type === 'state' && (m.state as { teamError?: unknown }).teamError != null);
    const stBad = bad.state as { teamError: string; team: unknown[] };
    check('ws: битая карточка — teamError в state', stBad.teamError.includes('не удалось прочитать'), stBad.teamError);
    check('ws: битая карточка — команда в снимке пуста', Array.isArray(stBad.team) && stBad.team.length === 0);

    writeFileSync(broken, JSON.stringify({ id: 'x' }));
    client.send({ type: 'hello' });
    const bad2 = await client.next((m) => m.type === 'state' && String((m.state as { teamError?: string }).teamError ?? '').includes('обязательны поля'));
    check('ws: карточка без name/prompt — ошибка называет поля', Boolean(bad2));

    rmSync(broken);
    writeFileSync(join(home, 'agents', 'boss.json'), JSON.stringify({ name: 'Босс', prompt: 'Ты руководитель.' }));
    client.send({ type: 'hello' });
    const good = await client.next((m) => m.type === 'state' && (m.state as { team?: { id: string }[] }).team?.some((a) => a.id === 'boss') === true);
    const stGood = good.state as { teamError?: string | null };
    check('ws: починили — teamError ушёл, команда в снимке', stGood.teamError == null);
    rmSync(join(home, 'agents'), { recursive: true }); // песочнице возвращаем отсутствие папки
    client.send({ type: 'hello' });
    const none = await client.next((m) => m.type === 'state' && (m.state as { team?: unknown[] }).team?.length === 0 && (m.state as { teamError?: unknown }).teamError == null);
    check('ws: папки нет — пусто и без ошибки', Boolean(none));
  }

  // --- upload без открытого проекта: честный 404 ---
  {
    client.send({ type: 'rpc', id: 'pc1', method: 'project.close' });
    const pc = await client.next((m) => m.type === 'rpc_result' && m.id === 'pc1');
    check('rpc: project.close — проект закрыт', Boolean(pc.result));
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/upload`, { method: 'POST', body: 'данные' });
    const j = (await res.json()) as { error?: string };
    check('http: upload без проекта — 404 с внятной ошибкой', res.status === 404 && String(j.error ?? '').includes('нет открытого проекта'), JSON.stringify(j));
  }

  client.close();
}

// --- AUTH: сервер с TOKEN требует авторизацию первым сообщением; проект из
// аргументов запуска (dreamteam serve <папка> → DT_PROJECT_ARGS) открывается
// до поднятия, и пустой разговор приветствуется менеджером ещё до клиентов ---
{
  mkdirSync(join(base, 'proj2'), { recursive: true });
  process.env.TOKEN = 'секрет-тест-123';
  process.env.DT_PROJECT_ARGS = JSON.stringify([join(base, 'proj2')]);
  const secured = await startServe({ port: 0 });
  delete process.env.DT_PROJECT_ARGS;
  const c1 = await makeClient(secured.port);
  const need = await c1.next((m) => m.type === 'auth_required');
  check('auth: сервер с TOKEN требует авторизацию', Boolean(need));

  c1.send({ type: 'auth', token: 'неверный-токен' });
  const fail = await c1.next((m) => m.type === 'auth_failed');
  check('auth: неверный токен — отказ', Boolean(fail));

  c1.send({ type: 'user_message', text: 'попытка без токена' });
  const again = await c1.next((m) => m.type === 'auth_required');
  check('auth: неавторизованные сообщения игнорируются', Boolean(again));

  c1.send({ type: 'auth', token: 'секрет-тест-123' });
  const ok = await c1.next((m) => m.type === 'auth_ok');
  const st = await c1.next((m) => m.type === 'state');
  check('auth: верный токен — пускает со state', Boolean(ok && st.state));
  check(
    'auth: проект из аргументов запуска открыт',
    (st.state as { project?: { name?: string } }).project?.name === 'proj2',
    JSON.stringify((st.state as { project?: unknown }).project ?? null),
  );

  c1.close();
  await secured.close();
  delete process.env.TOKEN;
}

// --- ServerPresenter отдельно: вопросы и таймауты ---
{
  const captured: string[] = [];
  const fakeWs = {
    readyState: 1,
    send: (d: string) => captured.push(d),
    on: () => {},
  } as unknown as WebSocket;

  const alone = new ServerPresenter(120);
  check('confirm: без клиентов — сразу отказ', (await alone.confirm({ label: 'Команда', desc: 'ls', who: { id: 'x', name: 'Кто' } })) === false);

  const withClient = new ServerPresenter(120);
  withClient.addClient(fakeWs);
  const pending = withClient.confirm({ label: 'Команда', desc: 'ls', who: { id: 'x', name: 'Кто-то', emoji: '🤖' } });
  await wait(30);
  const sent = captured.find((d) => d.includes('"confirm"'));
  check('confirm: вопрос ушёл клиенту', sent !== undefined && sent.includes('ls') && sent.includes('Кто-то'));
  const id = sent ? (JSON.parse(sent).id as string) : '';
  withClient.resolve(id, true);
  check('confirm: ответ true — подтверждено', (await pending) === true);
  check('confirm: повторный ответ на тот же id — false', withClient.resolve(id, true) === false);

  const chooser = new ServerPresenter(120);
  chooser.addClient(fakeWs);
  const choosing = chooser.chooseSession([{ title: 'Один', count: 3 }, { title: 'Два', count: 5 }]);
  await wait(30);
  const chooseMsg = captured.reverse().find((d) => d.includes('"choose_session"'));
  const cid = chooseMsg ? (JSON.parse(chooseMsg).id as string) : '';
  chooser.resolve(cid, 1);
  check('choose: индекс доходит', (await choosing) === 1);

  const slow = new ServerPresenter(120);
  slow.addClient(fakeWs);
  const t0 = Date.now();
  const denied = await slow.confirm({ label: 'Команда', desc: 'sleep', who: { id: 'x', name: 'Кто' } });
  check('confirm: таймаут — отказ', denied === false && Date.now() - t0 >= 100);

  // полный набор событий Presenter: каждое — валидное JSON-сообщение нужной формы
  {
    const wire: string[] = [];
    const wireWs = { readyState: 1, send: (d: string) => wire.push(d), on: () => {} } as unknown as WebSocket;
    const live = new ServerPresenter();
    live.addClient(wireWs);
    const who = { id: 'a1', name: 'Ася', emoji: '🐵', color: 'cyan', role: 'тестировщица' };
    live.notice('заметка');
    live.error('беда');
    live.turnHeader(who);
    const sink = live.stream('печатает…');
    sink.delta('при');
    sink.delta('вет');
    sink.done();
    live.say('реплика целиком');
    live.toolLines(['✅ ок']);
    live.attachment('Разговор «Т»', 'дайджест');
    live.turnEnd('привет');
    live.sessionOpened({ id: 's1', title: 'Т', messages: [] } as never);
    const parsed = wire.map((d) => JSON.parse(d) as Record<string, unknown>);
    const byType = (t: string) => parsed.filter((m) => m.type === t);
    check('events: notice и error', byType('notice')[0]?.text === 'заметка' && byType('error')[0]?.text === 'беда');
    check('events: turn_header несёт арбитра', (byType('turn_header')[0]?.agent as { name: string }).name === 'Ася');
    const busies = byType('busy');
    const busyEnds = byType('busy_end');
    check('events: stream — busy и busy_end парой', busies.length === 1 && busyEnds.length === 1 && busies[0]?.id === busyEnds[0]?.id);
    const deltas = byType('delta');
    check('events: delta по кусочкам', deltas.length === 2 && deltas[0]?.text === 'при' && deltas[1]?.text === 'вет');
    check('events: turn_end с полным текстом', byType('turn_end')[0]?.full === 'привет');
    check('events: say и tool_results', byType('say')[0]?.text === 'реплика целиком' && JSON.stringify(byType('tool_results')[0]?.results) === '["✅ ок"]');
    check('events: attachment', byType('attachment')[0]?.title === 'Разговор «Т»');
    const opened = byType('session_opened')[0]?.session as { id: string; title: string; messages: unknown[] };
    check('events: session_opened — публичная форма', opened.id === 's1' && opened.title === 'Т' && Array.isArray(opened.messages));
    // busy(): отдельный спиннер со своим stop()
    const spinner = live.busy('ищу…');
    spinner.stop();
    const parsed2 = wire.map((d) => JSON.parse(d) as Record<string, unknown>);
    const spin = parsed2.filter((m) => m.type === 'busy' && m.label === 'ищу…');
    check(
      'events: busy/stop — пара с общим id',
      spin.length === 1 && parsed2.some((m) => m.type === 'busy_end' && m.id === spin[0]?.id),
    );
    // broadcast — серверная инициатива (state) доходит клиенту
    live.broadcast({ type: 'state', state: { marker: 1 } });
    check('events: broadcast доходит', wire.some((d) => d.includes('"marker"')));
  }
}

// --- закрытие ---
await handle.close();
let closed = false;
try {
  await fetch(`http://127.0.0.1:${handle.port}/health`);
} catch {
  closed = true;
}
check('close: сервер остановился', closed);

rmTemp(home);
rmTemp(proj);

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
