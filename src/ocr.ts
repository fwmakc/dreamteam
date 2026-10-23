/**
 * OCR — распознавание текста с картинок: tesseract.js (wasm-сборка tesseract,
 * языки rus+eng по умолчанию) плюс подготовка входа:
 *   png/jpg/jpeg/bmp/webp — как есть;
 *   pdf — страницы рендерятся в png (pdfjs + @napi-rs/canvas, «dpi» карточки);
 *   docx — картинки из word/media (сканы часто хранят именно так, adm-zip).
 *
 * Языковые данные (traineddata) при первом запуске скачиваются с CDN и
 * кэшируются в ~/.dreamteam/cache/tesseract; для офлайн-машин карточка
 * "langPath" указывает папку с готовыми <lang>.traineddata.gz, "lang" — языки.
 *
 * Таблицы восстанавливаются по координатам слов: строки — кластеры по y,
 * ячейки — разрыв по горизонтальному зазору больше ~0.7 высоты шрифта.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { DT_HOME } from './paths.js';

/** Картинка, подготовленная к распознаванию: имя для отчёта и содержимое. */
export interface OcrImage {
  name: string;
  data: Buffer;
}

/** Слово с координатами рамки (пиксели входной картинки). */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Результат распознавания одной картинки: текст, слова и средняя уверенность. */
export interface OcrPage {
  name: string;
  text: string;
  words: OcrWord[];
  confidence: number;
}

export const OCR_CACHE_DIR = join(DT_HOME, 'cache', 'tesseract');

const IMAGE_KINDS: Record<string, true> = { png: true, jpg: true, jpeg: true, bmp: true, webp: true };

/** Похоже ли расширение на картинку, которую tesseract ест напрямую. */
export function isOcrImage(file: string): boolean {
  const ext = file.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return ext in IMAGE_KINDS;
}

// ─── Вход: картинки / страницы pdf / картинки из docx ───────────────────────

/** «3» | «2-5» | «all» (или пусто) → список 1-based страниц pdf. */
export function parsePages(spec: string | undefined, count: number): number[] {
  if (!spec || spec === 'all' || spec === 'все') return Array.from({ length: count }, (_, i) => i + 1);
  const m = spec.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`кривой номер страниц «${spec}» — ожидалось «2», «2-5» или «all»`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1 || to < from || to > count) throw new Error(`страниц «${spec}» нет — в pdf страниц: ${count}`);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Папка standard_fonts рядом с установленным pdfjs-dist — для шрифтов, не вшитых в pdf. */
function standardFontsUrl(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const dir = join(dirname(req.resolve('pdfjs-dist/package.json')), 'standard_fonts');
    if (existsSync(dir)) return pathToFileURL(dir.endsWith('/') ? dir : dir + '/').href;
  } catch {
    /* pdfjs не рядом — сканы (картинки целиком) читаются и без стандартных шрифтов */
  }
  return undefined;
}

/** Рендер страниц pdf в png: scale = dpi/72 (dpi карточки, по умолчанию 200). */
async function renderPdfPages(file: string, dpi: number, pagesSpec?: string): Promise<OcrImage[]> {
  const imageDpi = Number.isFinite(dpi) && dpi >= 72 && dpi <= 600 ? dpi : 200;
  type PdfJs = typeof import('pdfjs-dist');
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(file)),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: standardFontsUrl(),
  } as Parameters<typeof pdfjs.getDocument>[0]);
  try {
    const doc = await task.promise;
    const images: OcrImage[] = [];
    for (const n of parsePages(pagesSpec, doc.numPages)) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: imageDpi / 72 });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport } as Parameters<typeof page.render>[0]).promise;
      images.push({ name: `${file.split(/[\\/]/).pop()} · страница ${n}`, data: canvas.toBuffer('image/png') });
      page.cleanup();
    }
    return images;
  } finally {
    await task.destroy();
  }
}

/** Картинки из word/media docx: png/jpg/bmp/webp — распознаём, остальное перечисляем как пропущенное. */
export function docxImages(file: string): { images: OcrImage[]; skipped: string[] } {
  const zip = new AdmZip(file);
  const images: OcrImage[] = [];
  const skipped: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('word/media/')) continue;
    const base = entry.entryName.split('/').pop()!;
    if (isOcrImage(base)) images.push({ name: base, data: entry.getData() });
    else skipped.push(base);
  }
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { images, skipped };
}

/** Собирает картинки для распознавания из файла любого поддерживаемого вида. */
export async function collectImages(file: string, opts: { dpi?: number; pages?: string }): Promise<OcrImage[]> {
  if (isOcrImage(file)) {
    if (opts.pages && opts.pages !== 'all' && opts.pages !== 'все') {
      throw new Error('номера страниц — только для pdf; у картинки страниц нет');
    }
    return [{ name: file.split(/[\\/]/).pop()!, data: readFileSync(file) }];
  }
  const kind = file.toLowerCase().endsWith('.pdf') ? 'pdf' : file.toLowerCase().endsWith('.docx') ? 'docx' : 'other';
  if (kind === 'pdf') return renderPdfPages(file, opts.dpi ?? 200, opts.pages);
  if (kind === 'docx') {
    const { images, skipped } = docxImages(file);
    if (images.length === 0) {
      throw new Error('в docx нет картинок (word/media пуст) — если там текст, читайте тулом docs');
    }
    if (skipped.length > 0) console.error(`  ⚠ пропущены неподдерживаемые картинки: ${skipped.join(', ')}`);
    return images;
  }
  throw new Error('поддерживаю картинки png/jpg/jpeg/bmp/webp, pdf (страницы рендерятся) и docx (картинки из word/media)');
}

// ─── Распознавание: один воркер на партию картинок ──────────────────────────

/** Распознаёт картинки одним воркером; lang — «rus+eng» и т.п. (карточка "lang"). */
export async function recognizeImages(
  images: OcrImage[],
  opts: { lang?: string; cachePath?: string; langPath?: string },
): Promise<OcrPage[]> {
  const lang = opts.lang?.trim() || 'rus+eng';
  const { createWorker } = await import('tesseract.js');
  const cache = opts.cachePath ?? OCR_CACHE_DIR;
  mkdirSync(cache, { recursive: true });
  let worker;
  try {
    worker = await createWorker(lang, 1, {
      cachePath: cache,
      langPath: opts.langPath,
      gzip: true,
    });
  } catch (err) {
    const hint = opts.langPath
      ? `проверьте папку langPath: нужны ${lang}.traineddata.gz`
      : `при первом запуске нужен интернет (скачиваются языковые данные в ${cache}); ` +
        `для офлайн положите ${lang}.traineddata.gz в папку и укажите её в карточке тула "langPath"`;
    throw new Error(`tesseract не запустился (${err instanceof Error ? err.message : err}) — ${hint}`);
  }
  try {
    const pages: OcrPage[] = [];
    for (const img of images) {
      const { data } = await worker.recognize(img.data, {}, { text: true, blocks: true });
      const words: OcrWord[] = [];
      for (const block of data.blocks ?? []) {
        for (const par of block.paragraphs) {
          for (const line of par.lines) {
            for (const w of line.words) {
              const text = w.text.trim();
              if (!text) continue;
              words.push({ text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
            }
          }
        }
      }
      pages.push({
        name: img.name,
        text: (data.text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
        words,
        confidence: data.confidence ?? 0,
      });
    }
    return pages;
  } finally {
    await worker.terminate();
  }
}

// ─── Таблицы из координат слов ───────────────────────────────────────────────

/** Медиана чисел (для калибровки порогов под масштаб картинки). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Слова → строки: кластеризация по вертикальной середине слова (порог — 0.6 высоты шрифта). */
export function wordsToLines(words: OcrWord[]): OcrWord[][] {
  const h = median(words.map((w) => w.y1 - w.y0)) || 10;
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const lines: OcrWord[][] = [];
  let cur: OcrWord[] = [];
  let curY = 0;
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    if (cur.length > 0 && Math.abs(cy - curY) > h * 0.6) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
    curY = cur.length === 1 ? cy : curY + (cy - curY) / cur.length;
  }
  if (cur.length > 0) lines.push(cur);
  for (const line of lines) line.sort((a, b) => a.x0 - b.x0);
  return lines;
}

/** Строки слов → строки ячеек: разрыв по зазору больше 0.7 высоты шрифта. */
export function linesToRows(lines: OcrWord[][]): string[][] {
  const h = median(lines.flat().map((w) => w.y1 - w.y0)) || 10;
  return lines.map((line) => {
    const cells: string[][] = [[]];
    for (let i = 0; i < line.length; i++) {
      if (i > 0 && line[i]!.x0 - line[i - 1]!.x1 > h * 0.7) cells.push([]);
      cells[cells.length - 1]!.push(line[i]!.text);
    }
    return cells.map((cell) => cell.join(' '));
  });
}

/** Строки ячеек → markdown-таблица; null, если таблицы нет (меньше двух колонок).
 *  Одиночные строки (заголовки над таблицей, «Итого» под ней) выбрасываются —
 *  их текст и так виден в `ocr text`. */
export function rowsToMarkdown(rows: string[][]): string | null {
  const multi = rows.filter((r) => r.length >= 2);
  if (multi.length === 0) return null;
  const cols = Math.max(...multi.map((r) => r.length));
  const pad = multi.map((r) => [...r, ...Array<string>(cols - r.length).fill('')]);
  const head = `| ${pad[0]!.join(' | ')} |`;
  const bar = `| ${Array<string>(cols).fill('---').join(' | ')} |`;
  return [head, bar, ...pad.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
