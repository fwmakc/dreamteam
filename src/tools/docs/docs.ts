/**
 * Тул «docs»: документы в рабочей папке агента (```docs подкоманда, тело — текст).
 *
 *   read <файл>            — текст документа: pdf (текстовый слой), docx, odt;
 *                            xlsx/ods/csv — все листы как CSV;
 *   tables <файл>          — только таблицы: xlsx/ods/csv или таблицы из docx;
 *   write <файл>           — создать из тела: docx (абзацы), xlsx (markdown/TSV/CSV-таблица),
 *                            pdf (текст), csv (как есть); odt/ods — через мост soffice;
 *   append <файл>          — дописать абзацы тела в конец docx (пункт договора —
 *                            остальное содержимое не перестраивается);
 *   convert <цель> <файл>  — перекодировать через мост soffice: doc→docx, xls→xlsx,
 *                            любой→pdf, docx→odt…
 *
 * Все пути — строго внутри рабочей папки (safePath), как у files. Мост soffice —
 * HTTP-сервис docker/soffice; адрес — карточка "soffice" (по умолчанию
 * http://127.0.0.1:8200). Шрифт с кириллицей для pdf — карточка "font".
 * Чтение и запись внутри рабочей папки — уровень доверия shell, поэтому check()
 * всегда 'allow'; безобразия режутся safePath-ом и лимитами вывода конвейера.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  appendDocx,
  convertViaSoffice,
  docKind,
  docxTables,
  docxText,
  odsSheets,
  odtText,
  parseTableText,
  pdfText,
  rowsToCsv,
  writeDocx,
  writeOdfViaSoffice,
  writePdf,
  writeXlsx,
  xlsxSheets,
  type DocSheet,
} from '../../documents.js';
import { safePath } from '../../actions.js';
import { checkCardKeys, resolveCard, splitArgs, type Tool, type ToolConfig, type ToolRunContext } from '../../tools-api.js';

const DEFAULT_SOFFICE = 'http://127.0.0.1:8200';

/** Разбор заголовка блока: подкоманда + аргументы; тело после первой строки. */
function parseHead(body: string): { sub: string; rest: string[]; text: string } {
  const nl = body.indexOf('\n');
  const head = nl === -1 ? body : body.slice(0, nl);
  const text = nl === -1 ? '' : body.slice(nl + 1).replace(/^\r?\n/, '');
  const [sub = '', ...rest] = splitArgs(head);
  return { sub, rest, text };
}

function syntax(): string {
  return 'подкоманды: read <файл> · tables <файл> · write <файл> (тело — текст/таблица) · ' +
    'append <файл> (тело — абзацы для docx) · convert <цель> <файл>';
}

/** Путь внутри рабочей папки; наружу — отказ. */
function localPath(cwd: string, rel: string): string {
  if (!rel) throw new Error('укажите файл');
  const abs = safePath(cwd, rel);
  if (!abs) throw new Error(`«${rel}» — выход за рабочую папку`);
  return abs;
}

function sheetsToCsv(sheets: DocSheet[]): string {
  return sheets
    .map((s) => `# лист: ${s.name}\n${rowsToCsv(s.rows)}`)
    .join('\n\n');
}

const LEGACY_HINT = 'legacy-формат читается только мостом soffice — сначала «convert docx <файл>» ' +
  '(сервис: cd docker && docker compose --profile soffice up -d)';

export default (config: ToolConfig): Tool => {
  // заводской адрес моста LibreOffice — в default.json рядом с кодом
  const card = resolveCard('docs', config);
  checkCardKeys(card, 'docs', 'soffice', 'font');
  const soffice = typeof card.soffice === 'string' && card.soffice.trim() ? card.soffice.trim() : DEFAULT_SOFFICE;
  const font = typeof card.font === 'string' ? card.font : undefined;

  return {
    desc:
      'Документы: ```docs read договор.pdf · tables таблица.xlsx · write отчёт.docx (тело — текст) · ' +
      'append договор.docx (тело — дописываемые абзацы) · convert pdf файл.doc. ' +
      'pdf/docx/xlsx/csv/odt/ods — нативно; .doc/.xls и создание odt/ods — нужен мост soffice (docker/soffice).',
    check: () => 'allow',
    async run(body, ctx: ToolRunContext) {
      const { sub, rest, text } = parseHead(body);
      switch (sub) {
        case 'read':
          return readAny(localPath(ctx.cwd, rest[0] ?? ''));
        case 'tables':
          return tablesAny(localPath(ctx.cwd, rest[0] ?? ''));
        case 'write':
          return writeAny(localPath(ctx.cwd, rest[0] ?? ''), text, soffice, font);
        case 'append': {
          const abs = localPath(ctx.cwd, rest[0] ?? '');
          if (docKind(abs) !== 'docx') throw new Error('append работает только с docx — другой формат сперва «convert docx <файл>»');
          appendDocx(abs, text.split(/\r?\n/).filter((l) => l.trim()));
          return `✓ дописано абзацев: ${text.split(/\r?\n/).filter((l) => l.trim()).length} в ${rest[0]}`;
        }
        case 'convert': {
          const target = (rest[0] ?? '').replace(/^\./, '').toLowerCase();
          const abs = localPath(ctx.cwd, rest[1] ?? '');
          const out = await convertViaSoffice(soffice, abs, target);
          return `✓ ${rest[1]} → ${out.split(/[\\/]/).pop()}`;
        }
        default:
          throw new Error(syntax());
      }
    },
  };
};

/** Чтение: текст или CSV-таблицы — по расширению; csv/tsv отдаём как есть. */
function readAny(abs: string): string | Promise<string> {
  switch (docKind(abs)) {
    case 'pdf': return pdfText(abs);
    case 'docx': return docxText(abs);
    case 'odt': return odtText(abs);
    case 'xlsx': return xlsxSheets(abs).then(sheetsToCsv);
    case 'ods': return sheetsToCsv(odsSheets(abs));
    case 'csv': return readFileSync(abs, 'utf8').trim();
    case 'legacy': throw new Error(LEGACY_HINT);
    default: throw new Error('неизвестный формат документа — поддерживаю pdf, docx, xlsx, csv/tsv, odt, ods (и .doc/.xls через convert)');
  }
}

/** Только таблицы. */
function tablesAny(abs: string): string | Promise<string> {
  switch (docKind(abs)) {
    case 'xlsx': return xlsxSheets(abs).then(sheetsToCsv);
    case 'ods': return sheetsToCsv(odsSheets(abs));
    case 'csv': return readFileSync(abs, 'utf8').trim();
    case 'docx': return docxTables(abs).then(rowsToCsv);
    case 'pdf': throw new Error('таблицы из pdf — это распознавание: тул ocr (```ocr файл.pdf таблица)');
    case 'legacy': throw new Error(LEGACY_HINT);
    default: throw new Error('таблицы берутся из xlsx, ods, csv и docx');
  }
}

/** Создание файла из тела: расширение решает писателя. */
async function writeAny(abs: string, text: string, soffice: string, font?: string): Promise<string> {
  if (!text.trim()) throw new Error('тело блока пустое — нечего писать (текст после первой строки заголовка)');
  const paragraphs = text.split(/\r?\n/);
  switch (docKind(abs)) {
    case 'docx':
      await writeDocx(abs, paragraphs);
      break;
    case 'xlsx': {
      const rows = parseTableText(text);
      await writeXlsx(abs, [{ name: 'Данные', rows }]);
      break;
    }
    case 'pdf':
      await writePdf(abs, text, font);
      break;
    case 'csv':
      writeFileSync(abs, text.replace(/^\r?\n/, '') + '\n', 'utf8');
      break;
    case 'odt':
      await writeOdfViaSoffice(soffice, abs, 'odt', paragraphs, []);
      break;
    case 'ods':
      await writeOdfViaSoffice(soffice, abs, 'ods', [], [{ name: 'Данные', rows: parseTableText(text) }]);
      break;
    case 'legacy':
      throw new Error(`в legacy-форматы (.doc/.xls) не пишем — пишите .docx/.xlsx или «convert» из них; ${LEGACY_HINT}`);
    default:
      throw new Error('для write нужно расширение: .docx, .xlsx, .pdf, .csv, .odt, .ods');
  }
  return `✓ записан ${abs.split(/[\\/]/).pop()} (${Buffer.byteLength(readFileSync(abs))} байт)`;
}
