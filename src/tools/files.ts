/**
 * Тул «files»: запись файлов в рабочую папку (```file путь, тело — содержимое).
 * check(): путь внутри рабочей папки действия — allow, иначе вопрос человеку;
 * служебная папка .dreamteam и маски из карточки ("masks", синтаксис gitignore)
 * — отказ с обоснованием: слои поверх рамки рабочей папки.
 */
import { relative } from 'node:path';
import { executeFileAction, safePath } from '../actions.js';
import { checkCardKeys, maskDeny, parseMasks, protectedPath } from '../tools-api.js';
import type { BuiltinDeps, Tool, ToolCheckContext, ToolConfig } from '../tools-api.js';

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'files', 'masks');
  const masks = parseMasks(config, 'files');
  return {
    desc: 'Запись файлов в рабочую папку (```file путь, тело — полное содержимое файла). Внутри папки пишется молча.',
    check(path: string, ctx?: ToolCheckContext) {
      const target = ctx ? safePath(ctx.cwd, path) : null;
      if (!target) return 'ask';
      const rel = relative(ctx!.cwd, target);
      const prot = protectedPath(rel);
      if (prot) return { deny: prot };
      const masked = maskDeny(masks, rel);
      return masked ? { deny: masked } : 'allow';
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
