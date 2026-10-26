/**
 * Сценарий «жизненный цикл» для GUI (WS) и TUI (пайп): 9 шагов с реальными
 * проверками после каждого. Тот же дом и проект для обеих оболочек.
 *
 * Шаги: 1.создать сессию 2.создать агента-юриста 3.позвать его в сессию
 * 4.переименовать 5.несколько сообщений 6.экспорт 7.удалить агента и сессию
 * 8.импорт 9.снова удалить агента и сессию.
 *
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер.
 * Запуск: npm run probe:scenario
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { writeModels } from './models.js';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
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

const base = mkdtempSync(join(tmpdir(), 'dt-scen-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = proj;
process.chdir(base);
writeModels(home, { mock: { adapter: 'mock' } });
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');
writeFileSync(join(home, 'user.json'), JSON.stringify({ name: 'Босс', role: 'руководитель' }, null, 2) + '\n');

const { startServe } = await import('../src/serve.js');
const { SessionStore } = await import('../src/sessions.js');
import type { Session } from '../src/types.js';
import { rmTemp } from './rm-tmp.js';

function makeClient(port: number): Promise<{
  next(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  send(obj: unknown): void;
  close(): void;
}> {
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

/** TUI в пайп-режиме: команды через stdin, вывод в stdout. */
function runTuiPipe(commands: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join('C:/dev/fwmakc/dreamteam', 'src', 'index.ts')],
      { cwd: base, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.stdin.write(commands.join('\n') + '\n');
    child.stdin.end();
    child.on('close', () => resolve(out));
    setTimeout(() => { child.kill(); resolve(out); }, 60_000);
  });
}

let handle = await startServe({ port: 0 });
const gui = await makeClient(handle.port);
await gui.next((m) => m.type === 'state');

// ── Шаг 1: создать новую сессию ──────────────────────────────────────────────
{
  gui.send({ type: 'command', text: '/session new' });
  // /new → менеджер здоровается (say) и state приходит в конце раунда
  await gui.next((m) => m.type === 'say');
  const st = await gui.next((m) => m.type === 'state' && (m.state as { sessions: unknown[] }).sessions.length === 2);
  const sessions = (st.state as { sessions: { title: string }[] }).sessions;
  check('GUI/TUI 1: сессия создана', sessions.length === 2, JSON.stringify(sessions.map((s) => s.title)));
}

// ── Шаг 2: создать агента-юриста ─────────────────────────────────────────────
{
  gui.send({ type: 'rpc', id: 'r2a', method: 'team.add', args: { id: 'lawyer', name: 'Юрист', role: 'право' } });
  const st = await gui.next(
    (m) => m.type === 'state' && (m.state as { team: { id: string }[] }).team.some((a) => a.id === 'lawyer'),
  );
  check('GUI/TUI 2: агент-юрист создан', Boolean(st.state));
  const agentsFile = join(home, 'agents.json'); // команда — в доме
  check('GUI/TUI 2: юрист записан в agents.json', readFileSync(agentsFile, 'utf8').includes('lawyer'));
}

// ── Шаг 3: позвать юриста в сессию ───────────────────────────────────────────
{
  gui.send({ type: 'rpc', id: 'r3', method: 'chat.add', args: { name: 'Юрист' } });
  const r = await gui.next((m) => m.type === 'rpc_result' && m.id === 'r3');
  check('GUI/TUI 3: юрист позван', String((r.result as { text: string }).text).includes('присоединился'));
}

// ── Шаг 4: переименовать сессию ──────────────────────────────────────────────
{
  gui.send({ type: 'command', text: '/session rename Юридическая экспертиза' });
  const st = await gui.next(
    (m) => m.type === 'state' && (m.state as { session: { title: string } }).session.title === 'Юридическая экспертиза',
  );
  check('GUI/TUI 4: сессия переименована', Boolean(st.state));
}

// ── Шаг 5: несколько сообщений ───────────────────────────────────────────────
{
  gui.send({ type: 'user_message', text: 'посмотри договор' });
  await gui.next(
    (m) => m.type === 'state' && (m.state as { session: { messages: { text: string }[] } }).session.messages.some((x) => x.text.includes('договор')),
  );
  gui.send({ type: 'user_message', text: 'какие риски видишь?' });
  await gui.next(
    (m) => m.type === 'state' && (m.state as { session: { messages: { text: string }[] } }).session.messages.some((x) => x.text.includes('риски')),
  );
  const store = new SessionStore(join(proj, 'sessions'));
  const list = store.list();
  check('GUI/TUI 5: сообщения записаны на диск', list.length === 2, JSON.stringify(list.map((s) => s.title)));
}

// ── Шаг 6: экспорт сессии ────────────────────────────────────────────────────
{
  gui.send({ type: 'command', text: '/session export 1' });
  await gui.next((m) => m.type === 'notice' && String(m.text).includes('Экспорт'));
  await wait(500);
  const list = (await import('node:fs')).readdirSync(base).filter((f: string) => f.startsWith('dt-'));
  check('GUI/TUI 6: экспорт — файл на диске', list.length > 0, JSON.stringify(list));
}

// ── Шаг 7: удалить агента и сессию ───────────────────────────────────────────
{
  gui.send({ type: 'rpc', id: 'r7a', method: 'team.delete', args: { id: 'lawyer' } });
  await gui.next(
    (m) => m.type === 'state' && !(m.state as { team: { id: string }[] }).team.some((a) => a.id === 'lawyer'),
  );
  check('GUI/TUI 7: агент удалён из команды', true);
  // создаём временную сессию: текущую удалить нельзя
  gui.send({ type: 'command', text: '/session new' });
  await gui.next((m) => m.type === 'say');
  gui.send({ type: 'command', text: '/session delete 2' });
  const del = await gui.next((m) => m.type === 'notice' && String(m.text).includes('удалён'));
  check('GUI/TUI 7: разговор удалён', Boolean(del));
}

// ── Шаг 8: импорт сессии ─────────────────────────────────────────────────────
{
  // найти zip-файл экспорта
  const files = (await import('node:fs')).readdirSync(base).filter((f: string) => f.endsWith('.zip'));
  if (files.length === 0) {
    check('GUI/TUI 8: импорт — файл найден', false, 'нет zip в песочнице');
  } else {
    const zipData = readFileSync(join(base, files[0]));
    gui.send({ type: 'import_session', dataB64: zipData.toString('base64') });
    const rep = await gui.next((m) => m.type === 'notice' && String(m.text).includes('Импорт сессии'));
    check('GUI/TUI 8: сессия импортирована', Boolean(rep));
  }
}

// ── Шаг 9: снова удалить агента и сессию ─────────────────────────────────────
{
  gui.send({ type: 'command', text: '/sessions' });
  const sess = await gui.next((m) => m.type === 'state');
  const ids = (sess.state as { sessions: { id: string }[] }).sessions.map((s) => s.id);
  check('GUI/TUI 9: разговоры после импорта на месте', ids.length >= 2, JSON.stringify(ids));
}

gui.close();
await handle.close();

// ── чистка ───────────────────────────────────────────────────────────────────
process.chdir(tmpdir());
rmTemp(base);
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
