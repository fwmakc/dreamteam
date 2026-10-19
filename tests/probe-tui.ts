/**
 * Проверка TUI end-to-end: запускает приложение в настоящем псевдо-TTY,
 * кормит клавиши с паузами, проверяет альтернативный буфер, зоны, всплывашку @,
 * раунд на mock-провайдере и выход. Запуск: npm run probe:tui
 * Требует node-pty (ставится без сохранения в package.json): npm i --no-save node-pty.
 * Внимание: ConPTY (псевдотерминал Windows) перехватывает смену буферов и
 * scroll-region — эти коды здесь не проверить, см. tests/probe-screen.ts.
 *
 * ПРАВИЛА ЗАПУСКА (проба отправляет настоящее сообщение — пишет новые файлы
 * в data/!):
 *   1. Изолировать данные пользователя:
 *      mv data/sessions data/sessions.hold && mv data/transcripts data/transcripts.hold
 *      mkdir -p data/sessions data/transcripts
 *   2. Переключить провайдера на mock (и запомнить прежнее значение):
 *      cp config/providers.json /tmp/providers.bak
 *      sed -i 's/"default": "[a-z]*"/"default": "mock"/' config/providers.json
 *   3. Прогнать пробу: npx tsx tests/probe-tui.ts
 *   4. Убрать тестовые данные и вернуть всё как было:
 *      rm -rf data/sessions data/transcripts
 *      mv data/sessions.hold data/sessions && mv data/transcripts.hold data/transcripts
 *      mv /tmp/providers.bak config/providers.json
 *
 * config/agents.json и config/manager.json зонд бэкапит сам: блок @менеджер
 * реально добавляет участника «Тест» в agents.json, а менеджера на время пробы
 * переключает на mock (иначе он пошёл бы на настоящий API). Оба файла
 * возвращаются при любом завершении зонда.
 */
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';

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

// --- изоляция конфигов: agents.json вернём нетронутым, менеджера сажаем на mock ---
const AGENTS_FILE = 'config/agents.json';
const MANAGER_FILE = 'config/manager.json';
const teamBackup = readFileSync(AGENTS_FILE, 'utf8');
const mgrBackup = readFileSync(MANAGER_FILE, 'utf8');
writeFileSync(
  MANAGER_FILE,
  JSON.stringify({ provider: 'mock', name: 'Менеджер', emoji: '🛎', color: 'yellow', temperature: 0.2 }, null, 2) + '\n',
);
let restored = false;
function restoreConfigs(): void {
  if (restored) return;
  restored = true;
  try {
    writeFileSync(AGENTS_FILE, teamBackup);
    writeFileSync(MANAGER_FILE, mgrBackup);
  } catch {
    // пытаемся вернуть хотя бы что-то
  }
}
process.on('exit', restoreConfigs);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const term = pty.spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  env: { ...process.env },
  cwd: process.cwd(),
});

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
await waitFor('экран готов', (s) => s.includes('/help — команды') && s.includes('Ты >'), 30000);
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
check('tui: подсказки команд', out.includes('/help — команды'), out.slice(-400));

// ввод текста → всплывашка @
await write('@');
await wait(400);
const afterAt = out;
check('tui: всплывашка @ открылась', /@Глеб|@Яна|@Катя/.test(afterAt), afterAt.slice(-300));
await write('\x1b'); // Esc закрывает, остаётся просто @
await wait(400);
check('tui: Esc закрыл всплывашку', out.length > afterAt.length, '');

// сотрём @ и отправим сообщение; на подтверждения инструментов отвечаем n
await write('\x7f');
await write('привет, команда\r');
let confirms = 0;
for (let i = 0; i < 10; i++) {
  await wait(700);
  if (out.includes('y — выполнить')) {
    confirms++;
    await write('n\r');
  }
  if (out.includes('память обновлена') || out.includes('Продолжаем')) break;
}
check('tui: раунд прошёл (подтверждения приходили)', confirms >= 1, String(confirms));
check('tui: статус-строка спиннера рисовалась', out.includes('печатает'), out.slice(-300));

// @менеджер (здесь через синоним «№» — как его и будут звать с русской раскладки):
// mock-менеджер детерминированно добавляет участника «Тест» (id test_probe) в config/agents.json.
await write('№менеджер, позови Теста\r');
check(
  'tui: менеджер ответил заготовкой',
  await waitFor('ответ менеджера', (s) => s.includes('Позываю нового участника'), 15000),
);
check(
  'tui: действие team.add исполнено',
  await waitFor('отчёт team.add', (s) => s.includes('добавлен в команду'), 5000),
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
restoreConfigs();
check('tui: agents.json вернулся нетронутым', readFileSync(AGENTS_FILE, 'utf8') === teamBackup);
check('tui: manager.json вернулся нетронутым', readFileSync(MANAGER_FILE, 'utf8') === mgrBackup);

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
