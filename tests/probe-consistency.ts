/**
 * GUI ⟷ TUI: обе оболочки читают один и тот же слой дома — проверяем, что
 * они видят одинаковые разговоры и одинаковые сообщения внутри них.
 *
 *  - «взгляд GUI» — state-снапшот через WS у работающего serve;
 *  - «взгляд TUI» — те же файлы через свежий SessionStore (как у терминала).
 *
 * Сценарий: seeded-сессии → снапшот ≡ диск → раунд через GUI → диск обновился
 * (TUI увидит) → «TUI» пишет в файлы → serve перезапущен → GUI видит его данные
 * (одновременная работа двух процессов на одном проекте не поддерживается —
 * перезапуск подхватывает изменения, это и проверяем).
 *
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер.
 * Запуск: npm run probe:consistency
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const base = mkdtempSync(join(tmpdir(), 'dt-cons-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = proj;
process.chdir(base);
const { SESSIONS_DIR } = await import('../src/paths.js');
writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify({ default: 'mock', providers: { mock: { adapter: 'mock' } } }, null, 2) + '\n',
);

const { startServe } = await import('../src/serve.js');
const { SessionStore } = await import('../src/sessions.js');
import type { Session } from '../src/types.js';

// ── сеем два разговора так, как их сохранила бы любая из оболочек ───────────
const storeTUI = new SessionStore(join(home, 'sessions'));
const s1: Session = storeTUI.create();
s1.title = 'Проект Альфа — обсуждение';
s1.messages.push(
  { authorId: 'user', authorName: 'Вы', text: 'первое сообщение альфы', ts: 1 },
  { authorId: 'manager', authorName: 'Менеджер', authorRole: 'менеджер переговорки', text: 'ответ альфы', ts: 2 },
  { authorId: 'tool', authorName: '⚙ инструменты', text: '✅ ок', ts: 3 },
);
storeTUI.save(s1);
const s2: Session = storeTUI.create();
s2.title = 'Бета — заметки';
s2.messages.push({ authorId: 'user', authorName: 'Вы', text: 'сообщение беты', ts: 4 });
storeTUI.save(s2);

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
      if (m.type === 'state') states++;
      if (m.type === 'error') console.log('  … сервер:', String(m.text ?? '').slice(0, 160));
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
      queue.push(m);
    });
    let states = 0;
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

/** Взгляд GUI: sessions + сообщения текущего разговора из state-снапшота. */
type GuiView = {
  sessions: { id: string; title: string; createdAt: number; updatedAt: number; count: number }[];
  messages: { authorId: string; authorName: string; text: string; ts: number }[];
};
async function guiView(port: number): Promise<GuiView> {
  const c = await makeClient(port);
  const st = await c.next((m) => m.type === 'state');
  const view = st.state as { sessions: GuiView['sessions']; session: { messages: GuiView['messages'] } };
  c.close();
  return { sessions: view.sessions, messages: view.session.messages };
}

/** Взгляд TUI: свежий SessionStore поверх тех же файлов. */
function tuiView(): GuiView {
  const fresh = new SessionStore(SESSIONS_DIR); // сессии — проектные: тот же DT_PROJECT
  const list = fresh.list();
  return {
    sessions: list,
    messages: (fresh.load(list[0].id)?.messages ?? []).map((m) => ({
      authorId: m.authorId, authorName: m.authorName, text: m.text, ts: m.ts,
    })),
  };
}

let handle = await startServe({ port: 0 });

// ── 1. одинаковые разговоры: список сессий GUI ≡ TUI ─────────────────────────
{
  const gui = await guiView(handle.port);
  const tui = tuiView();
  check(
    'сессии: порядок, id и имена совпадают',
    JSON.stringify(gui.sessions.map((s) => [s.id, s.title])) ===
      JSON.stringify(tui.sessions.map((s) => [s.id, s.title])),
    JSON.stringify({ gui: gui.sessions.map((s) => s.title), tui: tui.sessions.map((s) => s.title) }),
  );
  check(
    'сессии: даты создания и обновления совпадают',
    JSON.stringify(gui.sessions.map((s) => [s.createdAt, s.updatedAt])) ===
      JSON.stringify(tui.sessions.map((s) => [s.createdAt, s.updatedAt])),
  );
}

// ── 2. одинаковые сообщения внутри текущего разговора ────────────────────────
{
  const gui = await guiView(handle.port);
  const tui = tuiView();
  check(
    'сообщения: состав и порядок совпадают',
    JSON.stringify(gui.messages) === JSON.stringify(tui.messages),
    JSON.stringify({ gui: gui.messages.length, tui: tui.messages.length }),
  );
}

// ── 3. раунд через GUI → файлы обновились → TUI это видит ────────────────────
{
  const c = await makeClient(handle.port);
  await c.next((m) => m.type === 'state');
  const before = tuiView().messages.length;
  c.send({ type: 'user_message', text: 'проверочное сообщение из GUI' });
  // ждём КОНЕЦ раунда: пользователь + ответ менеджера уже на диске
  await c.next(
    (m) => m.type === 'state' && (m.state as { session: { messages: { text: string }[] } }).session.messages.length >= before + 2,
  );
  const after = tuiView();
  const fresh = after.messages.find((m) => m.text.includes('проверочное сообщение из GUI'));
  check('раунд GUI → диск: TUI видит новое сообщение и ответ', Boolean(fresh) && after.messages.length >= before + 2, `было ${before}, стало ${after.messages.length}`);
  c.close();
}

// ── 4. «TUI» пишет в файлы → перезапущенный serve показывает его данные ──────
{
  await handle.close();
  const fresh = new SessionStore(SESSIONS_DIR); // сессии — проектные: тот же DT_PROJECT
  const current = fresh.load(fresh.list()[0].id)!;
  current.messages.push({ authorId: 'user', authorName: 'Вы', text: 'сообщение из TUI (после перезапуска сервера)', ts: Date.now() });
  fresh.save(current);

  handle = await startServe({ port: 0 });
  const gui = await guiView(handle.port);
  check(
    'перезапуск serve: сообщение TUI на месте у GUI',
    gui.messages.some((m) => m.text.includes('сообщение из TUI')),
    JSON.stringify(gui.messages.map((m) => m.text.slice(0, 40))),
  );
}

await handle.close();
process.chdir(tmpdir()); // Windows не даёт удалить каталог процесса
rmSync(base, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
