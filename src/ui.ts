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

export function printDim(text: string): void {
  console.log(pc.dim(text));
}

export function printError(text: string): void {
  console.log(pc.red(`  ✗ ${text}`));
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Индикатор ожидания: в живом терминале анимируется в одной строке и стирается
 * по stop(); при пайпе/перенаправлении просто печатается один раз.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(private text: string) {}

  start(): void {
    if (process.stdout.isTTY) {
      this.render();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.render();
      }, 120);
    } else {
      console.log(pc.dim(`  ${this.text}`));
    }
  }

  private render(): void {
    process.stdout.write(`\r\x1b[K${pc.dim(`${SPINNER_FRAMES[this.frame]} ${this.text}`)}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  }
}
