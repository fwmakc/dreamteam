import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Agent, ImageProvider, LLMProvider } from './types.js';
import { agentToolIds, BUILTIN_TOOL_IDS, type Tool } from './tools-api.js';
import { loadSettings } from './settings.js';

/**
 * Инструменты агентов: текстовый протокол поверх обычного ответа модели.
 * Агент вставляет в ответ markdown-блоки ```file / ```run / ```ssh / ```look /
 * ```image и блоки кастомных тулов (```<имя> из tools/), приложение парсит их
 * после стрима, проверяет структурные права агента, спрашивает вердикт check()
 * у тула ('allow' — молча, 'deny' — отказ, 'ask' — вопрос y/n), выполняет и
 * возвращает результаты следующим сообщением в истории.
 *
 * Серверы: реестр в hosts.json (в .dreamteam проекта) — { "prod": { "host": … } };
 * в блоках адресуются именем — ```ssh prod systemctl status nginx (префикс
 * «project:» тоже понимается, проект один — текущая папка). Доступ агенту
 * выдаётся полем projects в agents.json. Локально инструменты
 * работают всегда в текущей папке (проект = где запущено приложение), имя
 * сервера адресует только его.
 * Картинки: ```look показывает файл vision-модели агента, ```image уходит в
 * image-провайдер агента; файлы сохраняются в images/ рабочей папки.
 */

export interface HostConfig {
  host: string;
  user?: string;
  /** Пароль для sshpass (в конфиге лежит открытым текстом — машина ваша); без него — только ключи */
  password?: string;
  port?: number;
  /** Папка проекта на сервере: после коннекта всё исполняется из неё (cd, проверка по pwd) */
  dir?: string;
}

/** Серверы проекта из hosts.json: имя → параметры подключения. */
export interface ProjectEntry {
  hosts: Map<string, HostConfig>;
}

/** Лимиты инструментов из settings.json + реестр серверов проектов. */
export interface ToolsConfig {
  /** Рабочая папка инструментов — текущая папка (проект = где запущено) */
  workspaceAbs: string;
  runTimeoutMs: number;
  maxOutputChars: number;
  /** Именованные серверы: проект один (текущая папка), ключ — «project» */
  projects: Map<string, ProjectEntry>;
}

/** Параметры генерации из блока ```image — всё решает агент, пользователь даёт задачу словами */
export interface ImageParams {
  prompt: string;
  n?: number;
  size?: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  refs?: string[];
}

export type Action =
  | { kind: 'file'; path: string; content: string; project?: string }
  | { kind: 'run'; command: string; project?: string }
  | { kind: 'ssh'; host: string; command: string; project?: string }
  | { kind: 'look'; path: string; question: string; project?: string }
  | { kind: 'image'; params: ImageParams; project?: string }
  /** Кастомный тул из tools/<tool>.ts: тело блока — то, что тул парсит сам */
  | { kind: 'tool'; tool: string; command: string; project?: string };

export interface ActionResult {
  ok: boolean;
  label: string;
  output: string;
  /** Сгенерированные файлы (абсолютные пути) — чтобы приложение могло их показать */
  files?: string[];
}

/**
 * Доступ агента к «глазам» и «рукам»: провайдеры решаются в index.ts (там
 * живёт реестр), actions.ts только получает готовое или текст отказа.
 */
export interface ToolContext {
  getVisionProvider(agent: Agent | undefined): { provider: LLMProvider } | { error: string };
  getImageProvider(agent: Agent | undefined): { provider: ImageProvider } | { error: string };
}

/** Читает settings.json (лимиты) + hosts.json (серверы); settings обязателен, hosts.json нет — серверов нет. */
export function loadToolsConfig(settingsFile: string, hostsFile: string, workspaceAbs: string): ToolsConfig {
  const settings = loadSettings(settingsFile, 0);
  return {
    workspaceAbs,
    runTimeoutMs: settings.runTimeoutMs,
    maxOutputChars: settings.maxOutputChars,
    projects: new Map([['project', { hosts: loadHosts(hostsFile) }]]),
  };
}

/** Читает hosts.json ({ "prod": { "host": … } }); файла нет — серверов нет, битые поля — внятная ошибка. */
export function loadHosts(file: string): Map<string, HostConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Error(`не удалось прочитать ${file}: ${err instanceof Error ? err.message : err}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: ожидается объект { "сервер": { "host": "…", … } }`);
  }
  const hosts = new Map<string, HostConfig>();
  for (const [hid, h] of Object.entries(raw as Record<string, unknown>)) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      throw new Error(`${file}: сервер «${hid}» — ожидается объект { "host": "…", "dir": "…" }`);
    }
    const o = h as Record<string, unknown>;
    if (typeof o.host !== 'string' || !o.host) {
      throw new Error(`${file}: сервер «${hid}» — обязательное поле "host"`);
    }
    const host: HostConfig = { host: o.host };
    for (const key of ['user', 'password', 'dir'] as const) {
      const v = o[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || (key === 'dir' && !v.trim())) {
        throw new Error(`${file}: сервер «${hid}» — "${key}" жду непустой строкой`);
      }
      host[key] = v;
    }
    if (o.port !== undefined) {
      if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port <= 0) {
        throw new Error(`${file}: сервер «${hid}» — "port" жду целым числом больше нуля`);
      }
      host.port = o.port;
    }
    hosts.set(hid, host);
  }
  return hosts;
}

/** Куда бьёт ссылка на хост: проект + имя внутри проекта + параметры подключения. */
export interface HostTarget {
  project: string;
  id: string;
  host: HostConfig;
}

/**
 * «project:prod» → хост prod (проект один — текущая папка, префикс можно
 * опустить: «prod»). Неизвестный проект — отказ с подсказкой.
 */
export function resolveHost(ref: string, cfg: ToolsConfig): HostTarget | { error: string } {
  const qi = ref.indexOf(':');
  if (qi > 0) {
    const pid = ref.slice(0, qi);
    const hid = ref.slice(qi + 1);
    const h = cfg.projects.get(pid)?.hosts.get(hid);
    if (!h) return { error: `хост «${ref}» не настроен в hosts.json` };
    return { project: pid, id: hid, host: h };
  }
  const hits: HostTarget[] = [];
  for (const [pid, entry] of cfg.projects) {
    const h = entry.hosts.get(ref);
    if (h) hits.push({ project: pid, id: ref, host: h });
  }
  if (hits.length === 0) return { error: `хост «${ref}» не настроен в hosts.json` };
  if (hits.length > 1) {
    const fulls = hits.map((h) => `${h.project}:${ref}`).join(' или ');
    return {
      error: `хост «${ref}» у нескольких проектов (${hits.map((h) => h.project).join(', ')}) — уточните: ssh ${fulls}`,
    };
  }
  return hits[0]!;
}

/**
 * Блоки ```file / ```run / ```ssh / ```look / ```image и кастомных тулов
 * (extraTools — имена файлов из tools/) в ответе агента, в порядке появления.
 * Префикс проекта: «lms:путь» у file/look, «shop:команда» у run и кастомных,
 * «shop:» у image (id — строчные буквы/цифры, от 2 символов — чтобы не путать
 * с «C:/...» на Windows). Кастомные имена передаются явно, чтобы обычные
 * код-блоки (```json, ```ts) не принимались за вызовы тулов.
 */
export function parseActions(text: string, extraTools: readonly string[] = []): Action[] {
  // виды блоков: встроенные имена + кастомные тула; сортировка по длине, чтобы
  // «```runner» не съелся более коротким «```run» из альтернации
  const kinds = [...new Set([...extraTools, 'file', 'run', 'ssh', 'look', 'image'])].sort(
    (a, b) => b.length - a.length,
  );
  const re = new RegExp(
    '^```(' + kinds.join('|') + ')[ \\t]*([^\\n]*)\\n([\\s\\S]*?)^```[ \\t]*$',
    'gm',
  );
  const actions: Action[] = [];
  for (const m of text.matchAll(re)) {
    const kind = m[1]!;
    if (kind === 'file') {
      const { target, rest } = splitTarget(m[2].trim().replace(/^["']|["']$/g, ''));
      if (rest) actions.push({ kind: 'file', path: rest, content: m[3].replace(/\n$/, ''), project: target });
    } else if (kind === 'run') {
      // команда может быть и на строке блока («```run shop:cmd»), и в теле — склеиваем
      const combined = (m[2].trim() + '\n' + m[3].trim()).replace(/^\n+/, '').trim();
      const { target, rest } = splitTarget(combined);
      if (rest) actions.push({ kind: 'run', command: rest, project: target });
    } else if (kind === 'ssh') {
      const host = m[2].trim().replace(/^["']|["']$/g, '').toLowerCase();
      const command = m[3].trim();
      if (host && command) actions.push({ kind: 'ssh', host, command });
    } else if (kind === 'look') {
      const { target, rest } = splitTarget(m[2].trim().replace(/^["']|["']$/g, ''));
      const question = m[3].trim() || 'Подробно опиши это изображение.';
      actions.push({ kind: 'look', path: rest ?? '', question, project: target });
    } else if (kind === 'image') {
      // image: на строке блока — только префикс проекта («shop:»), параметры — в теле
      const pm = /^([a-z][a-z0-9_-]{1,}):(.*)$/.exec(m[2].trim());
      actions.push({ kind: 'image', params: parseImageParams(m[3]), project: pm?.[1] });
    } else {
      // кастомный тул: тело склеивается так же, как у run — аргумент на строке блока плюс тело
      const combined = (m[2].trim() + '\n' + m[3].trim()).replace(/^\n+/, '').trim();
      const { target, rest } = splitTarget(combined);
      if (rest) actions.push({ kind: 'tool', tool: kind, command: rest, project: target });
    }
  }
  return actions;
}

/** Разбирает тело блока ```image: строки «ключ: значение», свободные строки — продолжение промпта. */
export function parseImageParams(body: string): ImageParams {
  const params: ImageParams = { prompt: '' };
  const freeLines: string[] = [];
  for (const line of body.split('\n')) {
    const km = /^\s*(prompt|size|n|steps|guidance|seed|refs)\s*:\s*(.*)$/i.exec(line);
    if (!km) {
      if (line.trim()) freeLines.push(line.trim());
      continue;
    }
    const key = km[1]!.toLowerCase();
    const val = km[2]!.trim();
    if (key === 'prompt') params.prompt = params.prompt ? `${params.prompt}\n${val}` : val;
    else if (key === 'size' && val) params.size = val;
    else if (key === 'n') {
      const v = Number.parseInt(val, 10);
      if (v > 0) params.n = Math.min(v, 8);
    } else if (key === 'steps') {
      const v = Number.parseInt(val, 10);
      if (v > 0) params.steps = Math.min(v, 100);
    } else if (key === 'guidance') {
      const v = Number.parseFloat(val);
      if (Number.isFinite(v) && v > 0) params.guidance = v;
    } else if (key === 'seed') {
      const v = Number.parseInt(val, 10);
      if (Number.isFinite(v)) params.seed = v;
    } else if (key === 'refs') {
      params.refs = val.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    }
  }
  const free = freeLines.join('\n');
  params.prompt = [params.prompt, free].filter(Boolean).join('\n');
  return params;
}

/** Отделяет префикс проекта «id:» (строчный, ≥2 символа) от остального текста. */
function splitTarget(s: string): { target?: string; rest: string } {
  const m = /^([a-z][a-z0-9_-]{1,}):([\s\S]+)$/.exec(s);
  if (!m) return { rest: s };
  return { target: m[1], rest: m[2] };
}

/** Короткая строка для подтверждения и для отчёта об отказе. */
export function describeAction(a: Action): string {
  const at = (t?: string) => (t ? `[${t}] ` : '');
  if (a.kind === 'file') return `${at(a.project)}файл ${a.path} (${a.content.length} символов)`;
  if (a.kind === 'run') return `${at(a.project)}команда: ${a.command.replace(/\s+/g, ' ').slice(0, 140)}`;
  if (a.kind === 'tool') return `${at(a.project)}тул «${a.tool}»: ${a.command.replace(/\s+/g, ' ').slice(0, 140)}`;
  if (a.kind === 'look') return `${at(a.project)}смотреть картинку: ${a.path || '(путь не указан)'}`;
  if (a.kind === 'image') {
    const p = a.params;
    const refs = p.refs?.length ? `, референсы: ${p.refs.length}` : '';
    return `${at(a.project)}генерация: ${p.n ?? 1} × ${p.size ?? '512x512'}, «${p.prompt.replace(/\s+/g, ' ').slice(0, 100)}»${refs}`;
  }
  return `${at(a.host)}команда на сервере: ${a.command.replace(/\s+/g, ' ').slice(0, 140)}`;
}

/**
 * Структурные гейты действия: инструмент включён агенту, проект назначен
 * (доступ к проекту — это и папка, и его серверы) и настроен. Сюда входит
 * «кому вообще можно»; «можно ли молча» решает только check() тула.
 * Возвращает null, если структурно действие возможно, иначе текст отказа.
 */
export function checkPermission(agent: Agent, action: Action, cfg: ToolsConfig): string | null {
  const ids = agentToolIds(agent);
  if (action.kind === 'ssh') {
    if (!ids.includes('ssh')) return 'инструмент ssh этому агенту не включён';
    const r = resolveHost(action.host, cfg);
    if ('error' in r) return r.error;
    if (!agent.projects?.includes(r.project)) {
      return `хост «${r.id}» относится к проекту «${r.project}» — этот проект тебе не назначен`;
    }
    return null;
  }
  if (action.kind === 'tool') {
    if (!ids.includes(action.tool)) return `тул «${action.tool}» этому агенту не включён`;
  } else if (action.kind === 'look' || action.kind === 'image') {
    if (!ids.includes(action.kind)) {
      return action.kind === 'look'
        ? 'инструмент look (зрение) этому агенту не включён'
        : 'инструмент image (генерация) этому агенту не включён';
    }
  } else {
    const tool = action.kind === 'file' ? 'files' : 'shell';
    if (!ids.includes(tool)) {
      return tool === 'files'
        ? 'инструмент files этому агенту не включён'
        : 'локальная консоль (shell) этому агенту не включена';
    }
  }
  if (action.project) {
    if (!agent.projects?.includes(action.project)) return `проект «${action.project}» этому агенту не назначен`;
    if (!cfg.projects.has(action.project)) return `проект «${action.project}» не известен — серверы в hosts.json, префикс «project:»`;
  }
  return null;
}

/**
 * Рабочая папка действия: всегда текущая папка; agent.workspace может уточнить
 * её подпапкой (путь относительно рабочей).
 */
export function workspaceFor(agent: Agent | undefined, _action: { project?: string }, cfg: ToolsConfig): string {
  const w = agent?.workspace;
  if (w) return resolve(cfg.workspaceAbs, w);
  return cfg.workspaceAbs;
}

/**
 * Разрешает путь относительно рабочей папки и запрещает выходить за неё.
 * Возвращает абсолютный путь или null, если путь небезопасен.
 */
export function safePath(workspaceAbs: string, p: string): string | null {
  const target = resolve(workspaceAbs, p);
  const rel = relative(workspaceAbs, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

function killTree(child: ChildProcess): void {
  // shell:true порождает cmd.exe -> сама команда; убиваем всё дерево
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

/** Кавычки для удалённого шелла: путь с пробелами доживёт до cd. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let sshpassOk: boolean | null = null;
/** Парольный режим требует sshpass (штатный ssh пароль из конфига не возьмёт). */
function sshpassAvailable(): boolean {
  if (sshpassOk === null) {
    const r = spawnSync('sshpass', ['-V'], { stdio: 'ignore' });
    sshpassOk = !r.error;
  }
  return sshpassOk;
}

/**
 * Собирает аргументы запуска ssh: без пароля — только ключи (BatchMode),
 * с паролем — через sshpass -e (пароль идёт в env, а не в список процессов).
 */
function sshArgs(t: HostTarget, command: string): { argv: string[]; env?: NodeJS.ProcessEnv } {
  const h = t.host;
  const args = ['ssh', '-o', 'ConnectTimeout=15'];
  if (!h.password) args.push('-o', 'BatchMode=yes');
  if (h.port) args.push('-p', String(h.port));
  args.push(h.user ? `${h.user}@${h.host}` : h.host, command);
  if (h.password) return { argv: ['sshpass', '-e', ...args], env: { SSHPASS: h.password } };
  return { argv: args };
}

export function executeFileAction(
  action: Action & { kind: 'file' },
  cfg: ToolsConfig,
  agent?: Agent,
): ActionResult {
  const label = describeAction(action);
  const ws = workspaceFor(agent, action, cfg);
  const target = safePath(ws, action.path);
  if (!target) {
    return { ok: false, label, output: `отказ: путь «${action.path}» вне рабочей папки ${ws}` };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, action.content, 'utf8');
    const lines = action.content.split('\n').length;
    return { ok: true, label, output: `записан файл ${action.path} (${lines} строк, ${action.content.length} символов)` };
  } catch (err) {
    return { ok: false, label, output: `ошибка записи: ${err instanceof Error ? err.message : err}` };
  }
}

export function executeRunAction(
  action: Action & { kind: 'run' },
  cfg: ToolsConfig,
  signal?: AbortSignal,
  agent?: Agent,
): Promise<ActionResult> {
  return executeProcess({ command: action.command, cwd: workspaceFor(agent, action, cfg) }, cfg, signal).then(
    (r) => ({ ...r, label: describeAction(action) }),
  );
}

export function executeSshAction(
  action: Action & { kind: 'ssh' },
  cfg: ToolsConfig,
  signal?: AbortSignal,
): Promise<ActionResult> {
  const r = resolveHost(action.host, cfg);
  if ('error' in r) {
    return Promise.resolve({ ok: false, label: describeAction(action), output: `отказ: ${r.error}` });
  }
  if (r.host.password && !sshpassAvailable()) {
    return Promise.resolve({
      ok: false,
      label: describeAction(action),
      output: 'отказ: у хоста задан "password", но sshpass не найден на PATH — установите sshpass или уберите пароль (ключи тоже работают)',
    });
  }
  // папка проекта на сервере: cd и pwd — гарант, что команда исполняется в ней
  const command = r.host.dir ? `cd ${shq(r.host.dir)} && pwd && ${action.command}` : action.command;
  const { argv, env } = sshArgs(r, command);
  return executeProcess({ argv, env }, cfg, signal).then((res) => ({
    ...res,
    label: describeAction(action),
  }));
}

/**
 * put/get через штатный scp: обмен файлами с хостом. Локальная сторона уже
 * проверена тулом и пришла абсолютной; удалённая — внутри папки проекта.
 */
export function executeScpTransfer(
  direction: 'put' | 'get',
  localAbs: string,
  remotePath: string,
  target: HostTarget,
  cfg: ToolsConfig,
  signal?: AbortSignal,
): Promise<ActionResult> {
  const h = target.host;
  if (h.password && !sshpassAvailable()) {
    return Promise.resolve({
      ok: false,
      label: `scp ${direction}`,
      output: 'отказ: у хоста задан "password", но sshpass не найден на PATH — установите sshpass или уберите пароль',
    });
  }
  if (direction === 'get') {
    try {
      mkdirSync(dirname(localAbs), { recursive: true });
    } catch (err) {
      return Promise.resolve({
        ok: false,
        label: 'scp get',
        output: `ошибка: не создать папку для «${localAbs}»: ${err instanceof Error ? err.message : err}`,
      });
    }
  }
  const remoteArg = `${h.user ? `${h.user}@${h.host}` : h.host}:${shq(remotePath)}`;
  const args = ['scp', '-o', 'ConnectTimeout=15'];
  if (!h.password) args.push('-o', 'BatchMode=yes');
  if (h.port) args.push('-P', String(h.port));
  args.push(...(direction === 'put' ? [localAbs, remoteArg] : [remoteArg, localAbs]));
  const { argv, env } = h.password
    ? { argv: ['sshpass', '-e', ...args], env: { SSHPASS: h.password } }
    : { argv: args, env: undefined };
  return executeProcess({ argv, env }, cfg, signal).then((res) => ({ ...res, label: `scp ${direction}` }));
}

const LOOK_SYSTEM =
  'Ты — глаза ИИ-агента: тебе показывают изображение и вопрос. Отвечай подробно и конкретно ' +
  'по тому, что реально видно: объекты, расположение, цвета, текст, стиль, композиция. Ничего не выдумывай.';

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Показывает файл vision-модели агента (```look с вопросом в теле блока). */
export async function executeLookAction(
  action: Action & { kind: 'look' },
  cfg: ToolsConfig,
  agent: Agent | undefined,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ActionResult> {
  const label = describeAction(action);
  if (!action.path) {
    return { ok: false, label, output: 'отказ: в блоке look не указан путь к картинке (```look путь/к/файлу.png)' };
  }
  const ws = workspaceFor(agent, action, cfg);
  const target = safePath(ws, action.path);
  if (!target) {
    return { ok: false, label, output: `отказ: путь «${action.path}» вне рабочей папки ${ws}` };
  }
  const mediaType = MEDIA_TYPES[extname(target).slice(1).toLowerCase()];
  if (!mediaType) {
    return { ok: false, label, output: `отказ: «${action.path}» — не картинка (поддерживаются png, jpg, webp, gif)` };
  }
  let data: Buffer;
  try {
    data = readFileSync(target);
  } catch {
    return { ok: false, label, output: `не удалось прочитать «${action.path}» — файла нет в рабочей папке` };
  }
  const vp = ctx.getVisionProvider(agent);
  if ('error' in vp) return { ok: false, label, output: `отказ: ${vp.error}` };
  try {
    let out = '';
    for await (const chunk of vp.provider.stream({
      system: LOOK_SYSTEM,
      messages: [
        {
          role: 'user',
          content: action.question,
          images: [`data:${mediaType};base64,${data.toString('base64')}`],
        },
      ],
      temperature: 0.2,
      signal,
    })) {
      out += chunk;
    }
    out = out.trim();
    if (!out) return { ok: false, label, output: 'vision-модель вернула пустой ответ' };
    if (out.length > cfg.maxOutputChars) {
      out = out.slice(0, cfg.maxOutputChars) + '… (описание обрезано)';
    }
    return { ok: true, label, output: `смотрю «${action.path}»:\n${out}` };
  } catch (err) {
    if (signal?.aborted) return { ok: false, label, output: 'прервано пользователем' };
    return {
      ok: false,
      label,
      output: `ошибка vision-провайдера «${vp.provider.id}»: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** Открывает файлы в системном просмотрщике (только в живом терминале) — варианты надо увидеть. */
function openFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      if (process.platform === 'win32') {
        spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      // открыть не вышло — не страшно, пути напечатаны
    }
  }
}

/** Отправляет параметры блока ```image в image-провайдер агента, сохраняет PNG в images/. */
export async function executeImageAction(
  action: Action & { kind: 'image' },
  cfg: ToolsConfig,
  agent: Agent | undefined,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ActionResult> {
  const label = describeAction(action);
  const p = action.params;
  if (!p.prompt.trim()) {
    return { ok: false, label, output: 'отказ: в блоке image нет промпта — нужна строка «prompt: …»' };
  }
  const ip = ctx.getImageProvider(agent);
  if ('error' in ip) return { ok: false, label, output: `отказ: ${ip.error}` };

  const ws = workspaceFor(agent, action, cfg);
  const refImages: string[] = [];
  for (const ref of p.refs ?? []) {
    const abs = safePath(ws, ref);
    if (!abs) return { ok: false, label, output: `отказ: референс «${ref}» вне рабочей папки ${ws}` };
    const mediaType = MEDIA_TYPES[extname(abs).slice(1).toLowerCase()];
    if (!mediaType) return { ok: false, label, output: `отказ: референс «${ref}» — не картинка` };
    try {
      refImages.push(`data:${mediaType};base64,${readFileSync(abs).toString('base64')}`);
    } catch {
      return { ok: false, label, output: `не удалось прочитать референс «${ref}» — файла нет` };
    }
  }

  const result = await ip.provider.generate(
    {
      prompt: p.prompt,
      n: p.n,
      size: p.size,
      steps: p.steps,
      guidance: p.guidance,
      seed: p.seed,
      refImages,
    },
    signal,
  );
  if (!result.ok || result.images.length === 0) {
    return { ok: false, label, output: result.error ?? 'image-провайдер не вернул картинок' };
  }

  const dir = join(ws, 'images');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug =
    p.prompt.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'img';
  const saved: string[] = [];
  result.images.forEach((img, i) => {
    const ext = img.mediaType.includes('jpeg') ? 'jpg' : img.mediaType.includes('webp') ? 'webp' : 'png';
    const abs = join(dir, `${stamp}-${slug}-${String(i + 1).padStart(2, '0')}.${ext}`);
    writeFileSync(abs, Buffer.from(img.data, 'base64'));
    saved.push(abs);
  });
  if (process.stdout.isTTY) openFiles(saved);
  const rel = saved.map((abs) => relative(ws, abs).replace(/\\/g, '/'));
  return {
    ok: true,
    label,
    files: saved,
    output: `сгенерировано ${saved.length}:\n${rel.map((r) => `- ${r}`).join('\n')}`,
  };
}

/** Запускает процесс (командой через shell или argv напрямую), копит вывод, следит за таймаутом. */
function executeProcess(
  opts: { command?: string; argv?: string[]; cwd?: string; env?: NodeJS.ProcessEnv },
  cfg: ToolsConfig,
  signal?: AbortSignal,
): Promise<Omit<ActionResult, 'label'>> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = opts.argv
        ? spawn(opts.argv[0]!, opts.argv.slice(1), { cwd: opts.cwd ?? cfg.workspaceAbs, signal, env: opts.env })
        : spawn(opts.command!, { shell: true, cwd: opts.cwd ?? cfg.workspaceAbs, signal });
    } catch (err) {
      done({ ok: false, output: `ошибка запуска: ${err instanceof Error ? err.message : err}` });
      return;
    }
    let out = '';
    const collect = (chunk: Buffer | string) => {
      out += chunk.toString();
      if (out.length > cfg.maxOutputChars * 4) {
        // защита от бесконечно сыплющего вывода: дальше не копим
        out = out.slice(0, cfg.maxOutputChars * 4);
        killTree(child);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let timedOut = false;
    const timer =
      cfg.runTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, cfg.runTimeoutMs)
        : undefined;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      done({ ok: false, output: `ошибка запуска: ${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const full = out.trim();
      const output =
        full.length > cfg.maxOutputChars
          ? full.slice(0, cfg.maxOutputChars) + `\n… (вывод обрезан, всего ${full.length} символов)`
          : full || '(команда не вывела ничего)';
      const status = timedOut
        ? `превышен таймаут ${Math.round(cfg.runTimeoutMs / 1000)} с — процесс прерван`
        : `код выхода: ${code ?? '—'}`;
      done({ ok: !timedOut && code === 0, output: `${status}\n${output}` });
    });
  });
}

/** Запасной контекст (провайдеры не подключены): честный отказ вместо падения. */
const noCtx: ToolContext = {
  getVisionProvider: () => ({ error: 'vision-провайдеры не подключены' }),
  getImageProvider: () => ({ error: 'image-провайдеры не подключены' }),
};

export function executeAction(
  action: Action,
  cfg: ToolsConfig,
  signal?: AbortSignal,
  agent?: Agent,
  ctx: ToolContext = noCtx,
): ActionResult | Promise<ActionResult> {
  if (action.kind === 'file') return executeFileAction(action, cfg, agent);
  if (action.kind === 'run') return executeRunAction(action, cfg, signal, agent);
  if (action.kind === 'look') return executeLookAction(action, cfg, agent, ctx, signal);
  if (action.kind === 'image') return executeImageAction(action, cfg, agent, ctx, signal);
  if (action.kind === 'ssh') return executeSshAction(action, cfg, signal);
  throw new Error(`у действия «${(action as { kind: string }).kind}» нет прямого исполнения — оно выполняется тулом`);
}

/** Блок в системный промпт: как этому агенту пользоваться его инструментами. */
export function actionsHint(agent: Agent, cfg: ToolsConfig, customTools?: Map<string, Tool>): string | null {
  const ids = agentToolIds(agent);
  if (ids.length === 0) return null;
  const projects = (agent.projects ?? []).filter((p) => cfg.projects.has(p));
  const ws = workspaceFor(agent, {}, cfg);
  const lines: string[] = [
    '## Инструменты',
    `Ты можешь не только обсуждать, но и реально действовать. Твоя рабочая папка: ${ws} (абсолютный путь). Пути в блоках file — относительные, внутри рабочей папки.`,
  ];
  if (projects.length > 0) {
    lines.push(
      `Доступные тебе проекты: ${projects.join(', ')}. Укажи проект префиксом в блоке (например «${projects[0]}:путь/файл.txt»); без префикса — рабочая папка по умолчанию.`,
    );
  }
  lines.push('Чтобы подействовать, вставь в свой ответ блок одного из видов:');
  if (ids.includes('files')) {
    const sample = projects.length > 0 ? `${projects[0]}:относительный/путь/к/файлу.txt` : 'относительный/путь/к/файлу.txt';
    lines.push('```file ' + sample, '<полное содержимое файла>', '```');
  }
  if (ids.includes('shell')) {
    lines.push(
      '```run',
      projects.length > 0 ? `${projects[0]}:одна команда оболочки, например docker ps` : '<одна команда оболочки, например docker ps>',
      '```',
      'Это локальная командная строка этого ПК. Каждый домен — свой блок: работа с git — блоком ```git (если включён), команды на серверах — ```ssh, запись файлов — ```file; run — всё остальное локальное.',
    );
  }
  if (ids.includes('git')) {
    lines.push(
      '```git status',
      '```git log --oneline -5',
      '```',
      'git — вся работа с репозиторием, только этим блоком (не через run): read-only (status, log, diff, show, blame…) — молча; изменяющее (commit, push, reset…) — по правилам карточки или вопрос человеку. Репозиторий — рабочая папка действия или закреплён в карточке.',
    );
  }
  if (ids.includes('arch')) {
    lines.push(
      '```arch pack архив.zip папка/или/файл',
      '```arch unpack архив.zip',
      '```',
      'arch — архивы zip/tar/tar.gz без внешних программ: pack, unpack, list. Симлинки, секреты (.env, *.pem, id_rsa…) и выход за рабочую папку — отказ.',
    );
  }
  if (ids.includes('ssh')) {
    // цели ssh — хосты тех проектов, что назначены агенту; адресуем «проект:хост»
    const targets: string[] = [];
    for (const p of projects) {
      for (const hid of cfg.projects.get(p)!.hosts.keys()) targets.push(`${p}:${hid}`);
    }
    if (targets.length > 0) {
      lines.push(
        '```ssh ' + targets[0],
        '<команда для выполнения на сервере по ssh>',
        '```',
        `Доступные тебе серверы: ${targets.join(', ')}. Если имя хоста не повторяется в других твоих проектах, можно без префикса проекта. Команды на серверах — только здесь; локальные — через run.`,
      );
    }
  }
  if (ids.includes('look')) {
    lines.push(
      '```look относительный/путь/к/картинке.png',
      '<вопрос по картинке: что именно разглядеть>',
      '```',
      'look показывает файл твоей vision-модели; описание придёт результатом действия.',
    );
  }
  if (ids.includes('image')) {
    lines.push(
      '```image',
      'prompt: подробное описание изображения — пишешь сам: стиль, композиция, палитра, свет',
      'size: 512x768',
      'n: 4',
      'steps: 20',
      'refs: images/файл1.png, images/файл2.png',
      '```',
      'image рисует image-моделью. Промпт, размер, число вариантов (n, до 8), шаги и референсы выбираешь ты сам; ' +
        'refs — необязательны, включают режим перерисовки по образцам. Файлы сохраняются в images/ рабочей папки, ' +
        'пути придут в результате; прежде чем рассказывать, что получилось, посмотри файлы через look.',
    );
  }
  if (ids.includes('docs')) {
    lines.push(
      '```docs read файл.pdf',
      '```docs tables таблица.xlsx',
      '```docs write отчёт.docx',
      '<текст документа: абзацы построчно или markdown/TSV/CSV-таблица для xlsx/ods>',
      '```',
      'docs читает (read, tables) и пишет (write) pdf/docx/xlsx/csv/odt/ods в твоей рабочей папке; ' +
        'append дописывает абзацы в конец существующего docx; convert pdf файл.doc перекодирует формат.',
    );
  }
  if (ids.includes('ocr')) {
    lines.push(
      '```ocr text скан.png',
      '```ocr tables скан.pdf 1-3',
      '```',
      'ocr распознаёт текст (text) и таблицы (tables → markdown, «csv» — вторым словом) со сканов: ' +
        'png/jpg/bmp/webp, страницы pdf, картинки внутри docx. Распознанное всегда перепроверяй по смыслу.',
    );
  }
  if (ids.includes('web')) {
    lines.push(
      '```web read https://…/страница',
      '```web links https://…/раздел фильтр',
      '```',
      'web читает разрешённые сайты (список задал хозяин): read — страница текстом, links — ссылки страницы ' +
        '(фильтр — подстрока в адресе). JavaScript не исполняется; если страница пустая, она рисуется скриптами.',
    );
  }
  if (ids.includes('mail')) {
    lines.push(
      '```mail list личное 10',
      '```mail read личное 42',
      '```mail send личное',
      'кому: адрес@example.com',
      'тема: Паспорта',
      'файлы: паспорта.xlsx',
      '',
      '<текст письма>',
      '```',
      'mail работает с ящиками из mails.json в служебной папке проекта .dreamteam (настроил хозяин): list/find — проверка почты, ' +
        'read — письмо целиком (вложения сохраняются в mail/), send — отправка с вложениями.',
    );
  }
  if (ids.includes('telegram')) {
    lines.push(
      '```telegram list',
      '```telegram send 123456789',
      'файлы: отчёт.pdf',
      '',
      '<текст сообщения>',
      '```',
      'telegram — бот из messengers.json в служебной папке проекта .dreamteam (токен задал хозяин): list — чаты и chat_id, ' +
        'in — входящие, send — сообщение в чат (файлы — вложением).',
    );
  }
  if (ids.includes('max')) {
    lines.push(
      '```max chats',
      '```max send 987654321',
      'файлы: отчёт.xlsx',
      '',
      '<текст сообщения>',
      '```',
      'max — бот мессенджера MAX (токен в messengers.json проекта, папка .dreamteam): chats — чаты и chat_id, ' +
        'in — входящие, send — сообщение в чат или user:<user_id> (файлы — вложением).',
    );
  }
  for (const id of ids.filter((t) => !(BUILTIN_TOOL_IDS as readonly string[]).includes(t))) {
    const tool = customTools?.get(id);
    lines.push(
      '```' + id,
      projects.length > 0 ? `${projects[0]}:тело запроса к тулу` : 'тело запроса к тулу',
      '```',
      tool?.desc ?? `Кастомный тул «${id}»: формат тела описан в его описании (tools/${id}.ts).`,
    );
  }
  lines.push(
    'Правила: файл записывается целиком (это перезапись, а не дифф); в одном блоке — одно действие или один файл; не описывай результат словами — результат придёт тебе отдельным сообщением от «⚙ инструменты», дождись его и продолжай; не используй блоки ``` внутри содержимого файла; не выдумывай вывод команд и не рассказывай о картинках, которые не смотрел через look.',
  );
  return lines.join('\n');
}
