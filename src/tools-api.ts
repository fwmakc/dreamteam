/**
 * Контракт тула и карманный SDK для авторов tools/*.ts.
 *
 * Тул — фабрика make(config) → Tool: desc (что это и как пользоваться),
 * check(body) и run(body, ctx). Валидация в приложении ровно одна — check()
 * самого тула: 'allow' — выполнить молча, 'deny' — отказ, 'ask' — спросить
 * человека (живой y/n). Отказ можно обосновать: { deny: 'причина' } — причина
 * попадёт в историю агенту, и он сможет переформулировать запрос, а не тыкаться
 * наугад. Хост ничего не матчит и слов allow/deny не знает; карточка тула в
 * agents.json ("tools": {"git": {…}}) — это конфиг, который прилетает в make():
 * встроенные shell/ssh читают из неё свои списки, кастомный тул волен читать
 * что угодно своё.
 *
 * Хост даёт тулу мосты: ctx.run — полный конвейер shell-тула (с check и y/n),
 * ctx.http — запрос по сети, ctx.confirm — задать человеку вопрос.
 * Тул обязан быть честным с человеком: он может отказать и спросить,
 * но «разрешить молча» — тоже его ответственность, хозяин читает его код.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import type { Agent, AgentTools } from './types.js';
import type { ToolsConfig, ToolContext } from './actions.js';

/** Отказ с обоснованием: причина уходит агенту в отчёт «⚙ инструменты». */
export interface DenyVerdict {
  deny: string;
}

/** Простой 'deny' тоже законен — просто без объяснения причины. */
export type ToolVerdict = 'allow' | 'deny' | 'ask' | DenyVerdict;

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Что видно тулу в check() и run(): цель действия без мостов к хосту. */
export interface ToolCheckContext {
  /** Рабочая папка действия: проект из префикса, иначе папка агента/workspace */
  cwd: string;
  /** id проекта, если блок адресован проекту («shop:…») */
  project?: string;
  /** Аргумент строки блока: путь у file/look, цель хоста у ssh */
  arg?: string;
}

export interface ToolRunContext extends ToolCheckContext {
  /** Полный конвейер shell-тула: check → (спросить) → запуск в ctx.cwd */
  run(command: string): Promise<ToolResult>;
  /** HTTP-запрос: GET или POST JSON (если body задан); текст обрезан по лимиту */
  http(url: string, body?: unknown): Promise<ToolResult>;
  /** Живой вопрос человеку — тот же y/n, что у действий агентов */
  confirm(text: string): Promise<boolean>;
}

export interface Tool {
  /** Что это и как пользоваться — попадает в шпаргалку агента */
  desc: string;
  /** Единственная инстанция валидации: 'allow' | 'ask' | 'deny' | {deny: причина} */
  check(body: string, ctx?: ToolCheckContext): ToolVerdict;
  /** Действие; результат — строка, ошибка — throw Error */
  run(body: string, ctx: ToolRunContext): Promise<string>;
}

/** Карточка тула в agents.json: произвольный JSON-объект (config для make) */
export type ToolConfig = Record<string, unknown>;

export type ToolFactory = (config: ToolConfig) => Tool;

/** Встроенные тула: их имена нельзя занимать файлами в tools/ */
export const BUILTIN_TOOL_IDS = ['files', 'shell', 'ssh', 'look', 'image'] as const;

/** id тула: имя файла в tools/ или встроенный; строчные буквы/цифры/-/_ от 2 символов */
export const TOOL_ID_RE = /^[a-z][a-z0-9_-]{1,}$/;

// ─── Карточки агентов: объект {тул: {…карточка…}} ───────────────────────────

/**
 * Нормализует поле tools агента. Только объект-карточки: ключ — id тула,
 * значение — конфиг для make() (объект или null = пустые настройки).
 * Массивов больше нет: битая форма роняет загрузку с именем агента.
 */
export function normalizeAgentTools(agentId: string, tools: unknown): AgentTools | undefined {
  if (tools === undefined) return undefined;
  if (Array.isArray(tools)) {
    throw new Error(
      `агент «${agentId}»: tools — массивов больше нет, напишите карточки: {"files": {}, "shell": {}} (пустой объект или null — настройки по умолчанию)`,
    );
  }
  if (tools && typeof tools === 'object') {
    const cards: Record<string, ToolConfig> = {};
    for (const [id, v] of Object.entries(tools as Record<string, unknown>)) {
      if (!TOOL_ID_RE.test(id)) {
        throw new Error(`агент «${agentId}»: tools.${id} — неверный id тула (строчные буквы/цифры/-/_ от 2 символов)`);
      }
      if (v === null) {
        cards[id] = {};
        continue;
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`агент «${agentId}»: tools.${id} — ожидается объект-карточка или null`);
      }
      cards[id] = v as ToolConfig;
    }
    return Object.keys(cards).length > 0 ? cards : undefined;
  }
  throw new Error(`агент «${agentId}»: tools — объект {"тул": {…карточка…}} или null-настройки`);
}

export function agentToolIds(agent: Agent): string[] {
  return agent.tools ? Object.keys(agent.tools) : [];
}

/** Карточка тула агента — то, что уходит в make(); без карточки — {}. */
export function agentToolConfig(agent: Agent, id: string): ToolConfig {
  const card = agent.tools?.[id];
  return card && typeof card === 'object' ? (card as ToolConfig) : {};
}

// ─── Kit для командных тулов (shell, ssh; можно импортировать и в свои) ─────

/** Списки из карточки: {"allow": ["git *"], "deny": ["git push"]} */
export interface CommandRules {
  allow?: string[];
  deny?: string[];
}

/** Подстановки и перенаправления: в таком теле первые слова больше не описывают происходящее. */
export const SUBST = /[$()<>`]/;

const toks = (s: string): string[] => s.trim().split(/\s+/);

/** Правило — префикс слов тела (целые слова); «*» последним словом — явный хвост «что угодно». */
function patternMatches(pattern: string, seg: string): boolean {
  const p = toks(pattern);
  if (p.at(-1) === '*') p.pop();
  return p.length > 0 && p.length <= toks(seg).length && p.every((w, i) => w === toks(seg)[i]);
}

/** Цепочку команд режем на сегменты: «a && b», «a; b», «a | b» — самостоятельные команды. */
export function splitChain(body: string): string[] {
  return body
    .split(/&&|\|\||[;|&\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Читает allow/deny из карточки и проверяет их: массивы непустых строк,
 * «*» только последним словом, метасимволы и цепочки в правилах запрещены —
 * такие правила всё равно никогда бы не сработали, пусть конфиг сразу падает
 * с внятной ошибкой, а не молча не работает.
 */
export function parseCommandRules(config: ToolConfig, toolId: string): CommandRules {
  const read = (key: 'allow' | 'deny'): string[] | undefined => {
    const v = config[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`карточка тула ${toolId}: "${key}" — массив непустых строк`);
    }
    for (const raw of v as string[]) {
      const p = toks(raw);
      if (p.some((w, i) => w.includes('*') && (i !== p.length - 1 || w !== '*'))) {
        throw new Error(`карточка тула ${toolId}: "${key}": «${raw}» — «*» допустима только последним словом правила`);
      }
      if (p.some((w) => SUBST.test(w) || /[;&|]/.test(w))) {
        throw new Error(`карточка тула ${toolId}: "${key}": «${raw}» — метасимволы и цепочки в правилах не нужны: правило это первые слова команды`);
      }
    }
    return (v as string[]).length > 0 ? (v as string[]) : undefined;
  };
  return { allow: read('allow'), deny: read('deny') };
}

/**
 * Матч по телу команды: deny — по сегментам цепочки (запрещённое не пройдёт
 * и внутри «echo ok && git push»); allow — только на чистом теле, где каждый
 * сегмент разрешён («npm run build && npm run test» течёт молча); всё
 * остальное — ask: вопрос человеку. Отказ возвращается с обоснованием:
 * агенту полезно знать, какое правило его остановило.
 */
export function commandCheck(rules: CommandRules, body: string): ToolVerdict {
  const segs = splitChain(body);
  for (const seg of segs) {
    const hit = rules.deny?.find((p) => patternMatches(p, seg));
    if (hit) return { deny: `команда «${seg}» запрещена правилом «${hit}»` };
  }
  if (segs.length > 0 && !SUBST.test(body) && rules.allow?.length) {
    if (segs.every((seg) => rules.allow!.some((p) => patternMatches(p, seg)))) return 'allow';
  }
  return 'ask';
}

// ─── Дефолтная политика командных тулов (shell, ssh) ────────────────────────

/** Read-only подкоманды git — общий набор для тула git и для shell (git …). */
export const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse',
  'reflog', 'grep', 'cat-file', 'diff-tree', 'merge-base', 'ls-files',
  'branch', 'tag', 'help', 'version',
]);

/** Строка команды → аргументы: пробелы вне кавычек — границы, кавычки снимаются. */
export function splitArgs(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Ключи и пароли читать/показывать нельзя — даже внутри рабочей папки. */
const SENSITIVE = /(^|[\\/])(\.env|\.netrc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa)([.\w-]*)$|\.(pem|key|p12|pfx)$/i;

/**
 * Скан аргументов сегмента на пути: секреты и выход за рабочую папку —
 * причина для deny. cwd задан — пути сверяются с папкой честно (resolve);
 * не задан (ssh: папка на чужой машине) — только синтаксика: абсолютный путь,
 * «..» и «~» считаются выходом, относительные — своим.
 */
export function pathScan(segment: string, cwd: string | undefined): string | null {
  for (const a of splitArgs(segment).slice(1)) {
    if (a.startsWith('-')) continue; // флаги — не пути
    if (!(a === '.' || a === '..' || a.startsWith('~') || a.startsWith('.') || a.includes('/') || a.includes('\\'))) continue;
    if (SENSITIVE.test(a)) return `«${a}» похоже на секретный файл — читать и показывать его нельзя`;
    if (a.startsWith('~')) return `«${a}» — домашняя папка, работа только внутри рабочей`;
    if (cwd) {
      const rel = relative(cwd, resolve(cwd, a));
      const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      if (!inside) return `путь «${a}» вне рабочей папки «${cwd}» — работа только внутри неё`;
    } else if (a === '..' || a.startsWith('../') || a.startsWith('..\\') || /^[\\/]|[a-zA-Z]:/.test(a)) {
      return `путь «${a}» вне рабочей папки — работа только внутри неё`;
    }
  }
  return null;
}

/**
 * Дефолтная политика без правил в карточке: сегменты цепочки с безопасными
 * первыми словами текут молча, всё остальное — вопрос человеку; пути при этом
 * сканируются всегда, и выход за рабочую папку — не вопрос, а отказ
 * с обоснованием (deny). nested — команда, чьё второе слово сверяется со своим
 * набором (git в shell, systemctl в ssh); bareOnly — подкоманды, безопасные
 * только без аргументов.
 */
export function defaultCommandCheck(
  body: string,
  policy: {
    safe: ReadonlySet<string>;
    nested?: { command: string; readonlySet: ReadonlySet<string>; bareOnly?: string[] };
    cwd?: string;
    askIf?: RegExp;
  },
): ToolVerdict {
  const segs = splitChain(body);
  if (segs.length === 0 || SUBST.test(body)) return 'ask';
  for (const seg of segs) {
    const words = splitArgs(seg);
    const first = words[0] ?? '';
    if (policy.nested && first === policy.nested.command) {
      const rest = words.slice(1);
      const sub = rest[0] ?? '';
      if (sub && !policy.nested.readonlySet.has(sub)) return 'ask';
      if (sub && policy.nested.bareOnly?.includes(sub) && rest.length > 1) return 'ask';
    } else if (!policy.safe.has(first)) {
      return 'ask';
    }
    if (policy.askIf?.test(seg)) return 'ask';
    const bad = pathScan(seg, policy.cwd);
    if (bad) return { deny: bad };
  }
  return 'allow';
}

// ─── Встроенные тула: мосты и строгая карточка ──────────────────────────────

/** Всё, что встроенному тулу нужно на run: конвейер собирает это перед раундом. */
export interface BuiltinDeps {
  cfg: ToolsConfig;
  agent: Agent;
  tctx: ToolContext;
  signal?: AbortSignal;
}

/** Фабрика встроенного тула: карточка агента + мосты к коду исполнения. */
export type BuiltinFactory = (config: ToolConfig, deps?: BuiltinDeps) => Tool;

/**
 * Строгая карточка встроенного тула: поля вне разрешённых — fail-fast ошибка.
 * Опечатка («allowd» вместо «allow») не должна молча делать вид, что всё
 * хорошо: правило просто не сработало бы.
 */
export function checkCardKeys(config: ToolConfig, toolId: string, ...permitted: string[]): void {
  const extra = Object.keys(config).filter((k) => !permitted.includes(k));
  if (extra.length === 0) return;
  const allowed =
    permitted.length > 0
      ? `разрешены только: ${permitted.map((k) => `"${k}"`).join(', ')}`
      : 'у тула настроек нет — пустой объект или null';
  throw new Error(
    `карточка тула ${toolId}: неизвестные поля ${extra.map((k) => `"${k}"`).join(', ')} — ${allowed}`,
  );
}
