/**
 * Проверка локального API (dreamteam serve) без LLM и терминала:
 *  - HTTP: /health, статика 404 до появления gui/;
 *  - WS: первичный state, раунд через mock-провайдера (менеджер: team.add,
 *    chat.add, статус), rpc (sessions.list, session.new с приветствием,
 *    chat.add/remove, provider.set, session.delete, неизвестный метод);
 *  - ServerPresenter: вопрос без клиентов — сразу отказ, ответ клиента —
 *    подтверждение, выбор разговора, таймаут-отказ.
 *
 * Герметичность: DT_HOME/DT_PROJECT выставляются до импорта serve (пути
 * замораживаются на импорте) во временные каталоги; сервер — на порту 0.
 * Запуск: npm run probe:api
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

// --- песочница: слои во временных каталогах, провайдер только mock ---
// proj заранее не существует: ensureLayers скаффолдит его сам (как на живом проекте)
const base = mkdtempSync(join(tmpdir(), 'dt-api-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = proj;
// рабочая папка инструментов = cwd на момент импорта: уводим процесс в tmp,
// чтобы mock-демонстрация писала файлы в песочницу, а не в репозиторий
process.chdir(base);
writeModels(home, { mock: { adapter: 'mock' } }, 'mock');
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
  const st0 = first.state as { session?: unknown; team?: unknown[]; teamError?: string | null; models?: { id: string; isDefault: boolean }[] };
  check('ws: первичный state пришёл', Boolean(st0.session));
  const st0team = (st0.team ?? []) as { id: string }[];
  check('ws: стартовая команда — пять агентов', st0team.length === 5, JSON.stringify(st0team.map((a) => a.id)));
  check(
    'ws: ids стартовой команды',
    ['analyst', 'secretary', 'developer', 'designer', 'writer'].every((id) => st0team.some((a) => a.id === id)),
    JSON.stringify(st0team.map((a) => a.id)),
  );
  check('ws: нет agents/ — без ошибки в state', st0.teamError == null);
  check('ws: модель mock — основная', (st0.models ?? []).some((p) => p.id === 'mock' && p.isDefault));

  client.send({ type: 'hello' });
  const again = await client.next((m) => m.type === 'state');
  check('ws: hello возвращает свежий state', Boolean((again.state as { session?: unknown }).session));

  // пустой разговор: менеджер здоровается сам (как в терминале) — ждём приветствие
  await client.next((m) => m.type === 'say' && String(m.text).includes('менеджер переговорки'));
  await client.next(
    (m) => m.type === 'state' && (m.state as { session: { messages: unknown[] } }).session.messages.length > 0,
  );
  check('ws: консьерж поздоровался в пустом разговоре', true);

  // первая реплика уходит менеджеру: mock исполняет team.add Тест
  client.send({ type: 'user_message', text: 'привет, команда' });
  const header = await client.next((m) => m.type === 'turn_header');
  check('ws: заголовок реплики менеджера', (header.agent as { name: string }).name === 'Менеджер');
  const say = await client.next((m) => m.type === 'say');
  check('ws: менеджер ответил заготовкой', String(say.text).includes('Позываю'));
  const report = await client.next((m) => m.type === 'notice' && String(m.text).includes('Тест'));
  check('ws: отчёт о действии пришёл', String(report.text).includes('Тест'));
  const state1 = await client.next(
    (m) => m.type === 'state' && (m.state as { session: { messages: unknown[] } }).session.messages.length > 0,
  );
  const st1 = state1.state as { session: { messages: { authorId: string }[] }; team: { id: string }[] };
  check('ws: реплика менеджера в истории', st1.session.messages.some((m) => m.authorId === 'manager'));
  check('ws: «Тест» появился в команде', st1.team.some((a) => a.id === 'test_probe'));
  check(
    'ws: agents/ временного проекта получил «Теста»',
    readFileSync(join(home, 'agents'), 'utf8').includes('test_probe'),
  );

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

    client.send({ type: 'command', text: '/chat add Тест' });
    const again = await client.next((m) => m.type === 'notice' && String(m.text).includes('уже в чате'));
    check('ws: /add — отчёт о составе чата', Boolean(again));
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

    client.send({ type: 'command', text: '/profile set Иванов; инженер' });
    const stMe = await client.next(
      (m) => m.type === 'state' && (m.state as { profile: { name: string } }).profile.name === 'Иванов',
    );
    check('ws: /me меняет профиль в state', ((stMe.state as { profile: { role?: string } }).profile.role) === 'инженер');

    // user_message с `/…` исполняется так же (перехват в ядре)
    client.send({ type: 'user_message', text: '/model' });
    const prov = await client.next((m) => m.type === 'notice' && String(m.text).includes('• mock'));
    check('ws: /… в user_message тоже команда', Boolean(prov));
    await client.next((m) => m.type === 'state');
  }

  // rpc: список разговоров
  client.send({ type: 'rpc', id: 'r1', method: 'sessions.list' });
  const list = await client.next((m) => m.type === 'rpc_result' && m.id === 'r1');
  check('rpc: список разговоров', ((list.result as { sessions: unknown[] }).sessions.length === 1));

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
  client.send({ type: 'rpc', id: 'r3', method: 'chat.add', args: { name: 'Тест' } });
  const add = await client.next((m) => m.type === 'rpc_result' && m.id === 'r3');
  check('rpc: chat.add — текст отчёта', String((add.result as { text: string }).text).includes('присоединился'));
  client.send({ type: 'rpc', id: 'snap1', method: 'state' });
  const snap1 = await client.next((m) => m.type === 'rpc_result' && m.id === 'snap1');
  const after3 = snap1.result as { team: { id: string; inChat: boolean }[]; session: { messages: { authorId: string; text: string }[] } };
  check('rpc: после chat.add — inChat true', after3.team.some((a) => a.id === 'test_probe' && a.inChat));
  check(
    'rpc: событие chat.add — реплика менеджера в хронике',
    after3.session.messages.at(-1)?.authorId === 'manager' && (after3.session.messages.at(-1)?.text.includes('присоединился') ?? false),
    JSON.stringify(after3.session.messages.at(-1)),
  );

  client.send({ type: 'rpc', id: 'r4', method: 'chat.remove', args: { name: 'Тест' } });
  const rem = await client.next((m) => m.type === 'rpc_result' && m.id === 'r4');
  check('rpc: chat.remove — текст отчёта', String((rem.result as { text: string }).text).includes('покинул'));
  client.send({ type: 'rpc', id: 'snap2', method: 'state' });
  const snap2 = await client.next((m) => m.type === 'rpc_result' && m.id === 'snap2');
  const after4 = snap2.result as { session: { messages: { authorId: string; text: string }[] } };
  check(
    'rpc: событие chat.remove — реплика менеджера в хронике',
    after4.session.messages.at(-1)?.authorId === 'manager' && (after4.session.messages.at(-1)?.text.includes('покинул') ?? false),
    JSON.stringify(after4.session.messages.at(-1)),
  );

  // rpc: user_set — профиль через форму настроек (обе оболочки ходят rpc-методом)
  client.send({ type: 'rpc', id: 'r9', method: 'profile.set', args: { name: 'Профиль', role: 'тест' } });
  const us = await client.next((m) => m.type === 'rpc_result' && m.id === 'r9');
  check('rpc: profile.set — профиль обновлён', String((us.result as { text: string }).text).includes('Профиль'));
  // то же клиентским сообщением (канал без rpc) — и вернуть профиль как был
  client.send({ type: 'rpc', id: 'r9b', method: 'profile.set', args: { name: 'Пользователь' } });
  await client.next((m) => m.type === 'rpc_result' && m.id === 'r9b');

  // rpc: schedule.list — задачи расписания (секция «Расписание» в GUI)
  client.send({ type: 'rpc', id: 'r13', method: 'schedule.list' });
  const sch = await client.next((m) => m.type === 'rpc_result' && m.id === 'r13');
  check('rpc: schedule.list — задачи расписания', Array.isArray((sch.result as { tasks?: unknown[] }).tasks));

  // rpc: model.update — правка карточки существующей модели
  client.send({ type: 'rpc', id: 'r14', method: 'model.update', args: { id: 'mock', fields: { model: 'mock-2' } } });
  const pu = await client.next((m) => m.type === 'rpc_result' && m.id === 'r14');
  check('rpc: model.update — карточка правится', String((pu.result as { text: string }).text).includes('mock-2'));
  client.send({ type: 'rpc', id: 'r15', method: 'model.update', args: { id: 'mock', fields: { adapter: 'неттакого' } } });
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
  client.send({ type: 'rpc', id: 'r5', method: 'model.set', args: { id: 'nope' } });
  const err1 = await client.next((m) => m.type === 'rpc_error' && m.id === 'r5');
  check('rpc: неизвестная модель — rpc_error', String(err1.error).includes('nope'));
  client.send({ type: 'rpc', id: 'r6', method: 'совсем-неизвестное' });
  const err2 = await client.next((m) => m.type === 'rpc_error' && m.id === 'r6');
  check('rpc: неизвестный метод — rpc_error', String(err2.error).includes('совсем-неизвестное'));

  // rpc: текущий разговор удалить нельзя (но state после попытки всё равно уходит)
  client.send({ type: 'rpc', id: 'r7', method: 'session.delete', args: { n: 1 } });
  const del = await client.next((m) => m.type === 'rpc_result' && m.id === 'r7');
  check('rpc: текущий разговор не удаляется', String((del.result as { text: string }).text).includes('нельзя'));

  // rpc: другой разговор удаляется — отчёт и свежий state (список короче)
  client.send({ type: 'rpc', id: 'r8', method: 'session.delete', args: { n: 2 } });
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
        JSON.stringify(['auto', 'completion', 'images', 'knownProjects', 'manager', 'memory', 'models', 'profile', 'project', 'projects', 'session', 'sessions', 'settings', 'team', 'teamError', 'ui']),
    );
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
    client.send({ type: 'command', text: '/model' });
    const provN = await client.next((m) => m.type === 'notice' && String(m.text).includes('★ основной'));
    check('multi: после отключения B сервер работает с A', Boolean(provN));
    await client.next((m) => m.type === 'state');
  }

  // --- CONFIRM ЖИВОГО РАУНДА: у Теста shell с узким allow — echo уйдёт в вопрос ---
  {
    const teamFile = join(home, 'agents');
    type TeamAgent = { id: string; tools?: Record<string, unknown> };
    const team = JSON.parse(readFileSync(teamFile, 'utf8')) as TeamAgent[];
    const tester = team.find((a) => a.id === 'test_probe');
    tester!.tools = { files: {}, shell: { allow: ['git *'] } };
    writeFileSync(teamFile, JSON.stringify(team, null, 2));

    client.send({ type: 'rpc', id: 'c9', method: 'chat.add', args: { name: 'Тест' } });
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
    check('confirm: демо-файл на диске песочницы', readFileSync(join(base, 'demo-agent.txt'), 'utf8').includes('mock-агента'));

    // «отказать»: в новом разговоре ступеньки демо сбрасываются
    const sNew = client.stateCount();
    client.send({ type: 'rpc', id: 'c10', method: 'session.new' });
    const greeted = await client.next(
      (m) => (m.type === 'say' && String(m.text).includes('менеджер переговорки')) || m.type === 'error',
    );
    check('confirm: session.new — менеджер приветствует', greeted.type === 'say');
    await client.waitState(sNew + 1);
    client.send({ type: 'rpc', id: 'c11', method: 'chat.add', args: { name: 'Тест' } });
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

  // --- УПРАВЛЕНИЕ ЧЕРЕЗ КОМАНДЫ WS: /agent, /grant, /project ---
  {
    const sAg = client.stateCount();
    client.send({ type: 'command', text: '/team add api_guy Аписька тестировщик' });
    const addA = await client.next((m) => m.type === 'notice' && String(m.text).includes('api_guy'));
    check('ws: /agent add — отчёт', Boolean(addA));
    await client.waitState(sAg + 1);
    client.send({ type: 'rpc', id: 'dTeam', method: 'state' });
    const stA = await client.next((m) => m.type === 'rpc_result' && m.id === 'dTeam');
    check('ws: /agent add — появился в state.team', ((stA.result as { team: { id: string }[] }).team).some((a) => a.id === 'api_guy'));

    const sGrant = client.stateCount();
    client.send({ type: 'command', text: '/team grant api_guy files' });
    const g = await client.next((m) => m.type === 'notice' && String(m.text).includes('files'));
    check('ws: /grant — отчёт', Boolean(g));
    await client.waitState(sGrant + 1);

    const sProj = client.stateCount();
    client.send({ type: 'command', text: '/project host add main=root@127.0.0.1:2223' });
    const p = await client.next((m) => m.type === 'notice' && String(m.text).includes('main'));
    check('ws: /project host add — отчёт', Boolean(p));
    const pf = JSON.parse(readFileSync(join(proj, 'hosts.json'), 'utf8')) as Record<string, { host: string; user?: string; port?: number }>;
    check('ws: /project host add — hosts.json на диске', pf.main?.host === '127.0.0.1' && pf.main?.user === 'root' && pf.main?.port === 2223, JSON.stringify(pf));
    await client.waitState(sProj + 1);

    const sHost = client.stateCount();
    client.send({ type: 'command', text: '/project host add reserve=127.0.0.2' });
    const ph = await client.next((m) => m.type === 'notice' && String(m.text).includes('reserve'));
    check('ws: /project host — отчёт', Boolean(ph));
    await client.waitState(sHost + 1);

    const sBad = client.stateCount();
    client.send({ type: 'command', text: '/team update api_guy foo=bar' });
    const badSet = await client.next((m) => m.type === 'error' && String(m.text).includes('не понятно, что менять'));
    check('ws: /agent set с мусорным полем — честная ошибка', Boolean(badSet));
    await client.waitState(sBad + 1);
  }

  // --- ЮНИКОД И БОЛЬШИЕ СООБЩЕНИЯ ---
  {
    const big = 'ёёё 🎬🛎 — «кавычки» и <script>alert(1)</script> ' + 'х'.repeat(8000);
    const sent = '@менеджер ' + big; // менеджеру: раунд без демо-тулов и живых вопросов
    client.send({ type: 'user_message', text: sent });
    const stBig = await client.next(
      (m) => m.type === 'state' && (m.state as { session: { messages: { text: string }[] } }).session.messages.some((x) => x.text.includes('ёёё')),
    );
    const saved = (stBig.state as { session: { messages: { text: string }[] } }).session.messages.find((x) => x.text.includes('ёёё'));
    check('ws: юникод, html и 8КБ — дошли без искажений', saved?.text === sent);
  }

  // --- БИТЫЙ agents.json: команда не может молча исчезнуть (в конце — чтобы
  // наши hello не глотали state-события идущих раундов; предикаты прицельные:
  // в очереди к этому месту копятся несвежие state от прошлых секций) ---
  {
    writeFileSync(join(home, 'agents'), '{ это не json');
    client.send({ type: 'hello' });
    const bad = await client.next((m) => m.type === 'state' && (m.state as { teamError?: unknown }).teamError != null);
    const stBad = bad.state as { teamError: string; team: unknown[] };
    check('ws: битый json — teamError в state', stBad.teamError.includes('не удалось прочитать'));
    check('ws: битый json — команда в снимке пуста', Array.isArray(stBad.team) && stBad.team.length === 0);

    writeFileSync(join(home, 'agents'), JSON.stringify([{ id: 'x' }]));
    client.send({ type: 'hello' });
    const bad2 = await client.next((m) => m.type === 'state' && String((m.state as { teamError?: string }).teamError ?? '').includes('обязательны поля'));
    check('ws: агент без name/prompt — ошибка называет поля', Boolean(bad2));

    writeFileSync(join(home, 'agents'), JSON.stringify([{ id: 'boss', name: 'Босс', prompt: 'Ты руководитель.' }]));
    client.send({ type: 'hello' });
    const good = await client.next((m) => m.type === 'state' && (m.state as { team?: { id: string }[] }).team?.some((a) => a.id === 'boss') === true);
    const stGood = good.state as { teamError?: string | null };
    check('ws: починили — teamError ушёл, команда в снимке', stGood.teamError == null);
    rmSync(join(home, 'agents')); // песочнице возвращаем отсутствие файла
    client.send({ type: 'hello' });
    const none = await client.next((m) => m.type === 'state' && (m.state as { team?: unknown[] }).team?.length === 0 && (m.state as { teamError?: unknown }).teamError == null);
    check('ws: файла нет — пусто и без ошибки', Boolean(none));
  }

  client.close();
}

// --- AUTH: сервер с TOKEN требует авторизацию первым сообщением ---
{
  process.env.TOKEN = 'секрет-тест-123';
  const secured = await startServe({ port: 0 });
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
