/**
 * Временный зонд ввода: что реально доходит до приложения под ConPTY,
 * когда «терминал» шлёт колесо мыши (SGR и X10), PgUp/PgDn и стрелки.
 * Ребёнок включает мышиный режим и печатает всё пришедшее в stdin как JSON.
 * Запуск: npm run probe:e2e (нужен node-pty: npm i --no-save node-pty)
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const req = createRequire(import.meta.url);
let pty: { spawn: (...args: unknown[]) => any };
try {
  pty = req('node-pty');
} catch {
  console.log('Зонду нужен node-pty: npm i --no-save node-pty');
  process.exit(2);
}

const child = `
const chunks = [];
process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  chunks.push(JSON.stringify(d.toString('utf8')));
  process.stdout.write('GOT:' + JSON.stringify(d.toString('utf8')) + '\\n');
});
process.stdout.write('\\x1b[?1000h\\x1b[?1006h READY\\n');
setTimeout(() => process.exit(0), 8000);
`;

const term = pty.spawn(process.execPath, ['-e', child], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  env: { ...process.env },
  cwd: process.cwd(),
});

let out = '';
term.onData((d: string) => (out += d));
const write = (s: string): Promise<void> =>
  new Promise<void>((r) => {
    term.write(s);
    setTimeout(r, 500);
  });
const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

await wait(1200);
await write('a'); // обычная клавиша — базовая линия
await write('\x1b[<64;10;5M'); // SGR колесо вверх
await write('\x1b[<65;10;5M'); // SGR колесо вниз
await write('\x1b[M`!!'); // X10 колесо вверх
await write('\x1b[5~'); // PgUp
await write('\x1b[6~'); // PgDn
await write('\x1b[A'); // стрелка вверх
await wait(1000);
// ребёнок сам выйдет по таймауту; kill() роняет conpty-агента с AttachConsole

console.log('=== Ребёнок получил: ===');
for (const line of out.split('\n')) {
  if (line.startsWith('GOT:')) console.log(' ', line.slice(4));
}
writeFileSync('C:/tmp/dt-input-raw.txt', out, 'utf8');
// работа сделана — выходим сами: pty-ребёнок живёт до своего таймаута
// и в headless-окружении может не выйти, удерживая наш процесс
process.exit(0);
