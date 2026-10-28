/**
 * Markdown как богатый посредник между документами (тул docs): разбор в блоки
 * и сборка обратно. Подмножество, которого хватает для отчётов и договоров:
 *   заголовки #..######; абзацы (перенос строки — всегда разрыв строки);
 *   **жирный**, *курсив*, ***оба***, ~~зачёркнутый~~, `код`, [текст](url);
 *   экранирование \* \_ \` \~ \[; списки - * + и 1. с вложенностью (отступ 2 пробела);
 *   цитаты >; код-блоки ```; таблицы | a | b | с разделителем и выравниванием; линия ---.
 * Картинки пропускаются с пометкой в notes — текстовым форматам они не нужны.
 */
import { JSDOM } from 'jsdom';

/** Кусок строки с начертанием (href — кусок внутри ссылки). */
export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

/** Строка абзаца/ячейки: несколько кусков с разными начертаниями. */
export type MdLine = MdSpan[];

export type MdAlign = 'left' | 'center' | 'right';

export interface MdItem {
  lines: MdLine[];
  /** Исходный маркер пункта («-», «3.») — для честного сохранения нумерации. */
  marker?: string;
  sub?: MdList;
}

export interface MdList {
  kind: 'ul' | 'ol';
  items: MdItem[];
}

export type MdBlock =
  | { kind: 'heading'; level: number; spans: MdSpan[] }
  | { kind: 'p'; lines: MdLine[] }
  | { kind: 'ul'; items: MdItem[] }
  | { kind: 'ol'; items: MdItem[] }
  | { kind: 'quote'; paragraphs: MdLine[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; aligns: MdAlign[]; header: MdLine[]; rows: MdLine[][] }
  | { kind: 'hr' };

/** Разобранный markdown: блоки + пометки о пропущенном (картинки). */
export interface MdDoc {
  blocks: MdBlock[];
  notes: string[];
}

/** Готовый markdown-текст + пометки (экспорт из docx/odt). */
export interface MdText {
  md: string;
  notes: string[];
}

/** Простой текст кусков (для имён листов, отчётов). */
export function spanText(spans: MdLine): string {
  return spans.map((s) => s.text).join('');
}

// ─── Разбор инлайна ─────────────────────────────────────────────────────────

const ESC = '\u0000';

interface Flags {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

/** Инлайн-строка → куски: **жирный**, *курсив*, ~~зачёркнутый~~, `код`, [текст](url), \-экранирование. */
export function parseInline(src: string, notes?: string[]): MdLine {
  // экранированные символы прячем в плейсхолдеры, чтобы сканер их не трогал
  const stash: string[] = [];
  const s = src.replace(/\\([\\`*_~[\]()|#>!-.])/g, (_, ch: string) => {
    stash.push(ch);
    return `${ESC}${stash.length - 1}${ESC}`;
  });
  const spans = scan(s, {}, notes ?? []);
  for (const sp of spans) sp.text = sp.text.replace(new RegExp(`${ESC}(\\d+)${ESC}`, 'g'), (_, k) => stash[Number(k)]);
  return spans.filter((sp) => sp.text !== '');
}

function scan(s: string, f: Flags, notes: string[]): MdSpan[] {
  const spans: MdSpan[] = [];
  const flags = { ...f };
  let text = '';
  const push = () => {
    if (!text) return;
    const sp: MdSpan = { text };
    if (flags.bold) sp.bold = true;
    if (flags.italic) sp.italic = true;
    if (flags.strike) sp.strike = true;
    if (flags.code) sp.code = true;
    if (flags.href) sp.href = flags.href;
    spans.push(sp);
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    // картинка: пропускаем с пометкой
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (img) {
      push();
      notes.push(`картинка${img[1] ? ` «${img[1]}»` : ''} (${img[2]}) пропущена`);
      i += img[0].length;
      continue;
    }
    // ссылка [текст](url)
    if (!flags.code && s[i] === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        push();
        spans.push(...scan(m[1], { ...flags, href: m[2] }, notes));
        i += m[0].length;
        continue;
      }
    }
    // инлайн-код: от ` до ближайшего `
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1) {
        push();
        spans.push(...scan(s.slice(i + 1, end), { ...flags, code: true }, notes));
        i = end + 1;
        continue;
      }
    }
    if (!flags.code) {
      if (rest.startsWith('***') || rest.startsWith('___')) {
        push();
        flags.bold = !flags.bold;
        flags.italic = !flags.italic;
        i += 3;
        continue;
      }
      if (rest.startsWith('~~')) {
        push();
        flags.strike = !flags.strike;
        i += 2;
        continue;
      }
      if (rest.startsWith('**') || rest.startsWith('__')) {
        push();
        flags.bold = !flags.bold;
        i += 2;
        continue;
      }
      if (s[i] === '*' || (s[i] === '_' && !/[\p{L}\p{N}]/u.test(s[i - 1] ?? '') && !/\s/.test(s[i + 1] ?? ' '))) {
        push();
        flags.italic = !flags.italic;
        i++;
        continue;
      }
    }
    text += s[i];
    i++;
  }
  push();
  return spans;
}

// ─── Разбор блоков ──────────────────────────────────────────────────────────

const HR = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const FENCE = /^ {0,3}(```|~~~)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

const isTableLine = (l: string): boolean => l.includes('|');

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < l.length; k++) {
    if (l[k] === '\\' && l[k + 1] === '|') {
      cur += '|';
      k++;
    } else if (l[k] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += l[k];
  }
  cells.push(cur.trim());
  return cells;
}

const isSepRow = (l: string): boolean => {
  const cells = splitRow(l);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
};

const STRUCTURAL = /^ {0,3}(?:#{1,6}\s|```|~~~|>)/;

export function parseMd(md: string): MdDoc {
  const lines = md.replace(/\t/g, '  ').split(/\r?\n/);
  const blocks: MdBlock[] = [];
  const notes: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // код-блок
    const fence = FENCE.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[1]}\\s*$`).test(lines[i])) buf.push(lines[i++]);
      i++; // закрывающая (или конец файла — незакрытый блок берём целиком)
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    // заголовок
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, spans: parseInline(h[2], notes) });
      i++;
      continue;
    }
    // горизонтальная линия
    if (HR.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    // таблица: строка с |, за которой разделитель
    if (isTableLine(line) && isSepRow(lines[i + 1] ?? '')) {
      const header = splitRow(line).map((c) => parseInline(c, notes));
      const aligns: MdAlign[] = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        return t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : 'left';
      });
      i += 2;
      const rows: MdLine[][] = [];
      while (i < lines.length && isTableLine(lines[i]) && lines[i].trim()) rows.push(splitRow(lines[i]).map((c) => parseInline(c, notes))), i++;
      const width = header.length;
      const fix = (r: MdLine[]) => Array.from({ length: width }, (_, k) => r[k] ?? []);
      blocks.push({
        kind: 'table',
        aligns: Array.from({ length: width }, (_, k) => aligns[k] ?? 'left'),
        header: fix(header),
        rows: rows.map(fix),
      });
      continue;
    }
    // список: собираем всю цепочку пунктов с вложенностью
    if (LIST.test(line)) {
      const tops: MdList[] = [];
      const frames: { kind: 'ul' | 'ol'; indent: number; list: MdList; item: MdItem | null }[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m) {
          const indent = m[1].length;
          const kind: 'ul' | 'ol' = /[-*+]/.test(m[2]) ? 'ul' : 'ol';
          while (
            frames.length &&
            (frames[frames.length - 1].indent > indent ||
              (frames[frames.length - 1].indent === indent && frames[frames.length - 1].kind !== kind))
          )
            frames.pop();
          const frame = frames[frames.length - 1];
          const item: MdItem = { lines: [parseInline(m[3], notes)], marker: m[2] };
          if (!frame) {
            // новый список верхнего уровня
            const list: MdList = { kind, items: [item] };
            tops.push(list);
            frames.push({ kind, indent, list, item });
          } else if (frame.indent < indent) {
            // вложенный список — ребёнок текущего пункта
            const list: MdList = { kind, items: [item] };
            if (frame.item) frame.item.sub = list;
            else tops.push(list);
            frames.push({ kind, indent, list, item });
          } else {
            // продолжение того же списка
            frame.list.items.push(item);
          }
          frames[frames.length - 1].item = item;
          i++;
          continue;
        }
        // продолжение пункта — непустая строка с отступом от 2
        if (lines[i].trim() && /^ {2,}\S/.test(lines[i]) && frames.length) {
          frames[frames.length - 1].item?.lines.push(parseInline(lines[i].trim(), notes));
          i++;
          continue;
        }
        break;
      }
      for (const t of tops) blocks.push({ kind: t.kind, items: t.items });
      continue;
    }
    // цитата: непустые строки >, подряд — один блок (пустая > строка — разрыв)
    const q = QUOTE.exec(line);
    if (q) {
      const paragraphs: MdLine[] = [];
      while (i < lines.length) {
        const inner = QUOTE.exec(lines[i]);
        if (!inner) break;
        if (inner[1].trim()) paragraphs.push(parseInline(inner[1], notes));
        i++;
      }
      blocks.push({ kind: 'quote', paragraphs });
      continue;
    }
    // абзац: строки до пустой или структурной
    const p: MdLine[] = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (STRUCTURAL.test(l) || LIST.test(l) || (isTableLine(l) && isSepRow(lines[i + 1] ?? '')) || HR.test(l)) break;
      p.push(parseInline(l, notes));
      i++;
    }
    blocks.push({ kind: 'p', lines: p });
  }
  return { blocks, notes };
}

// ─── Сборка markdown из HTML (выдача mammoth из docx) ──────────────────────

const escapeMd = (t: string): string => t.replace(/[\\`*_~[\]]/g, '\\$&');

/** HTML (фрагмент от mammoth) → markdown + пометки о пропущенном. */
export function htmlToMd(html: string): MdText {
  const dom = new JSDOM(`<body>${html}</body>`);
  const notes: string[] = [];
  const out: string[] = [];
  for (const el of dom.window.document.body.children) {
    const block = blockToMd(el as Element, notes);
    if (block) out.push(block);
  }
  return { md: out.filter((s) => s.trim()).join('\n\n'), notes };
}

function blockToMd(el: Element, notes: string[]): string {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inlineToMd(el, notes).trim()}`;
  if (tag === 'p') return inlineToMd(el, notes).trim();
  if (tag === 'blockquote') {
    const inner = inlineToMd(el, notes).trim();
    return inner
      .split('\n')
      .map((l) => `> ${l}`.trimEnd())
      .join('\n');
  }
  if (tag === 'ul' || tag === 'ol') return listToMd(el, notes, 0, tag === 'ol');
  if (tag === 'table') return tableToMd(el, notes);
  const inline = inlineToMd(el, notes).trim();
  return inline;
}

function listToMd(el: Element, notes: string[], depth: number, ordered: boolean): string {
  const pad = '  '.repeat(depth);
  const out: string[] = [];
  let n = 1;
  for (const li of el.children) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    // вложенные списки вынимаем из текста пункта и выводим после него
    const subs = [...li.children].filter((c) => /^(ul|ol)$/i.test(c.tagName));
    for (const sub of subs) sub.remove();
    const marker = ordered ? `${n}. ` : '- ';
    n++;
    const text = inlineToMd(li, notes).trim();
    const lines = text.split('\n');
    out.push(pad + marker + (lines[0] ?? ''));
    for (const l of lines.slice(1)) out.push(`${pad}  ${l}`.trimEnd());
    for (const sub of subs) out.push(listToMd(sub, notes, depth + 1, sub.tagName.toLowerCase() === 'ol'));
  }
  return out.join('\n');
}

function tableToMd(el: Element, notes: string[]): string {
  const allRows = [...el.querySelectorAll('tr')];
  if (allRows.length === 0) return '';
  // шапка — строка из thead; если thead нет (mammoth так пишет) — первая строка
  const headRow = allRows.find((tr) => tr.parentElement?.tagName.toLowerCase() === 'thead') ?? allRows[0];
  const bodyRows = allRows.filter((tr) => tr !== headRow);
  const cellsOf = (tr: Element) =>
    [...tr.children].filter((c) => /^(td|th)$/i.test(c.tagName)).map((c) => inlineToMd(c, notes).replace(/\n/g, ' ').trim() || ' ');
  const head = cellsOf(headRow);
  const width = Math.max(1, head.length, ...bodyRows.map((r) => cellsOf(r).length));
  const fix = (cells: string[]) => Array.from({ length: width }, (_, k) => cells[k] ?? ' ');
  const rows = [fix(head), Array.from({ length: width }, () => ' --- '), ...bodyRows.map((r) => fix(cellsOf(r)))];
  return rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

/** Инлайн-содержимое элемента → markdown-строка (<br> → перенос строки). */
function inlineToMd(el: Element, notes: string[]): string {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      out += escapeMd(node.textContent ?? '');
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    const inner = () => inlineToMd(child, notes);
    if (tag === 'br') out += '\n';
    else if (tag === 'strong' || tag === 'b') out += `**${inner().trim()}**`;
    else if (tag === 'em' || tag === 'i') out += `*${inner().trim()}*`;
    else if (tag === 'del' || tag === 's' || tag === 'strike') out += `~~${inner().trim()}~~`;
    else if (tag === 'a') {
      const href = child.getAttribute('href') ?? '';
      const text = inner().trim();
      out += href ? `[${text || href}](${href})` : text;
    } else if (tag === 'img') {
      const alt = child.getAttribute('alt') ?? '';
      notes.push(`картинка${alt ? ` «${alt}»` : ''} пропущена`);
    } else if (tag === 'code') out += `\`${child.textContent ?? ''}\``;
    else out += inner();
  }
  return out;
}
