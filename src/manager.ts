import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Agent,
  AgentTools,
  ChatMessage,
  ManagerAction,
  ManagerConfig,
  ManagerHostSpec,
  ManagerProjectInfo,
  ManagerReply,
  ManagerUpdateFields,
  SessionMeta,
} from './types.js';
import { loadTeam, MENTION_TRIGGERS } from './agents.js';
import { loadProjects } from './actions.js';
import { agentToolIds, BUILTIN_TOOL_IDS, normalizeAgentTools, TOOL_ID_RE } from './tools-api.js';

export const MANAGER_ID = 'manager';
export const MANAGER_ROLE = 'менеджер переговорки';

const MANAGER_COLORS = new Set(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray']);
const AGENT_COLORS = MANAGER_COLORS;

/**
 * Читает config/manager.json. Файл обязателен: нет файла, битый JSON или
 * неизвестный провайдер — падение на старте с внятной ошибкой.
 */
export function loadManagerConfig(file: string, knownProviderIds: Iterable<string>): ManagerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`не удалось прочитать ${file}: ${err instanceof Error ? err.message : err}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: ожидается JSON-объект с полем "provider"`);
  }
  const obj = raw as Record<string, unknown>;
  const provider = typeof obj.provider === 'string' ? obj.provider.trim() : '';
  if (!provider) throw new Error(`${file}: не указан "provider" — id провайдера из config/providers.json`);
  const known = new Set(knownProviderIds);
  if (!known.has(provider)) {
    throw new Error(
      `${file}: провайдер «${provider}» не найден в config/providers.json (есть: ${[...known].join(', ')})`,
    );
  }
  const color =
    typeof obj.color === 'string' && MANAGER_COLORS.has(obj.color.toLowerCase()) ? obj.color.toLowerCase() : 'yellow';
  const temperature =
    typeof obj.temperature === 'number' && Number.isFinite(obj.temperature) ? obj.temperature : 0.2;
  return {
    provider,
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'Менеджер',
    emoji: typeof obj.emoji === 'string' && obj.emoji.trim() ? obj.emoji.trim() : '🛎',
    color,
    temperature,
  };
}

/** Псевдо-агент менеджера — для шапки реплики и списка участников */
export function managerAsAgent(cfg: ManagerConfig): Agent {
  return {
    id: MANAGER_ID,
    name: cfg.name,
    emoji: cfg.emoji,
    color: cfg.color,
    role: MANAGER_ROLE,
    prompt: MANAGER_PROMPT,
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/** Позвали ли менеджера: @менеджер / @manager / @<имя из manager.json> (или с «№» вместо «@») */
export function managerMentioned(text: string, cfg: ManagerConfig): boolean {
  const t = norm(text);
  const names = new Set(['менеджер', 'manager', norm(cfg.name), MANAGER_ID]);
  for (const n of names) {
    if (MENTION_TRIGGERS.some((p) => t.includes(`${p}${n}`))) return true;
  }
  return false;
}

/** Короткий промпт менеджера (маркер «менеджер переговорки» в начале — по нему mock-провайдер узнаёт его) */
export const MANAGER_PROMPT =
  'Ты — менеджер переговорки: модератор беседы и единственный, кто меняет состав команды, ' +
  'состав чата, разговоры, инструменты участников и реестр серверов. Пиши коротко, по-русски. ' +
  'Если просят изменение — сделай его сам.\n' +
  'Формат ответа: сначала короткий текст для человека, затем строго один JSON-объект:\n' +
  '{"say":"текст для человека","actions":[...действия...]}\n' +
  'Действия:\n' +
  '- {"op":"team.add","id":"логин-латиницей","name":"Имя","role":"роль","prompt":"системный промпт от первого лица","emoji":"🎯","color":"blue","temperature":0.5,"provider":"id-провайдера","tools":{"shell":{},"files":null}} — tools: объект-карточки, имя тула → настройки (объект или null = по умолчанию)\n' +
  '- {"op":"team.update","id":"id_участника","fields":{"role":"...","prompt":"...","provider":"...","temperature":0.3,"name":"...","emoji":"...","color":"...","description":"..."}}\n' +
  '- {"op":"chat.add","who":"имя или id"} / {"op":"chat.remove","who":"имя или id"} — позвать или вывести из текущего чата\n' +
  '- {"op":"session.list"} — показать разговоры; {"op":"session.open","n":2} — открыть №2; {"op":"session.new","title":"название","participants":["id"]} — новый разговор; {"op":"session.delete","n":3} — удалить №3 (текущий не удалится); {"op":"session.rename","title":"новое имя"} — переименовать текущий разговор (когда просят придумать имя — опирайся на краткое содержание или начало разговора)\n' +
  '- {"op":"tool.grant","agent":"id_участника","tool":"files","card":{"allow":["git *"]}} — включить тул агенту или обновить его карточку; card можно опустить (настройки по умолчанию). Встроенные: files, shell, git, ssh, look, image; свои — имя файла из tools/ (включить можно только существующий, код тулов пишет человек)\n' +
  '- {"op":"project.add","id":"код-латиницей","hosts":{"prod":{"host":"203.0.113.10","user":"deploy","port":22}}} — новый проект в реестре серверов (host обязателен, hostов хоть один)\n' +
  '- {"op":"project.host.add","project":"код проекта","name":"prod","host":"203.0.113.10","user":"deploy","port":22,"dir":"/srv/app"} — сервер в проект (password лучше не передавать в переписке — пусть человек впишет сам)\n' +
  'Делай только те действия, о которых попросили. Если изменение не требуется — ответь одним текстом, без JSON.';

export interface ManagerContext {
  /** Полная команда (не только этот чат) */
  team: Agent[];
  /** Состав текущего чата; пусто/undefined — вся команда */
  participants: string[] | undefined;
  sessions: SessionMeta[];
  currentSessionId: string;
  /** Имя текущего разговора — менеджер может предложить переименование */
  sessionTitle: string;
  /** Краткое содержание разговора (session.digest), если уже сжат */
  digest?: string;
  userName: string;
  history: ChatMessage[];
  /** Просьба руководителя, из-за которой позвали менеджера */
  request: string;
  /** Проекты из projects.json: серверы и кто назначен (для тула ssh) */
  projects?: ManagerProjectInfo[];
  /** Slash-команды руководителя — из того же списка, что /help */
  commands?: { cmd: string; args?: string; help: string }[];
}

/** Пользовательская часть запроса: состояние переговорки + история + просьба */
export function managerStateInput(ctx: ManagerContext): string {
  const roster = ctx.team
    .map((a) => {
      const tools = agentToolIds(a);
      return (
        `- ${a.id} — ${a.name} (${a.role}), провайдер: ${a.provider ?? 'основной'}` +
        (a.temperature != null ? `, temp ${a.temperature}` : '') +
        (tools.length > 0 ? `; тула: ${tools.join(', ')}` : '; тула нет')
      );
    })
    .join('\n');
  const inChat =
    !ctx.participants || ctx.participants.length === 0
      ? 'вся команда'
      : ctx.team.filter((a) => ctx.participants!.includes(a.id)).map((a) => a.id).join(', ') || 'никого';
  const sessions = ctx.sessions
    .map(
      (s, i) => `${i + 1}. ${s.title} — ${s.count} сообщ.${s.id === ctx.currentSessionId ? ' (текущий)' : ''}`,
    )
    .join('\n');
  const projects = (ctx.projects ?? [])
    .map((p) => {
      const hosts = p.hosts.length > 0 ? p.hosts.join(', ') : 'нет';
      const who = p.agents.length > 0 ? `; агенты: ${p.agents.join(', ')}` : '; агентов не назначено';
      return `- ${p.id}: серверы ${hosts}${who}`;
    })
    .join('\n');
  const commands = (ctx.commands ?? []).map((c) => `${c.cmd}${c.args ? ` ${c.args}` : ''} — ${c.help}`).join('\n');
  const history = ctx.history.length
    ? `\nПоследние сообщения:\n${ctx.history.map((m) => `${m.authorName}: ${m.text}`).join('\n')}\n`
    : '';
  return (
    `Текущее состояние.\nКоманда:\n${roster}\nВ этом чате: ${inChat}\n` +
    `Разговоры (номер — это n для session.*):\n${sessions || '- нет'}\n` +
    (projects ? `Проекты (реестр серверов для ssh):\n${projects}\n` : '') +
    `Текущий разговор: ${ctx.currentSessionId} (имя: «${ctx.sessionTitle}»)\n` +
    (ctx.digest ? `Краткое содержание разговора:\n${ctx.digest}\n` : '') +
    `Руководитель: ${ctx.userName}\n` +
    (commands ? `Slash-команды руководителя (сам ты их не исполняешь, но можешь подсказать):\n${commands}\n` : '') +
    `${history}\nПросьба руководителя: «${ctx.request}»`
  );
}

const MANAGER_OPS = new Set([
  'team.add',
  'team.update',
  'chat.add',
  'chat.remove',
  'session.list',
  'session.open',
  'session.new',
  'session.delete',
  'session.rename',
  'tool.grant',
  'project.add',
  'project.host.add',
]);

function isManagerAction(a: unknown): a is ManagerAction {
  if (!a || typeof a !== 'object') return false;
  const op = (a as { op?: unknown }).op;
  if (typeof op !== 'string' || !MANAGER_OPS.has(op)) return false;
  const o = a as Record<string, unknown>;
  switch (op) {
    case 'team.add':
      return typeof o.id === 'string' && typeof o.name === 'string';
    case 'team.update':
      return typeof o.id === 'string' && !!o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields);
    case 'chat.add':
    case 'chat.remove':
      return typeof o.who === 'string';
    case 'session.open':
    case 'session.delete':
      return typeof o.n === 'number' && Number.isInteger(o.n);
    case 'session.rename':
      return typeof o.title === 'string' && !!o.title.trim();
    case 'tool.grant':
      return typeof o.agent === 'string' && typeof o.tool === 'string';
    case 'project.add':
      return typeof o.id === 'string' && !!o.hosts && typeof o.hosts === 'object' && !Array.isArray(o.hosts);
    case 'project.host.add':
      return typeof o.project === 'string' && typeof o.name === 'string' && typeof o.host === 'string';
    default:
      return true; // session.list, session.new — обязательных полей нет
  }
}

/**
 * Ответ менеджера: короткий текст + строго один JSON-объект.
 * Нет валидного JSON — весь текст считается обычным ответом без действий.
 */
export function parseManagerReply(text: string): ManagerReply {
  const raw = text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { say: raw, actions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { say: raw, actions: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { say: raw, actions: [] };
  const obj = parsed as { say?: unknown; actions?: unknown };
  const actions: ManagerAction[] = Array.isArray(obj.actions) ? obj.actions.filter(isManagerAction) : [];
  const say = typeof obj.say === 'string' ? obj.say.trim() : '';
  if (!say && actions.length === 0) return { say: raw, actions: [] };
  return { say, actions };
}

// ─── Правки config/agents.json по действию менеджера ─────────────────────────

export interface ManagerNewAgent {
  id: string;
  name: string;
  role?: string;
  prompt?: string;
  emoji?: string;
  color?: string;
  description?: string;
  temperature?: number;
  provider?: string;
  tools?: AgentTools;
}

const UPDATABLE_FIELDS = new Set([
  'name',
  'emoji',
  'color',
  'role',
  'description',
  'prompt',
  'provider',
  'temperature',
]);

/** Корень agents.json: массив или объект { agents } — неизвестные поля сохраняем как есть */
function readTeamRoot(file: string): { root: unknown; agents: unknown[] } {
  const root: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const agents = Array.isArray(root)
    ? root
    : root && typeof root === 'object' && Array.isArray((root as { agents?: unknown }).agents)
      ? (root as { agents: unknown[] }).agents
      : undefined;
  if (!agents) throw new Error('в agents.json нет списка участников');
  return { root, agents };
}

/** Запись agents.json: tmp-файл → валидация loadTeam → rename. Ошибка — исходник не тронут. */
function writeTeamFile(file: string, root: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  try {
    loadTeam(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, file);
}

/** team.add: новый участник в agents.json. Бросает Error с причиной для отчёта «✗ …». */
export function addTeamAgent(file: string, data: ManagerNewAgent): string {
  const id = String(data.id ?? '').trim();
  const name = String(data.name ?? '').trim();
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`неверный id «${data.id}» — нужна латиница, цифры, «-» и «_»`);
  if (!name) throw new Error('не указано имя участника (name)');
  const { root, agents } = readTeamRoot(file);
  if (agents.some((a) => (a as Agent).id === id)) throw new Error(`участник с id «${id}» уже есть`);
  const role = typeof data.role === 'string' && data.role.trim() ? data.role.trim() : 'участник';
  const agent: Agent = {
    id,
    name,
    emoji: typeof data.emoji === 'string' && data.emoji.trim() ? data.emoji.trim() : '🤖',
    role,
    color:
      typeof data.color === 'string' && AGENT_COLORS.has(data.color.toLowerCase())
        ? data.color.toLowerCase()
        : 'white',
    prompt:
      typeof data.prompt === 'string' && data.prompt.trim()
        ? data.prompt.trim()
        : `Ты — ${name}, ${role}.`,
  };
  if (typeof data.description === 'string' && data.description.trim()) agent.description = data.description.trim();
  if (typeof data.temperature === 'number' && Number.isFinite(data.temperature)) agent.temperature = data.temperature;
  if (typeof data.provider === 'string' && data.provider.trim()) agent.provider = data.provider.trim();
  if (data.tools !== undefined) agent.tools = normalizeAgentTools(id, data.tools);
  agents.push(agent);
  writeTeamFile(file, root);
  return `✓ ${name} (id «${id}», роль «${role}») добавлен в команду`;
}

/** team.update: правка полей участника по белому списку. */
export function updateTeamAgent(file: string, id: string, fields: ManagerUpdateFields): string {
  const fid = String(id ?? '').trim();
  const { root, agents } = readTeamRoot(file);
  const agent = agents.find((a) => (a as Agent).id === fid) as Agent | undefined;
  if (!agent) throw new Error(`участника с id «${fid}» нет в команде`);
  const changes: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!UPDATABLE_FIELDS.has(key)) continue;
    if (key === 'temperature') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      agent.temperature = value;
      changes.push(`temperature=${value}`);
    } else if (typeof value === 'string' && value.trim()) {
      (agent as unknown as Record<string, unknown>)[key] = value.trim();
      changes.push(`${key}="${value.trim()}"`);
    }
  }
  if (changes.length === 0) throw new Error('не понятно, что менять — в fields нет узнаваемых полей');
  writeTeamFile(file, root);
  return `✓ ${agent.name}: ${changes.join(', ')}`;
}

// ─── tool.grant: тулы участников (agents.json); файлы в tools/ менеджер не пишет ──

/**
 * Включает тул агенту или обновляет его карточку. Белый список: id по правилам
 * тулов, у своего тула файл tools/<id>.ts должен существовать (включать можно
 * только то, что человек положил на полку). Запись — tmp → loadTeam → rename.
 */
export function grantTool(file: string, agentId: string, tool: string, card?: unknown, toolsDir?: string): string {
  const fid = String(agentId ?? '').trim();
  const tid = String(tool ?? '').trim().toLowerCase();
  if (!TOOL_ID_RE.test(tid)) {
    throw new Error(`неверный id тула «${tool}» — строчные буквы/цифры/-/_ от 2 символов`);
  }
  if (!(BUILTIN_TOOL_IDS as readonly string[]).includes(tid)) {
    if (!toolsDir || !existsSync(join(toolsDir, `${tid}.ts`))) {
      const builtins = (BUILTIN_TOOL_IDS as readonly string[]).join(', ');
      throw new Error(`тула «${tid}» нет: файла tools/${tid}.ts не существует (встроенные: ${builtins})`);
    }
  }
  const normalized = card === undefined || card === null ? {} : card;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error(`карточка тула «${tid}» — объект настроек (или пусто = по умолчанию)`);
  }
  const { root, agents } = readTeamRoot(file);
  const agent = agents.find((a) => (a as Agent).id === fid) as Agent | undefined;
  if (!agent) throw new Error(`участника с id «${fid}» нет в команде`);
  const had = Boolean(agent.tools?.[tid]);
  agent.tools = { ...(agent.tools ?? {}), [tid]: normalized as Record<string, unknown> };
  writeTeamFile(file, root);
  return had
    ? `✓ ${agent.name}: карточку тула «${tid}» обновил`
    : `✓ ${agent.name}: тул «${tid}» включён`;
}

// ─── project.add / project.host.add: реестр серверов (projects.json) ──────────

const PROJECT_ID_RE = /^[a-z][a-z0-9_-]{1,}$/;

/** Валидирует сервер из действия менеджера → HostSpec или Error с внятной причиной. */
function normalizeHost(where: string, spec: unknown): ManagerHostSpec {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${where} — ожидается объект { "host": "…", "user": "…", "port": 22 }`);
  }
  const o = spec as Record<string, unknown>;
  if (typeof o.host !== 'string' || !o.host.trim()) {
    throw new Error(`${where} — обязательное поле "host"`);
  }
  const out: ManagerHostSpec = { host: o.host.trim() };
  for (const key of ['user', 'password', 'dir'] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${where} — "${key}" жду непустой строкой`);
    out[key] = v.trim();
  }
  if (o.port !== undefined) {
    if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port <= 0) {
      throw new Error(`${where} — "port" жду целым числом больше нуля`);
    }
    out.port = o.port;
  }
  return out;
}

/** Запись projects.json: tmp → валидация loadProjects → rename. Ошибка — исходник не тронут. */
function writeProjectsFile(file: string, raw: Record<string, unknown>): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  try {
    loadProjects(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, file);
}

/** project.add: новый проект; серверов должен быть хоть один (иначе loadProjects не примет). */
export function addProject(
  file: string,
  id: string,
  hosts: Record<string, ManagerHostSpec>,
): string {
  const pid = String(id ?? '').trim();
  if (!PROJECT_ID_RE.test(pid)) {
    throw new Error(`неверный id проекта «${id}» — строчные буквы/цифры/-/_ от 2 символов`);
  }
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts) || Object.keys(hosts).length === 0) {
    throw new Error(`проекту «${pid}» нужен хоть один сервер: {"prod":{"host":"…"}}`);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: ожидаю объект { "проект": { "hosts": { … } } }`);
  }
  if (raw[pid] !== undefined) throw new Error(`проект «${pid}» уже есть`);
  const entry: Record<string, unknown> = {};
  for (const [hid, spec] of Object.entries(hosts)) {
    entry[hid] = normalizeHost(`проект «${pid}», сервер «${hid}»`, spec);
  }
  raw[pid] = { hosts: entry };
  writeProjectsFile(file, raw);
  return `✓ проект «${pid}» добавлен (серверы: ${Object.keys(entry).join(', ')})`;
}

/** project.host.add: сервер в существующий проект; дубликаты имён не нужны. */
export function addProjectHost(file: string, project: string, name: string, spec: ManagerHostSpec): string {
  const pid = String(project ?? '').trim();
  const hid = String(name ?? '').trim();
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const entry = raw[pid];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !(entry as Record<string, unknown>).hosts) {
    throw new Error(`проекта «${pid}» нет в projects.json — сначала project.add`);
  }
  if (!hid || /\s/.test(hid)) throw new Error('имя сервера — непустая строка без пробелов');
  const hosts = (entry as { hosts: Record<string, unknown> }).hosts;
  if (hosts[hid] !== undefined) throw new Error(`сервер «${hid}» уже есть у проекта «${pid}»`);
  hosts[hid] = normalizeHost(`проект «${pid}», сервер «${hid}»`, spec);
  writeProjectsFile(file, raw);
  return `✓ проект «${pid}»: сервер «${hid}» (${(hosts[hid] as ManagerHostSpec).host}) добавлен`;
}
