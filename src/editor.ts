import { Screen, stripAnsi, visibleWidth } from './screen.js';

export interface EditorHooks {
  /**
   * Перехват клавиш до редактора: всплывашка @упоминаний и Tab-дополнение.
   * 'handled' — клавиша съедена; {text, cursor} — заменить строку; null —
   * редактор обрабатывает сам (история, перемещение, отправка).
   */
  interceptKey(key: { name: string; sequence: string }): 'handled' | { text: string; cursor: number } | null;
  /** Строка изменилась — обновить всплывашку и подсказки */
  onEdit(buffer: string, cursor: number): void;
  /**
   * Прокрутка истории: колесо мыши (up/down, lines=3), PgUp/PgDn (20),
   * Ctrl+PgUp/Ctrl+PgDn (top/bottom — в начало/к свежим).
   */
  onScroll(dir: 'up' | 'down' | 'top' | 'bottom', lines: number): void;
  /** Мышь над экраном: нажатие/протяжка/отпускание левой кнопки (координаты 1-based, как в SGR) */
  onMouse(type: 'down' | 'drag' | 'up', col: number, row: number): void;
  /** Shift+стрелки/Home/End: движение головы выделения по панели чата */
  onSelectKey(dir: 'left' | 'right' | 'up' | 'down' | 'home' | 'end'): void;
  /** Enter (soft=false) или Ctrl/Alt+Enter (soft=true) */
  onSubmit(line: string, soft: boolean): void;
  /** Ctrl+C: в сыром режиме SIGINT не приходит */
  onCtrlC(): void;
  /** Ctrl+D на пустой строке — конец ввода */
  onEof(): void;
}

function prevCp(s: string, i: number): number {
  if (i <= 0) return 0;
  let j = i - 1;
  while (j > 0 && (s.codePointAt(j)! & 0xfc00) === 0xdc00) j--;
  return j;
}

function nextCp(s: string, i: number): number {
  if (i >= s.length) return s.length;
  const c = s.codePointAt(i)!;
  return i + (c > 0xffff ? 2 : 1);
}

function seqName(seq: string): string | null {
  switch (seq) {
    case '\x1b[A':
    case '\x1bOA':
      return 'up';
    case '\x1b[B':
    case '\x1bOB':
      return 'down';
    case '\x1b[C':
    case '\x1bOC':
      return 'right';
    case '\x1b[D':
    case '\x1bOD':
      return 'left';
    case '\x1b[H':
    case '\x1b[1~':
    case '\x1b[7~':
    case '\x1bOH':
      return 'home';
    case '\x1b[F':
    case '\x1b[4~':
    case '\x1b[8~':
    case '\x1bOF':
      return 'end';
    case '\x1b[3~':
      return 'delete';
    case '\x1b[1;5C': // xterm-модификаторы: 5 = Ctrl
      return 'ctrl+right';
    case '\x1b[1;5D':
      return 'ctrl+left';
    case '\x1b[1;6C': // 6 = Ctrl+Shift
      return 'ctrl+shift+right';
    case '\x1b[1;6D':
      return 'ctrl+shift+left';
    case '\x1b[1;6H': // Ctrl+Shift+Home/End — выделение до начала/конца строки
      return 'ctrl+shift+home';
    case '\x1b[1;6F':
      return 'ctrl+shift+end';
    case '\x1b[5~':
      return 'pageup';
    case '\x1b[6~':
      return 'pagedown';
    case '\x1b[5;5~': // xterm-модификаторы: 5 = Ctrl
    case '\x1b[5^': // rxvt
      return 'ctrl+pageup';
    case '\x1b[6;5~':
    case '\x1b[6^':
      return 'ctrl+pagedown';
    case '\x1b[1;2A': // xterm: 2 = Shift
    case '\x1b[a': // rxvt
      return 'shift+up';
    case '\x1b[1;2B':
    case '\x1b[b':
      return 'shift+down';
    case '\x1b[1;2C':
    case '\x1b[c':
      return 'shift+right';
    case '\x1b[1;2D':
    case '\x1b[d':
      return 'shift+left';
    case '\x1b[1;2H': // xterm
    case '\x1b[7;2~':
    case '\x1b[7$': // rxvt
      return 'shift+home';
    case '\x1b[1;2F': // xterm
    case '\x1b[8;2~':
    case '\x1b[8$': // rxvt
      return 'shift+end';
    default:
      return null;
  }
}

/** Видимые строки ввода: [{текст, индекс первого символа в буфере}] */
export function wrapPlain(
  text: string,
  width: number,
  firstWidth = width,
): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const chars = Array.from(text);
  const widths = chars.map((c) => visibleWidth(c));
  let line = '';
  let lineW = 0;
  let start = 0;
  let limit = Math.max(4, firstWidth);
  const push = (): void => {
    out.push({ text: line, start });
    line = '';
    lineW = 0;
  };
  let i = 0;
  while (i < chars.length) {
    const isSpace = chars[i] === ' ';
    let j = i;
    while (j < chars.length && (chars[j] === ' ') === isSpace) j++;
    const tok = chars.slice(i, j).join('');
    const tokW = widths.slice(i, j).reduce((a, b) => a + b, 0);
    if (isSpace) {
      if (lineW > 0 && lineW + tokW <= limit) {
        line += tok;
        lineW += tokW;
      } else if (lineW > 0) {
        push();
        start = j;
        limit = width;
      }
      i = j;
      continue;
    }
    if (tokW <= limit - lineW) {
      line += tok;
      lineW += tokW;
      i = j;
      continue;
    }
    if (lineW > 0) {
      push();
      start = i;
      limit = width;
    }
    if (tokW <= limit) {
      line = tok;
      lineW = tokW;
      i = j;
      continue;
    }
    // слово длиннее строки — режем по символам
    for (let k = i; k < j; ) {
      let w = 0;
      let k2 = k;
      while (k2 < j && w + widths[k2] <= limit) {
        w += widths[k2];
        k2++;
      }
      line = chars.slice(k, k2).join('');
      push();
      start = k2;
      k = k2;
    }
    i = j;
  }
  if (line || out.length === 0) push();
  return out;
}

/**
 * Редактор строки ввода для управляемого экрана: сырой ввод без readline.
 * Кодпоинты (не режет эмодзи), история (↑/↓), Ctrl+U — очистить, Ctrl+W —
 * удалить слово, Ctrl+←/→ — по словам (Ctrl+Shift+←/→ — выделение по словам),
 * Home/End/Delete, мягкий перенос Ctrl+Enter (LF) и Alt+Enter,
 * вставка из буфера (bracketed paste) — переносы становятся пробелами.
 * Отрисовка целиком живёт в Screen: зоны не мешают друг другу.
 */
export class Editor {
  private buffer = '';
  private cursor = 0;
  /** Якорь выделения в поле ввода; голова — cursor; null — выделения нет */
  private selA: number | null = null;
  private prompt = '';
  private promptW = 0;
  private history: string[] = [];
  private histIdx: number | null = null;
  private draft = '';
  private leftover = '';
  /** Ожидание продолжения escape-последовательности: одиночный \x1b — это Esc */
  private escTimer: NodeJS.Timeout | null = null;
  private pasting = false;
  private dataHandler: (chunk: Buffer | string) => void;

  constructor(
    private hooks: EditorHooks,
    private screen: Screen,
    private stdin: NodeJS.ReadStream,
  ) {
    this.dataHandler = (chunk) => this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }

  start(): void {
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('data', this.dataHandler);
    this.edit();
  }

  stop(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    this.stdin.off('data', this.dataHandler);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
  }  get text(): string {
    return this.buffer;
  }

  /** Есть ли выделение в поле ввода */
  hasSelection(): boolean {
    return this.selBounds() !== null;
  }

  /** Выделенный текст ввода (без цветов); пусто — выделения нет */
  selectionText(): string {
    const b = this.selBounds();
    return b ? this.buffer.slice(b[0], b[1]) : '';
  }

  /** Границы выделения [от, до) или null, если оно схлопнуто/отсутствует */
  private selBounds(): [number, number] | null {
    if (this.selA === null || this.selA === this.cursor) return null;
    return this.selA < this.cursor ? [this.selA, this.cursor] : [this.cursor, this.selA];
  }

  /** Удалить выделение, курсор — в его начало */
  private deleteSel(): void {
    const b = this.selBounds();
    if (!b) return;
    this.buffer = this.buffer.slice(0, b[0]) + this.buffer.slice(b[1]);
    this.cursor = b[0];
    this.selA = null;
  }

  setPrompt(p: string): void {
    this.prompt = p;
    this.promptW = visibleWidth(stripAnsi(p));
    this.edit();
  }

  private apply(text: string, cursor: number): void {
    this.buffer = text;
    this.cursor = cursor;
    this.selA = null;
    this.histIdx = null;
    this.edit();
  }

  private edit(): void {
    this.render();
    this.hooks.onEdit(this.buffer, this.cursor);
  }

  private submit(soft: boolean): void {
    const line = this.buffer;
    if (line.trim() && this.history[this.history.length - 1] !== line) this.history.push(line);
    this.buffer = '';
    this.cursor = 0;
    this.selA = null;
    this.histIdx = null;
    this.draft = '';
    this.edit();
    this.hooks.onSubmit(line, soft);
  }

  private onData(chunk: string): void {
    // новые байты либо достроят последовательность, либо сами по себе клавиши —
    // ожидание одиночного \x1b отменяется
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    let s = this.leftover + chunk;
    this.leftover = '';
    let dirty = false;
    while (s.length > 0) {
      if (this.pasting) {
        const end = s.indexOf('\x1b[201~');
        if (end === -1) {
          this.insert(s.replace(/\r\n?|\n/g, ' '));
          dirty = true;
          s = '';
          break;
        }
        this.insert(s.slice(0, end).replace(/\r\n?|\n/g, ' '));
        dirty = true;
        s = s.slice(end + 6);
        this.pasting = false;
        continue;
      }
      if (s.startsWith('\x1b[200~')) {
        this.pasting = true;
        s = s.slice(6);
        continue;
      }
      // Alt+Enter — мягкий перенос (readline считал бы это обычным Enter)
      if (s.startsWith('\x1b\r') || s.startsWith('\x1b\n')) {
        this.submit(true);
        dirty = true;
        s = s.slice(2);
        continue;
      }
      // мышь: SGR-режим \x1b[<b;x;yM/m — колёсико 64=вверх, 65=вниз,
      // левая кнопка: 0=нажатие, 32=протяжка, 'm'=отпускание
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (mouse) {
        const btn = Number(mouse[1]);
        const col = Number(mouse[2]);
        const row = Number(mouse[3]);
        if (mouse[4] === 'M' && (btn === 64 || btn === 65)) {
          this.hooks.onScroll(btn === 64 ? 'up' : 'down', 3);
          dirty = true;
        } else if (mouse[4] === 'M' && btn === 0) {
          this.hooks.onMouse('down', col, row);
        } else if (mouse[4] === 'M' && btn === 32) {
          this.hooks.onMouse('drag', col, row);
        } else if (mouse[4] === 'm' && btn === 0) {
          this.hooks.onMouse('up', col, row);
        }
        s = s.slice(mouse[0].length);
        continue;
      }
      // мышь в старом X10-режиме: \x1b[M + 3 байта (кнопка/колесо, x, y);
      // протяжку X10 не умеет — только нажатие (0) и отпускание (3)
      if (s.startsWith('\x1b[M')) {
        if (s.length < 6) {
          this.leftover = s; // ждём остальные байты события
          break;
        }
        const btn = s.charCodeAt(3) - 32;
        const col = s.charCodeAt(4) - 32;
        const row = s.charCodeAt(5) - 32;
        if (btn === 64 || btn === 65) {
          this.hooks.onScroll(btn === 64 ? 'up' : 'down', 3);
          dirty = true;
        } else if (btn === 0) {
          this.hooks.onMouse('down', col, row);
        } else if (btn === 3) {
          this.hooks.onMouse('up', col, row);
        }
        s = s.slice(6);
        continue;
      }
      const seq = /^(\x1b\[<?[0-9;]*[~A-Za-z^$]|\x1bO[A-Za-z]|\x1b[\x20-\x3f\x5b-\x7f]?)/.exec(s);
      if (seq && seq[1]) {
        // обрезок escape-последовательности — ждём продолжение следующим чанком
        if (/^\x1b(\[<?[0-9;]*|O[A-Za-z]?)?$/.test(s) && s.length > 1) {
          this.leftover = s;
          break;
        }
        if (seq[1] === '\x1b' && s.length === 1) {
          // одиночный \x1b: ждём продолжение (стрелка/F-клавиша), а если оно
          // не пришло — это нажатие Esc
          this.leftover = s;
          if (!this.escTimer) {
            this.escTimer = setTimeout(() => {
              this.escTimer = null;
              if (this.leftover === '\x1b') {
                this.leftover = '';
                this.key('\x1b');
                this.edit();
              }
            }, 80);
          }
          break;
        }
        this.key(seq[1]);
        dirty = true;
        s = s.slice(seq[1].length);
        continue;
      }
      const code = s.codePointAt(0)!;
      const ch = String.fromCodePoint(code);
      s = s.slice(code > 0xffff ? 2 : 1);
      // известные control-клавиши обрабатывает key(), прочие control — игнор
      if (
        code === 0x03 ||
        code === 0x04 ||
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x15 ||
        code === 0x17 ||
        code === 0x7f
      ) {
        this.key(ch);
        dirty = true;
        continue;
      }
      if (code < 0x20) continue;
      this.insert(ch);
      dirty = true;
    }
    if (dirty) this.edit();
  }

  private key(seq: string): void {
    const name = seqName(seq);
    if (name) {
      const stolen = this.hooks.interceptKey({ name, sequence: seq });
      if (stolen === 'handled') return;
      if (stolen) {
        this.apply(stolen.text, stolen.cursor);
        return;
      }
      switch (name) {
        case 'up':
          this.histPrev();
          return;
        case 'down':
          this.histNext();
          return;
        case 'left':
          // выделение есть — схлопнуть к его началу, без движения
          if (this.selA !== null) {
            this.cursor = this.selBounds()![0];
            this.selA = null;
          } else this.cursor = prevCp(this.buffer, this.cursor);
          return;
        case 'right':
          if (this.selA !== null) {
            this.cursor = this.selBounds()![1];
            this.selA = null;
          } else this.cursor = nextCp(this.buffer, this.cursor);
          return;
        case 'home':
          if (this.selA !== null) {
            this.cursor = this.selBounds()![0];
            this.selA = null;
          } else this.cursor = 0;
          return;
        case 'end':
          if (this.selA !== null) {
            this.cursor = this.selBounds()![1];
            this.selA = null;
          } else this.cursor = this.buffer.length;
          return;
        case 'delete':
          if (this.selA !== null) {
            this.deleteSel();
            return;
          }
          if (this.cursor < this.buffer.length) {
            const n = nextCp(this.buffer, this.cursor);
            this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(n);
          }
          return;
        case 'pageup':
          this.hooks.onScroll('up', 20);
          return;
        case 'pagedown':
          this.hooks.onScroll('down', 20);
          return;
        case 'ctrl+pageup':
          this.hooks.onScroll('top', 0);
          return;
        case 'ctrl+pagedown':
          this.hooks.onScroll('bottom', 0);
          return;
        case 'ctrl+left':
        case 'ctrl+right':
          // выделение есть — схлопнуть к его началу/концу, без движения
          if (this.selA !== null) {
            const b = this.selBounds()!;
            this.cursor = name === 'ctrl+left' ? b[0] : b[1];
            this.selA = null;
          } else {
            this.cursor = name === 'ctrl+left' ? this.wordBack(this.cursor) : this.wordFwd(this.cursor);
          }
          return;
        case 'ctrl+shift+left':
        case 'ctrl+shift+right':
        case 'ctrl+shift+home':
        case 'ctrl+shift+end':
          // выделение по словам (или до края) в набираемом сообщении
          if (this.selA === null) this.selA = this.cursor;
          if (name === 'ctrl+shift+home') this.cursor = 0;
          else if (name === 'ctrl+shift+end') this.cursor = this.buffer.length;
          else this.cursor = name === 'ctrl+shift+left' ? this.wordBack(this.cursor) : this.wordFwd(this.cursor);
          if (this.selA === this.cursor) this.selA = null; // схлопнулось
          return;
        case 'shift+up':
        case 'shift+down':
        case 'shift+left':
        case 'shift+right':
        case 'shift+home':
        case 'shift+end':
          // непустой ввод — выделяем набираемое сообщение; пустой — историю чата
          this.selectMove(name.slice(6) as 'up' | 'down' | 'left' | 'right' | 'home' | 'end');
          return;
        default:
          return;
      }
    }
    if (seq === '\r') {
      this.submit(false);
      return;
    }
    if (seq === '\n' || seq === '\x1b\r' || seq === '\x1b\n') {
      this.submit(true); // Ctrl+Enter (LF) или Alt+Enter
      return;
    }
    if (seq === '\x7f' || seq === '\x08') {
      if (this.selA !== null) {
        this.deleteSel();
        return;
      }
      if (this.cursor > 0) {
        const p = prevCp(this.buffer, this.cursor);
        this.buffer = this.buffer.slice(0, p) + this.buffer.slice(this.cursor);
        this.cursor = p;
      }
      return;
    }
    if (seq === '\x03') {
      this.hooks.onCtrlC();
      return;
    }
    if (seq === '\x04') {
      if (!this.buffer) this.hooks.onEof();
      else this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(nextCp(this.buffer, this.cursor));
      return;
    }
    if (seq === '\x15') {
      this.buffer = '';
      this.cursor = 0;
      return;
    }
    if (seq === '\x17' || seq === '\x1b\x7f') {
      if (this.selA !== null) {
        this.deleteSel();
        return;
      }
      this.deleteWord();
      return;
    }
    if (seq === '\x1b') {
      // Esc сначала снимает выделение ввода, затем отдаётся хукам (всплывашка, панель)
      if (this.selA !== null) {
        this.selA = null;
        return;
      }
      const stolen = this.hooks.interceptKey({ name: 'escape', sequence: seq });
      if (stolen === 'handled') return;
      if (stolen) this.apply(stolen.text, stolen.cursor);
      return;
    }
    if (seq === '\t') {
      const stolen = this.hooks.interceptKey({ name: 'tab', sequence: seq });
      if (stolen === 'handled') return;
      if (stolen) this.apply(stolen.text, stolen.cursor);
      return;
    }
  }

  private insert(text: string): void {
    this.deleteSel();
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  private deleteWord(): void {
    let i = this.cursor;
    while (i > 0 && this.buffer[i - 1] === ' ') i--;
    while (i > 0 && this.buffer[i - 1] !== ' ') i = prevCp(this.buffer, i);
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cursor);
    this.cursor = i;
  }

  /** Начало слова левее курсора (Ctrl+←): пробелы, потом слово — как deleteWord, но без удаления */
  private wordBack(i: number): number {
    let j = i;
    while (j > 0 && this.buffer[j - 1] === ' ') j--;
    while (j > 0 && this.buffer[j - 1] !== ' ') j = prevCp(this.buffer, j);
    return j;
  }

  /** Правее курсора: через слово и пробелы за ним — курсор встаёт перед следующим словом (Ctrl+→) */
  private wordFwd(i: number): number {
    let j = i;
    while (j < this.buffer.length && this.buffer[j] === ' ') j = nextCp(this.buffer, j);
    while (j < this.buffer.length && this.buffer[j] !== ' ') j = nextCp(this.buffer, j);
    while (j < this.buffer.length && this.buffer[j] === ' ') j = nextCp(this.buffer, j);
    return j;
  }

  private histPrev(): void {
    // первый ↑ при выделении — только снять его
    if (this.selA !== null) {
      this.selA = null;
      return;
    }
    if (this.history.length === 0) return;
    if (this.histIdx === null) {
      this.draft = this.buffer;
      this.histIdx = this.history.length;
    }
    if (this.histIdx > 0) {
      this.histIdx--;
      this.buffer = this.history[this.histIdx];
      this.cursor = this.buffer.length;
    }
  }

  private histNext(): void {
    if (this.selA !== null) {
      this.selA = null;
      return;
    }
    if (this.histIdx === null) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = null;
      this.buffer = this.draft;
    } else {
      this.buffer = this.history[this.histIdx];
    }
    this.cursor = this.buffer.length;
  }

  /**
   * Shift+клавиши: двигать голову выделения ввода (якорь — где был курсор).
   * Пустой ввод нечего выделять — клавиши уходят в выделение истории чата.
   */
  private selectMove(dir: 'up' | 'down' | 'left' | 'right' | 'home' | 'end'): void {
    if (!this.buffer) {
      this.hooks.onSelectKey(dir);
      return;
    }
    if (this.selA === null) this.selA = this.cursor;
    if (dir === 'home') {
      this.cursor = 0;
    } else if (dir === 'end') {
      this.cursor = this.buffer.length;
    } else if (dir === 'left') {
      if (this.cursor > 0) this.cursor = prevCp(this.buffer, this.cursor);
    } else if (dir === 'right') {
      if (this.cursor < this.buffer.length) this.cursor = nextCp(this.buffer, this.cursor);
    } else {
      // up/down: та же видимая колонка на строке выше/ниже (мягкий перенос)
      const firstW = Math.max(8, this.screen.inner - this.promptW);
      const segs = wrapPlain(this.buffer, this.screen.inner, firstW);
      let idx = segs.length - 1;
      for (let i = 0; i < segs.length; i++) {
        if (this.cursor <= segs[i].start + segs[i].text.length) {
          idx = i;
          break;
        }
      }
      const j = dir === 'up' ? Math.max(0, idx - 1) : Math.min(segs.length - 1, idx + 1);
      const col = this.cursor - segs[idx].start;
      this.cursor = segs[j].start + Math.min(col, segs[j].text.length);
    }
    if (this.selA === this.cursor) this.selA = null; // схлопнулось
  }

  private render(): void {
    const firstW = Math.max(8, this.screen.inner - this.promptW);
    const segs = wrapPlain(this.buffer, this.screen.inner, firstW);
    const sel = this.selBounds();
    const lines = segs.map((s, i) => {
      let text = s.text;
      if (sel) {
        const from = Math.max(sel[0] - s.start, 0);
        const to = Math.min(sel[1] - s.start, s.text.length);
        if (from < to) {
          text = text.slice(0, from) + '\x1b[7m' + text.slice(from, to) + '\x1b[27m' + text.slice(to);
        }
      }
      return (i === 0 ? this.prompt : '') + text;
    });
    let row = segs.length - 1;
    let col = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (this.cursor <= seg.start + seg.text.length || i === segs.length - 1) {
        row = i;
        col = (i === 0 ? this.promptW : 0) + (this.cursor - seg.start);
        break;
      }
    }
    this.screen.setInput(lines, row, col);
  }
}
