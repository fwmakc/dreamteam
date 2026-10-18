import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Agent, AgentTool, ImageProvider, LLMProvider } from './types.js';

/**
 * Инструменты агентов: текстовый протокол поверх обычного ответа модели.
 * Агент вставляет в ответ markdown-блоки ```file / ```run / ```ssh / ```look / ```image,
 * приложение парсит их после стрима, проверяет права агента, выполняет (с
 * подтверждением пользователя) и возвращает результаты следующим сообщением в истории.
 *
 * Проекты: реестр в config/tools.json ("projects": {id: путь}); в блоках
 * адресуются префиксом — ```file lms:src/app.ts, ```run shop:docker compose up.
 * Серверы: реестр в config/hosts.json; блок ```ssh <host> выполняет команду
 * на сервере штатным ssh-клиентом этого ПК (только по ключу, BatchMode).
 * Картинки: ```look показывает файл vision-модели агента, ```image уходит в
 * image-провайдер агента; файлы сохраняются в images/ рабочей папки.
 */

export interface HostConfig {
  host: string;
  user?: string;
  port?: number;
}

export interface ToolsConfig {
  /** Путь из конфига, как написано (по умолчанию) */
  workspace: string;
  /** Тот же путь, разрешённый относительно корня приложения */
  workspaceAbs: string;
  /** Именованные проекты: id → абсолютный путь */
  projects: Map<string, string>;
  /** Именованные ssh-хосты: id → параметры подключения */
  hosts: Map<string, HostConfig>;
  runTimeoutMs: number;
  maxOutputChars: number;
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
  | { kind: 'ssh'; host: string; command: string }
  | { kind: 'look'; path: string; question: string; project?: string }
  | { kind: 'image'; params: ImageParams; project?: string };

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

/** Читает config/tools.json + config/hosts.json; нет файлов или полей — дефолты. */
export function loadToolsConfig(root: string): ToolsConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(join(root, 'config', 'tools.json'), 'utf8'));
  } catch {
    // нет файла — работаем на дефолтах
  }
  let hostsRaw: Record<string, unknown> = {};
  try {
    hostsRaw = JSON.parse(readFileSync(join(root, 'config', 'hosts.json'), 'utf8'));
  } catch {
    // нет hosts.json — ssh-блоки будут отклоняться как «хост не настроен»
  }

  const workspace =
    typeof raw.workspace === 'string' && raw.workspace.trim() ? raw.workspace.trim() : '.';
  const projects = new Map<string, string>();
  if (raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects)) {
    for (const [id, p] of Object.entries(raw.projects as Record<string, unknown>)) {
      if (typeof p === 'string' && p.trim()) projects.set(id, resolve(root, p.trim()));
    }
  }
  const hosts = new Map<string, HostConfig>();
  if (hostsRaw.hosts && typeof hostsRaw.hosts === 'object' && !Array.isArray(hostsRaw.hosts)) {
    for (const [id, h] of Object.entries(hostsRaw.hosts as Record<string, unknown>)) {
      const hc = h as Partial<HostConfig>;
      if (hc && typeof hc.host === 'string' && hc.host.trim()) {
        hosts.set(id, {
          host: hc.host.trim(),
          user: typeof hc.user === 'string' && hc.user.trim() ? hc.user.trim() : undefined,
          port: typeof hc.port === 'number' && hc.port > 0 ? hc.port : undefined,
        });
      }
    }
  }

  const runTimeoutMs =
    typeof raw.runTimeoutMs === 'number' && raw.runTimeoutMs > 0 ? raw.runTimeoutMs : 180000;
  const maxOutputChars =
    typeof raw.maxOutputChars === 'number' && raw.maxOutputChars > 0 ? raw.maxOutputChars : 4000;
  return { workspace, workspaceAbs: resolve(root, workspace), projects, hosts, runTimeoutMs, maxOutputChars };
}

/**
 * Блоки ```file / ```run / ```ssh / ```look / ```image в ответе агента, в порядке появления.
 * Префикс проекта: «lms:путь» у file/look, «shop:команда» у run, «shop:» у image
 * (id — строчные буквы/цифры, от 2 символов — чтобы не путать с «C:/...» на Windows).
 */
export function parseActions(text: string): Action[] {
  const re = /^```(file|run|ssh|look|image)[ \t]*([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  const actions: Action[] = [];
  for (const m of text.matchAll(re)) {
    if (m[1] === 'file') {
      const { target, rest } = splitTarget(m[2].trim().replace(/^["']|["']$/g, ''));
      if (rest) actions.push({ kind: 'file', path: rest, content: m[3].replace(/\n$/, ''), project: target });
    } else if (m[1] === 'run') {
      // команда может быть и на строке блока («```run shop:cmd»), и в теле — склеиваем
      const combined = (m[2].trim() + '\n' + m[3].trim()).replace(/^\n+/, '').trim();
      const { target, rest } = splitTarget(combined);
      if (rest) actions.push({ kind: 'run', command: rest, project: target });
    } else if (m[1] === 'ssh') {
      const host = m[2].trim().replace(/^["']|["']$/g, '').toLowerCase();
      const command = m[3].trim();
      if (host && command) actions.push({ kind: 'ssh', host, command });
    } else if (m[1] === 'look') {
      const { target, rest } = splitTarget(m[2].trim().replace(/^["']|["']$/g, ''));
      const question = m[3].trim() || 'Подробно опиши это изображение.';
      actions.push({ kind: 'look', path: rest ?? '', question, project: target });
    } else {
      // image: на строке блока — только префикс проекта («shop:»), параметры — в теле
      const pm = /^([a-z][a-z0-9_-]{1,}):(.*)$/.exec(m[2].trim());
      actions.push({ kind: 'image', params: parseImageParams(m[3]), project: pm?.[1] });
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
  if (a.kind === 'look') return `${at(a.project)}смотреть картинку: ${a.path || '(путь не указан)'}`;
  if (a.kind === 'image') {
    const p = a.params;
    const refs = p.refs?.length ? `, референсы: ${p.refs.length}` : '';
    return `${at(a.project)}генерация: ${p.n ?? 1} × ${p.size ?? '512x512'}, «${p.prompt.replace(/\s+/g, ' ').slice(0, 100)}»${refs}`;
  }
  return `${at(a.host)}команда на сервере: ${a.command.replace(/\s+/g, ' ').slice(0, 140)}`;
}

/**
 * Проверяет права агента на действие: инструмент включён, проект/хост назначены
 * и настроены. Возвращает null, если действие разрешено, иначе текст отказа.
 */
export function checkPermission(agent: Agent, action: Action, cfg: ToolsConfig): string | null {
  if (action.kind === 'ssh') {
    if (!agent.tools?.includes('ssh')) return 'инструмент ssh этому агенту не включён';
    if (!agent.hosts?.includes(action.host)) return `хост «${action.host}» этому агенту не назначен`;
    if (!cfg.hosts.has(action.host)) return `хост «${action.host}» не настроен в config/hosts.json`;
    return null;
  }
  if (action.kind === 'look' || action.kind === 'image') {
    if (!agent.tools?.includes(action.kind)) {
      return action.kind === 'look'
        ? 'инструмент look (зрение) этому агенту не включён'
        : 'инструмент image (генерация) этому агенту не включён';
    }
    if (action.project) {
      if (!agent.projects?.includes(action.project)) return `проект «${action.project}» этому агенту не назначен`;
      if (!cfg.projects.has(action.project)) return `проект «${action.project}» не настроен в config/tools.json`;
    }
    return null;
  }
  const tool: AgentTool = action.kind === 'file' ? 'files' : 'shell';
  if (!agent.tools?.includes(tool)) {
    return tool === 'files'
      ? 'инструмент files этому агенту не включён'
      : 'локальная консоль (shell) этому агенту не включена';
  }
  if (action.project) {
    if (!agent.projects?.includes(action.project)) return `проект «${action.project}» этому агенту не назначен`;
    if (!cfg.projects.has(action.project)) return `проект «${action.project}» не настроен в config/tools.json`;
  }
  return null;
}

/**
 * Рабочая папка действия: проект из префикса, иначе проект по умолчанию агента
 * (agent.workspace: id из реестра или путь), иначе общий workspace.
 */
export function workspaceFor(agent: Agent | undefined, action: { project?: string }, cfg: ToolsConfig): string {
  if (action.project && cfg.projects.has(action.project)) return cfg.projects.get(action.project)!;
  const w = agent?.workspace;
  if (w && cfg.projects.has(w)) return cfg.projects.get(w)!;
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

/** Собирает аргументы запуска ssh: только по ключу, без интерактивных паролей. */
export function sshArgs(hostId: string, cfg: ToolsConfig, command: string): string[] | null {
  const h = cfg.hosts.get(hostId);
  if (!h) return null;
  const args = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  if (h.port) args.push('-p', String(h.port));
  args.push(h.user ? `${h.user}@${h.host}` : h.host, command);
  return args;
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
  const args = sshArgs(action.host, cfg, action.command);
  if (!args) {
    return Promise.resolve({
      ok: false,
      label: describeAction(action),
      output: `отказ: хост «${action.host}» не настроен в config/hosts.json`,
    });
  }
  return executeProcess({ argv: args }, cfg, signal).then((r) => ({ ...r, label: describeAction(action) }));
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
  opts: { command?: string; argv?: string[]; cwd?: string },
  cfg: ToolsConfig,
  signal?: AbortSignal,
): Promise<Omit<ActionResult, 'label'>> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = opts.argv
        ? spawn(opts.argv[0]!, opts.argv.slice(1), { cwd: opts.cwd ?? cfg.workspaceAbs, signal })
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
  return executeSshAction(action, cfg, signal);
}

/** Блок в системный промпт: как этому агенту пользоваться его инструментами. */
export function actionsHint(agent: Agent, cfg: ToolsConfig): string | null {
  const tools = agent.tools ?? [];
  if (tools.length === 0) return null;
  const projects = (agent.projects ?? []).filter((p) => cfg.projects.has(p));
  const hosts = (agent.hosts ?? []).filter((h) => cfg.hosts.has(h));
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
  if (tools.includes('files')) {
    const sample = projects.length > 0 ? `${projects[0]}:относительный/путь/к/файлу.txt` : 'относительный/путь/к/файлу.txt';
    lines.push('```file ' + sample, '<полное содержимое файла>', '```');
  }
  if (tools.includes('shell')) {
    lines.push('```run', projects.length > 0 ? `${projects[0]}:одна команда оболочки, например docker ps` : '<одна команда оболочки, например docker ps>', '```');
  }
  if (tools.includes('ssh') && hosts.length > 0) {
    lines.push(
      '```ssh ' + hosts[0],
      '<команда для выполнения на сервере по ssh>',
      '```',
      `Доступные тебе серверы: ${hosts.join(', ')}.`,
    );
  }
  if (tools.includes('look')) {
    lines.push(
      '```look относительный/путь/к/картинке.png',
      '<вопрос по картинке: что именно разглядеть>',
      '```',
      'look показывает файл твоей vision-модели; описание придёт результатом действия.',
    );
  }
  if (tools.includes('image')) {
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
  lines.push(
    'Правила: файл записывается целиком (это перезапись, а не дифф); в одном блоке — одно действие или один файл; не описывай результат словами — результат придёт тебе отдельным сообщением от «⚙ инструменты», дождись его и продолжай; не используй блоки ``` внутри содержимого файла; не выдумывай вывод команд и не рассказывай о картинках, которые не смотрел через look.',
  );
  return lines.join('\n');
}
