/**
 * Тул «shell»: команды оболочки этого ПК (```run, тело — команда).
 * check(): commandCheck по allow/deny из карточки тула (см. tools-api);
 * пустая карточка — спрашивается каждая команда.
 */
import { executeRunAction } from '../actions.js';
import { checkCardKeys, commandCheck, parseCommandRules } from '../tools-api.js';
import type { BuiltinDeps, Tool, ToolConfig } from '../tools-api.js';

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'shell', 'allow', 'deny');
  const rules = parseCommandRules(config, 'shell');
  return {
    desc:
      'Команды оболочки этого ПК (```run). Тело — команда; что разрешено молча, задано в карточке тула shell (allow/deny в agents.json).',
    check: (body) => commandCheck(rules, body),
    async run(body, ctx) {
      if (!deps) throw new Error('тул shell собран без конвейера — это внутренняя ошибка');
      const r = await executeRunAction({ kind: 'run', command: body, project: ctx.project }, deps.cfg, deps.signal, deps.agent);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
