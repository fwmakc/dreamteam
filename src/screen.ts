/** Строк зоны подсказок между чатом и вводом */
export const HINT_ROWS = 5;
/** Пустых строк ниже поля ввода */
export const BOTTOM_PAD = 2;
/** Хвост истории чата в памяти экрана (строк) */
const CHAT_CAP = 4000;

/** Только CSI-последовательности (цвета и позиционирование), иных не выводим */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Первые width видимых колонок строки (ANSI-последовательности сохраняются) */
function clipAnsi(s: string, width: number): string {
  let out = '';
  let w = 0;
  for (const m of s.matchAll(/(\x1b\[[0-9;]*[A-Za-z])|([\s\S])/g)) {
    if (m[1] !== undefined) {
      out += m[1];
      continue;
    }
    if (w + visibleWidth(m[2]!) > width) break;
    out += m[2]!;
    w += visibleWidth(m[2]!);
  }
  return out;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Видимая ширина строки: ANSI не считается, CJK/эмодзи — 2 колонки */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

export interface AnsiCell {
  /** Накопленный цвет к началу ячейки (полные SGR-последовательности) */
  sgr: string;
  ch: string;
  /** Начальная видимая колонка ячейки (0-based) */
  col: number;
  width: number;
}

/** Разбор строки на видимые ячейки с накопленным цветом — для выделения */
export function splitCells(line: string): AnsiCell[] {
  const cells: AnsiCell[] = [];
  let sgr = '';
  let col = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(line.slice(i));
      if (m) {
        if (m[0].endsWith('m')) sgr = m[0] === '\x1b[0m' ? '' : sgr + m[0];
        i += m[0].length;
        continue;
      }
      i++; // не-CSI escape — пропускаем
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const width = isWide(cp) ? 2 : 1;
    cells.push({ sgr, ch, col, width });
    col += width;
    i += ch.length;
  }
  return cells;
}

/**
 * Перенос по словам: строка режется на пробелах; слово длиннее строки —
 * по символам. Активный цвет переносится на следующую строку (и закрывается
 * reset-ом в конце каждой, чтобы очистка строки не разносила цвет).
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width < 8) width = 8;
  const lines: string[] = [];
  let line = '';
  let lineW = 0;
  let sgr = '';
  let space = '';
  let spaceW = 0;
  const push = (): void => {
    lines.push(sgr && line ? line + '\x1b[0m' : line);
    line = '';
    lineW = 0;
    space = '';
    spaceW = 0;
  };
  const re = /(\x1b\[[0-9;]*[A-Za-z])|([^\s\x1b]+)|(\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      line += m[1];
      if (m[1].endsWith('m')) sgr = m[1] === '\x1b[0m' ? '' : sgr + m[1];
      continue;
    }
    if (m[2] !== undefined) {
      const word = m[2];
      const wordW = visibleWidth(word);
      if (lineW + spaceW + wordW <= width) {
        line += space + word;
        lineW += spaceW + wordW;
      } else {
        if (line) push();
        line = sgr;
        if (wordW > width) {
          let chunk = sgr;
          let w = 0;
          for (const ch of word) {
            const cw = visibleWidth(ch);
            if (w + cw > width) {
              lines.push(sgr ? chunk + '\x1b[0m' : chunk);
              chunk = sgr;
              w = 0;
            }
            chunk += ch;
            w += cw;
          }
          line = chunk;
          lineW = w;
        } else {
          line += word;
          lineW = wordW;
        }
      }
      space = '';
      spaceW = 0;
      continue;
    }
    space = m[3];
    spaceW = visibleWidth(space);
  }
  if (line || lines.length === 0) push();
  return lines;
}

/**
 * Управляемый экран в альтернативном буфере терминала. Снизу вверх:
 *   [чат: панель со scroll-region — вывод прокручивается внутри неё]
 *   [HINT_ROWS строк подсказок; нижняя — строка статуса/спиннера]
 *   [поле ввода: 1+ строк, редактор]
 *   [BOTTOM_PAD пустых строк]
 * Всплывашка @упоминаний рисуется поверх зоны подсказок (и при нужде —
 * над ней, поверх чата; при закрытии эти строки перерисовываются из состояния).
 */
export class Screen {
  readonly width: number;
  /** Отступы по краям: слева/справа в колонках, сверху в строках */
  readonly margin: number;
  /** Ширина контента между отступами */
  readonly inner: number;
  private height: number;
  private chat: string[] = [];
  /** Недописанная строка стрима целиком (после неё \n ещё не приходил) */
  private liveLine = '';
  /** Живая строка, разбитая на визуальные строки; в панели показывается хвост */
  private liveWrapped: string[] = [];
  private liveWrapW = -1;
  private hints: string[] | null = null;
  private status: string | null = null;
  private overlayLines: string[] = [];
  private overlayTop = 1;
  private inputLines: string[] = [''];
  private inputCur = { row: 0, col: 0 };
  /** Границы зон, строки 1-based */
  private chatTop = 1;
  private chatBot = 1;
  private hintsTop = 1;
  private hintsRows = HINT_ROWS;
  private inputTop = 1;
  /** Куда пишется следующая строка чата */
  private paneRow = 1;
  /** Насколько строк вид выше хвоста истории (0 — следим за хвостом) */
  private viewOffset = 0;
  private stopped = false;
  private onResize: () => void;

  constructor(private out: NodeJS.WriteStream, width: number, margin = 0) {
    this.width = Math.max(20, Math.min(width, out.columns || width));
    this.margin = Math.max(0, Math.min(margin, Math.floor((this.width - 24) / 2)));
    this.inner = Math.max(8, this.width - 2 * this.margin);
    this.height = out.rows || 24;
    this.onResize = () => {
      this.height = this.out.rows || this.height;
      this.relayout();
    };
  }

  start(): void {
    this.w('\x1b[?1049h\x1b[?2004h');
    // мышь: кнопки + протяжка кнопкой + SGR-расширение (колесо, клики,
    // выделение перетаскиванием)
    this.w('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    this.relayout();
    this.out.on('resize', this.onResize);
    process.on('exit', () => this.stop());
  }

  stop(): void {
    if (this.stopped) return;
    this.out.off('resize', this.onResize);
    // пишем напрямую: w() молчит при stopped, а вернуть терминал нужно обязательно
    this.out.write('\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[r\x1b[?1049l');
    this.stopped = true;
  }

  /**
   * Засеять историю в панель до начала живого вывода: строки попадают
   * в chat[] (с переносом и шапкой), затем панель перерисовывается разом —
   * при старте видно хвост прошлого разговора, всё старое доступно прокруткой.
   */
  seed(lines: string[]): void {
    for (const l of lines) {
      for (const wrapped of wrapAnsi(l, this.inner)) {
        this.chat.push(wrapped);
        if (this.chat.length > CHAT_CAP) this.chat.shift();
      }
    }
    this.repaintPane();
    this.paintHints();
    this.placeCursor();
  }

  /**
   * Заменить историю в панели: открыли другой разговор — старые строки,
   * прокрутка и выделение к нему больше не относятся.
   */
  reseed(lines: string[]): void {
    this.chat = [];
    this.viewOffset = 0;
    this.clearSelection();
    this.seed(lines);
  }

  /** Полная перерисовка всех зон из состояния — страховка от потерянных кадров */
  repaint(): void {
    this.repaintPane();
    this.paintHints();
    const overlay = this.overlayLines;
    this.overlayLines = [];
    this.setOverlay(overlay.length > 0 ? overlay : null);
    this.paintInput();
    this.placeCursor();
  }

  /** Прокрутка истории: up — к старым, down — к свежим */
  scrollUp(lines = 3): void {    const paneH = this.chatBot - this.chatTop + 1;
    const max = Math.max(0, this.chat.length - paneH);
    const next = Math.min(this.viewOffset + lines, max);
    if (next === this.viewOffset) return;
    this.viewOffset = next;
    this.repaintPane();
    this.paintHints();
    this.placeCursor();
  }

  scrollDown(lines = 3): void {
    if (this.viewOffset === 0) return;
    this.viewOffset = Math.max(0, this.viewOffset - lines);
    this.repaintPane();
    this.paintHints();
    this.placeCursor();
  }

  /** В самое начало истории (Ctrl+PgUp) */
  scrollToStart(): void {
    const paneH = this.chatBot - this.chatTop + 1;
    const max = Math.max(0, this.chat.length - paneH);
    if (this.viewOffset === max) return;
    this.viewOffset = max;
    this.repaintPane();
    this.paintHints();
    this.placeCursor();
  }

  /** К свежим сообщениям, живой режим (Ctrl+PgDn) */
  scrollToEnd(): void {
    if (this.viewOffset === 0) return;
    this.viewOffset = 0;
    this.repaintPane();
    this.paintHints();
    this.placeCursor();
  }

  // --- Выделение фрагмента (мышь и Shift+стрелки) ---

  private selAnchor: { line: number; col: number } | null = null;
  private selHead: { line: number; col: number } | null = null;

  /** Нормализованный диапазон выделения; свёрнутый/пустой — null */
  private selRange(): { a: { line: number; col: number }; b: { line: number; col: number } } | null {
    if (!this.selAnchor || !this.selHead) return null;
    const p = this.selAnchor;
    const q = this.selHead;
    const before =
      p.line < q.line || (p.line === q.line && p.col <= q.col) ? { a: p, b: q } : { a: q, b: p };
    if (before.a.line === before.b.line && before.a.col === before.b.col) return null;
    return before;
  }

  hasSelection(): boolean {
    return this.selRange() !== null;
  }

  /** Текст выделения без ANSI-кодов; ничего не выделено — пустая строка */
  selectedText(): string {
    const r = this.selRange();
    if (!r) return '';
    const out: string[] = [];
    for (let line = r.a.line; line <= r.b.line; line++) {
      if (line < 0) continue;
      const cells = splitCells(this.lineAt(line));
      const from = line === r.a.line ? r.a.col : 0;
      const to = line === r.b.line ? r.b.col : Number.POSITIVE_INFINITY;
      let text = '';
      for (const c of cells) {
        if (c.col + c.width <= from) continue;
        if (c.col >= to) break;
        text += c.ch;
      }
      out.push(text);
    }
    return out.join('\n');
  }

  clearSelection(): void {
    if (!this.selAnchor && !this.selHead) return;
    this.selAnchor = null;
    this.selHead = null;
    this.repaintPane();
  }

  /** Экранная позиция мыши (1-based, как в SGR) → строка chat[] и колонка */
  private selHit(col: number, row: number): { line: number; col: number } | null {
    if (row < this.chatTop || row > this.chatBot) return null;
    const paneH = this.chatBot - this.chatTop + 1;
    const end = this.chat.length - this.viewOffset;
    const chatRows = paneH - this.liveRowsShown(paneH);
    const i = row - this.chatTop;
    const c = Math.max(0, col - 1 - this.margin);
    if (i < chatRows) {
      const idx = end - chatRows + i;
      if (idx < 0 || idx >= this.chat.length) return null;
      return { line: idx, col: c };
    }
    if (this.viewOffset !== 0) return null;
    // строки живого стрима — виртуальные индексы после chat[]
    return { line: this.chat.length + (i - chatRows), col: c };
  }

  /** Мышь: нажатие в панели — точка отсчёта; вне панели — снять выделение */
  selMouseDown(col: number, row: number): void {
    const hit = this.selHit(col, row);
    if (!hit) {
      this.clearSelection();
      return;
    }
    this.selAnchor = hit;
    this.selHead = hit;
    this.repaintPane();
  }

  /** Мышь: протяжка с зажатой кнопкой */
  selMouseDrag(col: number, row: number): void {
    if (!this.selAnchor) return;
    const hit = this.selHit(col, row);
    if (!hit) return;
    if (this.selHead && this.selHead.line === hit.line && this.selHead.col === hit.col) return;
    this.selHead = hit;
    this.repaintPane();
  }

  /** Мышь: отпускание кнопки. Возвращает текст выделения (пусто — был клик) */
  selMouseUp(): string {
    const text = this.selectedText();
    if (!text) this.clearSelection();
    return text;
  }

  /** Shift+стрелки/Home/End: двигать голову выделения; не было — начать от нижней видимой строки */
  selMoveKeyboard(dir: 'left' | 'right' | 'up' | 'down' | 'home' | 'end'): void {
    const paneH = this.chatBot - this.chatTop + 1;
    const liveK = this.liveRowsShown(paneH);
    if (this.chat.length === 0 && liveK === 0) return;
    const lastLine = this.chat.length + liveK - 1; // живые строки — виртуальные после chat[]
    if (!this.selAnchor || !this.selHead) {
      const end = this.chat.length - this.viewOffset;
      const line = this.viewOffset === 0 ? lastLine : Math.max(0, end - 1);
      this.selAnchor = { line, col: 0 };
      this.selHead = { line, col: 0 };
    }
    const h = { ...this.selHead };
    if (dir === 'up') {
      h.line = Math.max(0, h.line - 1);
    } else if (dir === 'down') {
      h.line = Math.min(lastLine, h.line + 1);
    } else if (dir === 'home') {
      h.col = 0;
    } else if (dir === 'end') {
      h.col = splitCells(this.lineAt(h.line)).reduce((w, c) => w + c.width, 0);
    } else {
      const cells = splitCells(this.lineAt(h.line));
      const bounds = cells.map((c) => c.col);
      if (dir === 'right') {
        const next = bounds.find((b) => b > h.col);
        if (next !== undefined) h.col = next;
        else if (h.line < this.chat.length - 1) {
          h.line++;
          h.col = 0;
        }
      } else {
        const prev = [...bounds].reverse().find((b) => b < h.col);
        if (prev !== undefined) h.col = prev;
        else if (h.line > 0) {
          h.line--;
          h.col = splitCells(this.chat[h.line] ?? '').reduce((w, c) => w + c.width, 0);
        }
      }
    }
    // голова ушла за край окна — подтянуть вид на строку (виртуальные строки стрима не скроллят)
    const end = this.chat.length - this.viewOffset;
    if (h.line < end - paneH) this.scrollUp(1);
    else if (h.line < this.chat.length && h.line >= end) this.scrollDown(1);
    this.selHead = h;
    this.repaintPane();
    this.placeCursor();
  }

  /** Строка панели для отрисовки: с реверсом на выделенном диапазоне */
  private paneLineText(idx: number): string {
    const line = this.lineAt(idx);
    const r = this.selRange();
    if (!r || idx < r.a.line || idx > r.b.line) return line;
    const from = idx === r.a.line ? r.a.col : 0;
    const to = idx === r.b.line ? r.b.col : Number.POSITIVE_INFINITY;
    let out = '';
    for (const c of splitCells(line)) {
      const on = c.col + c.width > from && c.col < to;
      out += on ? `\x1b[7m${c.sgr}${c.ch}\x1b[27m` : c.sgr + c.ch;
    }
    return out;
  }


  /** Перерисовать панель чата целиком из окна просмотра */
  /** Перенос живой строки под текущую ширину панели (лениво, при смене ширины) */
  private ensureLiveWrapped(): void {
    if (!this.liveLine) {
      this.liveWrapped = [];
      this.liveWrapW = -1;
    } else if (this.liveWrapW !== this.inner) {
      this.liveWrapped = wrapAnsi(this.liveLine, this.inner);
      this.liveWrapW = this.inner;
    }
  }

  /** Сколько нижних строк панели занято живой строкой (0 — стрим не виден) */
  private liveRowsShown(paneH: number): number {
    if (!this.liveLine || this.viewOffset !== 0) return 0;
    this.ensureLiveWrapped();
    return Math.max(1, Math.min(this.liveWrapped.length, paneH));
  }

  /** chat[idx] либо (для виртуальных строк стрима) соответствующая живая строка */
  private lineAt(idx: number): string {
    if (idx < this.chat.length) return this.chat[idx] ?? '';
    const paneH = this.chatBot - this.chatTop + 1;
    const skip = this.liveWrapped.length - this.liveRowsShown(paneH);
    return this.liveWrapped[skip + (idx - this.chat.length)] ?? '';
  }

  /** Строка панели: видимые строки chat[] либо хвост живого стрима */
  private paneRowText(r: number, paneH: number, end: number, chatRows: number): string {
    const i = r - this.chatTop;
    if (i < chatRows) {
      const idx = end - chatRows + i;
      return idx >= 0 && idx < this.chat.length ? this.paneLineText(idx) : '';
    }
    return this.paneLineText(this.chat.length + (i - chatRows));
  }

  private repaintPane(): void {
    const paneH = this.chatBot - this.chatTop + 1;
    const end = this.chat.length - this.viewOffset;
    const chatRows = paneH - this.liveRowsShown(paneH);
    for (let r = 0; r < paneH; r++) {
      this.pos(this.chatTop + r, 1 + this.margin);
      this.w('\x1b[2K' + this.paneRowText(this.chatTop + r, paneH, end, chatRows));
    }
    this.paneRow = Math.min(this.chatTop + Math.min(Math.max(end, 0), chatRows), this.chatBot);
  }

  /** Универсальный вывод: полный текст (переносится) или кусок стрима */
  push(text: string): void {
    if (!text) return;
    let pending = this.liveLine + text;
    this.liveLine = '';
    this.liveWrapped = [];
    this.liveWrapW = -1;
    let i = pending.indexOf('\n');
    if (i !== -1) {
      // виртуальные строки стрима сейчас уйдут в chat[] — выделение на них сбрасываем
      const selMax = Math.max(this.selAnchor?.line ?? -1, this.selHead?.line ?? -1);
      if (selMax >= this.chat.length) this.clearSelection();
    }
    let committed = false;
    while (i !== -1) {
      this.liveLine += pending.slice(0, i);
      pending = pending.slice(i + 1);
      for (const l of wrapAnsi(this.liveLine, this.inner)) this.commit(l, true);
      this.liveLine = '';
      i = pending.indexOf('\n');
      committed = true;
    }
    this.liveLine = pending;
    this.ensureLiveWrapped();
    // живой блок рисует сама перерисовка панели (хвост до высоты панели)
    if (this.viewOffset === 0 && (committed || this.liveLine)) this.repaintPane();
    this.placeCursor();
  }

  /** Подсказки под вводом (команды и т.п.); null — очистить */
  setHints(rows: string[] | null): void {
    this.hints = rows;
    this.paintHints();
    this.placeCursor();
  }

  /** Строка статуса/спиннера — нижняя строка зоны подсказок; null — убрать */
  setStatus(text: string | null): void {
    this.status = text;
    this.paintHints();
    this.placeCursor();
  }

  /** Всплывашка над полем ввода; null — закрыть и перерисовать закрытое */
  setOverlay(rows: string[] | null): void {
    const old = this.overlayLines;
    this.overlayLines = [];
    if (old.length > 0) this.repaintRows(this.overlayTop, this.overlayTop + old.length - 1);
    if (rows && rows.length > 0) {
      const fit = Math.max(0, this.inputTop - 1 - this.margin);
      const shown = rows.length > fit ? rows.slice(rows.length - fit) : rows;
      this.overlayLines = shown;
      this.overlayTop = this.inputTop - shown.length;
      for (let i = 0; i < shown.length; i++) {
        this.pos(this.overlayTop + i, 1 + this.margin);
        this.w('\x1b[2K' + clipAnsi(shown[i], this.inner));
      }
    }
    this.placeCursor();
  }

  /** Редактор отдал свои видимые строки и позицию курсора */
  setInput(lines: string[], row: number, col: number): void {
    const changedRows = lines.length !== this.inputLines.length;
    this.inputLines = lines;
    this.inputCur = { row, col };
    if (changedRows) this.relayout();
    else {
      this.paintInput();
      this.placeCursor();
    }
  }

  private relayout(): void {
    const h = this.height;
    const inputRows = Math.max(1, this.inputLines.length);
    let pad = BOTTOM_PAD;
    let hintsRows = HINT_ROWS;
    if (inputRows + hintsRows + pad + this.margin + 1 > h) hintsRows = Math.max(0, h - this.margin - inputRows - pad - 1);
    if (inputRows + hintsRows + pad + this.margin + 1 > h) pad = Math.max(0, h - this.margin - inputRows - hintsRows - 1);
    const inputTop0 = Math.max(this.margin, h - pad - inputRows);
    const hintsTop0 = Math.max(this.margin, inputTop0 - hintsRows);
    const chatBot0 = Math.max(this.margin, hintsTop0 - 1);
    this.hintsRows = hintsRows;
    this.hintsTop = hintsTop0 + 1;
    this.inputTop = inputTop0 + 1;
    this.chatBot = chatBot0 + 1;
    this.chatTop = this.margin + 1;
    // после resize панель могла стать ниже — offset не больше, чем есть истории
    const paneH = this.chatBot - this.chatTop + 1;
    this.viewOffset = Math.min(this.viewOffset, Math.max(0, this.chat.length - paneH));

    this.w('\x1b[2J');
    // прокрутка только внутри панели чата (ниже верхнего отступа)
    this.w(`\x1b[${this.chatTop};${this.chatBot}r`);
    this.repaintPane();
    this.paintHints();
    const overlay = this.overlayLines;
    this.overlayLines = [];
    this.setOverlay(overlay.length > 0 ? overlay : null);
    this.paintInput();
    this.placeCursor();
  }

  private commit(line: string, silent = false): void {
    this.chat.push(line);
    if (this.chat.length > CHAT_CAP) {
      this.chat.shift();
      // выделение привязано к индексам chat[] — строки сдвинулись на 1
      for (const p of [this.selAnchor, this.selHead]) {
        if (!p) continue;
        p.line--;
        if (p.line < 0) {
          this.selAnchor = null;
          this.selHead = null;
        }
      }
    }
    if (this.viewOffset > 0) {
      // вид приколот к просматриваемым строкам: новое уходит ниже окна
      this.viewOffset++;
      this.paintHints(); // счётчик «выше на N»
      return;
    }
    if (silent) return; // отрисовку делает repaintPane вызывающего
    this.pos(this.paneRow, 1 + this.margin);
    this.w(line + '\x1b[K\n');
    if (this.paneRow < this.chatBot) this.paneRow++;
  }

  private paintHints(): void {
    // строки, занятые всплывашкой, не трогаем — закроется, перерисуем из состояния
    const ovTop = this.overlayTop;
    const ovBot = this.overlayTop + this.overlayLines.length - 1;
    const scrollNote =
      this.viewOffset > 0
        ? `\x1b[2m  ↑ история: выше ещё на ${this.viewOffset} стр. · PgDn или колесо вниз — к свежим\x1b[22m`
        : null;
    for (let i = 0; i < this.hintsRows; i++) {
      const row = this.hintsTop + i;
      if (this.overlayLines.length > 0 && row >= ovTop && row <= ovBot) continue;
      const bottom = i === this.hintsRows - 1;
      const t = bottom
        ? (this.status ?? scrollNote ?? this.hints?.[i] ?? '')
        : this.hints?.[i] ?? '';
      this.pos(row, 1 + this.margin);
      this.w('\x1b[2K' + clipAnsi(t, this.inner));
    }
  }

  private paintInput(): void {
    for (let i = 0; i < this.inputLines.length; i++) {
      this.pos(this.inputTop + i, 1 + this.margin);
      this.w('\x1b[2K' + this.inputLines[i]);
    }
  }

  /** Перерисовать диапазон строк из состояния (чат/подсказки/ввод) */
  private repaintRows(from: number, to: number): void {
    const paneH = this.chatBot - this.chatTop + 1;
    for (let r = from; r <= to; r++) {
      this.pos(r, 1 + this.margin);
      if (r >= this.chatTop && r <= this.chatBot) {
        const paneH = this.chatBot - this.chatTop + 1;
        const end = this.chat.length - this.viewOffset;
        const chatRows = paneH - this.liveRowsShown(paneH);
        this.w('\x1b[2K' + this.paneRowText(r, paneH, end, chatRows));
      } else if (r >= this.hintsTop && r < this.hintsTop + this.hintsRows) {
        const i = r - this.hintsTop;
        const scrollNote =
          this.viewOffset > 0
            ? `\x1b[2m  ↑ история: выше ещё на ${this.viewOffset} стр. · PgDn или колесо вниз — к свежим\x1b[22m`
            : null;
        const bottom = i === this.hintsRows - 1;
        const t = bottom
          ? (this.status ?? scrollNote ?? this.hints?.[i] ?? '')
          : this.hints?.[i] ?? '';
        this.w('\x1b[2K' + clipAnsi(t, this.inner));
      } else if (r >= this.inputTop && r < this.inputTop + this.inputLines.length) {
        this.w('\x1b[2K' + this.inputLines[r - this.inputTop]);
      } else {
        this.w('\x1b[2K');
      }
    }
  }

  private placeCursor(): void {
    this.pos(this.inputTop + this.inputCur.row, 1 + this.margin + Math.min(this.inputCur.col, this.inner - 1));
  }

  private pos(row: number, col: number): void {
    this.w(`\x1b[${row};${col}H`);
  }

  private w(s: string): void {
    if (!this.stopped) this.out.write(s);
  }
}
