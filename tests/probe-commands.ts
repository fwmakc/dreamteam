/**
 * Проба канонических команд: ядро исполняет `/…` для любой оболочки —
 * терминал, сервер (WS-тип command) и перехват в handleMessage.
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер, команды не пишутся
 * в историю разговора. Запуск: npm run probe:commands
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'dt-cmds-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = proj;
// рабочая папка инструментов = cwd на момент импорта: уводим процесс в tmp
process.chdir(base);

writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify({ default: 'mock', providers: { mock: { adapter: 'mock' } } }, null, 2),
);

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { runCommandText, COMMANDS } = await import('../src/core/commands.js');
const { MANAGER_ID } = await import('../src/manager.js');
import type { Presenter, SpeakerRef, TurnSink } from '../src/core/presenter.js';

// ── заглушка Presenter: собирает всё, что ядро говорит оболочке ─────────────
const notices: string[] = [];
const errors: string[] = [];
let opened = 0;
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice(text) { notices.push(text); },
  error(text) { errors.push(text); },
  turnHeader(_agent: SpeakerRef) {},
  busy(_label: string) { return { stop() {} }; },
  stream(_label: string) { return sink; },
  turnEnd(_full: string) {},
  say(_text: string) {},
  toolLines(_results: string[]) {},
  attachment(_title: string, _digest: string) {},
  async confirm() { return false; },
  async chooseSession() { return null; },
  sessionOpened(_session) { opened++; },
};

const { app } = await bootstrapApp();
const engine = new Engine(app, stub);

// команда из двух агентов — в уже скаффолденный проект
writeFileSync(
  join(proj, 'agents.json'),
  JSON.stringify(
    [
      { id: 'test_probe', name: 'Тест', role: 'подопытный', prompt: 'Ты Тест.', emoji: '🧪', color: 'cyan' },
      { id: 'gleb', name: 'Глеб', role: 'скептик', prompt: 'Ты Глеб.', emoji: '💾', color: 'yellow' },
    ],
    null,
    2,
  ),
);

// консьерж-старт: в чате один менеджер — как после /new или первого запуска
app.session.participants = [MANAGER_ID];
app.store.save(app.session);

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name);
  if (!cond) failed++;
}

// ── /help ────────────────────────────────────────────────────────────────────
{
  const lines = await runCommandText(engine, '/help');
  check('help: перечислены все команды из списка', COMMANDS.every((c) => lines.some((l) => l.includes(c.cmd))));
  check('help: подсказки @упоминаний', lines.some((l) => l.includes('@менеджер')));
  const h = await runCommandText(engine, '/h');
  check('алиас /h — та же справка', h.length === lines.length);
}

// ── /add, /out ───────────────────────────────────────────────────────────────
{
  let lines = await runCommandText(engine, '/add');
  check('add: без аргумента — подсказка', lines[0]?.includes('Кого позвать?') ?? false);
  lines = await runCommandText(engine, '/add Тест');
  check('add: отчёт о вызове', lines[0]?.includes('присоединился') ?? false);
  lines = await runCommandText(engine, '/add Тест');
  check('add: повтор — уже в чате', lines[0]?.includes('уже в чате') ?? false);
  lines = await runCommandText(engine, '/add 2');
  check('add: по номеру из /team', lines[0]?.includes('Глеб') ?? false);
  lines = await runCommandText(engine, '/out Тест');
  check('out: отчёт о выводе', lines[0]?.includes('покинул') ?? false);
  lines = await runCommandText(engine, '/add Никто');
  check('add: неизвестный — внятный отказ', lines[0]?.includes('Нет участника «Никто»') ?? false);
}

// ── /sessions, /session, /delete ─────────────────────────────────────────────
{
  const lines = await runCommandText(engine, '/sessions');
  check('sessions: текущий помечен', lines.some((l) => l.includes('← текущий')));
  let d = await runCommandText(engine, '/delete 99');
  check('delete: нет номера — отказ', d[0]?.includes('Не нашёл') ?? false);
  d = await runCommandText(engine, '/delete 1');
  check('delete: текущий не удаляется', d[0]?.includes('нельзя') ?? false);
  await runCommandText(engine, '/session 99');
  check('session: нет номера — заметка через presenter', notices.some((t) => t.includes('Не нашёл разговор №99')));
}

// ── /provider, /me ───────────────────────────────────────────────────────────
{
  let lines = await runCommandText(engine, '/provider');
  check('provider: статус с менеджерским', lines[0]?.includes('Основной провайдер: mock') ?? false);
  lines = await runCommandText(engine, '/provider mock');
  check('provider: смена на тот же', lines[0]?.includes('Основной провайдер: mock') ?? false);
  lines = await runCommandText(engine, '/provider nope');
  check('provider: неизвестный id — отказ', lines[0]?.includes('Нет провайдера «nope»') ?? false);
  lines = await runCommandText(engine, '/me Иванов; инженер; пишу код');
  check('me: сохранение профиля', lines[0]?.includes('Иванов') ?? false);
  check('me: профиль в app', app.profile.name === 'Иванов' && app.profile.role === 'инженер');
  lines = await runCommandText(engine, '/me');
  check('me: показ профиля', lines[0]?.includes('Иванов — инженер') ?? false);
}

// ── /memory, /history, /team, /providers ─────────────────────────────────────
{
  let lines = await runCommandText(engine, '/memory shared');
  check('memory: пустая общая — подсказка', lines[0]?.includes('пока пуста') ?? false);
  lines = await runCommandText(engine, '/memory Тест');
  check('memory: личная — заготовка задачи', lines.some((l) => l.startsWith('Задача:')) ?? false);
  lines = await runCommandText(engine, '/memory');
  check('memory: без аргумента — чья память', lines[0]?.includes('Чья память') ?? false);
  lines = await runCommandText(engine, '/memory С drawback');
  check('memory: неизвестное имя — отказ', lines[0]?.includes('Нет участника') ?? false);
  lines = await runCommandText(engine, '/history');
  check('history: пустой разговор', lines[0]?.includes('Разговор пуст') ?? false);
  lines = await runCommandText(engine, '/team');
  check('team: менеджер первый', lines[0]?.includes('менеджер переговорки') ?? false);
  check('team: не в чате — метка с подсказкой', lines.some((l) => l.includes('не в этом чате (/add Тест)')) ?? false);
  lines = await runCommandText(engine, '/providers');
  check('providers: mock со статусом', lines.some((l) => l.includes('mock') && l.includes('готов')) ?? false);
}

// ── неизвестная и терминальная ───────────────────────────────────────────────
{
  const lines = await runCommandText(engine, '/foobar');
  check('неизвестная команда — отказ', lines[0]?.includes('Неизвестная команда') ?? false);
  const ex = await runCommandText(engine, '/exit');
  check('exit: только терминал', ex[0]?.includes('терминала') ?? false);
  const q = await runCommandText(engine, '/q');
  check('алиас /q — тоже отклонён', q[0]?.includes('терминала') ?? false);
}

// ── перехват в handleMessage: команда исполняется, но не пишется в историю ──
{
  app.session.participants = [MANAGER_ID];
  app.store.save(app.session);
  const before = app.session.messages.length;
  await engine.handleMessage('/add Тест', new AbortController().signal);
  check('handleMessage: /add исполнен', notices.some((t) => t.includes('присоединился')) ?? false);
  check('handleMessage: команда не в истории', app.session.messages.length === before);
}

console.log(failed === 0 ? '\nВсе проверки прошли' : `\nFAIL: ${failed}`);
process.on('exit', () => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // tmp — не страшно
  }
});
process.exit(failed === 0 ? 0 : 1);
