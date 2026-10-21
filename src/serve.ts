import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { loadTeam } from './agents.js';
import {
  addProject,
  addTeamAgent,
  managerAsAgent,
  updateTeamAgent,
  mergeTeamAgents,
  removeProject,
  removeProjectHost,
  removeTeamAgent,
  updateManagerConfig,
} from './manager.js';
import { addProviderConfig, loadProviders, removeProviderConfig } from './providers/registry.js';
import { loadSettings } from './settings.js';
import { AGENTS_FILE, MANAGER_FILE, PROJECTS_FILE, PROVIDERS_FILE, SETTINGS_FILE, WORKSPACE } from './paths.js';
import { loadProjects, safePath } from './actions.js';
import { Engine, chatTeam, type App } from './core/engine.js';
import { bootstrapApp } from './core/bootstrap.js';
import { COMMANDS } from './core/commands.js';
import { homeEntries, packEntriesZip, readZipEntries, sessionEntries, applyHomeImport, applySessionImport } from './core/transfer.js';
import { loadSchedule, saveSchedule, type ScheduleTask } from './core/schedule.js';
import type { ConfirmRequest, Presenter, SpeakerRef, TurnSink } from './core/presenter.js';
import type { Agent, Session } from './types.js';

/**
 * Локальный API поверх ядра: `dreamteam serve` поднимает HTTP+WS на
 * 127.0.0.1:8080 (PORT/HOST, можно в ~/.dreamteam/.env) и раздаёт
 * веб-оболочку из gui/. Ядро общается с клиентами
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
 * по таймауту: раунд не висит вечно, human-in-the-loop честный. Раунды
 * выстраиваются в очередь (roundChain): команды и сообщения от быстрых
 * клиентов никогда не «наезжают» друг на друга.
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
export function stateSnapshot(app: App, engine?: Engine, projects?: unknown[]): unknown {
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
    settings: loadSettings(SETTINGS_FILE, 0),
    projects: projects ?? [],
    auto: engine ? { mode: engine.autoMode, left: engine.autoLeft } : { mode: false, left: 0 },
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
  /** true — клиенты обязаны авторизоваться (см. TOKEN); рассылка — только им */
  authRequired = false;
  private nextId = 1;
  private clients = new Set<WebSocket & { authed?: boolean }>();
  private pending = new Map<string, (value: unknown) => void>();

  constructor(private confirmTimeoutMs: number = CONFIRM_TIMEOUT_MS) {}

  addClient(ws: WebSocket): void {
    const socket = ws as WebSocket & { authed?: boolean };
    socket.authed = !this.authRequired;
    this.clients.add(socket);
    ws.on('close', () => {
      this.clients.delete(socket);
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
      if (ws.readyState === WebSocket.OPEN && ws.authed) ws.send(data);
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

/**
 * Каталог веб-оболочки рядом с src/ — и в репозитории, и в установленном пакете.
 * Предпочитаем собранную Vue-оболочку (gui-dist/); если сборки нет
 * (установка из npm без этапа build) — vanilla-оболочка из gui/.
 */
const GUI_DIST = fileURLToPath(new URL('../gui-dist/', import.meta.url));
const GUI_VANILLA = fileURLToPath(new URL('../gui/', import.meta.url));
const GUI_DIR = existsSync(join(GUI_DIST, 'index.html')) ? GUI_DIST : GUI_VANILLA;

export interface ServeHandle {
  port: number;
  host: string;
  close(): Promise<void>;
}

export async function startServe(opts: { port?: number } = {}): Promise<ServeHandle> {
  const { app } = await bootstrapApp();
  const presenter = new ServerPresenter();
  const engine = new Engine(app, presenter);

  let activeAbort: (() => void) | null = null;
  // раунды выстраиваются в очередь: команды и сообщения никогда не «наезжают»
  // друг на друга, а отказ «подождите» не нужен ни скриптам, ни оболочке
  let roundChain: Promise<void> = Promise.resolve();

  /** Раунд под одним AbortController; в конце — свежий state всем клиентам. */
  const runRound = (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const run = roundChain.then(async () => {
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
    });
    roundChain = run.catch(() => {});
    return run;
  };

  // ── планировщик: раз в минуту проверяем расписание задач ──────
  const nextDue = new Map<string, number>();
  const scheduleTimer = setInterval(() => {
    const now = Date.now();
    for (const task of loadSchedule(join(dirname(PROJECTS_FILE), 'schedule.json')).filter((t) => t.enabled)) {
      const due = nextDue.get(task.id) ?? 0;
      if (now < due) continue;
      nextDue.set(task.id, now + task.intervalMinutes * 60_000);
      void runRound((signal) => engine.handleMessage(task.message, signal));
    }
  }, 60_000);

  const readProjects = (): unknown[] => {
    try {
      return [...loadProjects(PROJECTS_FILE).entries()].map(([id, p]) => ({
        id,
        hosts: [...p.hosts.entries()].map(([name, h]) => ({ name, host: h.host })),
      }));
    } catch {
      return [];
    }
  };

  const broadcastState = (): void => {
    presenter.broadcast({ type: 'state', state: stateSnapshot(app, engine, readProjects()) });
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/file') {
      const rel = url.searchParams.get('path') ?? '';
      const abs = safePath(WORKSPACE, rel);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('файл не найден');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rel.split('/').at(-1) ?? 'file')}`,
      });
      res.end(readFileSync(abs));
      return;
    }
    serveStatic(url.pathname, res);
  });

  type ClientSocket = WebSocket & { authed?: boolean };
  const stamp = (): string => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  // токен доступа: задаётся TOKEN в ~/.dreamteam/.env; пусто — сервер открыт
  // (по умолчанию он и так слушает только 127.0.0.1)
  const authToken = String(process.env.TOKEN ?? '').trim();
  if (authToken) presenter.authRequired = true;

  wss.on('connection', (plain: WebSocket) => {
    const ws = plain as ClientSocket;
    presenter.addClient(ws);
    if (authToken) {
      ws.authed = false;
      ws.send(JSON.stringify({ type: 'auth_required' }));
    } else {
      ws.authed = true;
      ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app, engine) }));
    }
    ws.on('message', (raw: RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        presenter.error('кривое сообщение (не JSON) — проигнорировано');
        return;
      }
      // null, массивы и прочее не-объектное: валидный JSON, но не сообщение
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        presenter.error('кривое сообщение (не объект) — проигнорировано');
        return;
      }
      const typed = msg as Record<string, unknown>;
      // без авторизации — только попытка авторизоваться
      if (!ws.authed && typed.type !== 'auth') {
        ws.send(JSON.stringify({ type: 'auth_required' }));
        return;
      }
      void handleClientMessage(ws, typed);
    });
  });

  /** Токен сверяется с постоянным временем (утечка через тайминги исключена). */
  function tokenMatches(candidate: string): boolean {
    const sha = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(sha(candidate), sha(authToken));
  }

  async function handleClientMessage(ws: ClientSocket, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? '');
    if (type === 'auth') {
      const ok = typeof msg.token === 'string' && tokenMatches(String(msg.token));
      ws.authed = ok;
      ws.send(JSON.stringify(ok ? { type: 'auth_ok' } : { type: 'auth_failed' }));
      if (ok) ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app, engine) }));
      return;
    }
    switch (type) {
      case 'hello':
        ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app, engine) }));
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
      case 'export_home': {
        const data = packEntriesZip(homeEntries());
        ws.send(JSON.stringify({ type: 'export_data', name: `dt-home-${stamp()}.zip`, dataB64: data.toString('base64') }));
        return;
      }
      case 'export_session': {
        const entries = sessionEntries(app, Number(msg.n));
        const meta = app.store.list()[Number(msg.n) - 1];
        ws.send(JSON.stringify({ type: 'export_data', name: `dt-session-${meta?.id ?? 'x'}.zip`, dataB64: packEntriesZip(entries).toString('base64') }));
        return;
      }
      case 'import_home': {
        const entries = readZipEntries(Buffer.from(String(msg.dataB64 ?? ''), 'base64'));
        const ok = await presenter.confirm({
          label: 'Импортировать домашние настройки из файла?',
          desc: 'Настройки/профиль/провайдеры заменяются; разговоры вливаются по id. Ключи (.env) не переносятся.',
          who: managerAsAgent(app.mgr),
        });
        if (!ok) {
          ws.send(JSON.stringify({ type: 'notice', text: '  Импорт дома отменён.' }));
          return;
        }
        const report = applyHomeImport(app, entries);
        presenter.notice('  ' + report);
        broadcastState();
        return;
      }
      case 'import_session': {
        const entries = readZipEntries(Buffer.from(String(msg.dataB64 ?? ''), 'base64'));
        const report = applySessionImport(app, entries);
        presenter.notice('  ' + report);
        broadcastState();
        return;
      }
      case 'file': {
        // файл от руководителя: кладём в inbox рабочей папки и шлём сообщение с меткой
        const name = String(msg.name ?? 'file').replace(/[\/]/g, '_');
        const data = Buffer.from(String(msg.dataB64 ?? ''), 'base64');
        const inbox = join(WORKSPACE, 'inbox');
        mkdirSync(inbox, { recursive: true });
        writeFileSync(join(inbox, name), data);
        const text = `[${name}] ${String(msg.text ?? '').trim()}`.trim();
        void runRound((signal) => engine.handleMessage(text, signal));
        return;
      }
      case 'settings_get': {
        ws.send(JSON.stringify({ type: 'settings', settings: loadSettings(SETTINGS_FILE, 0) }));
        return;
      }
      case 'settings_set': {
        const patch = (msg.patch ?? {}) as Record<string, unknown>;
        const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
        const merged = { ...raw, ...patch };
        const tmp = SETTINGS_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
        loadSettings(tmp, 0); // валидация
        renameSync(tmp, SETTINGS_FILE);
        presenter.notice('  ✓ настройки обновлены (язык и лимиты — со следующего раунда)');
        broadcastState();
        return;
      }
      case 'user_set': {
        const report = engine.setProfile(String(msg.name ?? ''), msg.role ? String(msg.role) : undefined, msg.about ? String(msg.about) : undefined);
        presenter.notice('  ' + report);
        broadcastState();
        ws.send(JSON.stringify({ type: 'notice', text: '  ' + report }));
        return;
      }
      case 'manager_get': {
        ws.send(JSON.stringify({ type: 'manager', manager: { name: app.mgr.name, emoji: app.mgr.emoji, color: app.mgr.color, temperature: app.mgr.temperature, provider: app.mgr.provider } }));
        return;
      }
      case 'manager_set': {
        const fields = (msg.fields ?? {}) as Record<string, unknown>;
        const known = [...app.providers.keys()];
        const report = updateManagerConfig(MANAGER_FILE, fields, known);
        app.mgr = (await import('./manager.js')).loadManagerConfig(MANAGER_FILE, known);
        presenter.notice('  ' + report);
        broadcastState();
        ws.send(JSON.stringify({ type: 'notice', text: '  ' + report }));
        return;
      }
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
        return stateSnapshot(app, engine);
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
      case 'agent_create': {
        const report = addTeamAgent(AGENTS_FILE, { id: String(args.id ?? ''), name: String(args.name ?? ''), role: args.role ? String(args.role) : undefined });
        broadcastState();
        return { text: report };
      }
      case 'agent_delete': {
        const report = removeTeamAgent(AGENTS_FILE, String(args.id ?? ''));
        broadcastState();
        return { text: report };
      }
      case 'agent_update': {
        const report = updateTeamAgent(AGENTS_FILE, String(args.id ?? ''), (args.fields ?? {}) as Record<string, unknown>);
        broadcastState();
        return { text: report };
      }
      case 'provider_create': {
        const report = addProviderConfig(PROVIDERS_FILE, String(args.id ?? ''), (args.config ?? {}) as Record<string, unknown>);
        const loaded = loadProviders(PROVIDERS_FILE);
        for (const [k, v] of loaded.providers) app.providers.set(k, v);
        for (const k of [...app.providers.keys()]) if (!loaded.providers.has(k)) app.providers.delete(k);
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'provider_delete': {
        const pid = String(args.id ?? '');
        const report = removeProviderConfig(PROVIDERS_FILE, pid, []);
        const loaded = loadProviders(PROVIDERS_FILE);
        for (const [k, v] of loaded.providers) app.providers.set(k, v);
        for (const k of [...app.providers.keys()]) if (!loaded.providers.has(k)) app.providers.delete(k);
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'projects.get':
        return { projects: readProjects() };
      case 'project_add': {
        const report = addProject(PROJECTS_FILE, String(args.id ?? ''), {
          [String(args.hostName ?? 'main')]: {
            host: String(args.host ?? ''),
            user: args.user ? String(args.user) : undefined,
            port: args.port ? Number(args.port) : undefined,
          },
        });
        broadcastState();
        return { text: report };
      }
      case 'project_delete': {
        const report = removeProject(PROJECTS_FILE, String(args.id ?? ''));
        broadcastState();
        return { text: report };
      }
      case 'project_host_delete': {
        const report = removeProjectHost(PROJECTS_FILE, String(args.id ?? ''), String(args.name ?? ''));
        broadcastState();
        return { text: report };
      }
      case 'settings_set': {
        const patch = (args.patch ?? {}) as Record<string, unknown>;
        const rawSettings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
        const merged = { ...rawSettings, ...patch };
        const tmp = SETTINGS_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
        loadSettings(tmp, 0);
        renameSync(tmp, SETTINGS_FILE);
        broadcastState();
        return { ok: true };
      }
      case 'manager_set': {
        const fields = (args.fields ?? {}) as Record<string, unknown>;
        const known = [...app.providers.keys()];
        const report = updateManagerConfig(MANAGER_FILE, fields, known);
        broadcastState();
        return { text: report };
      }
      case 'schedule_get':
        return { tasks: loadSchedule(join(dirname(PROJECTS_FILE), 'schedule.json')) };
      case 'schedule_add': {
        const tasks = loadSchedule(join(dirname(PROJECTS_FILE), 'schedule.json'));
        const id = `task-${Date.now().toString(36)}`;
        tasks.push({ id, message: String(args.message ?? ''), intervalMinutes: Number(args.intervalMinutes ?? 10), enabled: true });
        saveSchedule(join(dirname(PROJECTS_FILE), 'schedule.json'), tasks);
        return { tasks };
      }
      case 'schedule_delete': {
        const tasks = loadSchedule(join(dirname(PROJECTS_FILE), 'schedule.json')).filter((t) => t.id !== String(args.id ?? ''));
        saveSchedule(join(dirname(PROJECTS_FILE), 'schedule.json'), tasks);
        return { tasks };
      }
      case 'schedule_toggle': {
        const tasks = loadSchedule(join(dirname(PROJECTS_FILE), 'schedule.json'));
        const task = tasks.find((t) => t.id === String(args.id ?? ''));
        if (task) { task.enabled = !task.enabled; saveSchedule(join(dirname(PROJECTS_FILE), 'schedule.json'), tasks); }
        return { tasks };
      }
      default:
        throw new Error(`неизвестный rpc-метод «${method}»`);
    }
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(GUI_DIR, rel));
    // только внутрь каталога оболочки: без выходов по «..»
    if (!file.startsWith(normalize(GUI_DIR))) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'нет такого файла (оболочка живёт в gui-dist/ или gui/ пакета)' }));
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  const port = opts.port ?? (Number(process.env.PORT) || 8080);
  // по умолчанию — только локально; HOST=0.0.0.0 открывает сервер в сеть
  // (авторизации в API нет — так делают, только если сеть своя)
  const host = String(process.env.HOST ?? '').trim() || '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
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
    host,
    close(): Promise<void> {
      clearInterval(scheduleTimer);
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
    .then(({ port, host }) => {
      console.log(pc.dim(`\n  API поднято: http://${host}:${port} (WS — /ws) · ${host === '127.0.0.1' ? 'только локально' : 'ОТКРЫТО В СЕТЬ — авторизации нет'} · Ctrl+C — останов`));
    })
    .catch((err) => {
      console.error(pc.red(`Фатальная ошибка: ${err instanceof Error ? err.stack ?? err.message : err}`));
      process.exit(1);
    });
}
