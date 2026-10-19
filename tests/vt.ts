/**
 * Временный мини-эмулятор VT: превращает поток байт в отрисованный экран,
 * чтобы зонды могли проверять не «что ушло в поток», а «что увидит человек».
 * Покрывает коды самого приложения и то, чем ConPTY переупаковывает вывод:
 * CUP/CHA/VPA/CUU/CUD/CUF/CUB, ED, EL, DECSTBM, alt-буфер, SGR (снимается),
 * OSC (пропускается), \n \r \b. Эмодзи считаются одной ячейкой — проверки
 * делают substring по строке, поэтому погрешность не мешает.
 */
export class VtScreen {
  readonly cols: number;
  readonly rows: number;
  private main: string[][] = [];
  private alt: string[][] = [];
  private onAlt = false;
  private cur = { row: 0, col: 0 };
  private saved = { row: 0, col: 0 };
  private regionTop = 0;
  private regionBot: number;
  private pending = '';

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.regionBot = rows - 1;
    this.main = VtScreen.blank(cols, rows);
    this.alt = VtScreen.blank(cols, rows);
  }

  private static blank(cols: number, rows: number): string[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
  }

  private grid(): string[][] {
    return this.onAlt ? this.alt : this.main;
  }

  private csiRe = /^\x1b\[([\?0-9;]*)([A-Za-z@])/;
  private oscRe = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
  private escRe = /^\x1b[=>78cM]/;
  private maybeRe = /^\x1b(\[[\?0-9;]*|\][^\x07\x1b]*|O[A-Za-z]?)?$/;

  feed(chunk: string): void {
    this.pending += chunk;
    let i = 0;
    const s = this.pending;
    while (i < s.length) {
      if (s[i] === '\x1b') {
        const rest = s.slice(i);
        const m = this.csiRe.exec(rest) ?? null;
        const osc = this.oscRe.exec(rest) ?? null;
        const esc = this.escRe.exec(rest) ?? null;
        const seq = m ?? osc ?? esc;
        if (seq) {
          if (m) this.csi(m[1], m[2]);
          i += seq[0].length;
          continue;
        }
        if (this.maybeRe.test(rest)) break; // незавершённая последовательность — ждём чанк
        i++; // одинокий ESC — игнор
        continue;
      }
      this.put(s[i]);
      i++;
    }
    this.pending = s.slice(i);
    if (this.pending.length > 200) this.pending = ''; // защита от мусора
  }

  private csi(params: string, final: string): void {
    const g = this.grid();
    const priv = params.startsWith('?');
    const nums = params
      .replace('?', '')
      .split(';')
      .map((s) => (s === '' ? NaN : Number.parseInt(s, 10)));
    const n0 = (dflt: number): number => (Number.isNaN(nums[0]) ? dflt : nums[0] ?? dflt);
    const n1 = (dflt: number): number => (Number.isNaN(nums[1]) ? dflt : nums[1] ?? dflt);
    switch (final) {
      case 'h':
        if (priv && nums.includes(1049)) {
          this.onAlt = true;
          this.alt = VtScreen.blank(this.cols, this.rows);
          this.cur = { row: 0, col: 0 };
        }
        return;
      case 'l':
        if (priv && nums.includes(1049)) {
          this.onAlt = false;
          this.cur = this.saved;
        }
        return;
      case 'r': {
        const top = Math.max(0, (Number.isNaN(nums[0]) ? 1 : nums[0]) - 1);
        const bot = Math.min(this.rows - 1, (Number.isNaN(nums[1]) ? this.rows : nums[1]) - 1);
        this.regionTop = top;
        this.regionBot = bot;
        this.cur = { row: 0, col: 0 };
        return;
      }
      case 'H':
      case 'f':
        this.cur.row = Math.min(this.rows - 1, Math.max(0, n0(1) - 1));
        this.cur.col = Math.min(this.cols - 1, Math.max(0, n1(1) - 1));
        return;
      case 'G':
        this.cur.col = Math.min(this.cols - 1, Math.max(0, n0(1) - 1));
        return;
      case 'd':
        this.cur.row = Math.min(this.rows - 1, Math.max(0, n0(1) - 1));
        return;
      case 'A':
        this.cur.row = Math.max(this.regionTop, this.cur.row - Math.max(1, n0(1)));
        return;
      case 'B':
        this.cur.row = Math.min(this.regionBot, this.cur.row + Math.max(1, n0(1)));
        return;
      case 'C':
        this.cur.col = Math.min(this.cols - 1, this.cur.col + Math.max(1, n0(1)));
        return;
      case 'D':
        this.cur.col = Math.max(0, this.cur.col - Math.max(1, n0(1)));
        return;
      case 'J': {
        const mode = Number.isNaN(nums[0]) ? 0 : nums[0];
        if (mode === 2 || mode === 3) {
          const blank = VtScreen.blank(this.cols, this.rows);
          if (this.onAlt) this.alt = blank;
          else this.main = blank;
        } else if (mode === 0) {
          this.eraseLine();
          for (let r = this.cur.row + 1; r < this.rows; r++) g[r] = Array.from({ length: this.cols }, () => ' ');
        } else if (mode === 1) {
          for (let c = 0; c <= this.cur.col; c++) g[this.cur.row][c] = ' ';
        }
        return;
      }
      case 'K': {
        const mode = Number.isNaN(nums[0]) ? 0 : nums[0];
        if (mode === 0) for (let c = this.cur.col; c < this.cols; c++) g[this.cur.row][c] = ' ';
        else if (mode === 2) for (let c = 0; c < this.cols; c++) g[this.cur.row][c] = ' ';
        else if (mode === 1) for (let c = 0; c <= this.cur.col; c++) g[this.cur.row][c] = ' ';
        return;
      }
      case 's':
        this.saved = { ...this.cur };
        return;
      case 'u':
        this.cur = { ...this.saved };
        return;
      default:
        return; // m, h/l прочие режимы и т.п. — игнорируем
    }
  }

  private eraseLine(): void {
    const g = this.grid();
    for (let c = this.cur.col; c < this.cols; c++) g[this.cur.row][c] = ' ';
  }

  private scrollUp(): void {
    const g = this.grid();
    for (let r = this.regionTop; r < this.regionBot; r++) g[r] = g[r + 1];
    g[this.regionBot] = Array.from({ length: this.cols }, () => ' ');
  }

  private put(ch: string): void {
    if (ch === '\n') {
      if (this.cur.row === this.regionBot) this.scrollUp();
      else if (this.cur.row < this.rows - 1) this.cur.row++;
      return;
    }
    if (ch === '\r') {
      this.cur.col = 0;
      return;
    }
    if (ch === '\b') {
      this.cur.col = Math.max(0, this.cur.col - 1);
      return;
    }
    if (ch === '\x07' || ch === '\t') return;
    if (ch === '\x1b') return; // одинокий ESC — игнор
    const g = this.grid();
    g[this.cur.row][this.cur.col] = ch;
    if (this.cur.col < this.cols - 1) this.cur.col++;
    else this.cur.col = this.cols - 1;
  }

  /** Отрисованные строки экрана (активного буфера), 1-я строка — индекс 0 */
  lines(): string[] {
    return this.grid().map((row) => row.join('').replace(/\s+$/, ''));
  }

  /** Строка по 1-based номеру */
  line(row1: number): string {
    return this.lines()[row1 - 1] ?? '';
  }
}
