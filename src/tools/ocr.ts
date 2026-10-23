/**
 * Тул «ocr»: распознавание текста и таблиц с картинок (```ocr подкоманда).
 *
 *   text <файл> [страницы]   — текст: png/jpg/bmp/webp, pdf (страницы «2», «1-3»,
 *                              «all» — по умолчанию все), docx (картинки word/media);
 *   tables <файл> [csv] [страницы] — таблицы: восстановление по координатам
 *                              слов → markdown (второе слово «csv» — CSV).
 *
 * Языки — карточка "lang" (по умолчанию rus+eng), офлайн-данные — "langPath",
 * плотность рендера pdf — "dpi" (72…600, по умолчанию 200). Языковые данные
 * tesseract при первом запуске качаются в ~/.dreamteam/cache/tesseract — дальше
 * работают без сети. Файлы только внутри рабочей папки (safePath), поэтому
 * check() как у docs — всегда 'allow'.
 */
import { safePath } from '../actions.js';
import {
  collectImages,
  linesToRows,
  recognizeImages,
  rowsToMarkdown,
  wordsToLines,
} from '../ocr.js';
import { rowsToCsv } from '../documents.js';
import { checkCardKeys, splitArgs, type Tool, type ToolConfig, type ToolRunContext } from '../tools-api.js';

/** Разбор заголовка блока: подкоманда + аргументы. */
function parseHead(body: string): { sub: string; rest: string[] } {
  const nl = body.indexOf('\n');
  const head = nl === -1 ? body : body.slice(0, nl);
  return { sub: head.split(/\s+/)[0] ?? '', rest: splitArgs(head).slice(1) };
}

function syntax(): string {
  return 'подкоманды: text <файл> [страницы] · tables <файл> [csv] [страницы] — файлы png/jpg/bmp/webp, pdf, docx';
}

/** Путь внутри рабочей папки; наружу — отказ. */
function localPath(cwd: string, rel: string): string {
  if (!rel) throw new Error('укажите файл');
  const abs = safePath(cwd, rel);
  if (!abs) throw new Error(`«${rel}» — выход за рабочую папку`);
  return abs;
}

export default (config: ToolConfig): Tool => {
  checkCardKeys(config, 'ocr', 'lang', 'langPath', 'dpi');
  const lang = typeof config.lang === 'string' && config.lang.trim() ? config.lang.trim() : undefined;
  const langPath = typeof config.langPath === 'string' && config.langPath.trim() ? config.langPath.trim() : undefined;
  const dpi = typeof config.dpi === 'number' ? config.dpi : undefined;

  const recognize = async (file: string, pages?: string) =>
    recognizeImages(await collectImages(file, { dpi, pages }), { lang, langPath });

  return {
    desc:
      'OCR — распознавание текста и таблиц со сканов: ```ocr text скан.png · text скан.pdf 1-3 · ' +
      'text сканы.docx (картинки из документа) · tables скан.jpg (таблицы → markdown, «csv» — вторым словом). ' +
      'Языки rus+eng; таблицы восстанавливаются по координатам слов, выравнивание сложных макетов лучше перепроверить.',
    check: () => 'allow',
    async run(body: string, ctx: ToolRunContext) {
      const { sub, rest } = parseHead(body);
      switch (sub) {
        case 'text': {
          const abs = localPath(ctx.cwd, rest[0] ?? '');
          const pages = await recognize(abs, rest[1]);
          return pages.map((p) => `—— ${p.name} (уверенность ${Math.round(p.confidence)}%)\n\n${p.text}`).join('\n\n');
        }
        case 'tables': {
          const abs = localPath(ctx.cwd, rest[0] ?? '');
          const csv = rest[1] === 'csv';
          const pagesSpec = csv ? rest[2] : rest[1];
          const pages = await recognize(abs, pagesSpec);
          const parts: string[] = [];
          for (const p of pages) {
            const rows = linesToRows(wordsToLines(p.words));
            const table = rowsToMarkdown(rows);
            if (!table) {
              parts.push(`—— ${p.name}: таблиц не найдено (текст смотрите в «ocr text»)`);
              continue;
            }
            parts.push(`—— ${p.name}\n\n${csv ? rowsToCsv(rows.filter((r) => r.length >= 2)) : table}`);
          }
          return parts.join('\n\n');
        }
        default:
          throw new Error(syntax());
      }
    },
  };
};
