/**
 * Тул «files»: запись файлов в рабочую папку (```file путь, тело — содержимое).
 * check(): путь внутри рабочей папки действия — allow, иначе вопрос человеку.
 * Карточки у тула нет: настройка — какие проекты назначены агенту.
 */
import { executeFileAction, safePath } from '../actions.js';
import { checkCardKeys } from '../tools-api.js';
import type { BuiltinDeps, Tool, ToolCheckContext, ToolConfig } from '../tools-api.js';

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'files');
  return {
    desc: 'Запись файлов в рабочую папку (```file путь, тело — полное содержимое файла). Внутри папки пишется молча.',
    check(path: string, ctx?: ToolCheckContext) {
      const inside = ctx ? safePath(ctx.cwd, path) !== null : false;
      return inside ? 'allow' : 'ask';
    },
    async run(body, ctx) {
      if (!deps) throw new Error('тул files собран без конвейера — это внутренняя ошибка');
      const r = executeFileAction(
        { kind: 'file', path: ctx.arg ?? '', content: body, project: ctx.project },
        deps.cfg,
        deps.agent,
      );
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
