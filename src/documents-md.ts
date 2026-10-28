/**
 * Markdown-направление тула docs: богатая запись и экспорт.
 *   md → docx (заголовки, начертания, ссылки, списки, цитаты, код-блоки, таблицы, линия);
 *   md → xlsx (таблицы → листы, заголовок # перед таблицей — имя листа, шапка жирная);
 *   md → pdf  (единый красивый рендер: через него идут и write *.pdf, и фолбэк convert);
 *   md → odt/ods (нативка → мост soffice);
 *   docx → md (mammoth → htmlToMd), odt → md (content.xml: text:h/text:list),
 *   xlsx/ods → md (лист → # имя + таблица, симметрично сборке).
 * Пределы честно отдаются в notes: картинки пропускаются, в xlsx попадают
 * только таблицы, append не строит нумерацию и таблицы.
 */
import { copyFileSync, createWriteStream, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import PDFDocument from 'pdfkit';
import writeXlsxFile from 'write-excel-file/node';
import {
  contentXml,
  convertViaSoffice,
  decodeEntities,
  parseTableText,
  pdfFontPaths,
  xmlEscape,
  type DocSheet,
} from './documents.js';
import { htmlToMd, parseMd, spanText, type MdAlign, type MdBlock, type MdItem, type MdLine, type MdSpan, type MdText } from './md.js';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

// ─── md → docx ──────────────────────────────────────────────────────────────

/** Богатый docx из markdown. Возвращает пометки (пропущенные картинки). */
export async function writeDocxMd(file: string, md: string): Promise<string[]> {
  const { blocks, notes } = parseMd(md);
  const olRefs: string[] = [];
  const nextOl = (): string => {
    const ref = `md-ol-${olRefs.length}`;
    olRefs.push(ref);
    return ref;
  };
  const children: (Paragraph | Table)[] = [];
  for (const b of blocks) emitDocx(b, children, nextOl);
  const doc = new Document({
    // определение символьного стиля Code — по нему mammoth возвращает <code>
    styles: {
      characterStyles: [{ id: 'Code', name: 'Code', basedOn: 'DefaultParagraphFont', run: { font: 'Consolas' } }],
    },
    ...(olRefs.length
      ? {
          numbering: {
            config: olRefs.map((reference) => ({
              reference,
              levels: [0, 1, 2].map((level) => ({
                level,
                format: LevelFormat.DECIMAL,
                text: level === 0 ? '%1.' : level === 1 ? '%2.' : '%3.',
                alignment: AlignmentType.LEFT,
                start: 1,
                style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
              })),
            })),
          },
        }
      : {}),
    sections: [{ children }],
  });
  writeFileSync(file, await Packer.toBuffer(doc));
  return notes;
}

function emitDocx(b: MdBlock, out: (Paragraph | Table)[], nextOl: () => string): void {
  switch (b.kind) {
    case 'heading':
      out.push(new Paragraph({ heading: HEADINGS[Math.min(6, b.level) - 1], children: runs(b.spans) }));
      return;
    case 'p':
      out.push(new Paragraph({ children: withBreaks(b.lines) }));
      return;
    case 'ul':
    case 'ol':
      listDocx(b.kind, b.items, 0, out, nextOl);
      return;
    case 'quote':
      for (const p of b.paragraphs)
        out.push(
          new Paragraph({
            indent: { left: 567 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'AAAAAA', space: 8 } },
            children: runs(p.map((sp) => ({ ...sp, italic: true }))),
          }),
        );
      return;
    case 'code':
      for (const line of b.text.split('\n'))
        out.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
            children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })],
          }),
        );
      return;
    case 'hr':
      out.push(
        new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } }, children: [] }),
      );
      return;
    case 'table': {
      const cell = (c: MdLine, k: number, head: boolean) =>
        new TableCell({
          ...(head ? { shading: { type: ShadingType.CLEAR, fill: 'E8E8E8' } } : {}),
          children: [
            new Paragraph({
              alignment: b.aligns[k] === 'center' ? AlignmentType.CENTER : b.aligns[k] === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
              children: runs(head ? c.map((sp) => ({ ...sp, bold: true })) : c),
            }),
          ],
        });
      out.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: b.header.map((c, k) => cell(c, k, true)) }), ...b.rows.map((r) => new TableRow({ children: r.map((c, k) => cell(c, k, false)) }))],
        }),
      );
      return;
    }
  }
}

function listDocx(kind: 'ul' | 'ol', items: MdItem[], level: number, out: (Paragraph | Table)[], nextOl: () => string): void {
  const ref = kind === 'ol' ? nextOl() : null;
  for (const item of items) {
    out.push(
      new Paragraph({
        ...(kind === 'ul' ? { bullet: { level: Math.min(8, level) } } : { numbering: { reference: ref!, level: Math.min(2, level) } }),
        children: withBreaks(item.lines),
      }),
    );
    if (item.sub) listDocx(item.sub.kind, item.sub.items, level + 1, out, nextOl);
  }
}

/** Строки пункта/абзаца: между строками — разрыв строки (жёсткий перенос). */
function withBreaks(lines: MdLine[]): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  lines.forEach((line, k) => {
    if (k > 0) out.push(new TextRun({ break: 1 }));
    out.push(...runs(line));
  });
  return out;
}

function runs(spans: MdLine): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let i = 0;
  while (i < spans.length) {
    const href = spans[i].href;
    if (href) {
      const group: MdSpan[] = [];
      while (i < spans.length && spans[i].href === href) group.push(spans[i++]);
      out.push(new ExternalHyperlink({ link: href, children: group.map(mdRun) }));
    } else out.push(mdRun(spans[i++]));
  }
  return out;
}

function mdRun(sp: MdSpan): TextRun {
  return new TextRun({
    text: sp.text,
    bold: sp.bold,
    italics: sp.italic,
    strike: sp.strike,
    font: sp.code ? 'Consolas' : undefined,
    // символьный стиль Code — чтобы mammoth вернул <code> при экспорте в md
    ...(sp.href ? { style: 'Hyperlink' as const } : sp.code ? { style: 'Code' as const } : {}),
  });
}

// ─── docx → md ──────────────────────────────────────────────────────────────

/** docx → markdown: mammoth отдаёт HTML (h1–6, strong/em, списки, таблицы, ссылки), htmlToMd собирает md.
 * Инлайн-код пишем символьным стилем Code — styleMap возвращает его как <code>. */
export async function docxToMd(file: string): Promise<MdText> {
  const { value } = await mammoth.convertToHtml({ path: file }, { styleMap: ["r[style-name='Code'] => code"] });
  return htmlToMd(value);
}

// ─── odt → md ───────────────────────────────────────────────────────────────

/** odt → markdown: заголовки text:h → #, пункты text:list → дефисы (начертания span не вынимаем — предел). */
export function odtToMd(file: string): MdText {
  const xml = contentXml(file);
  const body = xml.slice(xml.indexOf('<office:body'));
  const lines: string[] = [];
  let depth = 0;
  const re = /<text:h\b([^>]*?)>([\s\S]*?)<\/text:h>|<text:p\b[^>]*?\/>|<text:p\b[^>]*?>([\s\S]*?)<\/text:p>|<text:list\b[^>]*?>|<\/text:list>/g;
  for (const m of body.matchAll(re)) {
    if (m[0].startsWith('<text:h')) {
      const lvl = Number(/text:outline-level="(\d+)"/.exec(m[1] ?? '')?.[1] ?? 1);
      lines.push(`${'#'.repeat(Math.min(6, lvl))} ${plainOdf(m[2])}`.trimEnd());
    } else if (m[0] === '<text:list') depth++;
    else if (m[0] === '</text:list>') depth = Math.max(0, depth - 1);
    else if (m[0].startsWith('<text:p')) {
      const t = plainOdf(m[3] ?? '');
      lines.push(depth > 0 ? `${'  '.repeat(depth - 1)}- ${t}` : t);
    }
  }
  return { md: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), notes: [] };
}

function plainOdf(xml: string): string {
  return decodeEntities(xml.replace(/<text:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).trim();
}

// ─── xlsx/ods ⇄ md ──────────────────────────────────────────────────────────

const mdCell = (c: string): string => c.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Листы → markdown: «# имя» + таблица (первая строка — шапка), симметрично writeXlsxMd. */
export function sheetsToMd(sheets: DocSheet[]): string {
  return sheets
    .map((s) => {
      const rows = s.rows.length
        ? [
            `| ${s.rows[0].map(mdCell).join(' | ')} |`,
            `| ${s.rows[0].map(() => '---').join(' | ')} |`,
            ...s.rows.slice(1).map((r) => `| ${r.map(mdCell).join(' | ')} |`),
          ]
        : [];
      return `# ${s.name}\n\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

/** xlsx из markdown: таблицы → листы, «# имя» перед таблицей — имя листа, шапка жирная.
 * Не-табличные блоки пропускаются (счётчик — в notes). Без таблиц — прежнее
 * поведение: markdown/TSV/CSV одной таблицей. */
export async function writeXlsxMd(file: string, md: string): Promise<string[]> {
  const { blocks } = parseMd(md);
  interface XlsxCell {
    value: string;
    fontWeight?: 'bold';
    fontStyle?: 'italic';
    align?: 'left' | 'center' | 'right';
  }
  const sheets: { sheet: string; data: XlsxCell[][] }[] = [];
  let pending: string | null = null;
  let skipped = 0;
  const cellOf = (c: MdLine, head: boolean, align: MdAlign | undefined): XlsxCell => ({
    value: spanText(c),
    ...(head || c.some((sp) => sp.bold) ? { fontWeight: 'bold' as const } : {}),
    ...(c.some((sp) => sp.italic) ? { fontStyle: 'italic' as const } : {}),
    ...(align && align !== 'left' ? { align } : {}),
  });
  for (const b of blocks) {
    if (b.kind === 'heading') {
      pending = spanText(b.spans).trim();
      continue;
    }
    if (b.kind === 'table') {
      const name = (pending || (sheets.length ? `Данные ${sheets.length + 1}` : 'Данные')).slice(0, 31);
      pending = null;
      sheets.push({
        sheet: name,
        data: [b.header.map((c, k) => cellOf(c, true, b.aligns[k])), ...b.rows.map((r) => r.map((c, k) => cellOf(c, false, b.aligns[k])))],
      });
      continue;
    }
    skipped++;
  }
  if (pending) skipped++;
  if (sheets.length === 0) sheets.push({ sheet: 'Данные', data: parseTableText(md).map((r) => r.map((c) => ({ value: c }))) });
  await writeXlsxFile(sheets).toFile(file);
  const notes = [`листы: ${sheets.map((s) => s.sheet).join(', ')}`];
  if (skipped > 0) notes.push(`в xlsx попадают только таблицы — пропущено не табличных блоков: ${skipped}`);
  return notes;
}

// ─── md → odt/ods (нативка → мост soffice) ──────────────────────────────────

/** odt/ods из markdown: богатый docx/xlsx во временный файл, затем мост soffice. */
export async function writeOdfMd(baseUrl: string, file: string, kind: 'odt' | 'ods', md: string): Promise<string[]> {
  const tmp = join(tmpdir(), `dt-md-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const native = kind === 'odt' ? `${tmp}.docx` : `${tmp}.xlsx`;
  const notes = kind === 'odt' ? await writeDocxMd(native, md) : await writeXlsxMd(native, md);
  let produced: string | null = null;
  try {
    produced = await convertViaSoffice(baseUrl, native, kind);
    copyFileSync(produced, file);
    return notes;
  } finally {
    for (const p of [native, produced]) {
      if (!p) continue;
      try {
        unlinkSync(p);
      } catch {
        /* осядем во временной папке — не страшно */
      }
    }
  }
}

// ─── md → pdf (единый рендер: write *.pdf, md, фолбэк convert) ──────────────

/** Красивый pdf из markdown: заголовки, выключка абзацев, списки, цитаты с линией,
 * код на серой плашке, таблицы выровненным моно-блоком. */
export async function writePdfMd(file: string, md: string, font?: string): Promise<string[]> {
  const F = pdfFontPaths(font);
  const { blocks, notes } = parseMd(md);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 64, left: 56, right: 56 },
    info: { Title: basename(file) },
  });
  const out = createWriteStream(file);
  doc.pipe(out);
  const M = 56;
  const W = (): number => doc.page.width - M * 2;
  const ensure = (h: number): void => {
    if (doc.y + h > doc.page.height - 64 && doc.y > 70) doc.addPage();
  };
  const fontOf = (sp: MdSpan, forceBold?: boolean): string =>
    sp.code ? F.mono : forceBold || sp.bold ? (sp.italic ? F.boldItalic : F.bold) : sp.italic ? F.italic : F.regular;

  /** Пословная вёрстка строки в строки-токены: жадная раскладка по ширине, выключка
   * (излишек делится по пробелам, последняя строка влево), каждый токен рисуется
   * своим шрифтом/размером — смена начертания и код-моно не зависят от потока pdfkit. */
  function flow(parts: MdLine, x: number, width: number, opts: { size?: number; align?: 'left' | 'justify'; forceBold?: boolean } = {}): void {
    const size = opts.size ?? 11;
    const fs = (sp: MdSpan): number => (sp.code ? size - 1.5 : size);
    doc.fillColor('black');
    interface Tok { text: string; sp: MdSpan; w: number; gap: boolean }
    const toks: Tok[] = [];
    for (const sp of parts.length ? parts : [{ text: ' ' }]) {
      doc.font(fontOf(sp, opts.forceBold)).fontSize(fs(sp));
      for (const piece of sp.text.split(/(\s+)/)) {
        if (!piece) continue;
        if (/^\s+$/.test(piece)) {
          if (toks.length) toks[toks.length - 1].gap = true;
        } else toks.push({ text: piece, sp, w: doc.widthOfString(piece), gap: false });
      }
    }
    const spaceW = doc.font(F.regular).fontSize(size).widthOfString(' ');
    const lh = doc.currentLineHeight(false) + 3.5;
    const lines: { toks: Tok[]; w: number; gaps: number }[] = [];
    let cur: Tok[] = [];
    let curW = 0;
    let curGaps = 0;
    for (const t of toks) {
      const gapBefore = cur.length > 0 && cur[cur.length - 1].gap;
      const add = t.w + (gapBefore ? spaceW : 0);
      if (cur.length && curW + add > width) {
        lines.push({ toks: cur, w: curW, gaps: curGaps });
        cur = [t];
        curW = t.w;
        curGaps = 0;
      } else {
        cur.push(t);
        curW += add;
        if (gapBefore) curGaps++;
      }
    }
    if (cur.length) lines.push({ toks: cur, w: curW, gaps: curGaps });
    let cy = doc.y;
    for (const line of lines) {
      if (cy + lh > doc.page.height - 64 && cy > 70) {
        doc.addPage();
        cy = 64;
      }
      const extra =
        opts.align === 'justify' && line !== lines[lines.length - 1] && line.gaps > 0
          ? Math.max(0, (width - line.w) / line.gaps)
          : 0;
      let cx = x;
      for (let k = 0; k < line.toks.length; k++) {
        const t = line.toks[k];
        doc.font(fontOf(t.sp, opts.forceBold)).fontSize(fs(t.sp)).fillColor('black');
        // lineBreak:false — иначе pdfkit подставит width до края страницы и порежет
        // слово у правого поля, а «хвост» положит на следующую строку со сдвигом
        const o: PDFKit.Mixins.TextOptions = { lineGap: 0, lineBreak: false };
        if (t.sp.href) Object.assign(o, { link: t.sp.href, underline: true });
        if (t.sp.strike) Object.assign(o, { strike: true });
        doc.text(t.text, cx, cy, o);
        cx += t.w;
        if (t.gap && k < line.toks.length - 1) cx += spaceW + extra;
      }
      cy += lh;
    }
    doc.y = cy;
    doc.x = M;
  }

  function paragraph(parts: MdLine, indent = 0, forceItalic = false): void {
    const parts0 = forceItalic ? parts.map((sp) => ({ ...sp, italic: true })) : parts;
    const plain = parts0.map((s) => s.text).join('') || ' ';
    doc.font(forceItalic ? F.italic : F.regular).fontSize(11);
    ensure(doc.heightOfString(plain, { width: W() - indent, lineGap: 3.5 }) + 10);
    flow(parts0, M + indent, W() - indent, { align: 'justify' });
    doc.moveDown(0.4);
  }

  function listMd(kind: 'ul' | 'ol', items: MdItem[], level: number): void {
    const indent = 16 * (level + 1);
    items.forEach((item, idx) => {
      const line: MdLine = item.lines.flat();
      const plain = line.map((s) => s.text).join('') || ' ';
      doc.font(F.regular).fontSize(11);
      ensure(doc.heightOfString(plain, { width: W() - indent, lineGap: 3.5 }) + 4);
      const y = doc.y;
      flow(line, M + indent, W() - indent, {});
      const yAfter = doc.y;
      // маркер — исходный («3.»), не пересчитанный; правым краем к тексту; doc.y после тела сохраняем
      const label = kind === 'ul' ? '•' : item.marker?.trim() || `${idx + 1}.`;
      const lw = Math.max(14, doc.widthOfString(label) + 2);
      doc.font(F.regular).fontSize(11).fillColor('black');
      doc.text(label, M + indent - lw - 2, y, { width: lw, lineGap: 3.5, align: 'right' });
      doc.y = yAfter;
      doc.x = M;
      if (item.sub) listMd(item.sub.kind, item.sub.items, level + 1);
    });
  }

  function quote(lines: MdLine[]): void {
    if (!lines.length) return;
    doc.font(F.italic).fontSize(11);
    let est = 0;
    for (const l of lines) est += doc.heightOfString(spanText(l) || ' ', { width: W() - 14, lineGap: 3.5 }) + 6;
    ensure(est + 8);
    const y0 = doc.y;
    for (const l of lines) paragraph(l, 14, true);
    doc.rect(M, y0, 2.5, Math.max(10, doc.y - y0 - 6)).fill('#AAAAAA');
    doc.fillColor('black');
    doc.moveDown(0.35);
  }

  function code(text: string): void {
    doc.font(F.mono).fontSize(9);
    const lh = doc.currentLineHeight(false) + 3;
    const maxChars = Math.max(10, Math.floor((W() - 16) / doc.widthOfString('0')));
    const wrapped: string[] = [];
    for (const raw of text.split('\n')) {
      if (raw.length <= maxChars) wrapped.push(raw);
      else for (let k = 0; k < raw.length; k += maxChars) wrapped.push(raw.slice(k, k + maxChars));
    }
    ensure(lh * Math.min(wrapped.length, 3) + 10);
    for (const l of wrapped) {
      ensure(lh + 6);
      doc.rect(M, doc.y - 3, W(), lh + 6).fill('#F4F4F4');
      doc.fillColor('black');
      doc.font(F.mono).fontSize(9).text(l || ' ', M + 8, doc.y, { width: W() - 16, lineGap: 0 });
    }
    doc.moveDown(0.5);
  }

  function table(b: Extract<MdBlock, { kind: 'table' }>): void {
    doc.font(F.mono).fontSize(8.5);
    const charW = doc.widthOfString('0');
    const rows = [b.header, ...b.rows].map((r) => r.map(spanText));
    const cols = b.header.length;
    const measure = (s: string, head: boolean): number => doc.font(head ? F.bold : F.mono).fontSize(8.5).widthOfString(s);
    const pad = 5;
    const widths = Array.from({ length: cols }, (_, k) =>
      Math.max(pad * 2 + 3 * charW, ...rows.map((r, ri) => measure(r[k] ?? '', ri === 0))) + pad * 2);
    const total = widths.reduce((a, b2) => a + b2, 0);
    const k0 = total > W() ? W() / total : 1;
    const cw = widths.map((w) => Math.max(3 * charW + pad * 2, w * k0));
    const fit = (s: string, w: number, head: boolean): string => {
      doc.font(head ? F.bold : F.mono).fontSize(8.5);
      if (doc.widthOfString(s) <= w) return s;
      let e = s.length;
      while (e > 1 && doc.widthOfString(s.slice(0, e - 1) + '…') > w) e--;
      return e > 1 ? s.slice(0, e - 1) + '…' : '…';
    };
    const lh = doc.currentLineHeight(false) + 3;
    // «шапочная» строка секции: короткая первая непустая ячейка («№») и дословный
    // повтор строки в таблице (данные уникальны, шапки блоков повторяются). Она держит
    // при себе две следующие строки, а строка перед ней — не оставляет её в одиночестве.
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.join('\u0001'), (seen.get(r.join('\u0001')) ?? 0) + 1);
    const isCap = (r: string[]): boolean => {
      const first = (r.find((c) => c.trim()) ?? '').trim();
      return first.length > 0 && first.length <= 2 && (seen.get(r.join('\u0001')) ?? 0) > 1;
    };
    rows.forEach((r, ri) => {
      ensure(lh * (ri === 0 ? 3 : isCap(rows[ri + 1] ?? []) ? 4 : isCap(r) ? 3 : 1) + 4);
      const head = ri === 0;
      const y = doc.y;
      let x = M;
      doc.font(head ? F.bold : F.mono).fontSize(8.5);
      r.forEach((c, k) => {
        const align = b.aligns?.[k] === 'right' ? 'right' : b.aligns?.[k] === 'center' ? 'center' : 'left';
        doc.text(fit(c, cw[k] - pad * 2, head), x + pad, y, { width: cw[k] - pad * 2, lineGap: 0, height: lh, ellipsis: false, align });
        x += cw[k];
      });
      doc.y = y + lh;
      if (head) {
        doc.rect(M, doc.y - 2, W(), 0.8).fill('#999999');
        doc.fillColor('black');
      }
    });
    doc.moveDown(0.6);
  }

  const HS = [20, 16, 13.5, 12, 11.5, 11];
  function heading(level: number, parts: MdLine): void {
    const size = HS[Math.min(6, level) - 1] ?? 11;
    doc.font(F.bold).fontSize(size);
    // заголовок не сирота: место под него и первую строку следующего блока
    ensure(size * 2.5 + 16);
    doc.moveDown(level <= 2 ? 0.7 : 0.4);
    flow(parts, M, W(), { size, forceBold: true });
    doc.moveDown(0.35);
  }

  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        heading(b.level, b.spans);
        break;
      case 'p':
        for (const line of b.lines) paragraph(line);
        break;
      case 'ul':
      case 'ol':
        listMd(b.kind, b.items, 0);
        break;
      case 'quote':
        quote(b.paragraphs);
        break;
      case 'code':
        code(b.text);
        break;
      case 'hr':
        ensure(14);
        doc.moveDown(0.5);
        doc.rect(M, doc.y, W(), 0.8).fill('#999999');
        doc.fillColor('black');
        doc.moveDown(0.7);
        break;
      case 'table':
        table(b);
        break;
    }
  }
  if (notes.length) {
    ensure(notes.length * 14 + 20);
    doc.moveDown(1);
    doc.font(F.italic).fontSize(9).fillColor('#666666');
    for (const n of notes) doc.text(`примечание: ${n}`, { lineGap: 2 });
    doc.fillColor('black');
  }
  doc.end();
  await new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return notes;
}

// ─── дописывание в существующий docx (прямая правка XML) ───────────────────

/** Дописать markdown-блоки в конец docx: заголовки (стили Heading), начертания,
 * цитаты, код (моно + заливка), списки — текстом с маркерами, таблицы — строки
 * через « | ». Возвращает число дописанных абзацев. */
export function appendDocxMd(file: string, md: string): number {
  const { blocks } = parseMd(md);
  const frag: string[] = [];
  let count = 0;
  const para = (pPr: string, lines: MdLine[]): void => {
    count += Math.max(1, lines.length);
    const runsXml = lines
      .map((line, k) => (k ? '<w:r><w:br/></w:r>' : '') + line.map(runXml).join(''))
      .join('');
    frag.push(`<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runsXml}</w:p>`);
  };
  const walkList = (items: MdItem[], depth: number, kind: 'ul' | 'ol'): void => {
    let n = 0;
    for (const item of items) {
      n++;
      const prefix = kind === 'ul' ? '- ' : item.marker ? `${item.marker.trim()} ` : `${n}. `;
      para(`<w:ind w:left="${360 * (depth + 1)}"/>`, item.lines.map((line, k) => (k === 0 ? [{ text: prefix }, ...line] : line)));
      if (item.sub) walkList(item.sub.items, depth + 1, item.sub.kind);
    }
  };
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        para(`<w:pStyle w:val="Heading${Math.min(6, b.level)}"/>`, [b.spans]);
        break;
      case 'p':
        para('', b.lines);
        break;
      case 'quote':
        for (const p of b.paragraphs) para('<w:ind w:left="567"/>', [p.map((sp) => ({ ...sp, italic: true }))]);
        break;
      case 'code':
        for (const line of b.text.split('\n')) para('<w:shd w:val="clear" w:fill="F2F2F2"/>', [[{ text: line || ' ', code: true }]]);
        break;
      case 'ul':
      case 'ol':
        walkList(b.items, 0, b.kind);
        break;
      case 'table':
        for (const r of [b.header, ...b.rows]) para('', [[{ text: r.map(spanText).join(' | ') }]]);
        break;
      case 'hr':
        break;
    }
  }
  if (frag.length === 0) return 0;
  const zip = new AdmZip(file);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('это не docx: в архиве нет word/document.xml');
  const xml = entry.getData().toString('utf8');
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (bodyEnd === -1) throw new Error('битый docx: нет закрывающего </w:body>');
  const sect = xml.lastIndexOf('<w:sectPr');
  const at = sect !== -1 && sect < bodyEnd ? sect : bodyEnd;
  zip.updateFile(entry, Buffer.from(xml.slice(0, at) + frag.join('') + xml.slice(at), 'utf8'));
  zip.writeZip(file);
  return count;
}

function runXml(sp: MdSpan): string {
  const rpr =
    sp.bold || sp.italic || sp.strike || sp.code
      ? `<w:rPr>${sp.bold ? '<w:b/>' : ''}${sp.italic ? '<w:i/>' : ''}${sp.strike ? '<w:strike/>' : ''}${
          sp.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ''
        }</w:rPr>`
      : '';
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(sp.text)}</w:t></w:r>`;
}
