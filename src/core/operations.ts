/**
 * Манифест операций: единый источник для всего, чем можно управлять.
 * Каноническое имя операции — `группа.глагол` — одновременно:
 *   - текстовая команда:  `/группа глагол аргументы`   (обзор группы — просто `/группа`);
 *   - rpc-метод WS:       то же имя строкой (GUI, скрипты);
 *   - тема справки:       /help печатает этот же список.
 * Никаких алиасов и коротких форм: одно имя — одна операция (активная фаза
 * разработки, легаси не тащим). Транспорт (`user_message`, `abort`, `file`,
 * диалоги confirm/choose) — не операции и здесь не живёт.
 *
 * Реализации опираются на те же helpers, что исполняет менеджер переговорки
 * своими JSON-действиями: валидация и tmp+rename-откат общие. Ошибки летят
 * вызывающему (терминал покажет, сервер ушлёт error/rpc_error).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadTeam } from '../agents.js';
import {
  addProject,
  addProjectHost,
  addTeamAgent,
  grantTool,
  loadManagerConfig,
  removeProject,
  removeProjectHost,
  removeTeamAgent,
  updateManagerConfig,
  updateTeamAgent,
} from '../manager.js';
import { addProviderConfig, loadProviders, removeProviderConfig } from '../providers/registry.js';
import { agentToolIds } from '../tools-api.js';
import { AGENTS_FILE, MANAGER_FILE, PROJECTS_FILE, PROVIDERS_FILE, SETTINGS_FILE, TOOLS_DIR } from '../paths.js';
import { loadSettings } from '../settings.js';
import { chatTeam, isSessionRef, type App, type Engine } from './engine.js';
import { loadSchedule, saveSchedule } from './schedule.js';
import {
  applyHomeImport,
  applySessionImport,
  homeEntries,
  packEntriesZip,
  readZipEntries,
  sessionEntries,
} from './transfer.js';
import type { Agent, ManagerHostSpec } from '../types.js';

/** Аргумент операции — для справки, подсказок и проверки количества. */
export interface OpArg {
  /** Как зовём аргумент в подсказках: «номер», «id», «имя»… */
  name: string;
  required: boolean;
  /** Уточнение для панели подсказок (что подставлять: номера, имена, id…) */
  hint?: 'sessions' | 'team' | 'chat' | 'providers' | 'projects' | 'schedule';
}

export interface OpSpec {
  /** Каноническое имя: `группа.глагол`; оно же — rpc-метод WS */
  name: string;
  args?: OpArg[];
  title: string;
  help: string;
  /** Обзор группы: разрешает вызов без глагола (`/team` = team.list) */
  implicit?: boolean;
  run: (engine: Engine, rest: string[], signal?: AbortSignal) => Promise<string[]>;
}

// ── просмотры (бесцветные: терминал рисует свои цветные версии сам) ─────────

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
      (inChat.has(a.id) ? '' : ` · не в этом чате (/chat add ${a.name})`),
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
      return ['Общая память пока пуста — заполняется при закрытии разговоров (/session new, /exit).'];
    }
    return ['', 'Общая память команды:', ...app.memory.shared.split('\n'), ''];
  }
  if (!arg) {
    const withMem = memTeam.filter((a) => app.session.memories?.[a.id]);
    return [
      'Чья память: /memory show <имя> (например, /memory show Глеб), /memory show shared — общая.',
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

function projectListText(app: App): string[] {
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
  } catch {
    return ['projects.json недоступен.'];
  }
  const projects = (file ?? {}) as Record<string, { hosts?: Record<string, { host: string; user?: string; port?: number }> }>;
  const ids = Object.keys(projects);
  if (ids.length === 0) return ['Проектов нет — /project add <id>; <имя>: [пользователь@]хост[:порт]'];
  const lines: string[] = [''];
  for (const id of ids) {
    lines.push(`• ${id}`);
    for (const [name, h] of Object.entries(projects[id].hosts ?? {})) {
      lines.push(`    ${name}: ${h.user ? h.user + '@' : ''}${h.host}${h.port ? ':' + h.port : ''}`);
    }
  }
  lines.push('');
  return lines;
}

// ── общая обвязка ────────────────────────────────────────────────────────────

/** /chat add и /chat remove: пустой аргумент и недоступный agents.json. */
function chatChangeText(engine: Engine, arg: string, verb: string): string[] {
  if (!arg) return [`Кого ${verb}? /chat ${verb === 'позвать' ? 'add' : 'remove'} <имя или номер> (список — /team)`];
  let fullTeam: Agent[];
  try {
    fullTeam = loadTeam(AGENTS_FILE);
  } catch {
    return [`agents.json недоступен — ${verb} никого не получится.`];
  }
  return [verb === 'позвать' ? engine.addToChat(arg, fullTeam) : engine.removeFromChat(arg, fullTeam)];
}

/** Разбор `поле=значение` в словарь; temperature — числом. Ключи сохраняют регистр. */
function parsePairs(pairs: string[]): Record<string, string | number> | string[] {
  const out: Record<string, string | number> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) return [`Поле без значения: «${pair}» — жду поле=значение`];
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!value) return [`Пустое значение у поля «${key}»`];
    if (key.toLowerCase() === 'temperature') {
      const num = Number(value);
      if (!Number.isFinite(num)) return [`temperature — жду числом, а не «${value}»`];
      out[key] = num;
    } else {
      out[key] = value;
    }
  }
  return out;
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

/** Экспорт: zip в рабочей папке. Номер — один разговор, без — весь дом. */
function exportZip(engine: Engine, n: number | undefined): string[] {
  const app = engine.app;
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const entries = n !== undefined ? sessionEntries(app, n) : homeEntries();
  const file = join(process.cwd(), n !== undefined ? `dt-session-${app.store.list()[n - 1].id}.zip` : `dt-home-${ts}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [`Экспорт: ${file} (${entries.length} записей${n !== undefined ? '' : ', без .env с ключами'})`];
}

// ── манифест ─────────────────────────────────────────────────────────────────

export const OPERATIONS: OpSpec[] = [
  // разговоры
  {
    name: 'sessions.list', implicit: true, title: 'список разговоров',
    help: 'разговоры: свежие сверху, текущий отмечен',
    run: async (engine) => sessionsText(engine.app),
  },
  {
    name: 'session.new', title: 'новый разговор',
    help: 'один на один с менеджером, он позовёт остальных',
    run: async (engine, _rest, signal) => {
      await engine.newSession(signal ?? new AbortController().signal);
      return [];
    },
  },
  {
    name: 'session.open',
    args: [{ name: 'номер', required: true, hint: 'sessions' }],
    title: 'открыть разговор',
    help: 'переключиться на разговор из списка',
    run: async (engine, rest) => {
      engine.openSessionByArg(rest.join(' '));
      return [];
    },
  },
  {
    name: 'session.delete',
    args: [{ name: 'номер', required: true, hint: 'sessions' }],
    title: 'удалить разговор',
    help: 'текущий удалить нельзя — сначала откройте другой',
    run: async (engine, rest) => {
      const n = Number.parseInt(rest[0] ?? '', 10);
      if (!Number.isInteger(n) || n <= 0) return [`Не нашёл разговор №${rest[0] ?? ''} — см. /sessions`];
      return [engine.deleteSession(n)];
    },
  },
  {
    name: 'session.rename',
    args: [{ name: 'имя', required: false }],
    title: 'переименовать разговор',
    help: 'текущий разговор; без имени менеджер придумает сам',
    run: async (engine, rest) => [await engine.renameSession(rest.join(' '))],
  },
  {
    name: 'session.history',
    args: [{ name: 'N', required: false }],
    title: 'история разговора',
    help: 'текущий разговор целиком или последние N сообщений',
    run: async (engine, rest) => historyText(engine.app, rest[0]),
  },
  {
    name: 'session.export',
    args: [{ name: 'номер', required: false, hint: 'sessions' }],
    title: 'экспорт разговора',
    help: 'архив разговора в zip; без номера — текущий',
    run: async (engine, rest) => {
      const n = Number.parseInt(rest[0] ?? '', 10);
      const current = engine.app.store.list().findIndex((s) => s.id === engine.app.session.id) + 1;
      const num = Number.isInteger(n) && n > 0 ? n : current;
      if (num <= 0) return ['Разговоров нет — экспортировать нечего.'];
      return exportZip(engine, num);
    },
  },
  {
    name: 'session.import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'импорт разговора',
    help: 'вернуть разговор из архива (вливается как новый)',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return ['Синтаксис: /session import <файл.zip>'];
      if (!existsSync(file)) return [`Файла «${file}» нет`];
      const entries = readZipEntries(readFileSync(file));
      if (!entries.some((e) => e.rel === 'session.json')) {
        return ['В архиве нет session.json — это архив дома? Тогда: /home import <файл>'];
      }
      return [await applySessionImport(engine.app, entries)];
    },
  },
  {
    name: 'home.export', title: 'экспорт дома',
    help: 'архив настроек, профиля и всех разговоров; ключи (.env) не выносятся',
    run: async (engine) => exportZip(engine, undefined),
  },
  {
    name: 'home.import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'импорт дома',
    help: 'настройки/профиль заменяются, разговоры вливаются по id; с подтверждением',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return ['Синтаксис: /home import <файл.zip>'];
      if (!existsSync(file)) return [`Файла «${file}» нет`];
      const entries = readZipEntries(readFileSync(file));
      const ok = await engine.confirmAction(
        'Импортировать домашние настройки из этого архива?',
        'Настройки/профиль/провайдеры заменяются; разговоры вливаются по id. Ключи (.env) не переносятся.',
      );
      if (!ok) return ['Импорт дома отменён.'];
      return [applyHomeImport(engine.app, entries)];
    },
  },

  // чат
  {
    name: 'chat.add',
    args: [{ name: 'имя|номер', required: true, hint: 'team' }],
    title: 'позвать участника',
    help: 'в текущий чат',
    run: async (engine, rest) => chatChangeText(engine, rest.join(' '), 'позвать'),
  },
  {
    name: 'chat.remove',
    args: [{ name: 'имя|номер', required: true, hint: 'team' }],
    title: 'вывести участника',
    help: 'из текущего чата',
    run: async (engine, rest) => chatChangeText(engine, rest.join(' '), 'вывести'),
  },

  // команда
  {
    name: 'team.list', implicit: true, title: 'состав команды',
    help: 'кто в команде, у кого какие тула, кто в чате',
    run: async (engine) => teamText(engine.app),
  },
  {
    name: 'team.add',
    args: [
      { name: 'id', required: true },
      { name: 'имя', required: true },
      { name: 'роль', required: false },
    ],
    title: 'новый участник',
    help: 'дефолты как у менеджера: эмодзи 🤖, белый цвет, автопромпт',
    run: async (_engine, rest) => {
      const [id, name, ...roleParts] = rest;
      if (!id || !name) return ['Синтаксис: /team add <id> <Имя> [роль]'];
      return [addTeamAgent(AGENTS_FILE, { id, name, role: roleParts.join(' ') || undefined })];
    },
  },
  {
    name: 'team.update',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: true },
    ],
    title: 'править участника',
    help: 'поля: name, role, emoji, color, description, prompt, provider, temperature',
    run: async (_engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [
          'Синтаксис: /team update <id> поле=значение…',
          'Поля: name, role, emoji, color, description, prompt, provider, temperature',
        ];
      }
      const parsed = parsePairs(pairs);
      if (Array.isArray(parsed)) return parsed;
      // поля агента в нижнем регистре (белый список updateTeamAgent точный)
      const fields: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(parsed)) fields[k.toLowerCase()] = v;
      return [updateTeamAgent(AGENTS_FILE, id, fields)];
    },
  },
  {
    name: 'team.delete',
    args: [{ name: 'id', required: true }],
    title: 'удалить участника',
    help: 'то же, что попросить менеджера; из чата исчезнет сам',
    run: async (_engine, rest) => {
      const id = rest[0];
      if (!id) return ['Синтаксис: /team delete <id>'];
      return [removeTeamAgent(AGENTS_FILE, id)];
    },
  },
  {
    name: 'team.grant',
    args: [
      { name: 'агент', required: true, hint: 'team' },
      { name: 'тул', required: true },
    ],
    title: 'включить тул',
    help: 'встроенные files/shell/ssh/look/image или свой из tools/',
    run: async (_engine, rest) => {
      const [who, tool] = rest;
      if (!who || !tool) return ['Синтаксис: /team grant <агент> <тул> (files, shell, ssh, look, image или свой из tools/)'];
      return [grantTool(AGENTS_FILE, who, tool, undefined, TOOLS_DIR)];
    },
  },

  // провайдеры
  {
    name: 'provider.list', implicit: true, title: 'провайдеры',
    help: 'какие есть, кто готов, кто основной и менеджерский',
    run: async (engine) => providersText(engine.app),
  },
  {
    name: 'provider.set',
    args: [{ name: 'id', required: true, hint: 'providers' }],
    title: 'сменить основного',
    help: 'у менеджера переговорки свой провайдер (/manager show)',
    run: async (engine, rest) => {
      const id = rest[0] ?? '';
      return engine.setProvider(id)
        ? [`Основной провайдер: ${id}`]
        : [`Нет провайдера «${id}». Доступны: ${[...engine.app.providers.keys()].join(', ')}`];
    },
  },
  {
    name: 'provider.add',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: true },
    ],
    title: 'новый провайдер',
    help: 'adapter обязателен; дальше model, baseUrl, apiKeyEnv и свой ключ адаптера',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return ['Синтаксис: /provider add <id> adapter=openai-compatible model=… baseUrl=… apiKeyEnv=…'];
      }
      const config = parsePairs(pairs);
      if (Array.isArray(config)) return config;
      const report = addProviderConfig(PROVIDERS_FILE, id, config);
      const loaded = loadProviders(PROVIDERS_FILE);
      for (const [k, v] of loaded.providers) engine.app.providers.set(k, v);
      for (const k of [...engine.app.providers.keys()]) if (!loaded.providers.has(k)) engine.app.providers.delete(k);
      return [report];
    },
  },
  {
    name: 'provider.delete',
    args: [{ name: 'id', required: true, hint: 'providers' }],
    title: 'удалить провайдера',
    help: 'основной не удалить — сначала /provider set другого',
    run: async (engine, rest) => {
      const id = rest[0] ?? '';
      if (!id) return ['Синтаксис: /provider delete <id>'];
      const report = removeProviderConfig(PROVIDERS_FILE, id, []);
      const loaded = loadProviders(PROVIDERS_FILE);
      for (const [k, v] of loaded.providers) engine.app.providers.set(k, v);
      for (const k of [...engine.app.providers.keys()]) if (!loaded.providers.has(k)) engine.app.providers.delete(k);
      return [report];
    },
  },

  // профиль и память
  {
    name: 'profile.show', implicit: true, title: 'ваш профиль',
    help: 'как вас видит команда (user.json)',
    run: async (engine) => {
      const p = engine.app.profile;
      return [
        `Вы: ${p.name}${p.role ? ' — ' + p.role : ''}${p.about ? ' — ' + p.about : ''}`,
        'Представиться: /profile set Имя; роль; пара слов о себе',
      ];
    },
  },
  {
    name: 'profile.set',
    args: [{ name: 'Имя; роль; о себе', required: true }],
    title: 'представиться',
    help: 'разделитель — точка с запятой',
    run: async (engine, rest) => {
      const parts = rest.join(' ').split(';').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) return ['Синтаксис: /profile set Имя; роль; о себе'];
      return [await engine.setProfile(parts[0], parts[1], parts[2])];
    },
  },
  {
    name: 'memory.show', implicit: true,
    args: [{ name: 'кого|shared', required: false, hint: 'team' }],
    title: 'память',
    help: 'без аргумента — обзор; «shared» — общая память команды',
    run: async (engine, rest) => memoryText(engine.app, rest.join(' ')),
  },

  // проекты
  {
    name: 'project.list', implicit: true, title: 'проекты',
    help: 'реестр серверов (projects.json)',
    run: async (engine) => projectListText(engine.app),
  },
  {
    name: 'project.add',
    args: [{ name: 'id; имя: [пользователь@]хост[:порт]…', required: true }],
    title: 'новый проект',
    help: 'пароля в команде сознательно нет — он остался бы в транскрипте',
    run: async (_engine, rest) => {
      const segs = rest.join(' ').split(';').map((s) => s.trim()).filter(Boolean);
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
    },
  },
  {
    name: 'project.host.add',
    args: [
      { name: 'проект', required: true },
      { name: 'имя=хост', required: true },
    ],
    title: 'добавить сервер',
    help: 'в существующий проект; формат хоста [пользователь@]хост[:порт]',
    run: async (_engine, rest) => {
      const body = rest.join(' ');
      const space = body.indexOf(' ');
      const eq = body.indexOf('=');
      if (!body || space === -1 || eq === -1 || eq < space) {
        return ['Синтаксис: /project host add <проект> <имя>=[пользователь@]хост[:порт]'];
      }
      const pid = body.slice(0, space).trim();
      const name = body.slice(space + 1, eq).trim();
      const spec = body.slice(eq + 1).trim();
      if (!name || !spec) return ['Синтаксис: /project host add <проект> <имя>=[пользователь@]хост[:порт]'];
      return [addProjectHost(PROJECTS_FILE, pid, name, parseHostSpec(spec))];
    },
  },
  {
    name: 'project.host.delete',
    args: [
      { name: 'проект', required: true },
      { name: 'имя', required: true },
    ],
    title: 'убрать сервер',
    help: 'из существующего проекта',
    run: async (_engine, rest) => {
      const [pid, name] = rest;
      if (!pid || !name) return ['Синтаксис: /project host delete <проект> <имя>'];
      return [removeProjectHost(PROJECTS_FILE, pid, name)];
    },
  },
  {
    name: 'project.delete',
    args: [{ name: 'id', required: true, hint: 'projects' }],
    title: 'удалить проект',
    help: 'целиком, со всеми серверами',
    run: async (_engine, rest) => {
      const id = rest[0];
      if (!id) return ['Синтаксис: /project delete <id>'];
      return [removeProject(PROJECTS_FILE, id)];
    },
  },

  // расписание
  {
    name: 'schedule.list', implicit: true, title: 'расписание',
    help: 'задачи, которые serve запускает сам по интервалу',
    run: async (engine) => {
      const tasks = loadSchedule(scheduleDir());
      void engine;
      if (tasks.length === 0) return ['Задач нет — /schedule add <задание> [минуты]'];
      return [
        '',
        'Расписание:',
        ...tasks.map((t) => `${t.enabled ? '▶' : '⏸'} ${t.message.slice(0, 60)} — каждые ${t.intervalMinutes} мин [${t.id}]`),
        '',
      ];
    },
  },
  {
    name: 'schedule.add',
    args: [
      { name: 'задание', required: true },
      { name: 'минуты', required: false },
    ],
    title: 'новая задача',
    help: 'текст уйдёт в чат как сообщение руководителя; интервал по умолчанию 10 минут',
    run: async (_engine, rest) => {
      if (rest.length === 0) return ['Синтаксис: /schedule add <задание> [минуты]'];
      const last = rest[rest.length - 1];
      const minutes = Number.parseInt(last, 10);
      const every = Number.isInteger(minutes) && minutes > 0 ? minutes : 10;
      const message = (Number.isInteger(minutes) && minutes > 0 ? rest.slice(0, -1) : rest).join(' ');
      if (!message) return ['Синтаксис: /schedule add <задание> [минуты]'];
      const dir = scheduleDir();
      const tasks = loadSchedule(dir);
      const id = `task-${Date.now().toString(36)}`;
      tasks.push({ id, message, intervalMinutes: every, enabled: true });
      saveSchedule(dir, tasks);
      return [`✓ Задача «${message.slice(0, 60)}» каждые ${every} мин [${id}]`];
    },
  },
  {
    name: 'schedule.toggle',
    args: [{ name: 'id', required: true, hint: 'schedule' }],
    title: 'вкл/выкл задачу',
    help: 'пауза и возврат без удаления',
    run: async (_engine, rest) => {
      const id = rest[0];
      if (!id) return ['Синтаксис: /schedule toggle <id>'];
      const dir = scheduleDir();
      const tasks = loadSchedule(dir);
      const task = tasks.find((t) => t.id === id);
      if (!task) return [`Нет задачи «${id}» — см. /schedule`];
      task.enabled = !task.enabled;
      saveSchedule(dir, tasks);
      return [`${task.enabled ? '▶ Включена' : '⏸ Выключена'}: ${task.message.slice(0, 60)}`];
    },
  },
  {
    name: 'schedule.delete',
    args: [{ name: 'id', required: true, hint: 'schedule' }],
    title: 'удалить задачу',
    help: 'полностью',
    run: async (_engine, rest) => {
      const id = rest[0];
      if (!id) return ['Синтаксис: /schedule delete <id>'];
      const dir = scheduleDir();
      const tasks = loadSchedule(dir).filter((t) => t.id !== id);
      saveSchedule(dir, tasks);
      return [`Удалено: задач осталось ${tasks.length}`];
    },
  },

  // настройки и менеджер
  {
    name: 'auto.on',
    args: [{ name: 'N', required: false }],
    title: 'включить автономный режим',
    help: 'агенты решают вопросы сами, до N ходов (по умолчанию 10)',
    run: async (engine, rest) => {
      const turns = Math.min(Math.max(Number.parseInt(rest[0] ?? '', 10) || 10, 1), 50);
      engine.setAutoMode(true, turns);
      return [`🤖 автономный режим: до ${turns} ходов без вашего участия. Остановить — /auto off или ⏹.`];
    },
  },
  {
    name: 'auto.off', title: 'выключить автономный режим',
    help: 'вернуть руководителя в разговор',
    run: async (engine) => {
      engine.setAutoMode(false, 0);
      return ['🤖 автономный режим выключен.'];
    },
  },

  {
    name: 'settings.show', implicit: true, title: 'настройки',
    help: 'язык, maxTurns, ширина и остальные поля settings.json',
    run: async (engine) => {
      const s = loadSettings(SETTINGS_FILE, 0);
      return [
        '',
        'Настройки (settings.json):',
        ...Object.entries(s).map(([k, v]) => `    ${k} = ${String(v)}`),
        'Поменять: /settings set поле=значение (например, /settings set maxTurns=2)',
        '',
      ];
    },
  },
  {
    name: 'settings.set',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'поменять настройки',
    help: 'вступают в силу со следующего раунда; запись с валидацией и откатом',
    run: async (_engine, rest) => {
      if (rest.length === 0) return ['Синтаксис: /settings set поле=значение… (см. /settings)'];
      const parsed = parsePairs(rest);
      if (Array.isArray(parsed)) return parsed;
      // настройки типизированы: числа и булевы приводим сразу
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v === 'true' || v === 'false') fields[k] = v === 'true';
        else if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) fields[k] = Number(v);
        else fields[k] = v;
      }
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
      const merged = { ...raw, ...fields };
      const tmp = SETTINGS_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
      loadSettings(tmp, 0); // валидация
      renameSync(tmp, SETTINGS_FILE);
      return ['✓ Настройки обновлены (язык и лимиты — со следующего раунда)'];
    },
  },
  {
    name: 'manager.show', implicit: true, title: 'менеджер переговорки',
    help: 'его провайдер, имя и температура',
    run: async (engine) => [
      '',
      `Менеджер: ${engine.app.mgr.emoji} ${engine.app.mgr.name}`,
      `    провайдер: ${engine.app.mgr.provider} · температура: ${engine.app.mgr.temperature ?? '—'}`,
      'Поменять: /manager set provider=… temperature=… name=… emoji=… color=…',
      '',
    ],
  },
  {
    name: 'manager.set',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'настроить менеджера',
    help: 'provider, temperature, name, emoji, color',
    run: async (engine, rest) => {
      if (rest.length === 0) return ['Синтаксис: /manager set provider=… temperature=… name=… emoji=… color=…'];
      const fields = parsePairs(rest);
      if (Array.isArray(fields)) return fields;
      const known = [...engine.app.providers.keys()];
      const report = updateManagerConfig(MANAGER_FILE, fields, known);
      engine.app.mgr = loadManagerConfig(MANAGER_FILE, known);
      return [report];
    },
  },
];

// ── расписание: schedule.json лежит в проектном слое рядом с projects.json ──

const scheduleDir = (): string => dirname(PROJECTS_FILE);

// ── поиск и исполнение ───────────────────────────────────────────────────────

const byName = new Map(OPERATIONS.map((o) => [o.name, o]));

export function findOperation(name: string): OpSpec | undefined {
  return byName.get(name);
}

/** Канонический текст команды операции: обзор группы — без глагола. */
export function operationCommand(op: OpSpec): string {
  const [group, verb] = op.name.split('.');
  return op.implicit ? `/${group}` : `/${group} ${verb}`;
}

/** Строка аргументов для справки: `<номер> [роль]`. */
export function operationArgs(op: OpSpec): string {
  return (op.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
}

/** Плоский список для подсказок терминала и GUI (completion). */
export interface OpHint {
  cmd: string;
  args?: string;
  help: string;
}

export function operationHints(): OpHint[] {
  return OPERATIONS.map((op) => {
    const cmd = operationCommand(op);
    const args = operationArgs(op);
    return { cmd, args: args || undefined, help: op.title };
  });
}

/**
 * Исполняет `/группа глагол аргументы…` и возвращает строки отчёта — без
 * отступов, оболочка печатает их как хочет. Обзор группы можно звать без
 * глагола (`/team`, `/memory Глеб`). Ошибки летят вызывающему.
 */
export async function runOperationText(
  engine: Engine,
  line: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const tokens = line.slice(1).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return helpLines();
  const [group, second, ...rest] = tokens;
  if (group === 'help') return helpLines();
  if (group === 'exit' || group === 'quit' || group === 'q') {
    return ['/exit — команда терминала. В веб-оболочке просто закройте страницу.'];
  }
  // трёхсловные имена (project host add) важнее двухсловных: ищем с хвоста
  const explicit3 = second && rest.length > 0 ? byName.get(`${group}.${second}.${rest[0].toLowerCase()}`) : undefined;
  if (explicit3) return explicit3.run(engine, rest.slice(1), signal);
  const explicit = second ? byName.get(`${group}.${second.toLowerCase()}`) : undefined;
  if (explicit) return explicit.run(engine, rest, signal);
  // обзор группы: verb-less (`/team`) или имплицитная операция с аргументом
  // (`/memory Глеб`, `/memory shared`) — глагол не нужен
  const implicit = OPERATIONS.find((o) => o.name.startsWith(`${group}.`) && o.implicit);
  if (implicit) {
    const args = second ? [second, ...rest] : rest;
    return implicit.run(engine, args, signal);
  }
  // не похоже ни на что: подсказываем ближайшую группу
  const groups = [...new Set(OPERATIONS.map((o) => o.name.split('.')[0]))];
  const near = groups.find((g) => g.startsWith(group.toLowerCase()));
  return [
    near
      ? `Не понял «/${group}${second ? ' ' + second : ''}». Есть группа /${near} — /help покажет её операции.`
      : 'Неизвестная команда. /help — список операций.',
  ];
}

function helpLines(): string[] {
  const lines = ['Операции (это же — имена rpc и подсказки GUI):'];
  let group = '';
  for (const op of OPERATIONS) {
    const g = op.name.split('.')[0];
    if (g !== group) {
      group = g;
      lines.push('');
    }
    const label = (operationCommand(op) + (op.args ? ' ' + operationArgs(op) : '')).padEnd(24);
    lines.push(`    ${label} — ${op.help}`);
  }
  lines.push(
    '',
    '  @имя или №имя — обратиться к участнику; @менеджер — к менеджеру переговорки;',
    '  @session N — приложить конспект другого разговора.',
  );
  return lines;
}
