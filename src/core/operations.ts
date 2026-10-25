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
import { join } from 'node:path';
import { loadTeam } from '../agents.js';
import {
  addMailAccount,
  addMessengerBot,
  addProjectHosts,
  addTeamAgent,
  grantTool,
  loadHostsFile,
  loadMailsFile,
  loadManagerConfig,
  loadMessengersFile,
  removeMailAccount,
  removeMessengerBot,
  removeProjectHost,
  removeTeamAgent,
  updateManagerConfig,
  updateTeamAgent,
} from '../manager.js';
import { addProviderConfig, loadProviders, removeProviderConfig, updateProviderConfig } from '../providers/registry.js';
import { resolveEndpoints } from '../mail.js';
import { agentToolIds } from '../tools-api.js';
import { t, tf, applyLocale } from '../i18n.js';
import { AGENTS_FILE, DT_HOME, HOSTS_FILE, MAIL_FILE, MANAGER_FILE, MESSENGERS_FILE, PROJECTS_FILE, PROVIDERS_FILE, SCHEDULE_FILE, SETTINGS_FILE, TOOLS_DIR, WORKSPACE } from '../paths.js';
import { loadProjectRegistry, projectLabel } from './projects.js';
import { loadSettings } from '../settings.js';
import { chatTeam, isSessionRef, type App, type Engine } from './engine.js';
import { loadSchedule, saveSchedule } from './schedule.js';
import {
  applyHomeImport,
  applySessionImport,
  homeEntries,
  packEntriesZip,
  readZipEntries,
  sessionEntriesById,
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
  if (list.length === 0) return [t('Разговоров пока нет.')];
  const fmt = (ts: number) => new Date(ts).toLocaleString('ru-RU');
  const lines = ['', t('Разговоры (свежие сверху):')];
  list.forEach((s, i) => {
    const cur = s.id === app.session.id ? t(' ← текущий') : '';
    lines.push(`${i + 1}. ${s.title} — ${t(`сообщ.:`)} ${s.count}${cur}`);
    lines.push(`   ${t('создан')} ${fmt(s.createdAt)} · ${t('последнее сообщение')} ${fmt(s.updatedAt)} · id ${s.id}`);
  });
  lines.push('');
  return lines;
}

function teamText(app: App): string[] {
  let fullTeam: Agent[] = [];
  try {
    fullTeam = loadTeam(AGENTS_FILE);
  } catch {
    return [t('agents.json недоступен.')];
  }
  const inChat = new Set(chatTeam(app.session, fullTeam).map((a) => a.id));
  const lines = [
    tf('{emoji} {name} — менеджер переговорки: консьерж и шлюз настроек [провайдер: {provider}]', {
      emoji: app.mgr.emoji, name: app.mgr.name, provider: app.mgr.provider,
    }),
  ];
  fullTeam.forEach((a, i) => {
    const tools = agentToolIds(a);
    const marks = [
      tools.length > 0 ? tf('тулы: {list}', { list: tools.join(', ') }) : '',
      a.provider ? tf('провайдер: {id}', { id: a.provider }) : '',
    ].filter(Boolean);
    lines.push(
      `${i + 1}. ${a.emoji} ${a.name} — ${a.role}${a.description ? ': ' + a.description : ''}` +
      (marks.length > 0 ? ` [${marks.join(' · ')}]` : '') +
      (inChat.has(a.id) ? '' : ` · ${t('не в этом чате')} (/chat add ${a.name})`),
    );
  });
  return lines;
}

function providersText(app: App): string[] {
  const lines: string[] = [];
  for (const [id, s] of app.providers) {
    const state = s.ok ? t('✓ готов') : `✗ ${s.note ?? t('не настроен')}`;
    lines.push(
      `• ${id} (${s.provider.kind}, ${s.provider.model}) ${state}` +
      (s.vision ? ` ${t('◉ зрение')}` : '') +
      (id === app.defaultProviderId ? ` ${t('★ основной')}` : '') +
      (id === app.mgr.provider ? ` ${t('🛎 менеджер')}` : ''),
    );
  }
  for (const [id, s] of app.images) {
    lines.push(`  ${t('картинки:')} ${id} ${s.ok ? t('✓ готов') : `✗ ${s.note ?? t('не настроен')}`}`);
  }
  return lines;
}

function historyText(app: App, nStr?: string): string[] {
  const n = Number.parseInt(nStr ?? '', 10);
  const all = app.session.messages;
  const shown = Number.isInteger(n) && n > 0 ? all.slice(-n) : all;
  if (shown.length === 0) return [t('Разговор пуст.')];
  const lines = [tf('Разговор «{title}» — показано {shown} из {all} сообщений:', { title: app.session.title, shown: shown.length, all: all.length }), ''];
  for (const m of shown) {
    const who = m.authorId === 'user'
      ? t('Вы')
      : m.authorId === 'tool'
        ? t('⚙ инструменты')
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
      return [t('Общая память пока пуста — заполняется при закрытии разговоров (/session new, /exit).')];
    }
    return ['', t('Общая память команды:'), ...app.memory.shared.split('\n'), ''];
  }
  if (!arg) {
    const withMem = memTeam.filter((a) => app.session.memories?.[a.id]);
    return [
      t('Чья память: /memory show <имя> (например, /memory show Глеб), /memory show shared — общая.'),
      withMem.length > 0
        ? tf('Уже помнят что-то: {names}', { names: withMem.map((a) => a.name).join(', ') })
        : t('Пока никто не «осмыслил» разговор (память обновляется примерно раз в 12 сообщений).'),
    ];
  }
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const who = memTeam.find((a) => norm(a.name) === norm(arg) || a.id === norm(arg));
  if (!who) return [tf('Нет участника «{name}» — см. /team', { name: arg })];
  const mine = app.session.memories?.[who.id];
  const glob = app.memory.agents[who.id];
  const lines = [
    '',
    tf('Что {name} помнит в разговоре «{title}»:', { name: who.name, title: app.session.title }),
    `${t('Задача:')} ${mine?.task ?? '—'}`,
    `${t('Отношение к вам:')} ${mine?.towardUser ?? '—'}`,
  ];
  if (mine?.ties && Object.keys(mine.ties).length > 0) {
    const byId = new Map(memTeam.map((a) => [a.id, a.name] as const));
    for (const [id, note] of Object.entries(mine.ties)) lines.push(`${byId.get(id) ?? id}: ${note}`);
  } else {
    lines.push(`${t('Коллеги:')} —`);
  }
  lines.push(`${t('Из других разговоров:')} ${glob?.otherChats ?? '—'}`, '');
  return lines;
}

function projectListText(app: App): string[] {
  void app;
  // реестр проектов машины: текущий — всегда первым, даже если его ещё не записали
  const known = loadProjectRegistry(PROJECTS_FILE).projects.filter((p) => p.path !== WORKSPACE);
  const lines = [
    '',
    t('Проекты (смена: /project open <имя|путь>):'),
    tf('• {name} — {path} ← текущий', { name: projectLabel(WORKSPACE), path: WORKSPACE }),
    ...known.map((p) => tf('• {name} — {path}', { name: p.name, path: p.path })),
  ];
  // серверы текущего проекта (hosts.json)
  const hosts = Object.entries(loadHostsFile(HOSTS_FILE)) as [string, { host: string; user?: string; port?: number }][];
  lines.push(t('Серверы проекта (hosts.json):'));
  if (hosts.length === 0) {
    lines.push(t('  пусто — /project host add <имя>=[пользователь@]хост[:порт]'));
  } else {
    for (const [name, h] of hosts) {
      lines.push(`  • ${name}: ${h.user ? h.user + '@' : ''}${h.host}${h.port ? ':' + h.port : ''}`);
    }
  }
  lines.push('');
  return lines;
}

/** Разбор пар поле=значение для /mail add; голый «tlsNoVerify» = true, порты — числами. */
function parseMailSpec(pairs: string[]): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      if (pair === 'tlsNoVerify') {
        out.tlsNoVerify = true;
        continue;
      }
      return tf('Синтаксис: пары поле=значение (например user=я@yandex.ru); «{pair}» — без "="', { pair });
    }
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  for (const key of ['port', 'smtpPort'] as const) {
    if (typeof out[key] === 'string') out[key] = Number(out[key]);
  }
  if (typeof out.tlsNoVerify === 'string') out.tlsNoVerify = out.tlsNoVerify !== 'false';
  return out;
}

// ── общая обвязка ────────────────────────────────────────────────────────────

/** /chat add и /chat remove: пустой аргумент и недоступный agents.json. */
function chatChangeText(engine: Engine, arg: string, verb: string): string[] {
  if (!arg) return [tf('Кого {verb}? /chat {cmd} <имя или номер> (список — /team)', { verb, cmd: verb === 'позвать' ? 'add' : 'remove' })];
  let fullTeam: Agent[];
  try {
    fullTeam = loadTeam(AGENTS_FILE);
  } catch {
    return [tf('agents.json недоступен — {verb} никого не получится.', { verb })];
  }
  const res = verb === 'позвать' ? engine.addToChat(arg, fullTeam) : engine.removeFromChat(arg, fullTeam);
  // событие чата ядро уже записал в хронику репликой менеджера — заметкой не дублируем
  if (res.changed) {
    engine.serviceLine(res.text);
    return [];
  }
  return [res.text];
}

/** Разбор `поле=значение` в словарь; temperature — числом. Ключи сохраняют регистр. */
function parsePairs(pairs: string[]): Record<string, string | number> | string[] {
  const out: Record<string, string | number> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) return [tf('Поле без значения: «{pair}» — жду поле=значение', { pair })];
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!value) return [tf('Пустое значение у поля «{key}»', { key })];
    if (key.toLowerCase() === 'temperature') {
      const num = Number(value);
      if (!Number.isFinite(num)) return [tf('temperature — жду числом, а не «{value}»', { value })];
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
  if (!rest) throw new Error(tf('в «{spec}» нет адреса хоста', { spec }));
  const out: ManagerHostSpec = { host: rest };
  if (user) out.user = user;
  if (port !== undefined) out.port = port;
  return out;
}

/** Экспорт дома: zip в рабочей папке. */
function exportHomeZip(engine: Engine): string[] {
  const app = engine.app;
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const entries = homeEntries(app);
  const file = join(WORKSPACE, `dt-home-${ts}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('Экспорт: {file} ({n} записей, включая ключи провайдеров — хранить как пароль)', { file, n: entries.length })];
}

/** Экспорт разговора: номер резолвится в id один раз — архив и его имя
 *  всегда про один и тот же разговор, даже если список живёт своей жизнью. */
function exportSessionZip(engine: Engine, n: number | undefined): string[] {
  const app = engine.app;
  const id = n === undefined ? app.session.id : app.store.list()[n - 1]?.id;
  if (!id) return [n === undefined ? t('Разговоров нет — экспортировать нечего.') : tf('Не нашёл разговор №{n} — см. /sessions', { n })];
  const entries = sessionEntriesById(app, id);
  const file = join(WORKSPACE, `dt-session-${id}.zip`);
  writeFileSync(file, packEntriesZip(entries));
  return [tf('Экспорт: {file} ({n} записей)', { file, n: entries.length })];
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
      if (!Number.isInteger(n) || n <= 0) return [tf('Не нашёл разговор №{n} — см. /sessions', { n: rest[0] ?? '' })];
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
      // без номера — текущий разговор (по id, не по позиции в списке)
      return Number.isInteger(n) && n > 0 ? exportSessionZip(engine, n) : exportSessionZip(engine, undefined);
    },
  },
  {
    name: 'session.import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'импорт разговора',
    help: 'вернуть разговор из архива (вливается как новый)',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('Синтаксис: /session import <файл.zip>')];
      if (!existsSync(file)) return [tf('Файла «{file}» нет', { file })];
      const entries = readZipEntries(readFileSync(file));
      if (!entries.some((e) => e.rel === 'session.json')) {
        return [t('В архиве нет session.json — это архив дома? Тогда: /home import <файл>')];
      }
      return [await applySessionImport(engine.app, entries)];
    },
  },
  {
    name: 'home.export', title: 'экспорт дома',
    help: 'снимок дома для переезда: настройки, провайдеры с ключами, память, расписание и все разговоры; .env (TOKEN/PORT) — вещь машины',
    run: async (engine) => exportHomeZip(engine),
  },
  {
    name: 'home.import',
    args: [{ name: 'файл.zip', required: true }],
    title: 'импорт дома',
    help: 'настройки/профиль/память/расписание заменяются, разговоры вливаются по id; с подтверждением',
    run: async (engine, rest) => {
      const file = rest.join(' ');
      if (!file) return [t('Синтаксис: /home import <файл.zip>')];
      if (!existsSync(file)) return [tf('Файла «{file}» нет', { file })];
      const entries = readZipEntries(readFileSync(file));
      const ok = await engine.confirmAction(
        t('Импортировать домашние настройки из этого архива?'),
        t('Настройки/профиль/провайдеры, память команды и расписание заменяются; разговоры вливаются по id. Ключи (.env) не переносятся.'),
      );
      if (!ok) return [t('Импорт дома отменён.')];
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
    run: async (engine, rest) => {
      const [id, name, ...roleParts] = rest;
      if (!id || !name) return [t('Синтаксис: /team add <id> <Имя> [роль]')];
      return [addTeamAgent(AGENTS_FILE, { id, name, role: roleParts.join(' ') || undefined }, engine.app.providers)];
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
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [
          t('Синтаксис: /team update <id> поле=значение…'),
          t('Поля: name, role, emoji, color, description, prompt, provider, temperature'),
        ];
      }
      const parsed = parsePairs(pairs);
      if (Array.isArray(parsed)) return parsed;
      // поля агента в нижнем регистре (белый список updateTeamAgent точный)
      const fields: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(parsed)) fields[k.toLowerCase()] = v;
      return [updateTeamAgent(AGENTS_FILE, id, fields, engine.app.providers)];
    },
  },
  {
    name: 'team.delete',
    args: [{ name: 'id…', required: true }],
    title: 'удалить участника',
    help: 'можно несколько — через запятую или пробел; то же, что попросить менеджера',
    run: async (_engine, rest) => {
      // «keks, volt, gosha» и «keks volt gosha» — одно и то же: запятые — разделители
      const ids = rest.flatMap((t) => t.split(',')).map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return [t('Синтаксис: /team delete <id> [id…] — id через пробел или запятую')];
      const lines: string[] = [];
      for (const id of ids) {
        try {
          lines.push(removeTeamAgent(AGENTS_FILE, id));
        } catch (err) {
          lines.push(`✗ ${err instanceof Error ? err.message : err}`);
        }
      }
      return lines;
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
      if (!who || !tool) return [t('Синтаксис: /team grant <агент> <тул> (files, shell, ssh, look, image или свой из tools/)')];
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
        ? [tf('Основной провайдер: {id}', { id })]
        : [tf('Нет провайдера «{id}». Доступны: {list}', { id, list: [...engine.app.providers.keys()].join(', ') })];
    },
  },
  {
    name: 'provider.add',
    args: [
      { name: 'id', required: true },
      { name: 'поле=значение…', required: true },
    ],
    title: 'новый провайдер',
    help: 'adapter обязателен; дальше model, baseUrl, apiKey и свой ключ адаптера',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [t('Синтаксис: /provider add <id> adapter=openai-compatible model=… baseUrl=… apiKey=…')];
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
    name: 'provider.update',
    args: [
      { name: 'id', required: true, hint: 'providers' },
      { name: 'поле=значение…', required: true },
    ],
    title: 'править провайдера',
    help: 'adapter, model, baseUrl, apiKey, maxTokens, temperature; пустое значение убирает поле',
    run: async (engine, rest) => {
      const [id, ...pairs] = rest;
      if (!id || pairs.length === 0) {
        return [t('Синтаксис: /provider update <id> model=… baseUrl=… apiKey=… adapter=…')];
      }
      const parsed = parsePairs(pairs);
      if (Array.isArray(parsed)) return parsed;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k === 'temperature' || k === 'maxTokens') fields[k] = Number(v);
        else fields[k] = v;
      }
      const report = updateProviderConfig(PROVIDERS_FILE, id, fields);
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
      if (!id) return [t('Синтаксис: /provider delete <id>')];
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
        tf('Вы: {name}{role}{about}', {
          name: p.name,
          role: p.role ? ` — ${p.role}` : '',
          about: p.about ? ` — ${p.about}` : '',
        }),
        t('Представиться: /profile set Имя; роль; пара слов о себе'),
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
      if (parts.length === 0) return [t('Синтаксис: /profile set Имя; роль; о себе')];
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
    help: 'известные проекты и серверы текущего; смена — /project open',
    run: async (engine) => projectListText(engine.app),
  },
  {
    name: 'project.open',
    args: [{ name: 'имя|путь', required: true, hint: 'projects' }],
    title: 'открыть проект',
    help: 'сменить рабочую папку и разговоры, не выходя из приложения',
    run: async (engine, rest) => {
      const arg = rest.join(' ').trim();
      if (!arg) return [t('Синтаксис: /project open <имя|путь> (список — /project)')];
      return [engine.switchProject(arg)];
    },
  },
  {
    name: 'project.add',
    args: [{ name: 'путь', required: true }],
    title: 'запомнить проект',
    help: 'добавить папку в реестр проектов, не переключаясь',
    run: async (engine, rest) => {
      const arg = rest.join(' ').trim();
      if (!arg) return [t('Синтаксис: /project add <путь>')];
      return [engine.addProject(arg)];
    },
  },
  {
    name: 'project.remove',
    args: [{ name: 'имя|путь', required: true, hint: 'projects' }],
    title: 'забыть проект',
    help: 'убрать из реестра (файлы не трогаются); текущий не забыть',
    run: async (engine, rest) => {
      const arg = rest.join(' ').trim();
      if (!arg) return [t('Синтаксис: /project remove <имя|путь>')];
      return [engine.removeProject(arg)];
    },
  },
  {
    name: 'project.host.add',
    args: [
      { name: 'имя=хост', required: true },
    ],
    title: 'добавить сервер',
    help: 'в текущий проект; формат хоста [пользователь@]хост[:порт]',
    run: async (_engine, rest) => {
      const body = rest.join(' ');
      const eq = body.indexOf('=');
      if (!body || eq === -1) {
        return [t('Синтаксис: /project host add <имя>=[пользователь@]хост[:порт]')];
      }
      const name = body.slice(0, eq).trim();
      const spec = body.slice(eq + 1).trim();
      if (!name || !spec) return [t('Синтаксис: /project host add <имя>=[пользователь@]хост[:порт]')];
      return [addProjectHosts(HOSTS_FILE, { [name]: parseHostSpec(spec) })];
    },
  },
  {
    name: 'project.host.delete',
    args: [{ name: 'имя', required: true }],
    title: 'убрать сервер',
    help: 'из текущего проекта',
    run: async (_engine, rest) => {
      const [name] = rest;
      if (!name) return [t('Синтаксис: /project host delete <имя>')];
      return [removeProjectHost(HOSTS_FILE, name)];
    },
  },

  // почта и боты проекта
  {
    name: 'mail.list', implicit: true, title: 'ящики',
    help: 'реестр ящиков (mails.json)',
    run: async () => {
      const mails = loadMailsFile(MAIL_FILE);
      const names = Object.keys(mails);
      if (names.length === 0) {
        return [t('Ящиков нет — /mail add <имя> user=… password=… imap=… smtp=… или попросите менеджера')];
      }
      return [
        '',
        t('Ящики:'),
        ...Object.entries(mails).map(([n, a]) => {
          const ep = resolveEndpoints(a);
          return `• ${n}: ${a.user} — imap ${ep.imap.host}:${ep.imap.port}, smtp ${ep.smtp.host}:${ep.smtp.port}${a.tlsNoVerify ? ` ${t('(без сверки сертификата)')}` : ''}`;
        }),
        '',
      ];
    },
  },
  {
    name: 'mail.add',
    args: [
      { name: 'имя', required: true },
      { name: 'user=… password=… imap=… smtp=…', required: true },
    ],
    title: 'добавить ящик',
    help: 'пароль приложения; в mails.json проекта — руками, командой или через менеджера',
    run: async (_engine, rest) => {
      const [name, ...pairs] = rest;
      if (!name || pairs.length === 0) {
        return [t('Синтаксис: /mail add <имя> user=… password=… imap=… smtp=… [port=…] [smtpPort=…] [tlsNoVerify]')];
      }
      const spec = parseMailSpec(pairs);
      if (typeof spec === 'string') return [spec];
      return [addMailAccount(MAIL_FILE, name, spec)];
    },
  },
  {
    name: 'mail.remove',
    args: [{ name: 'имя', required: true }],
    title: 'убрать ящик',
    help: 'из mails.json проекта',
    run: async (_engine, rest) => {
      const [name] = rest;
      if (!name) return [t('Синтаксис: /mail remove <имя>')];
      return [removeMailAccount(MAIL_FILE, name)];
    },
  },
  {
    name: 'messenger.list', implicit: true, title: 'боты',
    help: 'токены ботов (messengers.json)',
    run: async () => {
      const cfg = loadMessengersFile(MESSENGERS_FILE);
      const rows = (['telegram', 'max'] as const).filter((k) => cfg[k] !== undefined).map((k) => `• ${k}: ${t('токен сохранён')}`);
      if (rows.length === 0) return [t('Ботов нет — /messenger add <telegram|max> <токен> или попросите менеджера')];
      return ['', t('Боты:'), ...rows, ''];
    },
  },
  {
    name: 'messenger.add',
    args: [
      { name: 'telegram|max', required: true },
      { name: 'токен', required: true },
    ],
    title: 'токен бота',
    help: 'в messengers.json проекта; Telegram — @BotFather, MAX — dev.max.ru',
    run: async (_engine, rest) => {
      const [key, token] = rest;
      if (!key || !token) return [t('Синтаксис: /messenger add <telegram|max> <токен>')];
      return [addMessengerBot(MESSENGERS_FILE, key, token)];
    },
  },
  {
    name: 'messenger.remove',
    args: [{ name: 'telegram|max', required: true }],
    title: 'убрать бота',
    help: 'из messengers.json проекта',
    run: async (_engine, rest) => {
      const [key] = rest;
      if (!key) return [t('Синтаксис: /messenger remove <telegram|max>')];
      return [removeMessengerBot(MESSENGERS_FILE, key)];
    },
  },
  {
    name: 'schedule.list', implicit: true, title: 'расписание',
    help: 'задачи, которые serve запускает сам по интервалу',
    run: async (engine) => {
      const tasks = loadSchedule(scheduleDir());
      void engine;
      if (tasks.length === 0) return [t('Задач нет — /schedule add <задание> [минуты]')];
      return [
        '',
        t('Расписание:'),
        ...tasks.map((t2) => `${t2.enabled ? '▶' : '⏸'} ${t2.message.slice(0, 60)} — ${tf('каждые {n} мин', { n: t2.intervalMinutes })} [${t2.id}]`),
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
      if (rest.length === 0) return [t('Синтаксис: /schedule add <задание> [минуты]')];
      const last = rest[rest.length - 1];
      const minutes = Number.parseInt(last, 10);
      const every = Number.isInteger(minutes) && minutes > 0 ? minutes : 10;
      const message = (Number.isInteger(minutes) && minutes > 0 ? rest.slice(0, -1) : rest).join(' ');
      if (!message) return [t('Синтаксис: /schedule add <задание> [минуты]')];
      const dir = scheduleDir();
      const tasks = loadSchedule(dir);
      const id = `task-${Date.now().toString(36)}`;
      tasks.push({ id, message, intervalMinutes: every, enabled: true });
      saveSchedule(dir, tasks);
      return [tf('✓ Задача «{msg}» каждые {n} мин [{id}]', { msg: message.slice(0, 60), n: every, id })];
    },
  },
  {
    name: 'schedule.toggle',
    args: [{ name: 'id', required: true, hint: 'schedule' }],
    title: 'вкл/выкл задачу',
    help: 'пауза и возврат без удаления',
    run: async (_engine, rest) => {
      const id = rest[0];
      if (!id) return [t('Синтаксис: /schedule toggle <id>')];
      const dir = scheduleDir();
      const tasks = loadSchedule(dir);
      const task = tasks.find((t2) => t2.id === id);
      if (!task) return [tf('Нет задачи «{id}» — см. /schedule', { id })];
      task.enabled = !task.enabled;
      saveSchedule(dir, tasks);
      return [tf('{state}: {msg}', { state: task.enabled ? t('▶ Включена') : t('⏸ Выключена'), msg: task.message.slice(0, 60) })];
    },
  },
  {
    name: 'schedule.delete',
    args: [{ name: 'id', required: true, hint: 'schedule' }],
    title: 'удалить задачу',
    help: 'полностью',
    run: async (_engine, rest) => {
      const id = rest[0];
      if (!id) return [t('Синтаксис: /schedule delete <id>')];
      const dir = scheduleDir();
      const tasks = loadSchedule(dir).filter((t2) => t2.id !== id);
      saveSchedule(dir, tasks);
      return [tf('Удалено: задач осталось {n}', { n: tasks.length })];
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
      return [tf('🤖 автономный режим: до {n} ходов без вашего участия. Остановить — /auto off или ⏹.', { n: turns })];
    },
  },
  {
    name: 'auto.off', title: 'выключить автономный режим',
    help: 'вернуть руководителя в разговор',
    run: async (engine) => {
      engine.setAutoMode(false, 0);
      return [t('🤖 автономный режим выключен.')];
    },
  },

  {
    name: 'settings.show', implicit: true, title: 'настройки',
    help: 'язык, maxTurns, ширина и остальные поля settings.json',
    run: async (engine) => {
      const s = loadSettings(SETTINGS_FILE, 0);
      return [
        '',
        t('Настройки (settings.json):'),
        ...Object.entries(s).map(([k, v]) => `    ${k} = ${String(v)}`),
        t('Поменять: /settings set поле=значение (например, /settings set maxTurns=2 или /settings set ui=en)'),
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
      if (rest.length === 0) return [t('Синтаксис: /settings set поле=значение… (см. /settings)')];
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
      // язык интерфейса вступает в силу сразу (остальное — со следующего раунда)
      if (typeof fields.ui === 'string') applyLocale(fields.ui, DT_HOME);
      return [t('✓ Настройки обновлены (язык и лимиты — со следующего раунда)')];
    },
  },
  {
    name: 'manager.show', implicit: true, title: 'менеджер переговорки',
    help: 'его провайдер, имя и температура',
    run: async (engine) => [
      '',
      tf('Менеджер: {emoji} {name}', { emoji: engine.app.mgr.emoji, name: engine.app.mgr.name }),
      `    ${t('провайдер:')} ${engine.app.mgr.provider} · ${t('температура:')} ${engine.app.mgr.temperature ?? '—'}`,
      t('Поменять: /manager set provider=… temperature=… name=… emoji=… color=…'),
      '',
    ],
  },
  {
    name: 'manager.set',
    args: [{ name: 'поле=значение…', required: true }],
    title: 'настроить менеджера',
    help: 'provider, temperature, name, emoji, color',
    run: async (engine, rest) => {
      if (rest.length === 0) return [t('Синтаксис: /manager set provider=… temperature=… name=… emoji=… color=…')];
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

const scheduleDir = (): string => DT_HOME;

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
    return { cmd, args: args || undefined, help: t(op.title) };
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
    return [t('/exit — команда терминала. В веб-оболочке просто закройте страницу.')];
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
      ? tf('Не понял «/{cmd}». Есть группа /{near} — /help покажет её операции.', { cmd: `${group}${second ? ' ' + second : ''}`, near })
      : t('Неизвестная команда. /help — список операций.'),
  ];
}

function helpLines(): string[] {
  const lines = [t('Операции (это же — имена rpc и подсказки GUI):')];
  let group = '';
  for (const op of OPERATIONS) {
    const g = op.name.split('.')[0];
    if (g !== group) {
      group = g;
      lines.push('');
    }
    const label = (operationCommand(op) + (op.args ? ' ' + operationArgs(op) : '')).padEnd(24);
    lines.push(`    ${label} — ${t(op.help)}`);
  }
  lines.push(
    '',
    t('  @имя или !имя — обратиться к участнику; @менеджер — к менеджеру переговорки;'),
    t('  @session N — приложить конспект другого разговора.'),
  );
  return lines;
}
