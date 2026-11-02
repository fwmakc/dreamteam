/**
 * Временный зонд мастера первого запуска в живом терминале (ConPTY):
 * пустой дом → мастер рисует пикер языка СТРЕЛКАМИ (ветка TTY, не труба).
 * Регрессия, которую ловит зонд: после rl.close() подписка на 'keypress'
 * клавиш не получала — цикл событий пустел, приложение молча выходило
 * (выбор не работал, «сразу вылетает»). Здесь ↓ должно перерисовать список,
 * Enter — выбрать en по умолчанию, дальше мастер доводится до конца
 * (провайдер mock) и стартует TUI. Запуск: npm i --no-save node-pty &&
 * npx tsx tests/probe-wizard-pty.ts. Изоляция: пустой дом во временной
 * папке DT_HOME; ярлык на рабочий стол НЕ создаётся (ответ «n»); реальные
 * данные не трогает.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const req = createRequire(import.meta.url);
let pty: { spawn: (...args: unknown[]) => any };
try {
  pty = req('node-pty');
} catch {
  console.log('Зонду нужен node-pty: npm i --no-save node-pty');
  process.exit(2);
}

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  }
}

const home = join(mkdtempSync(join(tmpdir(), 'dt-wizard-pty-')), 'home');
const COLS = 100;
const ROWS = 30;

const term = pty.spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/index.ts')], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  env: { ...process.env, DT_HOME: home },
  cwd: tmpdir(),
});

let out = '';
let exited: number | null = null;
term.onData((d: string) => {
  out += d;
});
term.onExit(({ exitCode }: { exitCode: number }) => {
  exited = exitCode;
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

/** Ждём подстроку в выводе (или смерть процесса раньше времени). */
async function until(needle: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (out.includes(needle)) return true;
    if (exited !== null) return false;
    await wait(100);
  }
  return out.includes(needle);
}

try {
  // 1) пикер языка: заголовок-триязычник, подсказка и три пункта нарисовались
  check('мастер: пикер языка нарисован', await until('выбор: стрелки ↑/↓, PgUp/PgDn, Home/End, Enter'), out.slice(-400));
  check('мастер: три языка в списке', strip(out).includes('ru — Русский') && strip(out).includes('en — English') && strip(out).includes('zh — 中文'));

  // 2) ↓ — список перерисовался, процесс ЖИВ (регрессия: молчаливый exit(0))
  term.write('\x1b[B');
  await wait(700);
  check('мастер: жив после стрелки вниз (не вылетел)', exited === null, `exit=${exited}`);
  check('мастер: список перерисовался после ↓', (out.match(/ru — Русский/g) ?? []).length >= 2);

  // 3) ↑ обратно к en (по умолчанию) и Enter — выбрали en
  term.write('\x1b[A');
  await wait(400);
  term.write('\r');
  check('мастер: после Enter — вопрос модели (en)', await until('Model for the team:'), out.slice(-400));

  // 4) модель: по умолчанию «создать новую» — Enter; провайдер: End → mock — Enter
  term.write('\r');
  check('мастер: вопрос типа провайдера', await until('OpenAI-compatible'), out.slice(-400));
  term.write('\x1b[F'); // End — последний пункт: mock
  await wait(400);
  term.write('\r');
  check('мастер: вопрос про ярлык (модель mock сохранена)', await until('Desktop shortcut'), out.slice(-400));

  // 5) ярлык не создаём («n»), мастер прощается — дальше TUI (альтернативный буфер)
  term.write('n\r');
  check('мастер: завершился, TUI стартовал (alt-буфер)', await until('\x1b[?1049h'), out.slice(-400));

  // 6) дом после мастера: язык, модель, карточка, токен, менеджер
  const readJson = (rel: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(home, rel), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const settings = readJson('settings.json') as { ui?: string; model?: { id?: string } } | null;
  check('дом: язык en записан в settings', settings?.ui === 'en', JSON.stringify(settings));
  check('дом: settings.model.id=mock', settings?.model?.id === 'mock');
  const card = readJson(join('models', 'mock.json')) as { provider?: string } | null;
  check('дом: карточка mock.json с провайдером mock', card?.provider === 'mock');
  check('дом: .env с токеном создан', existsSync(join(home, '.env')) && readFileSync(join(home, '.env'), 'utf8').includes('TOKEN='));
  const mgr = readJson('manager.json') as { model?: { id?: string } } | null;
  check('дом: менеджер на mock', mgr?.model?.id === 'mock');

  // 7) выходим из TUI: Ctrl+C (первый может прервать приветствие менеджера)
  term.write('\x03');
  await wait(700);
  term.write('\x03');
  const deadline = Date.now() + 5000;
  while (exited === null && Date.now() < deadline) await wait(100);
  if (exited === null) term.kill();
  await wait(500);
  check('TUI: процесс завершился сам по Ctrl+C', exited !== null, `exit=${exited}`);
} finally {
  if (exited === null) term.kill();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch { /* занято — временная, не беда */ }
}

console.log(fails === 0 ? '\nВСЁ OK' : `\nПРОВАЛОВ: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
