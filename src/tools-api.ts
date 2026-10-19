/**
 * Контракт тула и карманный SDK для авторов tools/*.ts.
 *
 * Тул — фабрика make(config) → Tool: desc (что это и как пользоваться),
 * check(body) и run(body, ctx). Валидация в приложении ровно одна — check()
 * самого тула: 'allow' — выполнить молча, 'deny' — отказ, 'ask' — спросить
 * человека (живой y/n). Хост ничего не матчит и слов allow/deny не знает;
 * карточка тула в agents.json ("tools": {"git": {…}}) — это конфиг, который
 * прилетает в make(): встроенные shell/ssh читают из неё свои списки,
 * кастомный тул волен читать что угодно своё.
 *
 * Хост даёт тулу мосты: ctx.run — полный конвейер shell-тула (с check и y/n),
 * ctx.http — запрос по сети, ctx.confirm — задать человеку вопрос.
 * Тул обязан быть честным с человеком: он может отказать и спросить,
 * но «разрешить молча» — тоже его ответственность, хозяин читает его код.
 */

import type { Agent, AgentTools } from './types.js';

export type ToolVerdict = 'allow' | 'deny' | 'ask';

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
  /** Единственная инстанция валидации: 'allow' | 'deny' | 'ask' */
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
const SUBST = /[$()<>`]/;

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
 * остальное — ask: вопрос человеку.
 */
export function commandCheck(rules: CommandRules, body: string): ToolVerdict {
  const segs = splitChain(body);
  for (const seg of segs) {
    if (rules.deny?.some((p) => patternMatches(p, seg))) return 'deny';
  }
  if (segs.length > 0 && !SUBST.test(body) && rules.allow?.length) {
    if (segs.every((seg) => rules.allow!.some((p) => patternMatches(p, seg)))) return 'allow';
  }
  return 'ask';
}
