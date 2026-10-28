/**
 * Документы: чтение и запись pdf / docx / xlsx / csv / odt / ods — чистый Node,
 * без внешних программ:
 *   чтение  — pdf: текстовый слой (pdfjs-dist); docx: mammoth (сырой текст);
 *             xlsx: read-excel-file; odt/ods: zip + разбор content.xml (adm-zip);
 *   запись  — богатые писатели из documents-md.ts: docx (пакет docx), xlsx
 *             (write-excel-file), pdf (pdfkit, кириллица — системный TTF-шрифт,
 *             см. карточку тула "font");
 *   дописать markdown-блоки в существующий docx — прямая правка
 *             word/document.xml (остальное содержимое не трогается).
 * Всё, что Node нативно не умеет (бинарные .doc/.xls, создание ODF), — через
 * мост soffice: HTTP-сервис docker/soffice (обёртка над `soffice --convert-to`).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';
import readXlsxFile from 'read-excel-file/node';

/** Лист таблицы: имя и строки одинаковой ширины (пустые ячейки — ''). */
export interface DocSheet {
  name: string;
  rows: string[][];
}

/** Чем является файл по расширению; 'legacy' — бинарные .doc/.xls (только мост). */
export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'odt' | 'ods' | 'legacy' | 'other';

export function docKind(file: string): DocKind {
  const low = file.toLowerCase();
  if (low.endsWith('.pdf')) return 'pdf';
  if (low.endsWith('.docx')) return 'docx';
  if (low.endsWith('.xlsx')) return 'xlsx';
  if (low.endsWith('.csv') || low.endsWith('.tsv')) return 'csv';
  if (low.endsWith('.odt')) return 'odt';
  if (low.endsWith('.ods')) return 'ods';
  if (low.endsWith('.doc') || low.endsWith('.xls')) return 'legacy';
  return 'other';
}

// ─── CSV / таблицы ──────────────────────────────────────────────────────────

/** Одна строка CSV с кавычками: «a,"b,c",d» → ['a','b,c','d']. */
export function parseCsvLine(line: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Таблица из текста: markdown (| a | b |), TSV или CSV — разделитель авто. */
export function parseTableText(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*\|?[\s:|-]+\|?\s*$/.test(l));
  if (lines.length === 0) throw new Error('в теле блока нет таблицы — нужна markdown-таблица, TSV или CSV');
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes('|') && lines[0].trim().startsWith('|') ? '|' : ',';
  return lines.map((l) => parseCsvLine(l.trim().replace(/^\|/, '').replace(/\|$/, ''), delim)
    .map((c) => c.trim()));
}

/** Строки в CSV-текст (кавычки только там, где нужны). */
export function rowsToCsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(','))
    .join('\n');
}

// ─── Чтение ────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function stripTags(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ''));
}

/** docx → сырой текст (mammoth; таблицы уплощаются — для них tablesDocx). */
export async function docxText(file: string): Promise<string> {
  const { value } = await mammoth.extractRawText({ path: file });
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

/** Таблицы docx (из HTML mammoth'а) → строки. */
export async function docxTables(file: string): Promise<string[][]> {
  const { value } = await mammoth.convertToHtml({ path: file });
  const rows: string[][] = [];
  for (const tr of value.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    rows.push([...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((td) => stripTags(td[1]).trim()));
  }
  if (rows.length === 0) throw new Error('в docx таблиц не найдено');
  return rows;
}

/** pdf → текст текстового слоя: строки собираются по y-координате, разрывы — по x. */
export async function pdfText(file: string): Promise<string> {
  type PdfJs = typeof import('pdfjs-dist');
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false, useSystemFonts: false } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = '';
    let lastY: number | null = null;
    let lastEnd: number | null = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const [, , , , x, y] = item.transform as number[];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        out.push(line.trimEnd());
        line = '';
        lastEnd = null;
      } else if (lastEnd !== null && x - lastEnd > 1) {
        line += ' ';
      }
      line += item.str;
      lastY = y;
      lastEnd = x + item.width;
    }
    if (line.trim()) out.push(line.trimEnd());
    if (p < doc.numPages) out.push(''); // разрыв между страницами
  }
  await task.destroy();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Листы xlsx → текстовые строки (read-excel-file; у формул — кэшированное
 * значение, rich text — конкатенация; у объединённых ячеек значение стоит
 * в мастер-ячейке, покрытые пусты — как в самом файле).
 */
export async function xlsxSheets(file: string): Promise<DocSheet[]> {
  const sheets = await readXlsxFile(readFileSync(file));
  return sheets.map(({ sheet, data }) => {
    const rows = data.map((row) => row.map(cellText));
    return { name: sheet, rows: rows.map(padRow(rows)) };
  });
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Ширина строки — по самой длинной в листе (читатели возвращают строки рвано). */
function padRow(rows: string[][]): (r: string[]) => string[] {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return (r) => Array.from({ length: width }, (_, i) => r[i] ?? '');
}

/** odt → текст: content.xml, абзацы text:p → переносы строк. */
export function odtText(file: string): string {
  const xml = contentXml(file);
  const body = xml.slice(xml.indexOf('<office:body'));
  return body
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<\/text:p>/g, '\n')
    .replace(/<\/text:h>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => decodeEntities(l).trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Листы ods → строки (табличные ячейки с учётом number-columns-repeated). */
export function odsSheets(file: string): DocSheet[] {
  const xml = contentXml(file);
  const sheets: DocSheet[] = [];
  for (const m of xml.matchAll(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>([\s\S]*?)<\/table:table>/g)) {
    const rows: string[][] = [];
    for (const rm of m[2].matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
      const row: string[] = [];
      for (const cm of rm[1].matchAll(/<table:table-cell\b([^>]*)>([\s\S]*?)<\/table:table-cell>|<table:table-cell\b([^>]*)\/>/g)) {
        const attrs = cm[1] ?? cm[3] ?? '';
        const cellXml = cm[2] ?? '';
        const text = decodeEntities(cellXml.replace(/<text:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).trim();
        const repeat = Number(/table:number-columns-repeated="(\d+)"/.exec(attrs)?.[1] ?? 1);
        if (repeat > 0 && repeat <= 4096) for (let i = 0; i < repeat; i++) row.push(text);
      }
      rows.push(row);
    }
    const meaningful = rows.filter((r) => r.some((c) => c !== ''));
    sheets.push({ name: m[1], rows: meaningful.map(padRow(meaningful)) });
  }
  if (sheets.length === 0) throw new Error('в ods не найдено таблиц — файл битый?');
  return sheets;
}

function contentXml(file: string): string {
  const zip = new AdmZip(file);
  const entry = zip.getEntry('content.xml');
  if (!entry) throw new Error('это не ODF-документ: в архиве нет content.xml');
  return entry.getData().toString('utf8');
}

export { contentXml, decodeEntities };

// ─── Запись ────────────────────────────────────────────────────────────────

export function xmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Стили шрифта pdf-рендера: путь к TTF на каждый; чего в системе нет — заменяется regular. */
export type PdfFontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic' | 'mono';

const FONT_FILES: Record<PdfFontStyle, string[]> = {
  regular: ['arial.ttf', 'calibri.ttf', 'DejaVuSans.ttf'],
  bold: ['arialbd.ttf', 'calibrib.ttf', 'DejaVuSans-Bold.ttf'],
  italic: ['ariali.ttf', 'calibrii.ttf', 'DejaVuSans-Oblique.ttf'],
  boldItalic: ['arialbi.ttf', 'calibribi.ttf', 'DejaVuSans-BoldOblique.ttf'],
  mono: ['consola.ttf', 'cour.ttf', 'DejaVuSansMono.ttf'],
};

function fontCandidates(style: PdfFontStyle): string[] {
  return FONT_FILES[style].flatMap((f) => [
    `C:/Windows/Fonts/${f}`,
    `/usr/share/fonts/truetype/dejavu/${f}`,
    `/usr/share/fonts/TTF/${f}`,
  ]);
}

/** Пять начертаний для pdf-рендера: карточка "font" задаёт regular, остальные ищутся рядом по именам. */
export function pdfFontPaths(configured?: string): Record<PdfFontStyle, string> {
  const resolve = (style: PdfFontStyle): string | null => fontCandidates(style).find((f) => existsSync(f)) ?? null;
  const regular = (configured && existsSync(configured) ? configured : null) ?? resolve('regular');
  if (!regular) {
    throw new Error(
      `не найден TTF-шрифт с кириллицей (${fontCandidates('regular').join(', ')}) — встроенные шрифты pdf кириллицу не умеют; ` +
      'укажите путь в карточке тула docs: "font": "C:/Windows/Fonts/arial.ttf"',
    );
  }
  const pick = (style: PdfFontStyle): string => resolve(style) ?? regular;
  return { regular, bold: pick('bold'), italic: pick('italic'), boldItalic: pick('boldItalic'), mono: pick('mono') };
}

/** Шрифт с кириллицей для pdf: карточка "font", иначе системные кандидаты. */
export function pdfFontPath(configured?: string): string {
  return pdfFontPaths(configured).regular;
}

/**
 * Мост soffice: POST файла на /convert (multipart: file + target), ответ —
 * перекодированный файл. Сервис — docker/soffice (профиль compose "soffice");
 * без него легаси (.doc/.xls) и создание ODF недоступны — отказ с подсказкой.
 * Возвращает путь к созданному файлу (рядом с исходным).
 */
export async function convertViaSoffice(baseUrl: string, file: string, target: string): Promise<string> {
  if (!/^[a-z0-9]{2,5}$/.test(target)) throw new Error(`кривая цель конвертации «${target}» — ожидалось расширение: docx, xlsx, pdf, odt…`);
  if (!existsSync(file)) throw new Error(`файла «${file}» нет`);
  const outPath = file.replace(/\.[^.]+$/, '') + '.' + target;
  const form = new FormData();
  form.append('file', new Blob([readFileSync(file)]), basename(file));
  form.append('target', target);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/convert`, { method: 'POST', body: form });
  } catch (err) {
    throw new Error(
      `мост soffice (${baseUrl}) недоступен: ${err instanceof Error ? err.message : err} — ` +
      'поднимите сервис: cd docker && docker compose --profile soffice up -d (docker/soffice/README.md)',
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`мост soffice: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('мост soffice вернул пустой файл');
  writeFileSync(outPath, buf);
  return outPath;
}
