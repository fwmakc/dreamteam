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

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isToolId } from './ids.js';
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
  /** Папка проекта в доме (projects/<id>/) или null. Прикладное проекта —
   *  подпапки PROJECT_SUBDIRS (inbox, mail, images) — живёт в ней. */
  projectHome: string | null;
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
  /** Абсолютный путь в рабочей папке действия; наружу рамка не пускает. */
  workspaceFile(rel: string): string;
  /** Абсолютный путь в папке проекта в доме (projects/<id>/<rel>); нет
   *  открытого проекта — ошибка. Родительские папки сам не создаёт. */
  projectFile(rel: string): string;
}

/**
 * Прикладные подпапки проекта — фиксированные имена, на которые тула могут
 * опираться: «inbox/…» — файлы от человека (скрепка в GUI), «mail/…» —
 * вложения писем, «images/…» — нарисованные картинки. Живут в папке проекта
 * в доме; рабочая папка остаётся только файлами работы.
 */
export const PROJECT_SUBDIRS = ['inbox', 'mail', 'images'] as const;

/** Путь (уже абсолютный) лежит в прикладной подпапке проекта — не в project.json и не в sessions/. */
export function inProjectStore(projectHome: string | null | undefined, abs: string): boolean {
  if (!projectHome) return false;
  const rel = relative(projectHome, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const first = rel.replaceAll('\\', '/').split('/')[0]!;
  return (PROJECT_SUBDIRS as readonly string[]).includes(first);
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
export const BUILTIN_TOOL_IDS = ['files', 'shell', 'git', 'arch', 'ssh', 'look', 'image', 'docs', 'ocr', 'web', 'mail', 'telegram', 'max'] as const;

/** id тула: имя файла в tools/ или встроенный — маска в src/ids.ts. */

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
      if (!isToolId(id)) {
        throw new Error(`агент «${agentId}»: tools.${id} — неверный id тула (строчные буквы/цифры/./-/_ от 2 символов)`);
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

/** Подстановки и перенаправления: в таком теле первые слова больше не описывают происходящее.
 *  % — раскрытие переменных cmd.exe (иначе `echo %TOKEN%` слил бы секрет молча). */
export const SUBST = /[$()<>`%]/;

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

/**
 * Обязательный дефолтный конфиг встроенного тула: src/tools/<id>/default.json
 * рядом с кодом тула. Единственное место, где живут правила «что текёт
 * молча» и заводские настройки: файл открытый, его можно прочитать и
 * обсудить, а не копаться в коде. Фабрика тула валидирует его теми же
 * проверками, что и карточки агентов; нет файла или кривой JSON — ошибка
 * при сборке тула, а не молча другая политика. Результат кэшируется.
 */
const defaultsCache = new Map<string, ToolConfig>();

export function toolDefaults(toolId: string): ToolConfig {
  const cached = defaultsCache.get(toolId);
  if (cached) return cached;
  const file = fileURLToPath(new URL(`./tools/${toolId}/default.json`, import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`у встроенного тула «${toolId}» нет обязательного дефолтного конфига: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} — кривой JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} — ожидается объект (карточка по умолчанию)`);
  }
  defaultsCache.set(toolId, parsed as ToolConfig);
  return parsed as ToolConfig;
}

/**
 * Карточка тула для фабрики: что задал агент — то и работает (заменяет
 * дефолт целиком); пустая карточка (null/{}) — дефолт из default.json.
 */
export function resolveCard(toolId: string, config: ToolConfig): ToolConfig {
  return config && Object.keys(config).length > 0 ? config : toolDefaults(toolId);
}

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

/** Ключи и пароли читать/показывать нельзя — даже внутри рабочей папки.
 *  Экспортирован: тулу arch те же запреты нужны при упаковке/распаковке. */
export const SENSITIVE = /(^|[\\/])(\.env|\.netrc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa)([.\w-]*)$|\.(pem|key|p12|pfx)$/i;

/**
 * Служебная папка приложения внутри проекта: конфиги команды, серверов, памяти
 * и код тулов. Тулам она не доступна ни на чтение, ни на запись — иначе агент
 * смог бы переписать свои own права и настройки. rel — путь относительно
 * рабочей папки; возвращает причину отказа или null.
 */
export function protectedPath(rel: string): string | null {
  const norm = rel.replaceAll('\\', '/');
  if (norm === '.dreamteam' || norm.startsWith('.dreamteam/')) {
    return `«${rel}» — служебная папка .dreamteam (конфиги и тула приложения), тулам не доступна`;
  }
  return null;
}

/**
 * Скан аргументов сегмента на пути: секреты, служебная папка .dreamteam и
 * выход за рабочую папку — причина для deny. cwd задан — пути сверяются
 * с папкой честно (resolve); не задан (ssh: папка на чужой машине) — только
 * синтаксика: абсолютный путь, «..» и «~» считаются выходом, относительные —
 * своим.
 */
export function pathScan(segment: string, cwd: string | undefined, projectHome?: string | null): string | null {
  for (const a of splitArgs(segment).slice(1)) {
    if (a.startsWith('-')) continue; // флаги — не пути
    if (!(a === '.' || a === '..' || a.startsWith('~') || a.startsWith('.') || a.includes('/') || a.includes('\\'))) continue;
    if (SENSITIVE.test(a)) return `«${a}» похоже на секретный файл — читать и показывать его нельзя`;
    if (a.startsWith('~')) return `«${a}» — домашняя папка, работа только внутри рабочей`;
    if (a === '.dreamteam' || a.startsWith('.dreamteam/') || a.startsWith('.dreamteam\\')) {
      return protectedPath(a);
    }
    if (cwd) {
      const abs = resolve(cwd, a);
      const rel = relative(cwd, abs);
      const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      // прикладные подпапки проекта в доме (inbox, mail, images) — свои файлы,
      // не секреты: из shell их можно прочитать и переписать в рабочую папку
      if (!inside && !inProjectStore(projectHome, abs)) {
        return `путь «${a}» вне рабочей папки «${cwd}» — работа только внутри неё`;
      }
      const prot = protectedPath(rel);
      if (prot) return prot;
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
    /** Папка проекта в доме: прикладные подпапки (inbox, mail, images) shell разрешает */
    projectHome?: string | null;
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
    const bad = pathScan(seg, policy.cwd, policy.projectHome);
    if (bad) return { deny: bad };
  }
  return 'allow';
}

// ─── Маски файлов в духе gitignore ──────────────────────────────────────────

/**
 * Читает маски из карточки ("masks"): массив непустых строк. Маска без «!» —
 * запрет, с «!» — разрешение; последняя совпавшая решает, не совпало ничего —
 * можно. Так выражаются и «всё, кроме…» («*», «!*.pem»), и «только…»
 * («*», «!src/**»).
 */
export function parseMasks(config: ToolConfig, toolId: string): string[] | undefined {
  const v = config.masks;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || (v as unknown[]).some((s) => typeof s !== 'string' || !s.trim())) {
    throw new Error(`карточка тула ${toolId}: "masks" — массив непустых строк в духе gitignore («*.env», "!src/**")`);
  }
  return (v as string[]).length > 0 ? (v as string[]) : undefined;
}

/** Звёзды и «?» сегмента: '*' — любые символы внутри сегмента, '?' — один. */
function segWild(pat: string, s: string): boolean {
  const re = pat
    .split('*')
    .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').split('?').join('[^/]'))
    .join('[^/]*');
  return new RegExp(`^${re}$`).test(s);
}

/** '**' — любое число сегментов, остальные — по одному. */
function segMatchList(pat: string[], segs: string[]): boolean {
  if (pat.length === 0) return segs.length === 0;
  const [p, ...rest] = pat;
  if (p === '**') {
    for (let i = 0; i <= segs.length; i++) if (segMatchList(rest, segs.slice(i))) return true;
    return false;
  }
  return segs.length > 0 && segWild(p, segs[0]!) && segMatchList(rest, segs.slice(1));
}

/**
 * Совпала ли маска с путём: маска без слэша — по имени на любой глубине
 * (как в gitignore: «*.log» ловит и logs/x.log); якорная — по полному пути
 * или любому каталогу-предку (запрет каталога запирает и содержимое).
 */
function maskMatches(pattern: string, segs: string[]): boolean {
  let pat = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (pat.startsWith('/')) pat = pat.slice(1);
  if (pat.endsWith('/')) pat += '**';
  const parts = pat.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (!pattern.includes('/') && !pattern.includes('\\')) {
    return segs.some((s) => segWild(parts[0]!, s));
  }
  for (let k = 1; k <= segs.length; k++) {
    if (segMatchList(parts, segs.slice(0, k))) return true;
  }
  return false;
}

/**
 * Вердикт масок для пути: последняя совпавшая решает («!» — разрешение).
 * Возвращает причину отказа или null (можно); без масок — всегда null.
 */
export function maskDeny(masks: string[] | undefined, relPath: string): string | null {
  if (!masks?.length) return null;
  const segs = relPath.split(/[\\/]+/).filter((s) => s && s !== '.');
  let hit: string | null = null;
  for (const raw of masks) {
    const negated = raw.startsWith('!');
    const pat = (negated ? raw.slice(1) : raw).trim();
    if (pat && maskMatches(pat, segs)) hit = negated ? null : raw;
  }
  return hit ? `файл «${relPath}» под маской «${hit}»` : null;
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
