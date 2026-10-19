/**
 * Тул «shell»: команды оболочки этого ПК (```run, тело — команда).
 *
 * check() — два режима:
 *  - правила карточки (allow/deny) заданы — работает commandCheck, дефолт
 *    вытесняется целиком;
 *  - карточка пуста — дефолтная политика: read-only команды (ls, cat, git
 *    status…) текут молча, но ТОЛЬКО внутри рабочей папки: путь за её
 *    пределами или похожий на секрет — отказ с обоснованием (deny), не вопрос.
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

/** Безопасные команды: только читают (у find мутации ловит отдельный фильтр). */
const SHELL_SAFE = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'find', 'tree', 'wc', 'file',
  'stat', 'du', 'df', 'which', 'whoami', 'hostname', 'date', 'echo', 'printf',
]);

/** find умеет удалять и запускать — такие флаги мимо дефолта. */
const FIND_MUTATIONS = /-(delete|exec|execdir|ok|okdir)\b/;

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'shell', 'allow', 'deny');
  const hasRules = config.allow !== undefined || config.deny !== undefined;
  const rules = hasRules ? parseCommandRules(config, 'shell') : undefined;
  return {
    desc:
      'Команды оболочки этого ПК (```run). Read-only (ls, cat, grep, git status…) — ' +
      'молча, но только внутри рабочей папки (выход и секреты — отказ); ' +
      'остальное — по правилам карточки shell или вопрос человеку.',
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
