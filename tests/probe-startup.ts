/**
 * Временный зонд старта: запускает приложение в псевдо-TTY и прогоняет
 * весь вывод через мини-эмулятор VT — проверяется ОТРИСОВАННЫЙ экран,
 * а не поток байт. Приложение стартует БЕЗ проекта (метка «[без проекта]»,
 * подсказка выбора в панели) — проект выбирает человек: /project open dev
 * открывает проект с прошлым разговором, дальше вся отрисовка истории —
 * колесо, PgUp/PgDn, Ctrl+PgUp/Dn, мышь, выделение, Ctrl+C, Esc, «@».
 * Запуск: npm run probe:e2e (нужен node-pty: npm i --no-save node-pty).
 * Изоляция: всё во временном доме DT_HOME (модели на mock — ни одного
 * настоящего запроса к API); прошлый разговор сидит в
 * projects/dev/sessions. Реальные данные не трогает; но жмёт Ctrl+C
 * с выделением и КЛАДЁТ ТЕКСТ В БУФЕР ОБМЕНА — сохраните буфер перед
 * прогоном и верните после.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VtScreen } from './vt.js';
import { SessionStore } from '../src/sessions.js';
import type { ChatMessage } from '../src/types.js';

const req = createRequire(import.meta.url);
let pty: { spawn: (...args: unknown[]) => any };
try {
  pty = req('node-pty');
} catch {
  console.log('Зонду нужен node-pty: npm i --no-save node-pty');
  process.exit(2);
}

// --- герметичный дом: модели, менеджер, команда и проект с историей ---
const root = mkdtempSync(join(tmpdir(), 'dt-startup-'));
const home = join(root, 'home');
const proj = join(root, 'proj'); // рабочая папка проекта (cwd процесса)
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
const j = (p: string, v: unknown): void =>
  writeFileSync(join(home, p), JSON.stringify(v, null, 2) + '\n');
mkdirSync(join(home, 'models'), { recursive: true });
j('models/mock.json', { adapter: 'mock' });
j('models/mock-images.json', { adapter: 'mock-images' });
j('settings.json', { width: 100, margin: 2, screen: true, runTimeoutMs: 180000, maxOutputChars: 4000, model: { id: 'mock' } });
j('user.json', { name: 'Босс', role: 'руководитель команды', about: '' });
// менеджер и команда — вещь машины: в доме, на mock-моделях
j('manager.json', { model: { id: 'mock' }, name: 'Менеджер', emoji: '🛎', color: 'yellow', temperature: 0.2 });
mkdirSync(join(home, 'agents'), { recursive: true });
j('agents/gleb_cyber.json', { id: 'gleb_cyber', name: 'Глеб', emoji: '🧠', color: 'cyan', role: 'Главный по архитектуре и коду', prompt: 'Ты Глеб.', model: 'mock' });
j('agents/katya_uiux.json', { id: 'katya_uiux', name: 'Катя', emoji: '🎨', color: 'magenta', role: 'Арт-директор и UI/UX', prompt: 'Ты Катя.', model: 'mock' });
// прошлый разговор с историей: хвост в панели, «Продолжаю разговор», @Глеб в попапе.
// Сообщений много: панель должна иметь запас выше вьюпорта для PgUp («выше ещё на 26»).
{
  // реестр проектов = сами папки в доме: регистрирует project.json
  mkdirSync(join(home, 'projects', 'dev', 'sessions'), { recursive: true });
  j('projects/dev/project.json', { path: proj, createdAt: Date.now(), lastOpened: Date.now() - 60_000, hosts: {}, mails: {}, messengers: {} });
  const store = new SessionStore(join(home, 'projects', 'dev', 'sessions')); // переписка — в проекте дома
  const s = store.create();
  s.title = 'Прошлый разговор';
  let ts = Date.now() - 600_000;
  const msg = (authorId: string, authorName: string, text: string, role?: string): ChatMessage => ({
    authorId,
    authorName,
    authorRole: role,
    text,
    ts: (ts += 30_000),
  });
  const history: ChatMessage[] = [];
  for (let i = 1; i <= 16; i++) history.push(msg('user', 'Босс', `рабочая реплика ${i} — прогоняем сборку, смотрим логи`));
  history.push(
    msg('user', 'Босс', 'привет, команда'),
    msg('gleb_cyber', 'Глеб', 'Привет! Продолжаю разговор: серваки на месте, можно работать :)', 'Главный по архитектуре и коду'),
    msg('katya_uiux', 'Катя', 'И вам привет ^_^', 'Арт-директор и UI/UX'),
  );
  s.messages = history;
  store.save(s);
}
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const COLS = 100;
const ROWS = 30;
const term = pty.spawn(
  process.execPath,
  [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/index.ts')],
  {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    env: { ...process.env, DT_HOME: home },
    cwd: proj,
  },
);

const vt = new VtScreen(COLS, ROWS);
let raw = ''; // сырой поток: для проверки управляющих кодов (реверс-вид и т.п.)
term.onData((d: string) => {
  raw += d;
  vt.feed(d);
});
const exitedAt = new Promise<number | null>((r) =>
  term.onExit(({ exitCode }: { exitCode: number }) => r(exitCode)),
);
const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const write = (s: string): Promise<void> =>
  new Promise<void>((r) => {
    term.write(s);
    setTimeout(r, 500);
  });
async function waitPane(what: string, probe: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await wait(200);
  }
  console.log(`  …  не дождались: ${what}`);
  return false;
}

function dump(what: string): void {
  console.log(`=== Экран: ${what} ===`);
  vt.lines().forEach((l, i) => console.log(`${String(i + 1).padStart(2)}│${l}│`));
}

let fails = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name} — ${detail}`);
  }
}
const pane = (): string => vt.lines().slice(2, 22).join('\n'); // панель чата: строки 3..22
const hints = (): string => vt.lines().slice(22, 27).join('\n'); // подсказки: 23..27

await wait(3000); // старт: баннер, подсказка выбора проекта, промпт — без всякого ввода
dump('сразу после запуска (без проекта)');
writeFileSync('C:/tmp/dt-startup-1.txt', vt.lines().join('\n'), 'utf8');
check('старт: промпт внизу', (vt.lines()[27] ?? '').includes('Ты >'), JSON.stringify(vt.lines()[27]));
check('старт: без проекта — метка в промпте', (vt.lines()[27] ?? '').includes('без проекта'), JSON.stringify(vt.lines()[27]));
check('старт: статичные подсказки', hints().includes('/help — операции'), hints());
check('старт: подсказка выбора проекта в панели', pane().includes('Проект не выбран'), pane().slice(0, 400));

// проект выбирает человек: открываем зарегистрированный проект с прошлым разговором
await write('/project open dev\r');
check(
  'открытие: история в панели',
  await waitPane('хвост истории', () => pane().includes('Продолжаю разговор'), 15000),
);
check('открытие: проект открыт — разговор в промпте', (vt.lines()[27] ?? '').includes('Прошлый разговор'), JSON.stringify(vt.lines()[27]));
check('открытие: хвост истории с метками времени', /\d{2}:\d{2}:\d{2}/.test(pane()), pane().slice(-300));
const paneBefore = pane();

// колесо мыши вверх: панель уходит к старым, вид закреплён
await write('\x1b[<64;10;5M');
await write('\x1b[<64;10;5M');
await wait(400);
dump('после двух оборотов колеса вверх');
writeFileSync('C:/tmp/dt-startup-3.txt', vt.lines().join('\n'), 'utf8');
check('колесо: панель изменилась', pane() !== paneBefore, '');
check('колесо: индикатор «выше ещё на 6»', hints().includes('выше ещё на 6'), hints());
check('колесо: хвост ушёл из вида', !pane().includes('Продолжаю разговор'), pane().slice(-200));
check('колесо: ввод на месте', (vt.lines()[27] ?? '').includes('Ты >'), JSON.stringify(vt.lines()[27]));

// PgUp — страница вверх, PgDn — обратно к свежим
await write('\x1b[5~');
await wait(400);
check('PgUp: индикатор «на 26»', hints().includes('выше ещё на 26'), hints());
await write('\x1b[6~');
await write('\x1b[6~');
await wait(400);
check('PgDn: вернулись к хвосту', pane().includes('Продолжаю разговор') && !hints().includes('история'), hints());

// Ctrl+PgUp — в самое начало истории разговора (панель заменена целиком),
// Ctrl+PgDn — к свежим
await write('\x1b[5;5~');
await wait(400);
check('Ctrl+PgUp: в начале — первая реплика истории', pane().includes('рабочая реплика 1'), pane().slice(0, 200));
check('Ctrl+PgUp: индикатор прокрутки', hints().includes('выше ещё на'), hints());
await write('\x1b[6;5~');
await wait(400);
check('Ctrl+PgDn: снова хвост', pane().includes('Продолжаю разговор') && !hints().includes('история'), hints());
check('Ctrl+PgDn: ввод на месте', (vt.lines()[27] ?? '').includes('Ты >'), JSON.stringify(vt.lines()[27]));

// --- выделение мышью: нажать-протянуть (SGR-события проходят ConPTY насквозь) ---
let rawMark = 0;
const rawSince = (): string => raw.slice(rawMark);
rawMark = raw.length;
await write('\x1b[<0;6;10M'); // ЛКМ вниз на строке 10 панели
await write('\x1b[<32;30;11M'); // протянули на строку 11
await wait(400);
check('мышь: протяжка подсветила реверсом', rawSince().includes('\x1b[7m'), JSON.stringify(rawSince().slice(-200)));
rawMark = raw.length;
await write('\x1b[<0;30;11m'); // отпустили — авто-копирование
await wait(700);
check('мышь: отпускание скопировало', hints().includes('Скопировано'), hints());

// Shift+стрелки: свежее выделение от последней строки панели
rawMark = raw.length;
await write('\x1b[1;2A'); // Shift+вверх
await wait(400);
check('shift: подсветка появилась', rawSince().includes('\x1b[7m'), JSON.stringify(rawSince().slice(-200)));

// Ctrl+C с выделением — копирует, а не выходит
rawMark = raw.length;
await write('\x03');
await wait(700);
check('ctrl+c: скопировал выделение', hints().includes('Скопировано'), hints());
check('ctrl+c: приложение живо', (vt.lines()[27] ?? '').includes('Ты >'), JSON.stringify(vt.lines()[27]));

// Esc снимает выделение: перерисовка панели уже без реверса
// (Ctrl+C при копировании выделение снял — создаём заново Shift+End)
rawMark = raw.length;
await write('\x1b[1;2F'); // Shift+End — вся последняя строка
await wait(400);
check('esc: перед ним выделение живо (shift+end)', rawSince().includes('\x1b[7m'), JSON.stringify(rawSince().slice(-150)));
rawMark = raw.length;
await write('\x1b');
await wait(500);
// ConPTY шлёт дифф-кадры (\r + текст): подсвеченная строка перерисована без реверса
check('esc: перерисовал панель без реверса', !rawSince().includes('\x1b[7m') && rawSince().includes('Продолжаю разговор'), JSON.stringify(rawSince().slice(0, 150)));

// --- выделение в поле ввода: Shift+стрелки по набираемому сообщению ---
rawMark = raw.length;
await write('тест'); // набираем сообщение
await wait(400);
rawMark = raw.length;
await write('\x1b[1;2D'); // Shift+влево ×2 — выделили «ст»
await write('\x1b[1;2D');
await wait(400);
check('ввод: shift+влево подсветил', rawSince().includes('\x1b[7m'), JSON.stringify(rawSince().slice(-150)));
rawMark = raw.length;
await write('\x03'); // Ctrl+C — копия выделения ввода
await wait(700);
check('ввод: ctrl+c скопировал', hints().includes('Скопировано'), hints());
check('ввод: текст на месте', (vt.lines()[27] ?? '').includes('тест'), JSON.stringify(vt.lines()[27]));
rawMark = raw.length;
await write('\x1b'); // Esc — снять выделение ввода (одиночный Esc ждёт 80 мс)
await write('\x15'); // Ctrl+U — стереть ввод перед дальнейшими проверками
await wait(500);
check('ввод: esc снял, ctrl+u стёр', !rawSince().includes('\x1b[7m') && !(vt.lines()[27] ?? '').includes('тест'), JSON.stringify(vt.lines()[27]));

await write('@');
await wait(600);
dump('после «@»');
writeFileSync('C:/tmp/dt-startup-2.txt', vt.lines().join('\n'), 'utf8');
check('после @: всплывашка открылась', vt.lines().slice(18, 27).join('\n').includes('@Глеб'), '');
check('после @: ввод на месте', (vt.lines()[27] ?? '').includes('Ты > @'), JSON.stringify(vt.lines()[27]));

await write('\x1b'); // Esc закрывает всплывашку
await write('\x15'); // Ctrl+U — стереть @
await write('/exit\r');
const code = await Promise.race([exitedAt, wait(8000).then(() => 'timeout')]);
if (code === 'timeout') {
  term.kill();
  await wait(1500);
}
console.log(`exit: ${code}`);
check('выход: процесс завершился сам', code === 0, String(code));
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1); // kill() у node-pty может зависнуть на цепочке tsx→node
