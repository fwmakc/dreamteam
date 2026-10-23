/**
 * Проверка TUI end-to-end: запускает приложение в настоящем псевдо-TTY,
 * кормит клавиши с паузами, проверяет альтернативный буфер, зоны, всплывашку @,
 * раунд на mock-провайдере и выход. Запуск: npm run probe:tui
 * Требует node-pty (ставится без сохранения в package.json): npm i --no-save node-pty.
 * Внимание: ConPTY (псевдотерминал Windows) перехватывает смену буферов и
 * scroll-region — эти коды здесь не проверить, см. tests/probe-screen.ts.
 *
 * Изоляция: зонд полностью герметичен и реальные данные не трогает. Приложение
 * запускается во временном проекте (cwd) с переменными DT_HOME/DT_PROJECT во
 * временные папки: там свои providers.json (всё на mock — ни одного настоящего
 * запроса к API), settings.json, user.json, менеджер и копия боевой команды
 * (слой дома), в проекте — hosts.json. Сценарий —
 * консьерж-поток: пустой разговор → приветствие менеджера на старте → первая
 * реплика менеджеру (team.add «Теста» с тулами) → chat.add → раунд с
 * инструментами. team.add реально пишет в agents.json дома — зонд
 * проверяет это по файлу и убирает за собой всё при любом завершении.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// node-pty ставится отдельно (npm i --no-save node-pty); грузим в обход
// статического импорта, чтобы tsc не требовал его всему проекту
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

// --- герметичные слои: временный дом и временный проект ---
const root = mkdtempSync(join(tmpdir(), 'dt-tui-'));
const home = join(root, 'home');
const proj = join(root, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(join(proj, '.dreamteam'), { recursive: true });
const j = (p: string, v: unknown): void =>
  writeFileSync(join(home, p), JSON.stringify(v, null, 2) + '\n');
const pj = (p: string, v: unknown): void =>
  writeFileSync(join(proj, '.dreamteam', p), JSON.stringify(v, null, 2) + '\n');
j('providers.json', {
  default: 'mock',
  providers: { mock: { adapter: 'mock' }, 'mock-images': { adapter: 'mock-images' } },
});
j('settings.json', { width: 100, margin: 2, screen: true, runTimeoutMs: 180000, maxOutputChars: 4000 });
j('user.json', { name: 'Босс', role: 'руководитель команды', about: '' });
// команда — вещь машины: менеджер и команда в доме
j('manager.json', { provider: 'mock', name: 'Менеджер', emoji: '🛎', color: 'yellow', temperature: 0.2 });
// проект — только свой hosts.json (серверы)
pj('hosts.json', { dev: { host: '192.0.2.1' } });
// команда — копия боевой (фикстура в репозитории): имена и роли важны для
// сценария, провайдеры сажаем на mock
const team = JSON.parse(readFileSync('.dreamteam/agents.json', 'utf8')) as Array<Record<string, unknown>>;
for (const a of team) {
  if (a.provider) a.provider = 'mock';
  if (a.vision) a.vision = 'mock';
  if (a.image) a.image = 'mock-images';
}
j('agents.json', team);
import { rmTemp } from './rm-tmp.js';

process.on('exit', () => rmTemp(root));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const term = pty.spawn(
  process.execPath,
  [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/index.ts')],
  {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    env: { ...process.env, DT_HOME: home, DT_PROJECT: join(proj, '.dreamteam') },
    cwd: proj,
  },
);

let out = '';
term.onData((d: string) => (out += d));
// слушаем завершение сразу: после прощания приложение выходит за ~250 мс
const exitedAt = new Promise<number | null>((r) =>
  term.onExit(({ exitCode }: { exitCode: number }) => r(exitCode)),
);
const write = (s: string): Promise<void> =>
  new Promise<void>((r) => {
    term.write(s);
    setTimeout(r, 350);
  });
const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(what: string, probe: (s: string) => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe(out)) return true;
    await wait(200);
  }
  console.log(`  …  не дождались: ${what}`);
  return false;
}

// ждём готовый экран: подсказки (статичная зона) и промпт
await waitFor('экран готов', (s) => s.includes('/help — операции') && s.includes('Ты >'), 30000);
check('tui: альтернативный буфер включён', out.includes('\x1b[?1049h'), out.slice(0, 120));
check('tui: bracketed paste включён', out.includes('\x1b[?2004h'));
// Мышиные режимы (\x1b[?1000h/1006h) ConPTY перехватывает и в поток не пропускает —
// их проверяет юнит-зонд Screen. Здесь лишь кормим PgUp/PgDn: в живом виде
// (история короче панели) это no-op, но клавиши не должны ломать редактор;
// сама проверка — ниже, после раунда, по введённому тексту.
await write('\x1b[5~');
await write('\x1b[6~');
// Баннер НЕ проверяем: это прокручиваемый контент панели чата — при старте
// вывод (~40 строк) уходит за верх панели, и ConPTY не всегда успевает
// передать его в поток до первого flush. Надёжны только статичные зоны.
// Scroll-region (\x1b[top;bot r) ConPTY тоже перехватывает — см. tmp-probe-screen.ts.
check('tui: промпт редактора', out.includes('Ты >'), out.slice(-200));
check('tui: подсказки операций', out.includes('/help — операции'), out.slice(-400));

// Пустой разговор на старте: менеджер-консьерж здоровается сам (без действий).
check(
  'tui: менеджер поприветствовал на старте',
  await waitFor('стартовое приветствие', (s) => s.includes('Я менеджер переговорки'), 15000),
);

// ввод текста → всплывашка @: в чате пока только менеджер — он и первый в списке
await write('@');
await wait(400);
const afterAt = out;
check('tui: всплывашка @ открылась с менеджером', /@Менеджер/.test(afterAt), afterAt.slice(-300));
await write('\x1b'); // Esc закрывает, остаётся просто @
await wait(400);
check('tui: Esc закрыл всплывашку', out.length > afterAt.length, '');

// сотрём @ и отправим сообщение: в пустом разговоре любая реплика уходит
// менеджеру-консьержу, и mock детерминированно зовёт «Теста» (team.add
// с тулами files+shell). Если что-то вдруг спросили — отвечаем n.
await write('\x7f');
await write('привет, команда\r');
check(
  'tui: менеджер ответил заготовкой',
  await waitFor('ответ менеджера', (s) => s.includes('Позываю нового участника'), 15000),
);
check(
  'tui: действие team.add исполнено',
  await waitFor('отчёт team.add', (s) => s.includes('добавлен в команду'), 5000),
);
check('tui: статус-строка менеджера рисовалась', out.includes('разбирается'), out.slice(-300));

// позвать Теста в чат: mock-менеджер по фразе «позови Теста в чат» исполняет chat.add
await write('!менеджер, позови Теста в чат\r');
check(
  'tui: chat.add исполнен',
  await waitFor('Тест в чате', (s) => s.includes('присоединился к чату'), 15000),
);

// теперь в чате Тест (с тулами): обычный раунд с инструментами — запись файла
// и echo на дефолтной политике проходят молча. Ждём конца раунда (итог и
// запись памяти), попутно отвечая n, если что-то вдруг спросили.
await write('покажи, что умеешь\r');
for (let i = 0; i < 30; i++) {
  await wait(700);
  if (out.includes('y — выполнить')) await write('n\r');
  if (out.includes('память обновлена') || out.includes('Продолжаем')) break;
}
check('tui: раунд прошёл (инструменты отработали)', out.includes('✅'), out.slice(-400));
check('tui: дефолтная политика — без вопросов человеку', !out.includes('y — выполнить'), out.slice(-400));
check('tui: статус-строка спиннера рисовалась', out.includes('печатает'), out.slice(-300));
await wait(1500); // раунд дописывает хвост (память) — следующую реплику шлём в простой

// финальное обращение через «!» (второй триггер): роутинг упоминаний работает после всех раундов
await write('!менеджер, дай статус команды\r');
check(
  'tui: повторное обращение — ответ без действий',
  await waitFor('ответ менеджера', (s) => s.includes('Команда на месте'), 20000),
);
await write('/team\r');
check(
  'tui: «Тест» появился в /team',
  await waitFor('Тест в /team', (s) => /🧪 Тест/.test(s), 5000),
);
await write('\x15'); // Ctrl+U — стереть ввод (если что-то осталось) перед /exit

// /exit после раунда (с повторами — вдруг строка уйдёт не туда)
for (let i = 0; i < 3; i++) {
  await write('/exit\r');
  if (await waitFor('прощание', (s) => s.includes('Совещание окончено'), 6000)) break;
}
check('tui: прощание напечатано', out.includes('Совещание окончено'), out.slice(-300));
// собственное сообщение приложение в панель не печатает — оно попадает в
// название сессии, которое ярчится в промпте. Всплывашка @ после PgUp/PgDn
// показала, что редактор жив; здесь — что и отправка дошла до сессии.
check('tui: после PgUp/PgDn отправка работает', out.includes('[привет, команда]'), out.slice(-300));
// ВАЖНО: \x1b[?1049l/\x1b[r здесь не проверяем — ConPTY (псевдотерминал Windows)
// перехватывает смену буферов и не пропускает эти коды в поток. Покрыто
// юнит-зондом Screen (tmp-probe-screen.ts), где выход пишется в Pipe напрямую.

const code = await Promise.race([
  Promise.race([exitedAt, wait(8000).then(() => null)]),
]);
check('tui: процесс завершился сам', code === 0, String(code));
if (code === null) term.kill();
writeFileSync('/tmp/dt-tui-raw.txt', out, 'utf8');
// team.add менеджера писал в agents.json дома (команда — вещь машины) — проверяем по файлу
check('tui: «Тест» записан в агенты дома', readFileSync(join(home, 'agents.json'), 'utf8').includes('test_probe'));
check('tui: разговор сохранился в проекте', readdirSync(join(proj, '.dreamteam', 'sessions')).length === 1);

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
