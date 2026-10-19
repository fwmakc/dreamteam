/**
 * Тул «image»: генерация изображений image-моделью (```image, параметры
 * строками «prompt: …», «size: …» и т.д.). check(): всегда allow — генерация
 * пишет только в папку images/ и проверяется глазами через look; протокол
 * «эскизы → одобрение босса» — в промптах художников.
 */
import { executeImageAction, parseImageParams } from '../actions.js';
import { checkCardKeys } from '../tools-api.js';
import type { BuiltinDeps, Tool, ToolConfig } from '../tools-api.js';

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'image');
  return {
    desc: 'Генерация изображений image-моделью (```image, параметры строками «prompt: …», «size: …» и т.д.).',
    check: () => 'allow',
    async run(body, ctx) {
      if (!deps) throw new Error('тул image собран без конвейера — это внутренняя ошибка');
      const r = await executeImageAction(
        { kind: 'image', params: parseImageParams(body), project: ctx.project },
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
