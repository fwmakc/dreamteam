/**
 * Тул «shell»: команды оболочки этого ПК (```run, тело — команда).
 *
 * Команды исполняются системным шеллом платформы: на Windows — cmd.exe,
 * на Linux/macOS — /bin/sh. Поэтому и белый список read-only, и подсказка
 * агенту — платформенные: на Windows bash-команды (ls, pwd, cat) физически
 * не существуют, а родные команды cmd (dir, type, findstr) — существуют.
 *
 * check() — два режима:
 *  - правила карточки (allow/deny) заданы — работает commandCheck: та же
 *    механика, что у git (deny бьёт любую часть цепочки, allow — целыми
 *    словами и без подстановок), дефолтная политика вытесняется целиком;
 *  - карточка пуста — дефолтная политика: read-only команды (ls, cat, git
 *    status… / dir, type, findstr…) текут молча, но ТОЛЬКО внутри рабочей
 *    папки: путь за её пределами или похожий на секрет — отказ с
 *    обоснованием (deny), не вопрос.
 *
 * run() исполняет команду через системный шелл, таймаут и обрезка вывода —
 * из настроек. Рабочая папка — папка действия (текущая папка проекта).
 */
import { executeRunAction } from '../actions.js';
import {
  checkCardKeys,
  commandCheck,
  defaultCommandCheck,
  GIT_READONLY_SUBCOMMANDS,
  parseCommandRules,
} from '../tools-api.js';
import type { BuiltinDeps, Tool, ToolConfig } from '../tools-api.js';

/** Read-only команды Unix-шелла: только читают (у find мутации ловит отдельный фильтр). */
const SHELL_SAFE_UNIX = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'find', 'tree', 'wc', 'file',
  'stat', 'du', 'df', 'which', 'whoami', 'hostname', 'date', 'echo', 'printf',
]);

/**
 * Read-only команды cmd.exe на Windows — аналоги POSIX-набора.
 * Без date: голая `date` в cmd ждёт ввод с stdin и виснет до таймаута.
 * cd оставлен: голая `cd` печатает папку (аналог pwd); `cd куда-то` —
 * только внутри одного блока, сквозной смены папки не существует.
 */
const SHELL_SAFE_WIN32 = new Set([
  'cd', 'dir', 'type', 'findstr', 'find', 'where', 'tree', 'echo',
  'hostname', 'whoami',
]);

const SHELL_SAFE = process.platform === 'win32' ? SHELL_SAFE_WIN32 : SHELL_SAFE_UNIX;

/** find умеет удалять и запускать — такие флаги мимо дефолта. */
const FIND_MUTATIONS = /-(delete|exec|execdir|ok|okdir)\b/;

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'shell', 'allow', 'deny');
  const hasRules = config.allow !== undefined || config.deny !== undefined;
  const rules = hasRules ? parseCommandRules(config, 'shell') : undefined;
  const isWin = process.platform === 'win32';
  const desc = isWin
    ? 'Команды cmd.exe этого ПК (```run, тело — команда). Это Windows: bash-команды ' +
      '(ls, pwd, cat, grep) недоступны — используй dir, type, findstr, tree, where, ' +
      'а для git — отдельный тул git. Read-only — молча, но только внутри рабочей ' +
      'папки (выход, секреты и подстановки %переменные% — отказ); ' +
      'остальное — по правилам карточки shell или вопрос человеку.'
    : 'Команды оболочки этого ПК (```run). Read-only (ls, cat, grep, git status…) — ' +
      'молча, но только внутри рабочей папки (выход и секреты — отказ); ' +
      'остальное — по правилам карточки shell или вопрос человеку.';
  return {
    desc,
    check: (body, ctx) =>
      rules
        ? commandCheck(rules, body)
        : defaultCommandCheck(body, {
            safe: SHELL_SAFE,
            nested: { command: 'git', readonlySet: GIT_READONLY_SUBCOMMANDS, bareOnly: ['branch', 'tag'] },
            cwd: ctx?.cwd,
            askIf: FIND_MUTATIONS,
          }),
    async run(body, ctx) {
      if (!deps) throw new Error('тул shell собран без конвейера — это внутренняя ошибка');
      const r = await executeRunAction({ kind: 'run', command: body, project: ctx.project }, deps.cfg, deps.signal, deps.agent);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
