/**
 * Тул «git»: работа с репозиторием без шелла (блок ```git [проект:]команда).
 *
 * check() — единственное место валидации, два режима:
 *  - правила карточки (allow/deny) заданы — работает commandCheck: та же
 *    механика, что у shell (deny бьёт любую часть цепочки, allow — целыми
 *    словами и без подстановок), дефолтная политика вытесняется;
 *  - карточка пуста — встроенная политика: read-only команды (status, log,
 *    diff, show, blame…) текут молча, всё изменяющее (commit, push, reset…)
 *    и любые подстановки — вопрос человеку.
 *
 * run() запускает настоящий git: spawn с массивом аргументов (без cmd.exe —
 * инъекции исключены), таймаут и обрезка вывода из карточки. Репозиторий —
 * рабочая папка действия (префикс проекта в строке блока) или card.repo.
 *
 * Карточка: repo (путь, иначе cwd действия), allow/deny (правила команд),
 * timeoutMs (по умолчанию 120000), maxOutput (символов, по умолчанию 4000).
 * Другие поля — ошибка: опечатка не должна молча не работать.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkCardKeys,
  commandCheck,
  parseCommandRules,
  splitChain,
  SUBST,
  type Tool,
  type ToolConfig,
  type ToolRunContext,
} from '../src/tools-api.js';

/** Read-only подкоманды: первое слово каждого сегмента сверяем с этим набором. */
const READONLY = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse',
  'reflog', 'grep', 'cat-file', 'diff-tree', 'merge-base', 'ls-files',
  'branch', 'tag', 'help', 'version',
]);

/** Дефолтная политика без карточки: каждая команда цепочки должна быть read-only. */
function defaultCheck(body: string): 'allow' | 'deny' | 'ask' {
  const segs = splitChain(body);
  if (segs.length === 0 || SUBST.test(body)) return 'ask';
  for (const seg of segs) {
    const words = seg.split(/\s+/);
    // «branch»/«tag» без аргументов — просто список; с аргументами уже мутация
    if ((words[0] === 'branch' || words[0] === 'tag') && words.length > 1) return 'ask';
    if (!READONLY.has(words[0]!)) return 'ask';
  }
  return 'allow';
}

/** Строка команды → аргументы spawn: пробелы вне кавычек — границы. */
function argify(command: string): string[] {
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

function execGit(gitArgs: string[], cwd: string, timeoutMs: number, maxOutput: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', gitArgs, { cwd, shell: false });
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        reject(new Error(`git ${gitArgs[0]}: таймаут ${timeoutMs} мс — процесс прерван`));
      }
    }, timeoutMs);
    const take = (chunk: Buffer) => {
      if (out.length < maxOutput) out += chunk.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`git не запустился: ${err.message}`));
      }
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const trimmed = out.length > maxOutput ? `${out.slice(0, maxOutput)}\n…(обрезано)` : out;
      if (code === 0) resolvePromise(trimmed.trim());
      else reject(new Error(`git ${gitArgs[0]}: код выхода ${code}\n${trimmed.trim() || '(вывода нет)'}`));
    });
  });
}

export default (config: ToolConfig, _deps?: unknown): Tool => {
  checkCardKeys(config, 'git', 'repo', 'allow', 'deny', 'timeoutMs', 'maxOutput');
  const hasRules = config.allow !== undefined || config.deny !== undefined;
  const rules = hasRules ? parseCommandRules(config, 'git') : undefined;
  const timeoutMs =
    config.timeoutMs === undefined ? 120000 : Number(config.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('карточка тула git: "timeoutMs" — положительное число миллисекунд');
  }
  const maxOutput = config.maxOutput === undefined ? 4000 : Number(config.maxOutput);
  if (!Number.isInteger(maxOutput) || maxOutput <= 0) {
    throw new Error('карточка тула git: "maxOutput" — положительное целое число символов');
  }
  const repo =
    config.repo === undefined
      ? undefined
      : resolve(String(config.repo));
  if (repo !== undefined && !existsSync(repo)) {
    throw new Error(`карточка тула git: "repo" «${String(config.repo)}» — папки нет`);
  }
  const desc =
    'Git в репозитории (```git [проект:]команда, тело или строка блока — подкоманда). ' +
    (repo
      ? `Репозиторий закреплён карточкой: ${repo}.`
      : 'Репозиторий — рабочая папка действия (префикс проекта в строке блока).') +
    ' Read-only (status, log, diff…) — молча; изменяющее — по правилам карточки или вопрос.';
  return {
    desc,
    // тело блока многострочно («log\n--oneline -5»): в git это одна команда,
    // а не цепочка — нормализуем так же, как в run()
    check: (body) => {
      const command = body.replace(/\s*\n\s*/g, ' ').trim();
      return rules ? commandCheck(rules, command) : defaultCheck(command);
    },
    async run(body, ctx: ToolRunContext) {
      const where = repo ?? ctx.cwd;
      // многострочное тело («log\n--oneline -5») — одна команда: переводы — пробелы
      const command = body.trim().replace(/\s*\n\s*/g, ' ');
      const gitArgs = argify(command);
      if (gitArgs.length === 0) throw new Error('пустая команда git');
      return execGit(gitArgs, where, timeoutMs, maxOutput);
    },
  };
};
