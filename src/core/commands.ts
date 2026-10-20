/**
 * Канонический слой команд: один набор `/…` для всех оболочек. Текст,
 * начинающийся с `/`, ядро исполняет само (см. Engine.handleMessage), сервер
 * прогоняет те же команды через WS-тип `command`, а менеджер переговорки
 * выполняет те же операции своими JSON-действиями. Текстовые просмотры здесь
 * нарочно бесцветные: цветные версии остаются терминалу (index.ts), веб-оболочка
 * показывает свои панели по state.
 */
import { loadTeam } from '../agents.js';
import {
  addProject,
  addProjectHost,
  addTeamAgent,
  grantTool,
  updateTeamAgent,
} from '../manager.js';
import { agentToolIds } from '../tools-api.js';
import { AGENTS_FILE, PROJECTS_FILE, TOOLS_DIR } from '../paths.js';
import { chatTeam, isSessionRef, type App, type Engine } from './engine.js';
import type { Agent, ManagerHostSpec } from '../types.js';

/** Описание команды: справка, автодополнение и панель подсказок — из одного списка. */
export interface CommandSpec {
  cmd: string;
  /** Ожидаемые аргументы — для справки и панели; пусто, если аргументов нет */
  args?: string;
  help: string;
  /** Родственные написания (/help → h, /exit → quit, q); в справке не печатаются */
  aliases?: string[];
  /** Команда терминала: из протокола ядро её вежливо отклоняет */
  tuiOnly?: boolean;
}

export const COMMANDS: CommandSpec[] = [
  { cmd: '/new', help: 'новый разговор — один на один с менеджером, он позовёт остальных' },
  { cmd: '/sessions', help: 'список сохранённых разговоров' },
  { cmd: '/session', args: '<номер>', help: 'открыть разговор из списка' },
  { cmd: '/delete', args: '<номер>', help: 'удалить разговор из списка' },
  { cmd: '/rename', args: '<новое имя>', help: 'переименовать разговор; без имени менеджер придумает' },
  { cmd: '/history', args: '[N]', help: 'история текущего разговора (или последние N)' },
  { cmd: '/team', help: 'состав команды (· не в этом чате)' },
  { cmd: '/add', args: '<имя|номер>', help: 'позвать участника в текущий чат' },
  { cmd: '/out', args: '<имя|номер>', help: 'вывести участника из текущего чата' },
  { cmd: '/providers', help: 'провайдеры и их статус' },
  { cmd: '/provider', args: '<id>', help: 'сменить основного провайдера (у менеджера свой)' },
  { cmd: '/me', args: '[Имя; роль; о себе]', help: 'как вас видит команда' },
  { cmd: '/memory', args: '[имя|shared]', help: 'что помнит участник; shared — общая память' },
  { cmd: '/agent', args: 'add <id> <Имя> [роль] | set <id> поле=знач…', help: 'участник команды: добавить или править (как менеджер)' },
  { cmd: '/grant', args: '<агент> <тул>', help: 'включить агенту тул: files, shell, ssh, look, image или свой' },
  { cmd: '/project', args: 'add <id>; <имя>: [польз.@]хост[:порт]', help: 'проект с серверами; /project host <проект> <имя>=<хост>' },
  { cmd: '/help', help: 'эта справка', aliases: ['h'] },
  { cmd: '/exit', help: 'выход (только в терминале)', tuiOnly: true, aliases: ['quit', 'q'] },
];

/**
 * Исполняет `/команду` и возвращает строки отчёта — без отступов, оболочка
 * печатает их как хочет (терминал — с «  », сервер — notice-событиями).
 * Побочные выходы ядра (открытие разговора, приветствие менеджера) идут через
 * Presenter как обычно. Ошибки (например, запись user.json) летят вызывающему.
 */
export async function runCommandText(
  engine: Engine,
  line: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const app = engine.app;
  const [raw, ...rest] = line.slice(1).trim().split(/\s+/);
  const cmd = (raw ?? '').toLowerCase();
  const arg = rest.join(' ');
  switch (cmd) {
    case 'help':
    case 'h':
      return helpText();
    case 'new':
      await engine.newSession(signal ?? new AbortController().signal);
      return [];
    case 'sessions':
      return sessionsText(app);
    case 'rename':
      return renameCommand(engine, arg);
    case 'session':
      engine.openSessionByArg(arg);
      return [];
    case 'history':
      return historyText(app, rest[0]);
    case 'delete': {
      const n = Number.parseInt(arg, 10);
      if (!Number.isInteger(n) || n <= 0) return [`Не нашёл разговор №${arg} — см. /sessions`];
      return [engine.deleteSession(n)];
    }
    case 'team':
      return teamText(app);
    case 'add':
      return chatChangeText(engine, arg, 'позвать');
    case 'out':
      return chatChangeText(engine, arg, 'вывести');
    case 'providers':
      return providersText(app);
    case 'provider': {
      if (!arg) {
        return [
          `Основной провайдер: ${app.defaultProviderId}. ` +
          `Менеджер переговорки: ${app.mgr.provider} (меняется только в config/manager.json)`,
        ];
      }
      return engine.setProvider(arg)
        ? [`Основной провайдер: ${arg}`]
        : [`Нет провайдера «${arg}». Доступны: ${[...app.providers.keys()].join(', ')}`];
    }
    case 'all':
      return ['Команды /all больше нет — состав отвечает по решению модератора или @упоминания.'];
    case 'memory':
      return memoryText(app, arg);
    case 'agent':
      return agentCommand(rest);
    case 'grant': {
      const [who, tool] = rest;
      if (!who || !tool) return ['Синтаксис: /grant <агент> <тул> (files, shell, ssh, look, image или свой из tools/)'];
      return [grantTool(AGENTS_FILE, who, tool, undefined, TOOLS_DIR)];
    }
    case 'project':
      return projectCommand(rest);
    case 'me': {
      const parts = arg.split(';').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) {
        const p = app.profile;
        return [
          `Вы: ${p.name}${p.role ? ' — ' + p.role : ''}${p.about ? ' — ' + p.about : ''}`,
          'Представиться: /me Имя; роль; пара слов о себе (сохраняется в config/user.json)',
        ];
      }
      return [await engine.setProfile(parts[0], parts[1], parts[2])];
    }
    case 'exit':
    case 'quit':
    case 'q':
      return ['/exit — команда терминала. В веб-оболочке просто закройте страницу.'];
    default:
      return ['Неизвестная команда. /help — список команд.'];
  }
}

/** /add и /out: общая обвязка — пустой аргумент и недоступный agents.json. */
function chatChangeText(engine: Engine, arg: string, verb: string): string[] {
  if (!arg) return [`Кого ${verb}? /${verb === 'позвать' ? 'add' : 'out'} <имя или номер> (список — /team)`];
  let fullTeam: Agent[];
  try {
    fullTeam = loadTeam(AGENTS_FILE);
  } catch {
    return [`agents.json недоступен — ${verb} никого не получится.`];
  }
  return [verb === 'позвать' ? engine.addToChat(arg, fullTeam) : engine.removeFromChat(arg, fullTeam)];
}

/**
 * /agent add|set — управление составом поверх тех же helpers, что исполняет
 * менеджер переговорки (addTeamAgent/updateTeamAgent): валидация и
 * tmp+rename-откат там общие. Ошибки летят вызывающему — оболочка покажет.
 */
function agentCommand(rest: string[]): string[] {
  const [sub, ...tail] = rest;
  if (sub === 'add') {
    const [id, name, ...roleParts] = tail;
    if (!id || !name) return ['Синтаксис: /agent add <id> <Имя> [роль]'];
    const role = roleParts.join(' ');
    return [addTeamAgent(AGENTS_FILE, { id, name, role: role || undefined })];
  }
  if (sub === 'set') {
    const [id, ...pairs] = tail;
    if (!id || pairs.length === 0) {
      return [
        'Синтаксис: /agent set <id> поле=значение…',
        'Поля: name, role, emoji, color, description, prompt, provider, temperature',
      ];
    }
    const fields: Record<string, string | number> = {};
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq === -1) return [`Поле без значения: «${pair}» — жду поле=значение`];
      const key = pair.slice(0, eq).toLowerCase();
      const value = pair.slice(eq + 1);
      if (!value) return [`Пустое значение у поля «${key}»`];
      if (key === 'temperature') {
        const num = Number(value);
        if (!Number.isFinite(num)) return [`temperature — жду числом, а не «${value}»`];
        fields[key] = num;
      } else {
        fields[key] = value;
      }
    }
    return [updateTeamAgent(AGENTS_FILE, id, fields)];
  }
  return ['Синтаксис: /agent add <id> <Имя> [роль] · /agent set <id> поле=значение…'];
}

/**
 * Адрес в командной строке: [пользователь@]хост[:порт]. Пароля тут сознательно
 * нет — он остался бы в транскрипте; пароли через разговор с менеджером или
 * руками в projects.json.
 */
function parseHostSpec(spec: string): ManagerHostSpec {
  let rest = spec.trim();
  let user: string | undefined;
  let port: number | undefined;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const colon = rest.lastIndexOf(':');
  if (colon !== -1) {
    const p = Number.parseInt(rest.slice(colon + 1), 10);
    if (Number.isInteger(p) && p > 0) {
      port = p;
      rest = rest.slice(0, colon);
    }
  }
  if (!rest) throw new Error(`в «${spec}» нет адреса хоста`);
  const out: ManagerHostSpec = { host: rest };
  if (user) out.user = user;
  if (port !== undefined) out.port = port;
  return out;
}

/** /project add|host — реестр серверов поверх addProject/addProjectHost. */
function projectCommand(rest: string[]): string[] {
  const [sub, ...tail] = rest;
  if (sub === 'add') {
    const segs = tail.join(' ').split(';').map((s) => s.trim()).filter(Boolean);
    const pid = segs.shift() ?? '';
    if (!pid || segs.length === 0) {
      return ['Синтаксис: /project add <id>; <имя>: [пользователь@]хост[:порт] …'];
    }
    const hosts: Record<string, ManagerHostSpec> = {};
    for (const seg of segs) {
      const colon = seg.indexOf(':');
      if (colon === -1) return [`Сервер без адреса: «${seg}» — жду <имя>: <хост>`];
      const name = seg.slice(0, colon).trim();
      const spec = seg.slice(colon + 1).trim();
      if (!name || !spec) return [`Сервер без имени или адреса: «${seg}»`];
      hosts[name] = parseHostSpec(spec);
    }
    return [addProject(PROJECTS_FILE, pid, hosts)];
  }
  if (sub === 'host') {
    const body = tail.join(' ');
    const space = body.indexOf(' ');
    const eq = body.indexOf('=');
    if (!body || space === -1 || eq === -1 || eq < space) {
      return ['Синтаксис: /project host <проект> <имя>=[пользователь@]хост[:порт]'];
    }
    const pid = body.slice(0, space).trim();
    const name = body.slice(space + 1, eq).trim();
    const spec = body.slice(eq + 1).trim();
    if (!name || !spec) return ['Синтаксис: /project host <проект> <имя>=[пользователь@]хост[:порт]'];
    return [addProjectHost(PROJECTS_FILE, pid, name, parseHostSpec(spec))];
  }
  return ['Синтаксис: /project add <id>; <имя>: <хост> … · /project host <проект> <имя>=<хост>'];
}

function helpText(): string[] {
  const lines = ['Команды:'];
  for (const c of COMMANDS) {
    lines.push(`    ${(c.cmd + (c.args ? ' ' + c.args : '')).padEnd(18)} — ${c.help}`);
  }
  lines.push(
    '',
    '  @имя или №имя — обратиться к участнику; @менеджер — к менеджеру переговорки;',
    '  @session N — приложить конспект другого разговора.',
  );
  return lines;
}

function sessionsText(app: App): string[] {
  const list = app.store.list();
  if (list.length === 0) return ['Разговоров пока нет.'];
  const fmt = (ts: number) => new Date(ts).toLocaleString('ru-RU');
  const lines = ['', 'Разговоры (свежие сверху):'];
  list.forEach((s, i) => {
    const cur = s.id === app.session.id ? ' ← текущий' : '';
    lines.push(`${i + 1}. ${s.title} — ${s.count} сообщ.${cur}`);
    lines.push(`   создан ${fmt(s.createdAt)} · последнее сообщение ${fmt(s.updatedAt)} · id ${s.id}`);
  });
  lines.push('');
  return lines;
}

/** /rename [имя]: с именем — напрямую, без — менеджер придумывает по разговору. */
async function renameCommand(engine: Engine, arg: string): Promise<string[]> {
  if (!arg) return ['Синтаксис: /rename <новое имя>; без имени менеджер придумает сам'];
  return [await engine.renameSession(arg)];
}

function teamText(app: App): string[] {
  let fullTeam: Agent[] = [];
  try {
    fullTeam = loadTeam(AGENTS_FILE);
  } catch {
    return ['agents.json недоступен.'];
  }
  const inChat = new Set(chatTeam(app.session, fullTeam).map((a) => a.id));
  const lines = [
    `${app.mgr.emoji} ${app.mgr.name} — менеджер переговорки: консьерж и шлюз настроек ` +
    `[провайдер: ${app.mgr.provider}]`,
  ];
  fullTeam.forEach((a, i) => {
    const tools = agentToolIds(a);
    const marks = [
      tools.length > 0 ? `тулы: ${tools.join(', ')}` : '',
      a.provider ? `провайдер: ${a.provider}` : '',
    ].filter(Boolean);
    lines.push(
      `${i + 1}. ${a.emoji} ${a.name} — ${a.role}${a.description ? ': ' + a.description : ''}` +
      (marks.length > 0 ? ` [${marks.join(' · ')}]` : '') +
      (inChat.has(a.id) ? '' : ` · не в этом чате (/add ${a.name})`),
    );
  });
  return lines;
}

function providersText(app: App): string[] {
  const lines: string[] = [];
  for (const [id, s] of app.providers) {
    const state = s.ok ? '✓ готов' : `✗ ${s.note ?? 'не настроен'}`;
    lines.push(
      `• ${id} (${s.provider.kind}, ${s.provider.model}) ${state}` +
      (s.vision ? ' ◉ зрение' : '') +
      (id === app.defaultProviderId ? ' ★ основной' : '') +
      (id === app.mgr.provider ? ' 🛎 менеджер' : ''),
    );
  }
  for (const [id, s] of app.images) {
    lines.push(`  картинки: ${id} ${s.ok ? '✓ готов' : `✗ ${s.note ?? 'не настроен'}`}`);
  }
  return lines;
}

function historyText(app: App, nStr?: string): string[] {
  const n = Number.parseInt(nStr ?? '', 10);
  const all = app.session.messages;
  const shown = Number.isInteger(n) && n > 0 ? all.slice(-n) : all;
  if (shown.length === 0) return ['Разговор пуст.'];
  const lines = [`Разговор «${app.session.title}» — показано ${shown.length} из ${all.length} сообщений:`, ''];
  for (const m of shown) {
    const who = m.authorId === 'user'
      ? 'Вы'
      : m.authorId === 'tool'
        ? '⚙ инструменты'
        : isSessionRef(m)
          ? `📎 ${m.authorName}`
          : `${m.authorName}${m.authorRole ? ` (${m.authorRole})` : ''}`;
    lines.push('', `${who}: ${m.text}`);
  }
  lines.push('');
  return lines;
}

function memoryText(app: App, arg: string): string[] {
  let memTeam: Agent[] = [];
  try {
    memTeam = loadTeam(AGENTS_FILE);
  } catch {
    // без agents.json показываем только общую память
  }
  if (arg === 'shared') {
    if (!app.memory.shared) {
      return ['Общая память пока пуста — заполняется при закрытии разговоров (/new, /exit).'];
    }
    return ['', 'Общая память команды:', ...app.memory.shared.split('\n'), ''];
  }
  if (!arg) {
    const withMem = memTeam.filter((a) => app.session.memories?.[a.id]);
    return [
      'Чья память: /memory <имя> (например, /memory Глеб), /memory shared — общая.',
      withMem.length > 0
        ? `Уже помнят что-то: ${withMem.map((a) => a.name).join(', ')}`
        : 'Пока никто не «осмыслил» разговор (память обновляется примерно раз в 12 сообщений).',
    ];
  }
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const who = memTeam.find((a) => norm(a.name) === norm(arg) || a.id === norm(arg));
  if (!who) return [`Нет участника «${arg}» — см. /team`];
  const mine = app.session.memories?.[who.id];
  const glob = app.memory.agents[who.id];
  const lines = [
    '',
    `Что ${who.name} помнит в разговоре «${app.session.title}»:`,
    `Задача: ${mine?.task ?? '—'}`,
    `Отношение к вам: ${mine?.towardUser ?? '—'}`,
  ];
  if (mine?.ties && Object.keys(mine.ties).length > 0) {
    const byId = new Map(memTeam.map((a) => [a.id, a.name] as const));
    for (const [id, note] of Object.entries(mine.ties)) lines.push(`${byId.get(id) ?? id}: ${note}`);
  } else {
    lines.push('Коллеги: —');
  }
  lines.push(`Из других разговоров: ${glob?.otherChats ?? '—'}`, '');
  return lines;
}
