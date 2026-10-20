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
writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify({ default: 'mock', providers: { mock: { adapter: 'mock' } } }, null, 2) + '\n',
);

const { startServe, ServerPresenter } = await import('../src/serve.js');

/** WS-клиент с очередью событий и поиском по предикату. */
function makeClient(port: number): Promise<{
  send(obj: unknown): void;
  next(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
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
        send: (obj) => ws.send(JSON.stringify(obj)),
        next(pred, ms = 10_000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('ждать нечего: событие не пришло')), ms);
            waiters.push({ pred, resolve: res, timer });
          });
        },
        raw: () => queue,
        close: () => ws.close(),
      }),
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
  const appJs = await fetch(`http://127.0.0.1:${handle.port}/app.js`);
  check('http: app.js отдаётся (text/javascript)', appJs.status === 200 && (appJs.headers.get('content-type') ?? '').includes('javascript'));
  const style = await fetch(`http://127.0.0.1:${handle.port}/style.css`);
  check('http: style.css отдаётся (text/css)', style.status === 200 && (style.headers.get('content-type') ?? '').includes('text/css'));
  const escape = await fetch(`http://127.0.0.1:${handle.port}/../package.json`);
  check('http: выход за gui/ не проходит', escape.status === 403 || escape.status === 404);
}

// --- WS: консьерж-сценарий на mock-провайдере ---
const client = await makeClient(handle.port);
{
  const first = await client.next((m) => m.type === 'state');
  const st0 = first.state as { session?: unknown; team?: unknown[]; providers?: { id: string; isDefault: boolean }[] };
  check('ws: первичный state пришёл', Boolean(st0.session));
  check('ws: команда пуста (консьерж-старт)', Array.isArray(st0.team) && st0.team.length === 0);
  check('ws: провайдер mock — основной', (st0.providers ?? []).some((p) => p.id === 'mock' && p.isDefault));

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
    'ws: agents.json временного проекта получил «Теста»',
    readFileSync(join(proj, 'agents.json'), 'utf8').includes('test_probe'),
  );

  // chat.add менеджером (обращение явное: в чате уже есть Тест — без @ раунд ушёл бы модератору)
  client.send({ type: 'user_message', text: '№менеджер, позови Теста в чат' });
  const joined = await client.next(
    (m) => m.type === 'notice' && String(m.text).includes('присоединился к чат'),
  );
  check('ws: chat.add исполнен', String(joined.text).includes('Тест'));

  // статус команды — менеджер отвечает без действий
  client.send({ type: 'user_message', text: '@менеджер, дай статус команды' });
  const status = await client.next((m) => m.type === 'say' && String(m.text).includes('Команда на месте'));
  check('ws: статус команды — ответ без действий', Boolean(status));

  // --- WS: команды через протокол (тот же набор, что и в терминале) ---
  {
    const stateCmd = await client.next(
      (m) => m.type === 'state' && Boolean((m.state as { completion?: { commands?: unknown[] } }).completion),
    );
    const commands = (stateCmd.state as { completion: { commands: { cmd: string }[] } }).completion.commands;
    check('ws: state несёт словарь команд', commands.length > 0 && commands.some((c) => c.cmd === '/help'));

    client.send({ type: 'rpc', id: 'rc0', method: 'state' });
    const snap = await client.next((m) => m.type === 'rpc_result' && m.id === 'rc0');
    const beforeCmd = (snap.result as { session: { messages: unknown[] } }).session.messages.length;
    client.send({ type: 'command', text: '/help' });
    const help = await client.next((m) => m.type === 'notice' && String(m.text).includes('/new'));
    check('ws: /help — справка notice-событием', Boolean(help));
    const stHelp = await client.next((m) => m.type === 'state');
    check(
      'ws: команды не пишутся в историю',
      (stHelp.state as { session: { messages: unknown[] } }).session.messages.length === beforeCmd,
    );

    client.send({ type: 'command', text: '/add Тест' });
    const again = await client.next((m) => m.type === 'notice' && String(m.text).includes('уже в чате'));
    check('ws: /add — отчёт о составе чата', Boolean(again));

    client.send({ type: 'command', text: '/foobar' });
    const unknown = await client.next((m) => m.type === 'notice' && String(m.text).includes('Неизвестная команда'));
    check('ws: неизвестная команда — отказ', Boolean(unknown));

    client.send({ type: 'command', text: '/exit' });
    const tui = await client.next((m) => m.type === 'notice' && String(m.text).includes('терминала'));
    check('ws: /exit — только терминал', Boolean(tui));

    client.send({ type: 'command', text: '/me Иванов; инженер' });
    const stMe = await client.next(
      (m) => m.type === 'state' && (m.state as { profile: { name: string } }).profile.name === 'Иванов',
    );
    check('ws: /me меняет профиль в state', ((stMe.state as { profile: { role?: string } }).profile.role) === 'инженер');

    // user_message с `/…` исполняется так же (перехват в ядре)
    client.send({ type: 'user_message', text: '/providers' });
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

  // rpc: состав чата туда-обратно
  client.send({ type: 'rpc', id: 'r3', method: 'chat.add', args: { name: 'Тест' } });
  const add = await client.next((m) => m.type === 'rpc_result' && m.id === 'r3');
  check('rpc: chat.add — текст отчёта', String((add.result as { text: string }).text).includes('присоединился'));
  const st3 = await client.next((m) => m.type === 'state');
  const team3 = (st3.state as { team: { id: string; inChat: boolean }[] }).team;
  check('rpc: в chat.add после — inChat true', team3.some((a) => a.id === 'test_probe' && a.inChat));

  client.send({ type: 'rpc', id: 'r4', method: 'chat.remove', args: { name: 'Тест' } });
  const rem = await client.next((m) => m.type === 'rpc_result' && m.id === 'r4');
  check('rpc: chat.remove — текст отчёта', String((rem.result as { text: string }).text).includes('покинул'));

  // rpc: ошибки — честные сообщения
  client.send({ type: 'rpc', id: 'r5', method: 'provider.set', args: { id: 'nope' } });
  const err1 = await client.next((m) => m.type === 'rpc_error' && m.id === 'r5');
  check('rpc: неизвестный провайдер — rpc_error', String(err1.error).includes('nope'));
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
  client.close();
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

rmSync(home, { recursive: true, force: true });
rmSync(proj, { recursive: true, force: true });

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
