/**
 * Тул «look»: показать файл своей vision-модели (```look путь, тело — вопрос).
 * check(): всегда allow — чтение своей картинки ничего не меняет; вопрос
 * человеку не нужен. Провайдер зрения берётся из мостов (deps.tctx).
 */
import { executeLookAction } from '../../actions.js';
import { checkCardKeys, resolveCard } from '../../tools-api.js';
import type { BuiltinDeps, Tool, ToolConfig } from '../../tools-api.js';

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(resolveCard('look', config), 'look');
  return {
    desc: 'Показать файл своей vision-модели (```look путь, тело — вопрос по картинке).',
    check: () => 'allow',
    async run(body, ctx) {
      if (!deps) throw new Error('тул look собран без конвейера — это внутренняя ошибка');
      const r = await executeLookAction(
        { kind: 'look', path: ctx.arg ?? '', question: body, project: ctx.project },
        deps.cfg,
        deps.agent,
        deps.tctx,
        deps.signal,
      );
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
