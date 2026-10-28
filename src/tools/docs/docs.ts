/**
 * Тул «docs»: документы в рабочей папке агента (```docs подкоманда, тело — текст).
 *
 *   read <файл>            — текст документа: pdf (текстовый слой), docx, odt;
 *                            xlsx/ods/csv — все листы как CSV;
 *   md <файл>              — документ как markdown: заголовки, начертания,
 *                            списки, цитаты, таблицы (docx/odt/pdf/xlsx/ods/csv);
 *   tables <файл>          — только таблицы: xlsx/ods/csv или таблицы из docx;
 *   write <файл>           — создать из тела; тело — markdown (заголовки #,
 *                            **жирный**, *курсив*, списки, цитаты >, код-блоки,
 *                            таблицы | a | b |), литеральный * экранируется \*;
 *                            docx/pdf — нативно, odt/ods — мост soffice;
 *                            xlsx: таблицы → листы, «# имя» — имя листа;
 *   append <файл>          — дописать markdown-блоки тела в конец docx
 *                            (заголовки, начертания, код, списки, таблицы);
 *   convert <цель> <файл>  — перекодировать через мост soffice: doc→docx,
 *                            xls→xlsx, любой→pdf, docx→odt…; docx→pdf без моста —
 *                            нативный фолбэк через markdown (вёрстка проще).
 *
 * Все пути — рабочая папка или прикладные подпапки проекта (inbox, mail,
 * images; resolveToolPath), как у files. Мост soffice —
 * HTTP-сервис docker/soffice; адрес — карточка "soffice" (по умолчанию
 * http://127.0.0.1:8200). Шрифт с кириллицей для pdf — карточка "font".
 * Чтение и запись внутри рабочей папки — уровень доверия shell, поэтому check()
 * всегда 'allow'; безобразия режутся резолвером путей и лимитами вывода конвейера.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  appendDocxMd,
  docxToMd,
  odtToMd,
  sheetsToMd,
  writeDocxMd,
  writeOdfMd,
  writePdfMd,
  writeXlsxMd,
} from '../../documents-md.js';
import {
  convertViaSoffice,
  docKind,
  docxTables,
  docxText,
  odsSheets,
  odtText,
  pdfText,
  rowsToCsv,
  xlsxSheets,
  type DocSheet,
} from '../../documents.js';
import { resolveToolPath } from '../../actions.js';
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
  return 'подкоманды: read <файл> · md <файл> · tables <файл> · write <файл> (тело — markdown/таблица) · ' +
    'append <файл> (тело — markdown для docx) · convert <цель> <файл> — имя файла с пробелами берите в кавычки';
}

/** Путь в рабочей папке или прикладных подпапках проекта (inbox, mail, images); наружу — отказ. */
function localPath(cwd: string, rel: string): string {
  if (!rel) throw new Error('укажите файл');
  const abs = resolveToolPath(cwd, rel);
  if (!abs) throw new Error(`«${rel}» — выход за рабочую папку и прикладные папки проекта`);
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
      'Документы: ```docs read договор.pdf · md договор.docx (как markdown) · tables таблица.xlsx · ' +
      'write отчёт.docx (тело — markdown: # заголовки, **жирный**, списки, таблицы) · ' +
      'append договор.docx (тело — дописываемые markdown-блоки) · convert pdf файл.doc. ' +
      'Имя файла с пробелами — в кавычках: read "иск по квартире.docx". ' +
      'pdf/docx/xlsx/csv/odt/ods — нативно; .doc/.xls и создание odt/ods — нужен мост soffice (docker/soffice).',
    check: () => 'allow',
    async run(body, ctx: ToolRunContext) {
      const { sub, rest, text } = parseHead(body);
      switch (sub) {
        case 'read':
          return readAny(localPath(ctx.cwd, rest[0] ?? ''));
        case 'md':
          return mdAny(localPath(ctx.cwd, rest[0] ?? ''));
        case 'tables':
          return tablesAny(localPath(ctx.cwd, rest[0] ?? ''));
        case 'write':
          return writeAny(localPath(ctx.cwd, rest[0] ?? ''), text, soffice, font);
        case 'append': {
          const abs = localPath(ctx.cwd, rest[0] ?? '');
          if (docKind(abs) !== 'docx') throw new Error('append работает только с docx — другой формат сперва «convert docx <файл>»');
          const n = appendDocxMd(abs, text);
          return `✓ дописано строк: ${n} в ${rest[0]}`;
        }
        case 'convert': {
          const target = (rest[0] ?? '').replace(/^\./, '').toLowerCase();
          const abs = localPath(ctx.cwd, rest[1] ?? '');
          try {
            const out = await convertViaSoffice(soffice, abs, target);
            return `✓ ${rest[1]} → ${out.split(/[\\/]/).pop()}`;
          } catch (e) {
            if (target === 'pdf' && docKind(abs) === 'docx' && String((e as Error).message).includes('мост soffice')) {
              const out = abs.replace(/\.docx$/i, '') + '.pdf';
              const { md, notes } = await docxToMd(abs);
              await writePdfMd(out, md, font);
              return `✓ ${rest[1]} → ${out.split(/[\\/]/).pop()} (мост soffice недоступен — нативный фолбэк docx→md→pdf, ` +
                `вёрстка проще полного форматирования${notes.length ? `; ${notes.join('; ')}` : ''})`;
            }
            throw e;
          }
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

/** Документ как markdown: заголовки/начертания/списки/таблицы; pdf — только текст слоя. */
async function mdAny(abs: string): Promise<string> {
  const tail = (notes: string[]): string => (notes.length ? `\n\n---\n${notes.map((n) => `- примечание: ${n}`).join('\n')}` : '');
  switch (docKind(abs)) {
    case 'docx': {
      const { md, notes } = await docxToMd(abs);
      return md + tail(notes);
    }
    case 'odt': {
      const { md, notes } = odtToMd(abs);
      return md + tail(notes);
    }
    case 'xlsx': return sheetsToMd(await xlsxSheets(abs));
    case 'ods': return sheetsToMd(odsSheets(abs));
    case 'pdf': return pdfText(abs);
    case 'csv': return readFileSync(abs, 'utf8').trim();
    case 'legacy': throw new Error(LEGACY_HINT);
    default: throw new Error('в markdown отдаю pdf, docx, xlsx, csv/tsv, odt, ods (и .doc/.xls через convert)');
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

/** Создание файла из тела (тело — markdown): расширение решает писателя.
 * Пометки писателей (пропущенные картинки, имена листов) — в отчёте. */
async function writeAny(abs: string, text: string, soffice: string, font?: string): Promise<string> {
  if (!text.trim()) throw new Error('тело блока пустое — нечего писать (текст после первой строки заголовка)');
  const body = text.replace(/^\r?\n/, '');
  let notes: string[] = [];
  switch (docKind(abs)) {
    case 'docx':
      notes = await writeDocxMd(abs, body);
      break;
    case 'xlsx':
      notes = await writeXlsxMd(abs, body);
      break;
    case 'pdf':
      notes = await writePdfMd(abs, body, font);
      break;
    case 'csv':
      writeFileSync(abs, body + '\n', 'utf8');
      break;
    case 'odt':
      notes = await writeOdfMd(soffice, abs, 'odt', body);
      break;
    case 'ods':
      notes = await writeOdfMd(soffice, abs, 'ods', body);
      break;
    case 'legacy':
      throw new Error(`в legacy-форматы (.doc/.xls) не пишем — пишите .docx/.xlsx или «convert» из них; ${LEGACY_HINT}`);
    default:
      throw new Error('для write нужно расширение: .docx, .xlsx, .pdf, .csv, .odt, .ods');
  }
  const tail = notes.length ? `\n  ${notes.join('\n  ')}` : '';
  return `✓ записан ${abs.split(/[\\/]/).pop()} (${Buffer.byteLength(readFileSync(abs))} байт)${tail}`;
}
