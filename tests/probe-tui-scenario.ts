/**
 * Тот же сценарий руководителя, но через настоящий терминал (node-pty):
 * команды кормятся клавишами в живой TUI, после КАЖДОГО шага — проверка
 * на диске (sessions/, agents.json, экспорт-архив), плюс маркер на экране.
 *
 *  1. /new         2. /agent add    3. /add      4. /rename   5. сообщения
 *  6. /export      7. /out + /delete (агента из TUI удаляет менеджер через
 *     разговор с LLM — на mock не скриптуется; само удаление агента покрыто
 *     в probe-gui-scenario и probe-scenario)
 *  8. /import      9. /delete снова
 *
 * Герметично: временные DT_HOME/DT_PROJECT, всё на mock-провайдере.
 * Запуск: npm run probe:scenario-tui (нужен node-pty: npm i --no-save node-pty)
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AdmZip from 'adm-zip';

const req = createRequire(import.meta.url);
let pty: { spawn: (...args: unknown[]) => any };
try {
  pty = req('node-pty');
} catch {
  console.log('Зонду нужен node-pty: npm i --no-save node-pty');
  process.exit(2);
}

let fails = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` — ${String(detail).slice(0, 250)}` : ''}`);
  }
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- герметичные слои: дом + проект, всё на mock (как в probe-tui)
const base = mkdtempSync(join(tmpdir(), 'dt-tui-scn-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
const dt = join(proj, '.dreamteam');
mkdirSync(home, { recursive: true });
mkdirSync(dt, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = dt;
// cwd НЕ трогаем: относительные пути (node_modules/tsx, src/index.ts) резолвятся
// из корня репозитория; песочница живёт в DT_HOME/DT_PROJECT и в cwd самого pty
mkdirSync(join(home, 'models'), { recursive: true });
writeFileSync(join(home, 'models', 'mock.json'), JSON.stringify({ adapter: 'mock' }, null, 2) + '\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ width: 100, margin: 2, screen: true, runTimeoutMs: 180000, maxOutputChars: 4000, model: { id: 'mock' } }, null, 2) + '\n');
writeFileSync(join(home, 'manager.json'), JSON.stringify({ model: { id: 'mock' } }, null, 2) + '\n');
writeFileSync(join(home, 'agents'), '[]\n');
writeFileSync(join(dt, 'hosts.json'), '{}\n');
// скаффолд руками: команда и manager — в доме, hosts.json — в проекте
mkdirSync(join(home, 'tools'), { recursive: true });
process.on('exit', () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows держит файлы */ } });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const sessionsDir = join(dt, 'sessions'); // переписка — в проекте
const agentsFile = join(home, 'agents');
const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const readSessions = (): any[] =>
  readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(sessionsDir, f)));

/** Действие считается выполненным только когда файл на диске изменился. */
async function waitDisk(cond: () => boolean, what: string, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (cond()) return true; } catch { /* файл пишется — читаем снова */ }
    await wait(150);
  }
  let detail = '';
  try { detail = `sessions=${readSessions().map((s) => `${s.id}:${(s.messages ?? []).length}msg`).join(', ')}`; } catch { /* не смогли — ладно */ }
  check(`диск: ${what}`, false, detail || 'не появилось');
  return false;
}

// --- живой терминал
const term = pty.spawn(
  process.execPath,
  [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/index.ts')],
  { name: 'xterm-256color', cols: 100, rows: 30, env: { ...process.env }, cwd: proj },
);
let out = '';
term.onData((d: string) => (out += d));
const exited = new Promise<number | null>((r) => term.onExit(({ exitCode }: { exitCode: number }) => r(exitCode)));
const type = async (line: string): Promise<void> => {
  term.write(line + '\r');
  await wait(500);
};

let exitedCleanly = false;

async function main(): Promise<void> {
  // ждём готовый экран и приветствие консьержа
  const deadline = Date.now() + 90_000; // холодный старт tsx на занятой машине
  while (Date.now() < deadline && !(out.includes('/help — команды') && out.includes('Я менеджер переговорки'))) await wait(200);
  check('старт: экран готов, менеджер поприветствовал', out.includes('/help — команды') && out.includes('Я менеджер переговорки'));
  check('старт: одна сессия на диске', readSessions().length === 1);

  // ── 1. новая сессия ──────────────────────────────────────────────────────
  await type('/session new');
  const ok1 = await waitDisk(() => readSessions().length === 2, 'второй файл сессии');
  // приветствие менеджера пишется раундом чуть позже самого файла — дожидаемся
  const fresh = ok1 ? readSessions().slice().sort((a: any, b: any) => b.createdAt - a.createdAt)[0] : null;
  if (fresh) await waitDisk(
    () => ((readSessions().find((s) => s.id === fresh.id)?.messages ?? []).length >= 1),
    'приветствие в новой сессии',
  );
  const freshFull = fresh ? readSessions().find((s) => s.id === fresh.id) : null;
  check('1: /new — новая сессия на диске с приветствием менеджера',
    Boolean(freshFull) && freshFull.title === 'Новый разговор' && (freshFull.messages ?? []).length >= 1);
  const freshId = freshFull?.id as string;

  // ── 2. агент-юрист ───────────────────────────────────────────────────────
  await type('/team add yurist Юрист право и договоры');
  await waitDisk(() => readJson(agentsFile).some((a: any) => a.id === 'yurist'), 'юрист в agents/');
  const yurist = readJson(agentsFile).find((a: any) => a.id === 'yurist');
  check('2: /team add — юрист на диске с дефолтами',
    yurist?.name === 'Юрист' && yurist?.emoji === '🤖' && String(yurist?.prompt).startsWith('Ты — Юрист'),
    JSON.stringify(yurist).slice(0, 160));

  // ── 3. позвать в сессию ──────────────────────────────────────────────────
  await type('/chat add Юрист');
  await waitDisk(() => (readSessions().find((s) => s.id === freshId)?.participants ?? []).includes('yurist'), 'юрист в participants');
  check('3: /chat add — на диске participants = менеджер + юрист',
    (readSessions().find((s) => s.id === freshId)?.participants ?? []).includes('yurist'));

  // ── 4. переименовать ─────────────────────────────────────────────────────
  await type('/session rename Юридический вопрос');
  await waitDisk(() => readSessions().find((s) => s.id === freshId)?.title === 'Юридический вопрос', 'новое имя на диске');
  check('4: /session rename — title на диске изменился',
    readSessions().find((s) => s.id === freshId)?.title === 'Юридический вопрос');

  // ── 5. несколько сообщений ───────────────────────────────────────────────
  // кто именно ответит — решает модератор; ждём прирост любых не-руководительских реплик
  const repliesCount = (): number => {
    const s = readSessions().find((x) => x.id === freshId);
    return (s?.messages ?? []).filter((m: any) => m.authorId !== 'user').length;
  };
  await type('Здравствуйте! Нужен договор аренды.');
  const r1 = repliesCount();
  await waitDisk(() => repliesCount() > r1, 'ответ на первое сообщение');
  await type('Спасибо, ждём документы.');
  const r2 = repliesCount();
  await waitDisk(() => repliesCount() > r2, 'ответ на второе сообщение');
  const msgs = readSessions().find((s) => s.id === freshId).messages;
  check('5: обе реплики руководителя записаны', msgs.filter((m: any) => m.authorId === 'user').length === 2);
  check('5: ответы записаны и не пустые',
    msgs.filter((m: any) => m.authorId !== 'user').every((m: any) => String(m.text).length > 5));

  // ── 6. экспорт ───────────────────────────────────────────────────────────
  // /export без номера — архив ДОМА; архив разговора — только с номером
  await type('/session export 1');
  await waitDisk(() => existsSync(join(proj, `dt-session-${freshId}.zip`)), 'zip экспорта в рабочей папке');
  const zipPath = join(proj, `dt-session-${freshId}.zip`);
  check('6: /session export — архив на диске', existsSync(zipPath));
  const zip = new AdmZip(zipPath);
  const exported = JSON.parse(zip.readAsText('session.json'));
  check('6: внутри архива тот разговор (имя, юрист, участники)',
    exported.title === 'Юридический вопрос' && (exported.participants ?? []).includes('yurist') &&
    exported.messages.length === msgs.length);

  // ── 7. вывести из чата и удалить разговор ────────────────────────────────
  await type('/chat remove Юрист');
  await waitDisk(() => !(readSessions().find((s) => s.id === freshId)?.participants ?? []).includes('yurist'), 'юрист выведен из чата');
  check('7: /chat remove — юриста нет в participants на диске',
    !(readSessions().find((s) => s.id === freshId)?.participants ?? []).includes('yurist'));
  await type('/session open 2'); // уходим из удаляемого (свежий — №1)
  await wait(600);
  await type('/session delete 1');
  await waitDisk(() => readSessions().length === 1, 'файл сессии удалён');
  check('7: /session delete — удалённый разговор исчез с диска',
    readSessions().length === 1 && readSessions()[0].id !== freshId);

  // ── 8. импорт ────────────────────────────────────────────────────────────
  await type(`/session import ${zipPath}`);
  await waitDisk(() => readSessions().length === 2, 'сессия вернулась из архива');
  const restored = readSessions().find((s) => s.title === 'Юридический вопрос');
  check('8: /import — разговор вернулся «как новый» (другой id, содержимое на месте)',
    Boolean(restored) && restored.id !== freshId && (restored.participants ?? []).includes('yurist'));

  // ── 9. снова удалить ─────────────────────────────────────────────────────
  await type('/session open 2'); // импортированный свежее — №1, уходим на №2
  await wait(600);
  await type('/session delete 1');
  await waitDisk(() => readSessions().length === 1, 'импортированная сессия удалена');
  check('9: песочница в исходном состоянии',
    readSessions().length === 1 && readSessions()[0].id !== restored.id);

  await type('/exit');
  const code = await Promise.race([exited, wait(8000).then(() => -1)]);
  exitedCleanly = code === 0;
  check('выход: /exit завершает процесс', code === 0, `код ${code}`);
}

await main().catch((e) => {
  check('сценарий упал', false, e instanceof Error ? e.message : e);
  console.log('— последние 1500 символов экрана —\n' + out.slice(-1500));
});
// добиваем терминал только если приложение само не вышло (kill мёртвого pty на
// Windows роняет сам зонд — AttachConsole failed внутри node-pty)
if (!exitedCleanly) { try { term.kill(); } catch { /* уже мёртв */ } }
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
