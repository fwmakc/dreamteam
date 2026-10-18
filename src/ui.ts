import pc from 'picocolors';
import type { Agent } from './types.js';

const COLORS: Record<string, (s: string) => string> = {
  black: pc.black,
  red: pc.red,
  green: pc.green,
  yellow: pc.yellow,
  blue: pc.blue,
  magenta: pc.magenta,
  cyan: pc.cyan,
  white: pc.white,
  gray: pc.gray,
};

export function colorFn(name?: string): (s: string) => string {
  return (name && COLORS[name.toLowerCase()]) || ((s: string) => s);
}

/** Заголовок реплики агента: цветной «[💾 Глеб]» */
export function agentHeader(agent: Agent): string {
  return colorFn(agent.color)(`[${agent.emoji} ${agent.name}]`);
}

export function rosterLine(agent: Agent): string {
  const c = colorFn(agent.color);
  return `  ${c(`${agent.emoji} ${agent.name}`)} — ${agent.role}${agent.description ? `: ${agent.description}` : ''}`;
}

/**
 * Слив вывода: в управляемом экране весь текст идёт в панель чата,
 * без экрана — в консоль как раньше. Ставится один раз на старте.
 */
let outputSink: ((text: string) => void) | null = null;

export function setOutputSink(fn: (text: string) => void): void {
  outputSink = fn;
}

function outLine(text: string): void {
  if (outputSink) outputSink(text + '\n');
  else console.log(text);
}

export function printDim(text: string): void {
  outLine(pc.dim(text));
}

export function printError(text: string): void {
  outLine(pc.red(`  ✗ ${text}`));
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Куда рисовать спиннер в управляемом экране (строка статуса); null — как раньше */
let spinnerRenderer: ((text: string | null) => void) | null = null;

export function setSpinnerRenderer(fn: (text: string | null) => void): void {
  spinnerRenderer = fn;
}

/**
 * Индикатор ожидания: в живом терминале анимируется (в экране — в строке
 * статуса, без экрана — в текущей строке); при пайпе печатается один раз.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(private text: string) {}

  start(): void {
    if (spinnerRenderer || process.stdout.isTTY) {
      this.render();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.render();
      }, 120);
    } else {
      outLine(pc.dim(`  ${this.text}`));
    }
  }

  private render(): void {
    const t = pc.dim(`${SPINNER_FRAMES[this.frame]} ${this.text}`);
    if (spinnerRenderer) spinnerRenderer(t);
    else process.stdout.write(`\r\x1b[K${t}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (spinnerRenderer) spinnerRenderer(null);
    else if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  }
}
