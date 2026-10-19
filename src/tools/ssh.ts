/**
 * Тул «ssh»: команды на серверах проектов (```ssh цель, тело — команда).
 * Цель — «проект:хост» (приходит через ctx.arg). check(): commandCheck
 * по allow/deny из карточки тула — те же правила, что у shell.
 */
import { executeSshAction } from '../actions.js';
import { checkCardKeys, commandCheck, parseCommandRules } from '../tools-api.js';
import type { BuiltinDeps, Tool, ToolConfig } from '../tools-api.js';

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'ssh', 'allow', 'deny');
  const rules = parseCommandRules(config, 'ssh');
  return {
    desc:
      'Команды на серверах по ssh (```ssh цель). Цель — «проект:хост»; тело — команда для сервера. Списки allow/deny — в карточке тула ssh.',
    check: (body) => commandCheck(rules, body),
    async run(body, ctx) {
      if (!deps) throw new Error('тул ssh собран без конвейера — это внутренняя ошибка');
      const r = await executeSshAction({ kind: 'ssh', host: ctx.arg ?? '', command: body }, deps.cfg, deps.signal);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
