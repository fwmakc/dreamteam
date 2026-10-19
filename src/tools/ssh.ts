/**
 * Тул «ssh»: команды на серверах проектов (```ssh цель, тело — команда).
 * Цель — «проект:хост» (приходит через ctx.arg).
 *
 * check() — два режима: правила карточки (allow/deny) или дефолт — read-only
 * команды (uptime, df, systemctl status…) молча, остальное — вопрос. Рабочей
 * папки на чужой машине у нас нет, поэтому путь сверяется синтаксически:
 * относительный — «свой», а абсолютный, «..» и «~» — выход за домашнюю папку,
 * отказ с обоснованием (deny); секреты (.env, ключи) — отказ всегда.
 */
import { executeSshAction } from '../actions.js';
import { checkCardKeys, commandCheck, defaultCommandCheck, parseCommandRules } from '../tools-api.js';
import type { BuiltinDeps, Tool, ToolConfig } from '../tools-api.js';

/** Безопасные команды на сервере: только читают. */
const SSH_SAFE = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'ps', 'df', 'du', 'free',
  'uptime', 'whoami', 'hostname', 'uname', 'id', 'date', 'which', 'journalctl',
]);

/** systemctl только спрашивающие подкоманды — управляющие мимо дефолта. */
const SYSTEMCTL_READONLY = new Set([
  'status', 'is-active', 'is-enabled', 'is-failed', 'list-units',
  'list-unit-files', 'list-timers', 'show', 'cat',
]);

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'ssh', 'allow', 'deny');
  const hasRules = config.allow !== undefined || config.deny !== undefined;
  const rules = hasRules ? parseCommandRules(config, 'ssh') : undefined;
  return {
    desc:
      'Команды на серверах по ssh (```ssh цель). Цель — «проект:хост»; тело — команда для сервера. ' +
      'Read-only (uptime, df, systemctl status…) — молча, абсолютные пути и «..» — отказ; ' +
      'остальное — по правилам карточки ssh или вопрос человеку.',
    check: (body) =>
      rules
        ? commandCheck(rules, body)
        : defaultCommandCheck(body, {
            safe: SSH_SAFE,
            nested: { command: 'systemctl', readonlySet: SYSTEMCTL_READONLY },
          }),
    async run(body, ctx) {
      if (!deps) throw new Error('тул ssh собран без конвейера — это внутренняя ошибка');
      const r = await executeSshAction({ kind: 'ssh', host: ctx.arg ?? '', command: body }, deps.cfg, deps.signal);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
