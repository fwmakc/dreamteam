import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { loadTeamOrEmpty } from './agents.js';
import {
  addTeamAgent,
  managerAsAgent,
  updateTeamAgent,
  grantTool,
  loadManagerConfig,
  loadHostsFile,
  addMailAccount,
  addMessengerBot,
  addProjectHosts,
  mergeTeamAgents,
  removeMailAccount,
  removeMessengerBot,
  removeProjectHost,
  removeTeamAgent,
  updateManagerConfig,
} from './manager.js';
import { addModelConfig, loadModels, removeModelConfig, updateModelConfig } from './providers/registry.js';
import { openBrowser } from './open.js';
import { loadSettings } from './settings.js';
import { AGENTS_DIR, APP_VERSION, DT_HOME, MANAGER_FILE, MODELS_DIR, PROJECT_DIR, PROJECT_FILE, SETTINGS_FILE, TOOLS_DIR, WORKSPACE } from './paths.js';
import { listProjects } from './core/projects.js';
import { agentToolIds } from './tools-api.js';
import { safePath } from './actions.js';
import { basename } from 'node:path';
import { Engine, chatTeam, type App } from './core/engine.js';
import { bootstrapApp } from './core/bootstrap.js';
import { operationHints } from './core/operations.js';
import {
  applyHomeImport,
  applyProjectImport,
  applySessionImport,
  applySettingsImport,
  homeEntries,
  packEntriesZip,
  projectEntries,
  readZipEntries,
  sessionEntriesById,
  settingsEntries,
} from './core/transfer.js';
import { loadSchedule, saveSchedule, type ScheduleTask } from './core/schedule.js';
import type { ConfirmRequest, Presenter, SpeakerRef, TurnSink } from './core/presenter.js';
import type { Agent, Session } from './types.js';
import { localeId, localeDict, applyLocale } from './i18n.js';

/**
 * Локальный API поверх ядра: `dreamteam serve` поднимает HTTP+WS на
 * 127.0.0.1:8080 (PORT/HOST, можно в ~/.dreamteam/.env) и раздаёт
 * собранную веб-оболочку из gui-dist/. Ядро общается с клиентами
 * только через ServerPresenter (тот же интерфейс Presenter, что и у
 * терминала) — никакого второго ядра нет.
 *
 * Протокол (WS /ws, JSON-строки):
 *  сервер → клиент: state, notice, error, turn_header, busy, busy_end,
 *    delta, turn_end, say, tool_results, attachment, confirm, choose_session,
 *    session_opened, export_data, rpc_result, rpc_error;
 *  клиент → сервер: hello, user_message, command, abort, confirm_response,
 *    choose_response, export_home | export_settings | export_project |
 *    export_session, import_home | import_settings | import_project |
 *    import_session, rpc {method: state | sessions.list | session.open |
 *    session.new | session.delete | chat.add | chat.remove | model.set |
 *    project.list | project.new | project.open | project.remove |
 *    project.rename | project.path}.
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
  let teamError: string | null = null;
  try {
    team = loadTeamOrEmpty(AGENTS_DIR);
  } catch (err) {
    // битый agents.json: в снимке пусто, а ошибка — отдельным полем,
    // чтобы оболочка показала её, а не молчаливую пустую команду
    teamError = err instanceof Error ? err.message : String(err);
  }
  const inChat = new Set(app.session ? chatTeam(app.session, team).map((a) => a.id) : []);
  const projectId = PROJECT_DIR ? basename(PROJECT_DIR) : '';
  return {
    // без открытого проекта session/sessions — null/[]: GUI показывает панель выбора проекта
    session: app.session ? publicSession(app.session) : null,
    sessions: app.store ? app.store.list() : [],
    teamError,
    team: team.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      emoji: a.emoji,
      color: a.color,
      model: a.model?.id,
      tools: agentToolIds(a),
      inChat: inChat.has(a.id),
    })),
    manager: { name: app.mgr.name, emoji: app.mgr.emoji, color: app.mgr.color, model: app.mgr.model.id },
    models: [...app.models].map(([id, s]) => ({
      id,
      kind: s.provider.kind,
      model: s.provider.model,
      baseUrl: s.config?.baseUrl ? String(s.config.baseUrl) : undefined,
      ok: s.ok,
      note: s.note,
      vision: s.vision,
      isDefault: id === app.settings.model?.id,
      isManager: id === app.mgr.model.id,
    })),
    images: [...app.images].map(([id, s]) => ({ id, ok: s.ok, note: s.note })),
    memory: { shared: app.memory.shared ?? '', agents: app.memory.agents },
    profile: { name: app.profile.name, role: app.profile.role },
    settings: loadSettings(SETTINGS_FILE, 0),
    projects: projects ?? [],
    // текущий проект (null — не выбран) и все проекты дома (смена — project.open,
    // создание — project.new; список — /project)
    project: projectId ? { id: projectId, name: projectId, path: WORKSPACE } : null,
    knownProjects: listProjects().map((p) => ({ name: p.id, path: p.path ?? '', lastOpened: p.lastOpened ?? p.createdAt })),
    auto: engine ? { mode: engine.autoMode, left: engine.autoLeft } : { mode: false, left: 0 },
    // словарь автодополнения: имена команд — из ядра; остальные данные
    // (разговоры, команда, состав чата, провайдеры, имя менеджера) выводятся
    // клиентом из остальных полей этого же снапшота
    completion: { operations: operationHints() },
    // язык интерфейса и его словарь: оболочка переводит строки через tr(s)
    ui: { id: localeId(), strings: localeDict() },
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

  /** Событие чата уже записано в хронику разговора — клиенты получат реплику
   *  менеджера со свежим state; отдельное событие не нужно. */
  service(_text: string): void {}

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
 * Каталог собранной Vue-оболочки рядом с src/ — и в репозитории, и в
 * установленном пакете (build:gui выполняется перед публикацией).
 */
const GUI_DIR = fileURLToPath(new URL('../gui-dist/', import.meta.url));

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
    for (const task of loadSchedule(DT_HOME).filter((t) => t.enabled)) {
      const due = nextDue.get(task.id) ?? 0;
      if (now < due) continue;
      nextDue.set(task.id, now + task.intervalMinutes * 60_000);
      void runRound((signal) => engine.handleMessage(task.message, signal));
    }
  }, 60_000);

  const broadcastState = (): void => {
    presenter.broadcast({ type: 'state', state: stateSnapshot(app, engine, readProjects()) });
  };

  // Открыли проект в пустой разговор — консьерж здоровается сам (как на старте
  // терминала и как по /session new); раунд в общей очереди.
  const welcomeIfEmpty = async (): Promise<void> => {
    if (app.session && app.session.messages.length === 0) {
      await runRound((signal) => engine.startupWelcome(signal));
    }
  };

  const readProjects = (): unknown[] => {
    if (!PROJECT_FILE) return []; // нет проекта — панели серверов нет
    try {
      const hosts = loadHostsFile(PROJECT_FILE);
      // пустой реестр = блока в снимке нет
      if (Object.keys(hosts).length === 0) return [];
      return [{ id: PROJECT_DIR ? basename(PROJECT_DIR) : '', hosts }];
    } catch {
      return [];
    }
  };

  const broadcastSchedule = (): void => {
    presenter.broadcast({ type: 'schedule', tasks: loadSchedule(DT_HOME) });
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
      const abs = WORKSPACE ? safePath(WORKSPACE, rel) : null;
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
  /** Имя проекта в сообщении клиента: поле name (или id — кто как шлёт). */
  const argsId = (m: Record<string, unknown>): string => String(m.name ?? m.id ?? '');
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
      ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app, engine, readProjects()) }));
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
      // кривой номер/битый архив не должны ронять процесс — ошибка уходит клиенту
      handleClientMessage(ws, typed).catch((err: unknown) => {
        presenter.error(`✗ ${err instanceof Error ? err.message : err}`);
      });
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
      if (ok) ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app, engine, readProjects()) }));
      return;
    }
    switch (type) {
      case 'hello':
        ws.send(JSON.stringify({ type: 'state', state: stateSnapshot(app, engine, readProjects()) }));
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
        // уровень 1: всё приложение — дом и все проекты с разговорами
        ws.send(JSON.stringify({ type: 'export_data', name: `dt-home-${stamp()}.zip`, dataB64: packEntriesZip(homeEntries()).toString('base64') }));
        return;
      }
      case 'export_settings': {
        // уровень 2: настройки приложения без проектов
        ws.send(JSON.stringify({ type: 'export_data', name: `dt-settings-${stamp()}.zip`, dataB64: packEntriesZip(settingsEntries()).toString('base64') }));
        return;
      }
      case 'export_project': {
        // уровень 3: один проект (project.json с секретами + разговоры); без id — текущий
        const id = String(argsId(msg) ?? '').trim() || (PROJECT_DIR ? basename(PROJECT_DIR) : '');
        if (!id) throw new Error('export_project: нет открытого проекта — укажите name');
        const entries = projectEntries(id);
        ws.send(JSON.stringify({ type: 'export_data', name: `dt-project-${id}.zip`, dataB64: packEntriesZip(entries).toString('base64') }));
        return;
      }
      case 'export_session': {
        if (!app.store) throw new Error('нет открытого проекта — сначала /project new или /project open');
        const meta = app.store.list()[Number(msg.n) - 1];
        if (!meta) throw new Error(`не нашёл разговор №${String(msg.n)} — обновите список разговоров`);
        const entries = sessionEntriesById(app, meta.id);
        ws.send(JSON.stringify({ type: 'export_data', name: `dt-session-${meta.id}.zip`, dataB64: packEntriesZip(entries).toString('base64') }));
        return;
      }
      case 'import_home': {
        const entries = readZipEntries(Buffer.from(String(msg.dataB64 ?? ''), 'base64'));
        const ok = await presenter.confirm({
          label: 'Импортировать всё приложение из этого архива?',
          desc: 'Настройки/профиль/модели, память команды и расписание заменяются; проекты и их разговоры вливаются по id; открытый проект перечитывается. Ключи (.env) не переносятся.',
          who: managerAsAgent(app.mgr),
        });
        if (!ok) {
          ws.send(JSON.stringify({ type: 'notice', text: '  Импорт отменён.' }));
          return;
        }
        const report = applyHomeImport(app, entries);
        presenter.notice('  ' + report);
        broadcastState();
        return;
      }
      case 'import_settings': {
        const entries = readZipEntries(Buffer.from(String(msg.dataB64 ?? ''), 'base64'));
        const ok = await presenter.confirm({
          label: 'Импортировать настройки приложения из этого архива?',
          desc: 'settings.json, профиль, менеджер и карточки моделей (с ключами) заменяются; проекты и разговоры не трогаются.',
          who: managerAsAgent(app.mgr),
        });
        if (!ok) {
          ws.send(JSON.stringify({ type: 'notice', text: '  Импорт отменён.' }));
          return;
        }
        const report = applySettingsImport(app, entries);
        presenter.notice('  ' + report);
        broadcastState();
        return;
      }
      case 'import_project': {
        const entries = readZipEntries(Buffer.from(String(msg.dataB64 ?? ''), 'base64'));
        if (!entries.some((e) => e.rel === 'project.json')) {
          throw new Error('в архиве нет project.json — это архив всего приложения? Тогда: import_home');
        }
        const ok = await presenter.confirm({
          label: 'Импортировать проект из этого архива?',
          desc: 'Имя проекта занято — разговоры вливаются в него по id (совпавшие заменяются); свободно — создастся новый проект. Секреты (серверы, почта, боты) не заменяются.',
          who: managerAsAgent(app.mgr),
        });
        if (!ok) {
          ws.send(JSON.stringify({ type: 'notice', text: '  Импорт отменён.' }));
          return;
        }
        const report = applyProjectImport(app, entries, argsId(msg) || undefined);
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
        if (!WORKSPACE) throw new Error('нет открытого проекта — некуда класть файл');
        const name = String(msg.name ?? 'file').replace(/[\/]/g, '_');
        const data = Buffer.from(String(msg.dataB64 ?? ''), 'base64');
        const inbox = join(WORKSPACE, 'inbox');
        mkdirSync(inbox, { recursive: true });
        writeFileSync(join(inbox, name), data);
        const text = `[${name}] ${String(msg.text ?? '').trim()}`.trim();
        void runRound((signal) => engine.handleMessage(text, signal));
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
        return stateSnapshot(app, engine, readProjects());
      case 'sessions.list':
        return { sessions: app.store ? app.store.list() : [] };
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
        const res = method === 'chat.add' ? engine.addToChat(name, team) : engine.removeFromChat(name, team);
        // событие чата — репликой менеджера в хронологии; уйдёт с этим же state
        if (res.changed) engine.serviceLine(res.text);
        broadcastState();
        return { text: res.text };
      }
      case 'team.add': {
        const report = addTeamAgent(AGENTS_DIR, { id: String(args.id ?? ''), name: String(args.name ?? ''), role: args.role ? String(args.role) : undefined }, engine.app.models);
        broadcastState();
        return { text: report };
      }
      case 'team.delete': {
        const report = removeTeamAgent(AGENTS_DIR, String(args.id ?? ''));
        broadcastState();
        return { text: report };
      }
      case 'team.update': {
        const report = updateTeamAgent(AGENTS_DIR, String(args.id ?? ''), (args.fields ?? {}) as Record<string, unknown>, engine.app.models);
        broadcastState();
        return { text: report };
      }
      case 'team.grant': {
        const report = grantTool(AGENTS_DIR, String(args.agent ?? ''), String(args.tool ?? ''), args.card, TOOLS_DIR);
        broadcastState();
        return { text: report };
      }
      case 'auto.on': {
        const turns = Math.min(Math.max(Number(args.n ?? 10) || 10, 1), 50);
        engine.setAutoMode(true, turns);
        broadcastState();
        return { ok: true };
      }
      case 'auto.off': {
        engine.setAutoMode(false, 0);
        broadcastState();
        return { ok: true };
      }
      case 'session.rename': {
        const report = await engine.renameSession(String(args.name ?? ''));
        broadcastState();
        return { text: report };
      }
      case 'session.history': {
        if (!app.session) throw new Error('нет открытого проекта — сначала /project new или /project open');
        const n = Number(args.n);
        const all = app.session.messages;
        const messages = Number.isInteger(n) && n > 0 ? all.slice(-n) : all;
        return { messages };
      }
      case 'model.set': {
        const mid = String(args.id ?? '').trim();
        const ok = engine.setModel(mid);
        if (!ok) throw new Error(`Нет модели «${mid}». Доступны: ${[...app.models.keys()].join(', ')}`);
        broadcastState();
        return { ok: true };
      }
      case 'model.add': {
        const report = addModelConfig(MODELS_DIR, String(args.id ?? ''), (args.config ?? {}) as Record<string, unknown>);
        const { models, images } = loadModels(MODELS_DIR);
        app.models = models;
        app.images = images;
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'model.update': {
        const report = updateModelConfig(MODELS_DIR, String(args.id ?? ''), (args.fields ?? {}) as Record<string, unknown>);
        const { models, images } = loadModels(MODELS_DIR);
        app.models = models;
        app.images = images;
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'model.delete': {
        const mid = String(args.id ?? '');
        const report = removeModelConfig(MODELS_DIR, mid, [app.settings.model?.id, app.settings.serviceModel?.id, app.mgr.model.id].filter((x): x is string => Boolean(x)));
        const { models, images } = loadModels(MODELS_DIR);
        app.models = models;
        app.images = images;
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'project.list':
        return {
          known: listProjects().map((p) => ({ name: p.id, path: p.path ?? '', lastOpened: p.lastOpened ?? p.createdAt })),
          current: PROJECT_DIR ? { id: basename(PROJECT_DIR), name: basename(PROJECT_DIR), path: WORKSPACE } : null,
        };
      case 'project.new': {
        // новый проект: дом создаёт projects/<id>/ и открывает его (папка
        // рабочей области создаётся, если её нет)
        const name = String(args.name ?? args.id ?? '').trim();
        if (!name) throw new Error('project.new: жду имя проекта (name)');
        const path = args.path ? String(args.path) : null;
        let report = '';
        await runRound(async () => {
          report = engine.newProject(name, path);
        });
        await welcomeIfEmpty();
        broadcastState();
        return { text: report };
      }
      case 'project.open': {
        // смена проекта: имя/папка → switchProject (шлёт session_opened);
        // раунд — чтобы клиенты получили свежий state после подмены магазина
        const arg = String(args.path ?? args.name ?? '').trim();
        if (!arg) throw new Error('project.open: жду путь или имя проекта (список — /project)');
        let report = '';
        await runRound(async () => {
          report = engine.switchProject(arg);
        });
        await welcomeIfEmpty();
        return { text: report };
      }
      case 'project.remove': {
        // из дома целиком (projects/<id>/); рабочая папка не трогается
        const arg = String(args.path ?? args.name ?? '').trim();
        if (!arg) throw new Error('project.remove: жду путь или имя проекта');
        const report = engine.deleteProject(arg);
        broadcastState();
        return { text: report };
      }
      case 'project.rename': {
        // переименовать текущий: папка в доме + id в project.json
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error('project.rename: жду новое имя (name)');
        const report = engine.renameCurrentProject(name);
        broadcastState();
        return { text: report };
      }
      case 'project.path': {
        // сменить рабочую папку текущего проекта
        const path = String(args.path ?? '').trim();
        if (!path) throw new Error('project.path: жду путь к рабочей папке (path)');
        const report = engine.repointProject(path);
        broadcastState();
        return { text: report };
      }
      case 'project.host.add': {
        if (!PROJECT_FILE) throw new Error('нет открытого проекта — сначала /project new или /project open');
        const report = addProjectHosts(PROJECT_FILE, {
          [String(args.hostName ?? 'main')]: {
            host: String(args.host ?? ''),
            user: args.user ? String(args.user) : undefined,
            port: args.port ? Number(args.port) : undefined,
          },
        });
        broadcastState();
        return { text: report };
      }
      case 'manager.show':
        return { manager: { name: app.mgr.name, emoji: app.mgr.emoji, color: app.mgr.color, temperature: app.mgr.temperature, model: app.mgr.model.id } };
      case 'settings.show':
        return { settings: loadSettings(SETTINGS_FILE, 0) };
      case 'project.host.delete': {
        if (!PROJECT_FILE) throw new Error('нет открытого проекта — сначала /project new или /project open');
        const report = removeProjectHost(PROJECT_FILE, String(args.name ?? ''));
        broadcastState();
        return { text: report };
      }
      case 'mail.add': {
        if (!PROJECT_FILE) throw new Error('нет открытого проекта — сначала /project new или /project open');
        // name — имя ящика, остальное (user/password/imap/smtp/порты/tlsNoVerify) уходит в валидацию как есть
        const { name, ...spec } = args as Record<string, unknown>;
        const report = addMailAccount(PROJECT_FILE, String(name ?? ''), spec);
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'mail.remove': {
        if (!PROJECT_FILE) throw new Error('нет открытого проекта — сначала /project new или /project open');
        const report = removeMailAccount(PROJECT_FILE, String(args.name ?? ''));
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'messenger.add': {
        if (!PROJECT_FILE) throw new Error('нет открытого проекта — сначала /project new или /project open');
        const report = addMessengerBot(PROJECT_FILE, String(args.key ?? ''), String(args.token ?? ''));
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'messenger.remove': {
        if (!PROJECT_FILE) throw new Error('нет открытого проекта — сначала /project new или /project open');
        const report = removeMessengerBot(PROJECT_FILE, String(args.key ?? ''));
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'profile.set': {
        // профиль владельца: форма настроек в обеих оболочках идёт через rpc
        const report = engine.setProfile(String(args.name ?? ''), args.role ? String(args.role) : undefined, args.about ? String(args.about) : undefined);
        presenter.notice('  ' + report);
        broadcastState();
        return { text: report };
      }
      case 'settings.set': {
        const patch = (args.patch ?? {}) as Record<string, unknown>;
        const rawSettings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
        const merged = { ...rawSettings, ...patch };
        const tmp = SETTINGS_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
        loadSettings(tmp, 0);
        renameSync(tmp, SETTINGS_FILE);
        // язык интерфейса — сразу: в следующем state уйдёт новый словарь
        if (typeof patch.ui === 'string') applyLocale(patch.ui, DT_HOME);
        broadcastState();
        return { ok: true };
      }
      case 'manager.set': {
        const fields = (args.fields ?? {}) as Record<string, unknown>;
        const known = [...app.models.keys()];
        const report = updateManagerConfig(MANAGER_FILE, fields, known);
        broadcastState();
        return { text: report };
      }
      case 'schedule.list':
        return { tasks: loadSchedule(DT_HOME) };
      case 'schedule.add': {
        const tasks = loadSchedule(DT_HOME);
        const id = `task-${Date.now().toString(36)}`;
        tasks.push({ id, message: String(args.message ?? ''), intervalMinutes: Number(args.intervalMinutes ?? 10), enabled: true });
        saveSchedule(DT_HOME, tasks);
        broadcastSchedule();
        return { tasks };
      }
      case 'schedule.delete': {
        const tasks = loadSchedule(DT_HOME).filter((t) => t.id !== String(args.id ?? ''));
        saveSchedule(DT_HOME, tasks);
        broadcastSchedule();
        return { tasks };
      }
      case 'schedule.toggle': {
        const tasks = loadSchedule(DT_HOME);
        const task = tasks.find((t) => t.id === String(args.id ?? ''));
        if (task) { task.enabled = !task.enabled; saveSchedule(DT_HOME, tasks); }
        broadcastSchedule();
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
      // клон репозитория без build:gui — вместо пустой страницы объясняем, как собрать
      const hint = rel === 'index.html' ? ' — оболочка не собрана: npm run build:gui' : '';
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'нет такого файла (оболочка живёт в gui-dist/ пакета)' + hint }));
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
  // Без проекта здороваться некому: человек сначала выбирает проект.
  if (app.session && app.session.messages.length === 0) {
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
// npm run serve (argv[1] — этот файл); при импорте из проб не стартуем.
// Флаг --open: после поднятия сервера открыть http://адрес в браузере —
// так работает ярлык быстрого запуска (см. src/shortcut.ts).
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (process.env.DT_SERVE === '1' || entry.endsWith('/src/serve.ts')) {
  const openFlag = process.argv.slice(2).includes('--open');
  startServe()
    .then(({ port, host }) => {
      console.log(pc.dim(`\n  API поднято: http://${host}:${port} (WS — /ws) · dreamteam v${APP_VERSION} · ${host === '127.0.0.1' ? 'только локально' : 'ОТКРЫТО В СЕТЬ — авторизации нет'} · Ctrl+C — останов`));
      if (openFlag) {
        // HOST=0.0.0.0 — браузеру всё равно нужен конкретный адрес
        openBrowser(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
      }
    })
    .catch((err) => {
      console.error(pc.red(`Фатальная ошибка: ${err instanceof Error ? err.stack ?? err.message : err}`));
      process.exit(1);
    });
}
