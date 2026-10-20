import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { loadTeam } from './agents.js';
import { AGENTS_FILE } from './paths.js';
import { Engine, chatTeam, type App } from './core/engine.js';
import { bootstrapApp } from './core/bootstrap.js';
import { COMMANDS } from './core/commands.js';
import type { ConfirmRequest, Presenter, SpeakerRef, TurnSink } from './core/presenter.js';
import type { Agent, Session } from './types.js';

/**
 * Локальный API поверх ядра: `dreamteam serve` поднимает HTTP+WS на
 * 127.0.0.1 и раздаёт веб-оболочку из gui/. Ядро общается с клиентами
 * только через ServerPresenter (тот же интерфейс Presenter, что и у
 * терминала) — никакого второго ядра нет.
 *
 * Протокол (WS /ws, JSON-строки):
 *  сервер → клиент: state, notice, error, turn_header, busy, busy_end,
 *    delta, turn_end, say, tool_results, attachment, confirm, choose_session,
 *    session_opened, rpc_result, rpc_error;
 *  клиент → сервер: hello, user_message, command, abort, confirm_response,
 *    choose_response, rpc {method: state | sessions.list | session.open |
 *    session.new | session.delete | chat.add | chat.remove | provider.set}.
 *
 * `command` — текст `/…`: ядро исполняет те же команды, что и терминал
 * (перехват в handleMessage), отчёты уходят notice-событиями. GUI посылает
 * `command`, чтобы не рисовать текст команды пузырём пользователя; `user_message`
 * с `/…` внутри исполнится так же — на стороне сервера разницы нет.
 *
 * Вопрос человеку (confirm/choose_session), оставшийся без ответа, — отказ
 * по таймауту: раунд не висит вечно, human-in-the-loop честный.
 */

/** Таймаут живого вопроса: без ответа считается отказом (как runTimeoutMs у тулов) */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** Сообщение для клиента: то же, что лежит в истории разговора. */
function publicSession(session: Session): {
  id: string;
  title: string;
  messages: { authorId: string; authorName: string; authorRole?: string; text: string; ts: number }[];
} {
  return {
    id: session.id,
    title: session.title,
    messages: session.messages.map((m) => ({
      authorId: m.authorId,
      authorName: m.authorName,
      authorRole: m.authorRole,
      text: m.text,
      ts: m.ts,
    })),
  };
}

/** Полный снимок состояния для синхронизации оболочки. */
export function stateSnapshot(app: App): unknown {
  let team: Agent[] = [];
  try {
    team = loadTeam(AGENTS_FILE);
  } catch {
    team = []; // нет agents.json — консьерж-старт, GUI покажет пустую команду
  }
  const inChat = new Set(chatTeam(app.session, team).map((a) => a.id));
  return {
    session: publicSession(app.session),
    sessions: app.store.list(),
    team: team.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      emoji: a.emoji,
      color: a.color,
      provider: a.provider,
      inChat: inChat.has(a.id),
    })),
    manager: { name: app.mgr.name, emoji: app.mgr.emoji, color: app.mgr.color, provider: app.mgr.provider },
    providers: [...app.providers].map(([id, s]) => ({
      id,
      kind: s.provider.kind,
      model: s.provider.model,
      ok: s.ok,
      note: s.note,
      vision: s.vision,
      isDefault: id === app.defaultProviderId,
      isManager: id === app.mgr.provider,
    })),
    images: [...app.images].map(([id, s]) => ({ id, ok: s.ok, note: s.note })),
    profile: { name: app.profile.name, role: app.profile.role },
    // словарь автодополнения: имена команд — из ядра; остальные данные
    // (разговоры, команда, состав чата, провайдеры, имя менеджера) выводятся
    // клиентом из остальных полей этого же снапшота
    completion: { commands: COMMANDS },
  };
}

/**
 * Presenter для сети: события уходят всем подключенным клиентам,
 * вопросы (confirm/choose) ждут первый ответ — или таймаут-отказ.
 */
export class ServerPresenter implements Presenter {
  private nextId = 1;
  private clients = new Set<WebSocket>();
  private pending = new Map<string, (value: unknown) => void>();

  constructor(private confirmTimeoutMs: number = CONFIRM_TIMEOUT_MS) {}

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
    });
  }

  /** Ответ клиента на вопрос по id; false — опоздал/неизвестный id. */
  resolve(id: string, value: unknown): boolean {
    const res = this.pending.get(id);
    if (!res) return false;
    this.pending.delete(id);
    res(value);
    return true;
  }

  private send(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  /** Серверная инициатива вне Presenter (например, state-снапшот). */
  broadcast(msg: unknown): void {
    this.send(msg);
  }

  /** Живой вопрос всем клиентам; никого нет — сразу отказ (честный fail-fast). */
  private request(type: 'confirm' | 'choose_session', payload: object): Promise<unknown> {
    if (this.clients.size === 0) return Promise.resolve(null);
    const id = `r${this.nextId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type, id, ...payload });
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, this.confirmTimeoutMs).unref();
    });
  }

  notice(text: string): void {
    this.send({ type: 'notice', text });
  }

  error(text: string): void {
    this.send({ type: 'error', text });
  }

  turnHeader(agent: SpeakerRef): void {
    this.send({ type: 'turn_header', agent });
  }

  busy(label: string): { stop(): void } {
    const id = `b${this.nextId++}`;
    this.send({ type: 'busy', id, label });
    return { stop: () => this.send({ type: 'busy_end', id }) };
  }

  stream(busyLabel: string): TurnSink {
    const busyId = `b${this.nextId++}`;
    let started = false;
    this.send({ type: 'busy', id: busyId, label: busyLabel });
    return {
      delta: (text) => {
        if (!started) {
          started = true;
          this.send({ type: 'busy_end', id: busyId });
        }
        this.send({ type: 'delta', text });
      },
      done: () => {
        if (!started) this.send({ type: 'busy_end', id: busyId });
      },
    };
  }

  turnEnd(full: string): void {
    this.send({ type: 'turn_end', full });
  }

  say(text: string): void {
    this.send({ type: 'say', text });
  }

  toolLines(results: string[]): void {
    this.send({ type: 'tool_results', results });
  }

  attachment(title: string, digest: string): void {
    this.send({ type: 'attachment', title, digest });
  }

  async confirm(req: ConfirmRequest): Promise<boolean> {
    const v = await this.request('confirm', { label: req.label, desc: req.desc, who: req.who });
    return v === true;
  }

  async chooseSession(items: { title: string; count: number }[]): Promise<number | null> {
    const v = await this.request('choose_session', { items });
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  }

  sessionOpened(session: Session): void {
    this.send({ type: 'session_opened', session: publicSession(session) });
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Каталог веб-оболочки рядом с src/ — и в репозитории, и в установленном пакете. */
const GUI_DIR = fileURLToPath(new URL('../gui/', import.meta.url));

export interface ServeHandle {
  port: number;
  close(): Promise<void>;
}

export async function startServe(opts: { port?: number } = {}): Promise<ServeHandle> {
  const { app } = await bootstrapApp();
  const presenter = new ServerPresenter();
  const engine = new Engine(app, presenter);

  let activeAbort: (() => void) | null = null;

  /** Раунд под одним AbortController; в конце — свежий state всем клиентам. */
  const runRound = async (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (activeAbort) {
      presenter.error('Предыдущий раунд ещё идёт — отмените его или подождите.');
      return;
    }
    const ac = new AbortController();
    activeAbort = () => ac.abort();
    try {
      await work(ac.signal);
    } catch (err) {
      presenter.error(`ошибка: ${err instanceof Error ? err.message : err}`);
    } finally {
      activeAbort = null;
      broadcastState();
    }
  };

  const broadcastState = (): void => {
    presenter.broadcast({ type: 'state', state: stateSnapshot(app) });
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    serveStatic(url.pathname, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws: WebSocket) => {
    presenter.addClient(ws);
    ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app) }));
    ws.on('message', (raw: RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        presenter.error('кривое сообщение (не JSON) — проигнорировано');
        return;
      }
      void handleClientMessage(ws, msg);
    });
  });

  async function handleClientMessage(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? '');
    switch (type) {
      case 'hello':
        ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app) }));
        return;
      case 'user_message':
      case 'command': {
        // `command` — `/…`-текст от GUI (не рисуется пузырём пользователя);
        // серверу разницы нет: перехват '/' живёт в ядре
        const text = String(msg.text ?? '').trim();
        if (!text) return;
        await runRound((signal) => engine.handleMessage(text, signal));
        return;
      }
      case 'abort':
        activeAbort?.();
        return;
      case 'confirm_response': {
        presenter.resolve(String(msg.id ?? ''), msg.approved === true);
        return;
      }
      case 'choose_response': {
        const index = msg.index;
        presenter.resolve(String(msg.id ?? ''), typeof index === 'number' ? index : null);
        return;
      }
      case 'rpc': {
        const id = String(msg.id ?? '');
        try {
          const result = await handleRpc(msg);
          ws.send(JSON.stringify({ type: 'rpc_result', id, result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'rpc_error', id, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
      default:
        presenter.error(`неизвестный тип сообщения «${type}»`);
    }
  }

  async function handleRpc(msg: Record<string, unknown>): Promise<unknown> {
    const method = String(msg.method ?? '');
    const args = (msg.args ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'state':
        return stateSnapshot(app);
      case 'sessions.list':
        return { sessions: app.store.list() };
      case 'session.open': {
        const n = Number(args.n);
        if (!Number.isInteger(n) || n <= 0) throw new Error('session.open: жду номер из sessions.list');
        engine.openSessionByArg(String(n));
        // состав чата зависит от разговора: после переключения всем нужен свежий state
        broadcastState();
        return { ok: true };
      }
      case 'session.new':
        await runRound((signal) => engine.newSession(signal));
        return { ok: true };
      case 'session.delete': {
        const n = Number(args.n);
        if (!Number.isInteger(n) || n <= 0) throw new Error('session.delete: жду номер из sessions.list');
        const text = engine.deleteSession(n);
        broadcastState(); // список разговоров изменился — всем свежий state
        return { text };
      }
      case 'chat.add':
      case 'chat.remove': {
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error(`${method}: жду имя участника`);
        const team = engine.team();
        const text = method === 'chat.add' ? engine.addToChat(name, team) : engine.removeFromChat(name, team);
        broadcastState();
        return { text };
      }
      case 'provider.set': {
        const pid = String(args.id ?? '').trim();
        const ok = engine.setProvider(pid);
        if (!ok) throw new Error(`Нет провайдера «${pid}». Доступны: ${[...app.providers.keys()].join(', ')}`);
        broadcastState();
        return { ok: true };
      }
      default:
        throw new Error(`неизвестный rpc-метод «${method}»`);
    }
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(GUI_DIR, rel));
    // только внутрь gui/: без выходов по «..»
    if (!file.startsWith(normalize(GUI_DIR))) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'нет такого файла (оболочка живёт в gui/ пакета)' }));
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  const port = opts.port ?? (Number(process.env.DT_PORT) || 8787);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', resolve);
  });
  const actual = httpServer.address();
  const realPort = typeof actual === 'object' && actual ? actual.port : port;

  // Пустой разговор — менеджер здоровается сам (как в терминале на старте):
  // раунд в фоне, клиенты, подключившиеся посреди приветствия, получат события.
  if (app.session.messages.length === 0) {
    void runRound((signal) => engine.startupWelcome(signal));
  }

  return {
    port: realPort,
    close(): Promise<void> {
      return new Promise((resolve) => {
        wss.close();
        httpServer.close(() => resolve());
        // активные WS-соединения держат сервер: рвём принудительно
        for (const ws of wss.clients) ws.terminate();
      });
    },
  };
}

// запускаемся только как точка входа — bin serve (ставит DT_SERVE=1) или
// npm run serve (argv[1] — этот файл); при импорте из проб не стартуем
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (process.env.DT_SERVE === '1' || entry.endsWith('/src/serve.ts')) {
  startServe()
    .then(({ port }) => {
      console.log(pc.dim(`\n  API поднято: http://127.0.0.1:${port} (WS — /ws) · только локально · Ctrl+C — останов`));
    })
    .catch((err) => {
      console.error(pc.red(`Фатальная ошибка: ${err instanceof Error ? err.stack ?? err.message : err}`));
      process.exit(1);
    });
}
