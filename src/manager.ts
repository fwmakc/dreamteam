import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
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
  ModelRef,
  SessionMeta,
} from './types.js';
import { loadTeam, MENTION_TRIGGERS } from './agents.js';
import { readAccount, type MailAccount } from './mail.js';
import { isAgentId, isRecordId, isToolId } from './ids.js';
import { agentToolIds, BUILTIN_TOOL_DESCS, BUILTIN_TOOL_IDS, normalizeAgentTools } from './tools-api.js';
import { t, tf } from './i18n.js';

export const MANAGER_ID = 'manager';
export const MANAGER_ROLE = 'менеджер переговорки';

const MANAGER_COLORS = new Set(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray']);
const AGENT_COLORS = MANAGER_COLORS;

/**
 * Читает manager.json в доме. Файл обязателен: нет файла, битый JSON или
 * неизвестная модель — падение на старте с внятной ошибкой.
 */
/** Правка manager.json из GUI по белому списку; валидация loadManagerConfig после записи. */
export function updateManagerConfig(
  file: string,
  fields: Record<string, unknown>,
  knownModelIds: Iterable<string>,
): string {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const current = loadManagerConfig(file, knownModelIds);
  const changes: string[] = [];
  const updatable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!['name', 'emoji', 'color', 'temperature', 'model'].includes(key)) continue;
    if (key === 'temperature') {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 2) {
        throw new Error(`temperature — жду число от 0 до 2, а не «${value}»`);
      }
      updatable[key] = num;
    } else if (key === 'model') {
      // ссылка на модель: id строкой или объект; существование проверит loadManagerConfig
      if (typeof value === 'string' && value.trim()) updatable[key] = { id: value.trim() };
      else if (value && typeof value === 'object' && !Array.isArray(value)) updatable[key] = value;
      else throw new Error(`model — id модели («"model": {"id": "…"}»)`);
    } else {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`поле «${key}» — непустая строка`);
      updatable[key] = value.trim();
    }
    changes.push(`${key}="${String(JSON.stringify(updatable[key]))}"`);
  }
  if (changes.length === 0) throw new Error('не понятно, что менять — нет узнаваемых полей');
  raw.name = updatable.name ?? current.name;
  raw.emoji = updatable.emoji ?? current.emoji;
  raw.color = updatable.color ?? current.color;
  raw.temperature = updatable.temperature ?? current.temperature;
  raw.model = updatable.model ?? current.model;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}
`, 'utf8');
  try {
    loadManagerConfig(tmp, knownModelIds);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, file);
  return tf('✓ менеджер: {changes}', { changes: changes.join(', ') });
}

export function loadManagerConfig(file: string, knownModelIds: Iterable<string>): ManagerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`не удалось прочитать ${file}: ${err instanceof Error ? err.message : err}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: ожидается JSON-объект с полем "model"`);
  }
  const obj = raw as Record<string, unknown>;
  const rawModel = obj.model;
  let model: ModelRef;
  if (typeof rawModel === 'string' && rawModel.trim()) {
    model = { id: rawModel.trim() };
  } else if (rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel)) {
    model = { ...(rawModel as ModelRef) };
  } else {
    throw new Error(`${file}: не указан "model" — ссылка на модель из models/ дома ({"id": "…"})`);
  }
  const known = new Set(knownModelIds);
  if (!model.id || !known.has(model.id)) {
    throw new Error(
      `${file}: модель «${model.id ?? ''}» не найдена в models/ дома (есть: ${[...known].join(', ')})`,
    );
  }
  const color =
    typeof obj.color === 'string' && MANAGER_COLORS.has(obj.color.toLowerCase()) ? obj.color.toLowerCase() : 'yellow';
  const temperature =
    typeof obj.temperature === 'number' && Number.isFinite(obj.temperature) ? obj.temperature : 0.2;
  return {
    model,
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

/** Позвали ли менеджера: @менеджер / @manager / @<имя из manager.json> (или с «!» вместо «@») */
export function managerMentioned(text: string, cfg: ManagerConfig): boolean {
  const t = norm(text);
  const names = new Set(['менеджер', 'manager', norm(cfg.name), MANAGER_ID]);
  for (const n of names) {
    if (MENTION_TRIGGERS.some((p) => t.includes(`${p}${n}`))) return true;
  }
  return false;
}

/** Список встроенных тулов для промпта — производный от реестра (tools-api), не ручная копия. */
const BUILTIN_TOOL_LIST = (BUILTIN_TOOL_IDS as readonly string[]).join(', ');

/** Короткий промпт менеджера (маркер «менеджер переговорки» в начале — по нему mock-провайдер узнаёт его) */
export const MANAGER_PROMPT =
  'Ты — менеджер переговорки: модератор беседы и единственный, кто меняет состав команды, ' +
  'состав чата, разговоры, инструменты участников и реестры проекта (серверы, ящики, боты). Пиши коротко, по-русски. ' +
  'Если просят изменение — сделай его сам.\n' +
  'Формат ответа: сначала короткий текст для человека, затем строго один JSON-объект:\n' +
  '{"say":"текст для человека","actions":[...действия...]}\n' +
  'Действия:\n' +
  '- {"op":"team.add","id":"логин-латиницей","name":"Имя","description":"чем занимается, одной фразой","prompt":"системный промпт от первого лица","emoji":"🎯","color":"blue","temperature":0.5,"tools":{"shell":{},"files":null}} — tools: объект-карточки, имя тула → настройки (объект или null = по умолчанию); модель наследуется (переопределить можно полем "model":"id-модели")\n' +
  '- {"op":"team.update","id":"id_участника","fields":{"description":"...","prompt":"...","model":"...","temperature":0.3,"name":"...","emoji":"...","color":"..."}}\n' +
  '- {"op":"chat.add","who":"id"} / {"op":"chat.remove","who":"id"} — позвать или вывести из текущего чата\n' +
  '- {"op":"session.list"} — показать разговоры; {"op":"session.open","id":"20261027-143052"} — открыть по id; {"op":"session.new","title":"название","participants":["id"]} — новый разговор; {"op":"session.delete","id":"20261027-143052"} — удалить по id (текущий не удалится); {"op":"session.rename","title":"новое имя"} — переименовать текущий разговор (имя — по краткому содержанию)\n' +
  '- {"op":"tool.grant","agent":"id_участника","tool":"files","card":{"allow":["git *"]}} — включить тул агенту или обновить его карточку; card можно опустить (настройки по умолчанию). Встроенные: ' +
  BUILTIN_TOOL_LIST +
  '; свои — имя файла из tools/ (включить можно только существующий, код тулов пишет человек). Какие тулы есть и что умеют — блок «Тулы дома» в состоянии\n' +
   '- {"op":"project.host.add","name":"prod","host":"203.0.113.10","user":"deploy","port":22,"dir":"/srv/app"} — сервер в текущий проект (password лучше не передавать в переписке — пусть человек впишет сам)\n' +
   '- {"op":"project.open","path":"путь или имя"} — сменить проект: рабочая папка и разговоры\n' +
  '- {"op":"mail.add","name":"ящик","user":"робот@corp.ru","password":"пароль-приложения","imap":"imap.corp.ru","smtp":"smtp.corp.ru","smtpPort":587} — ящик в mails.json (tlsNoVerify — опционально)\n' +
  '- {"op":"mail.remove","name":"ящик"}; {"op":"messenger.add","key":"telegram","token":"123456:ABC…"} / {"op":"messenger.remove","key":"max"} — токены ботов в messengers.json (key: telegram|max)\n' +
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
  /** Серверы из hosts.json текущего проекта (для тула ssh) */
  projects?: ManagerProjectInfo[];
  /** Известные проекты машины (реестр projects.json) — имена для project.open */
  knownProjects?: { name: string; path: string; current?: boolean }[];
  /** Операции руководителя — из манифеста (operations.ts), как в /help */
  operations?: { cmd: string; args?: string; help: string }[];
  /** Тулы дома: встроенные и свои из tools/ — id и короткое описание (что умеет) */
  houseTools?: { id: string; builtin: boolean; desc: string }[];
  /** Версия приложения (из package.json); пусто — строки в состоянии не будет */
  appVersion?: string;
}

/** Пользовательская часть запроса: состояние переговорки + история + просьба */
export function managerStateInput(ctx: ManagerContext): string {
  const roster = ctx.team
    .map((a) => {
      const tools = agentToolIds(a);
      return (
        `- ${a.id} — ${a.name}${a.description ? ` (${a.description})` : ''}, модель: ${a.model?.id ?? 'основная'}` +
        (a.temperature != null ? `, temp ${a.temperature}` : '') +
        (tools.length > 0 ? `; тулы: ${tools.join(', ')}` : '; тулов нет')
      );
    })
    .join('\n');
  const inChat =
    !ctx.participants || ctx.participants.length === 0
      ? 'вся команда'
      : ctx.team.filter((a) => ctx.participants!.includes(a.id)).map((a) => a.id).join(', ') || 'никого';
  const sessions = ctx.sessions
    .map(
      (s) => `- ${s.id} — ${s.title} — ${s.count} сообщ.${s.id === ctx.currentSessionId ? ' (текущий)' : ''}`,
    )
    .join('\n');
  const projects = (ctx.projects ?? [])
    .filter((p) => p.hosts.length > 0) // пустой проект — блока нет
    .map((p) => `- ${p.id}: серверы ${p.hosts.length > 0 ? p.hosts.join(', ') : 'нет'}`)
    .join('\n');
  const known = (ctx.knownProjects ?? [])
    .map((p) => `- ${p.name} — ${p.path}${p.current ? ' (текущий)' : ''}`)
    .join('\n');
  const ops = (ctx.operations ?? []).map((c) => `${c.cmd}${c.args ? ` ${c.args}` : ''} — ${c.help}`).join('\n');
  const house = (ctx.houseTools ?? [])
    .map((tl) => `- ${tl.id} — ${tl.desc}${tl.builtin ? '' : ' (свой, из tools/)'}`)
    .join('\n');
  const history = ctx.history.length
    ? `\nПоследние сообщения:\n${ctx.history.map((m) => `${m.authorName}: ${m.text}`).join('\n')}\n`
    : '';
  return (
    `Текущее состояние.${ctx.appVersion ? `\nПриложение: dreamteam ${ctx.appVersion}` : ''}\nКоманда:\n${roster}\nВ этом чате: ${inChat}\n` +
    (house ? `Тулы дома (id — что умеет; включить агенту можно только существующий):\n${house}\n` : '') +
    `Разговоры (id — для session.open/session.delete):\n${sessions || '- нет'}\n` +
    (projects ? `Проекты (реестр серверов для ssh):\n${projects}\n` : '') +
    (known ? `Известные проекты (для project.open):\n${known}\n` : '') +
    `Текущий разговор: ${ctx.currentSessionId} (имя: «${ctx.sessionTitle}»)\n` +
    (ctx.digest ? `Краткое содержание разговора:\n${ctx.digest}\n` : '') +
    `Руководитель: ${ctx.userName}\n` +
    (ops ? `Операции руководителя (сам ты их не исполняешь, но можешь подсказать):\n${ops}\n` : '') +
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
  'project.host.add',
  'project.open',
  'mail.add',
  'mail.remove',
  'messenger.add',
  'messenger.remove',
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
      return typeof o.id === 'string' && !!o.id.trim();
    case 'session.rename':
      return typeof o.title === 'string' && !!o.title.trim();
    case 'tool.grant':
      return typeof o.agent === 'string' && typeof o.tool === 'string';
    case 'project.host.add':
      return typeof o.name === 'string' && typeof o.host === 'string';
    case 'project.open':
      return typeof o.path === 'string' && !!o.path.trim();
    case 'mail.add':
      return (
        typeof o.name === 'string' &&
        typeof o.user === 'string' && typeof o.password === 'string' &&
        typeof o.imap === 'string' && typeof o.smtp === 'string'
      );
    case 'mail.remove':
      return typeof o.name === 'string';
    case 'messenger.add':
      return (o.key === 'telegram' || o.key === 'max') && typeof o.token === 'string';
    case 'messenger.remove':
      return o.key === 'telegram' || o.key === 'max';
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
  /** id модели строкой или объект-ссылка; пусто → settings.model */
  model?: string | ModelRef;
  tools?: AgentTools;
}

const UPDATABLE_FIELDS = new Set([
  'name',
  'emoji',
  'color',
  'role',
  'description',
  'prompt',
  'model',
  'temperature',
  'workspace',
]);

/** Корень полки агентов: один файл — один агент (tmp-файл → валидация loadTeam → rename). */
function readAgentFile(dir: string, id: string): Record<string, unknown> {
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`участника с id «${id}» нет в команде`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Запись карточки агента: tmp → валидация loadTeam(dir) → rename. Ошибка — файл не тронут. */
function writeAgentFile(dir: string, id: string, card: Record<string, unknown>): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const tmp = `${path}.tmp`;
  const forCheck = { id, ...card };
  writeFileSync(tmp, `${JSON.stringify(forCheck, null, 2)}\n`, 'utf8');
  try {
    // валидация: прочитаем все карточки — битые соседи тоже всплывут
    loadTeam(dir);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, path);
}

function agentPathExists(dir: string, id: string): boolean {
  return existsSync(join(dir, `${id}.json`));
}

/** Модель в карточке агента — только существующий id: иначе в файл уйдёт слово вместо id */
function requireModel(models: ReadonlyMap<string, unknown>, mid: string): void {
  if (models.has(mid)) return;
  const ids = [...models.keys()].join(', ') || 'нет ни одной';
  throw new Error(`неизвестная модель «${mid}» — есть: ${ids}`);
}

function normalizeModelRef(value: string | ModelRef): ModelRef {
  return typeof value === 'string' ? { id: value.trim() } : value;
}

/** team.add: новый участник — файл agents/<id>.json. Бросает Error с причиной для отчёта «✗ …». */
export function addTeamAgent(dir: string, data: ManagerNewAgent, models: ReadonlyMap<string, unknown>): string {
  const id = String(data.id ?? '').trim();
  const name = String(data.name ?? '').trim();
  if (!isAgentId(id)) throw new Error(`неверный id «${data.id}» — нужна латиница, цифры, точка, «-» и «_»`);
  if (!name) throw new Error('не указано имя участника (name)');
  if (agentPathExists(dir, id)) throw new Error(`участник с id «${id}» уже есть`);
  const role = typeof data.role === 'string' && data.role.trim() ? data.role.trim() : 'участник';
  const card: Record<string, unknown> = {
    name,
    emoji: typeof data.emoji === 'string' && data.emoji.trim() ? data.emoji.trim() : '🤖',
    color:
      typeof data.color === 'string' && AGENT_COLORS.has(data.color.toLowerCase())
        ? data.color.toLowerCase()
        : 'white',
    prompt:
      typeof data.prompt === 'string' && data.prompt.trim()
        ? data.prompt.trim()
        : `Ты — ${name}, ${role}.`,
  };
  if (typeof data.description === 'string' && data.description.trim()) card.description = data.description.trim();
  if (typeof data.temperature === 'number' && Number.isFinite(data.temperature)) card.temperature = data.temperature;
  if (data.model !== undefined && (typeof data.model === 'string' ? data.model.trim() : true)) {
    const ref = normalizeModelRef(data.model);
    if (ref.id) {
      requireModel(models, ref.id);
      card.model = ref;
    }
  }
  if (data.tools !== undefined) card.tools = normalizeAgentTools(id, data.tools);
  writeAgentFile(dir, id, card);
  return tf('✓ {name} (id «{id}», роль «{role}») добавлен в команду', { name, id, role });
}

/** Импорт: вливает входящих агентов по id — новых добавляет, совпавших не трогает. */
export function mergeTeamAgents(dir: string, incoming: Agent[]): number {
  let added = 0;
  for (const a of incoming) {
    if (!a?.id || agentPathExists(dir, a.id)) continue;
    const { id: _id, ...card } = a;
    writeAgentFile(dir, a.id, card as Record<string, unknown>);
    added++;
  }
  return added;
}

/** Удаление участника по id (для /team delete и GUI). */
export function removeTeamAgent(dir: string, id: string): string {
  const fid = String(id ?? '').trim();
  if (!fid) throw new Error('не указан id участника');
  const path = join(dir, `${fid}.json`);
  if (!existsSync(path)) throw new Error(`участника с id «${fid}» нет в команде`);
  const card = JSON.parse(readFileSync(path, 'utf8')) as { emoji?: string; name?: string };
  rmSync(path);
  return tf('✓ {emoji} {name} (id «{id}») удалён из команды', { emoji: card.emoji ?? '🤖', name: card.name ?? fid, id: fid });
}

/** team.update: правка полей участника по белому списку (read-modify-write одного файла). */
export function updateTeamAgent(dir: string, id: string, fields: ManagerUpdateFields, models: ReadonlyMap<string, unknown>): string {
  const fid = String(id ?? '').trim();
  const card = readAgentFile(dir, fid);
  const changes: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!UPDATABLE_FIELDS.has(key)) continue;
    if (key === 'temperature') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      card.temperature = value;
      changes.push(`temperature=${value}`);
    } else if (key === 'model') {
      if (value === undefined || value === null) continue;
      const ref = normalizeModelRef(value as string | ModelRef);
      if (!ref.id || !ref.id.trim()) continue;
      requireModel(models, ref.id.trim());
      card.model = ref;
      changes.push(`model="${ref.id.trim()}"`);
    } else if (typeof value === 'string' && value.trim()) {
      card[key] = value.trim();
      changes.push(`${key}="${value.trim()}"`);
    }
  }
  if (changes.length === 0) throw new Error('не понятно, что менять — в fields нет узнаваемых полей');
  writeAgentFile(dir, fid, card);
  return tf('✓ {name}: {changes}', { name: String(card.name ?? fid), changes: changes.join(', ') });
}

// ─── tool.grant: тулы участников (agents.json); файлы в tools/ менеджер не пишет ──

/**
 * Включает тул агенту или обновляет его карточку. Белый список: id по правилам
 * тулов, у своего тула файл tools/<id>.ts должен существовать (включать можно
 * только то, что человек положил на полку). Запись — tmp → loadTeam → rename.
 */
export function grantTool(dir: string, agentId: string, tool: string, card?: unknown, toolsDir?: string): string {
  const fid = String(agentId ?? '').trim();
  const tid = String(tool ?? '').trim().toLowerCase();
  if (!isToolId(tid)) {
    throw new Error(`неверный id тула «${tool}» — строчные буквы/цифры/./-/_ от 2 символов`);
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
  const agentCard = readAgentFile(dir, fid);
  const tools = (agentCard.tools ?? {}) as Record<string, unknown>;
  const had = Boolean(tools[tid]);
  agentCard.tools = { ...tools, [tid]: normalized };
  writeAgentFile(dir, fid, agentCard);
  return had
    ? tf('✓ {name}: карточку тула «{tool}» обновил', { name: String(agentCard.name ?? fid), tool: tid })
    : tf('✓ {name}: тул «{tool}» включён', { name: String(agentCard.name ?? fid), tool: tid });
}

/** Убирает тул у агента: карточка из поля tools удаляется; не было — ошибка. */
export function revokeTool(dir: string, agentId: string, tool: string): string {
  const fid = String(agentId ?? '').trim();
  const tid = String(tool ?? '').trim().toLowerCase();
  const agentCard = readAgentFile(dir, fid);
  const tools = (agentCard.tools ?? {}) as Record<string, unknown>;
  if (tools[tid] === undefined && !(tid in tools)) {
    throw new Error(`агенту «${fid}» тул «${tid}» и так не включён — см. /agent tools ${fid}`);
  }
  delete tools[tid];
  agentCard.tools = tools;
  writeAgentFile(dir, fid, agentCard);
  return tf('✓ {name}: тул «{tool}» выключен', { name: String(agentCard.name ?? fid), tool: tid });
}

// ─── hosts: серверы проекта (поле "hosts" в project.json) ───────────────────

/** Серверы проекта: { "prod": { host, user?, password?, dir?, port? } } — плоский словарь. */
export type HostsFile = Record<string, ManagerHostSpec>;

/** Читает поле "hosts" из project.json; нет файла/поля или поле битое — пусто (просмотр не падает). */
export function loadHostsFile(file: string): HostsFile {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const raw = cfg?.hosts;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as HostsFile;
  } catch {
    return {};
  }
}

/** Запись поля "hosts" в project.json (остальные поля нетронуты): tmp → rename. */
function saveHostsFile(file: string, hosts: HostsFile): void {
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch { /* файла нет — начнём project.json с чистого */ }
  cfg.hosts = hosts;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

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

/** project host add: сервер(а) в поле "hosts" project.json; поля нет — создаём. */
export function addProjectHosts(
  file: string,
  hosts: Record<string, ManagerHostSpec>,
): string {
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts) || Object.keys(hosts).length === 0) {
    throw new Error('проекту нужен хоть один сервер: {"prod":{"host":"…"}}');
  }
  const registry = loadHostsFile(file);
  const added: string[] = [];
  for (const [hid, spec] of Object.entries(hosts)) {
    const id = requireRecordId(hid, 'id сервера');
    if (registry[id] !== undefined) {
      throw new Error(`сервер «${id}» уже есть — /project host delete «${id}», если нужно заменить`);
    }
    registry[id] = normalizeHost(`сервер «${id}»`, spec);
    added.push(id);
  }
  saveHostsFile(file, registry);
  return tf('✓ сервер(а) добавлены в проект: {list}', { list: added.join(', ') });
}

/** project host delete: убрать сервер из поля "hosts" project.json. */
export function removeProjectHost(file: string, name: string): string {
  const hid = String(name ?? '').trim();
  const registry = loadHostsFile(file);
  if (registry[hid] === undefined) {
    throw new Error(`сервера «${hid}» нет в проекте — см. /project hosts`);
  }
  delete registry[hid];
  saveHostsFile(file, registry);
  return tf('✓ сервер «{id}» убран из проекта', { id: hid });
}

// ─── mails: ящики проекта (поле "mails" в project.json) ──────────────────────

/** Ящики проекта: { "работа": { user, password, imap, smtp, … } } — плоский словарь. */
export type MailsFile = Record<string, MailAccount>;

/** Читает поле "mails" из project.json; нет файла/поля или поле битое — пусто (просмотр не падает). */
export function loadMailsFile(file: string): MailsFile {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const raw = cfg?.mails;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as MailsFile;
  } catch {
    return {};
  }
}

/** Запись поля "mails" в project.json (остальные поля нетронуты): tmp → rename. */
function saveMailsFile(file: string, mails: MailsFile): void {
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch { /* файла нет — начнём project.json с чистого */ }
  cfg.mails = mails;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * mail add: ящик в поле "mails" project.json; поля нет — создаём. Валидация
 * та же, что у тула mail (readAccount), до записи; пароль в отчёте не светится.
 */
export function addMailAccount(file: string, name: string, spec: unknown): string {
  const box = requireRecordId(name, 'id ящика');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('ящик — объект { "user", "password", "imap", "smtp" }');
  }
  const acc = readAccount(box, spec as Record<string, unknown>, file);
  const mails = loadMailsFile(file);
  if (mails[box] !== undefined) {
    throw new Error(`ящик «${box}» уже есть — /project mail delete «${box}», если нужно заменить`);
  }
  mails[box] = acc;
  saveMailsFile(file, mails);
  return tf('✓ ящик «{box}» добавлен ({user} — imap {imap}, smtp {smtp})', { box, user: acc.user, imap: acc.imap, smtp: acc.smtp });
}

/** mail remove: убрать ящик из поля "mails" project.json. */
export function removeMailAccount(file: string, name: string): string {
  const box = String(name ?? '').trim();
  const mails = loadMailsFile(file);
  if (mails[box] === undefined) {
    throw new Error(`ящика «${box}» нет — см. /project mails`);
  }
  delete mails[box];
  saveMailsFile(file, mails);
  return tf('✓ ящик «{box}» убран', { box });
}

// ─── messengers: боты telegram/max (поле "messengers" в project.json) ────────

const MESSENGER_KEYS = ['telegram', 'max'] as const;

/** Читает поле "messengers" из project.json; нет файла/поля или поле битое — пусто (просмотр не падает). */
export function loadMessengersFile(file: string): Record<string, unknown> {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const raw = cfg?.messengers;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Запись поля "messengers" в project.json (остальные поля нетронуты): tmp → rename. */
function saveMessengersFile(file: string, msngrs: Record<string, unknown>): void {
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch { /* файла нет — начнём project.json с чистого */ }
  cfg.messengers = msngrs;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** messenger add: токен бота в поле "messengers" project.json; поля нет — создаём. Токен в отчёте не светится. */
export function addMessengerBot(file: string, key: string, token: string): string {
  const k = String(key ?? '').trim().toLowerCase();
  if (!(MESSENGER_KEYS as readonly string[]).includes(k)) {
    throw new Error(`ключ бота — «telegram» или «max», получено «${key}»`);
  }
  const tok = String(token ?? '').trim();
  if (!tok) throw new Error('нужен токен (Telegram — @BotFather, MAX — dev.max.ru)');
  const cfg = loadMessengersFile(file);
  if (cfg[k] !== undefined) {
    throw new Error(`бот «${k}» уже есть — /project messenger delete ${k}, если нужно заменить`);
  }
  cfg[k] = { token: tok };
  saveMessengersFile(file, cfg);
  return tf('✓ токен бота «{key}» сохранён в project.json проекта', { key: k });
}

/** messenger remove: убрать бота из поля "messengers" project.json. */
export function removeMessengerBot(file: string, key: string): string {
  const k = String(key ?? '').trim().toLowerCase();
  if (!(MESSENGER_KEYS as readonly string[]).includes(k)) {
    throw new Error(`ключ бота — «telegram» или «max», получено «${key}»`);
  }
  const cfg = loadMessengersFile(file);
  if (cfg[k] === undefined) {
    throw new Error(`бота «${k}» нет — см. /project messengers`);
  }
  delete cfg[k];
  saveMessengersFile(file, cfg);
  return tf('✓ бот «{key}» убран из проекта', { key: k });
}

// ─── записи секретов уровня команд: пустой add + update по полям ─────────────
// Команды (/project mail|host|messenger …) создают пустую запись и заполняют
// её по полям; действия менеджера кладут готовые записи через add*-выше.

/** id записи секрета (ящик/сервер): маска id; иначе Error с внятной причиной. */
function requireRecordId(raw: string, what: string): string {
  const id = String(raw ?? '').trim();
  if (!isRecordId(id)) {
    throw new Error(`${what} — по маске id: строчная латиница и цифры, внутри точка, «-», «_» (получено «${raw}»)`);
  }
  return id;
}

/** Запись полей в словарь проекта: строки как есть (пустая строка убирает поле), port* — числом, tlsNoVerify — булевым. */
function applyRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const changes: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw new Error(`поле «${key}» записи не узнаю (можно: ${allowed.join(', ')})`);
    if (value === '' || value === undefined) {
      delete record[key];
      changes.push(`-${key}`);
      continue;
    }
    if ((key === 'port' || key === 'smtpPort') && typeof value === 'string') {
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0) throw new Error(`${key} — целое число больше нуля, а не «${value}»`);
      record[key] = num;
      changes.push(`${key}=${num}`);
      continue;
    }
    if (key === 'tlsNoVerify') {
      record[key] = value === true || value === 'true';
      changes.push(`${key}=${String(record[key])}`);
      continue;
    }
    record[key] = String(value);
    changes.push(`${key}="…"`); // значения секретов в отчёте не светятся
  }
  return changes;
}

/** /project host add: пустой сервер — поля заполнит host update. */
export function addHostRecord(file: string, id: string): string {
  const hid = requireRecordId(id, 'id сервера');
  const registry = loadHostsFile(file);
  if (registry[hid] !== undefined) throw new Error(`сервер «${hid}» уже есть — см. /project hosts`);
  registry[hid] = { host: '' };
  saveHostsFile(file, registry);
  return tf('✓ сервер «{id}» добавлен (пустой) — заполни поля: /project host update {id} host=… user=… port=…', { id: hid });
}

/** /project host update: правка полей сервера (host, user, password, dir, port). */
export function updateHostRecord(file: string, id: string, fields: Record<string, unknown>): string {
  const hid = requireRecordId(id, 'id сервера');
  const registry = loadHostsFile(file);
  if (registry[hid] === undefined) throw new Error(`сервера «${hid}» нет — см. /project hosts`);
  const record: Record<string, unknown> = { ...registry[hid] };
  const changes = applyRecordFields(record, fields, ['host', 'user', 'password', 'dir', 'port']);
  if (changes.length === 0) throw new Error('не понятно, что менять — жду поле=значение');
  registry[hid] = record as unknown as ManagerHostSpec;
  saveHostsFile(file, registry);
  return tf('✓ сервер «{id}»: {changes}', { id: hid, changes: changes.join(', ') });
}

/** /project mail add: пустой ящик — поля заполнит mail update. */
export function addMailRecord(file: string, id: string): string {
  const box = requireRecordId(id, 'id ящика');
  const mails = loadMailsFile(file);
  if (mails[box] !== undefined) throw new Error(`ящик «${box}» уже есть — см. /project mails`);
  mails[box] = {} as MailAccount;
  saveMailsFile(file, mails);
  return tf('✓ ящик «{id}» добавлен (пустой) — заполни поля: /project mail update {id} user=… password=… imap=… smtp=…', { id: box });
}

/** /project mail update: правка полей ящика (user, password, imap, smtp, port, smtpPort, tlsNoVerify). */
export function updateMailRecord(file: string, id: string, fields: Record<string, unknown>): string {
  const box = requireRecordId(id, 'id ящика');
  const mails = loadMailsFile(file);
  if (mails[box] === undefined) throw new Error(`ящика «${box}» нет — см. /project mails`);
  const record: Record<string, unknown> = { ...mails[box] };
  const changes = applyRecordFields(record, fields, ['user', 'password', 'imap', 'smtp', 'port', 'smtpPort', 'tlsNoVerify']);
  if (changes.length === 0) throw new Error('не понятно, что менять — жду поле=значение');
  mails[box] = record as unknown as MailAccount;
  saveMailsFile(file, mails);
  return tf('✓ ящик «{id}»: {changes}', { id: box, changes: changes.join(', ') });
}

/** /project messenger add: пустой бот (token зальёт update или менеджер). */
export function addMessengerRecord(file: string, key: string): string {
  const k = String(key ?? '').trim().toLowerCase();
  if (!(MESSENGER_KEYS as readonly string[]).includes(k)) {
    throw new Error(`id бота — «telegram» или «max», получено «${key}»`);
  }
  const cfg = loadMessengersFile(file);
  if (cfg[k] !== undefined) throw new Error(`бот «${k}» уже есть — см. /project messengers`);
  cfg[k] = { token: '' };
  saveMessengersFile(file, cfg);
  return tf('✓ бот «{key}» добавлен (без токена) — заполни: /project messenger update {id} token=…', { key: k });
}

/** /project messenger update: залить токен боту. */
export function updateMessengerRecord(file: string, key: string, fields: Record<string, unknown>): string {
  const k = String(key ?? '').trim().toLowerCase();
  if (!(MESSENGER_KEYS as readonly string[]).includes(k)) {
    throw new Error(`id бота — «telegram» или «max», получено «${key}»`);
  }
  const cfg = loadMessengersFile(file);
  if (cfg[k] === undefined) throw new Error(`бота «${k}» нет — см. /project messengers`);
  const record = (cfg[k] ?? {}) as Record<string, unknown>;
  const changes = applyRecordFields(record, fields, ['token']);
  if (changes.length === 0) throw new Error('не понятно, что менять — жду token=…');
  cfg[k] = record;
  saveMessengersFile(file, cfg);
  return tf('✓ бот «{key}»: токен обновлён', { key: k });
}
