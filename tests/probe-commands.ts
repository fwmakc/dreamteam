/**
 * Проба канонических команд: ядро исполняет `/…` для любой оболочки —
 * терминал, сервер (WS-тип command) и перехват в handleMessage.
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер, команды не пишутся
 * в историю разговора. Запуск: npm run probe:commands
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ── /agent, /grant, /project — управление теми же helpers, что у менеджера ──
{
  let lines = await runCommandText(engine, '/agent');
  check('agent: без подкоманды — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await runCommandText(engine, '/agent add test2 Второй лаборант');
  check('agent add: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  let team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  const second = team.find((a) => a.id === 'test2');
  check('agent add: записан с ролью', second?.name === 'Второй' && second?.role === 'лаборант');
  check('agent add: дефолты эмодзи/цвета', second?.emoji === '🤖' && second?.color === 'white');
  let threw = '';
  try {
    await runCommandText(engine, '/agent add test2 Дубль');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('agent add: дубликат id — ошибка', threw.includes('уже есть'));
  lines = await runCommandText(engine, '/agent set test2 role=сметана provider=mock');
  check('agent set: отчёт с полями', lines[0]?.includes('role="сметана"') ?? false);
  team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  check('agent set: роль и провайдер записаны', team.find((a) => a.id === 'test2')?.role === 'сметана');
  const badTemp = await runCommandText(engine, '/agent set test2 temperature=жарко');
  check('agent set: temperature не число — отказ', badTemp[0]?.includes('числом') ?? false);

  lines = await runCommandText(engine, '/grant');
  check('grant: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await runCommandText(engine, '/grant test2 files');
  check('grant: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  check('grant: тул files у агента', Boolean((team.find((a) => a.id === 'test2')?.tools as { files?: unknown })?.files));
  threw = '';
  try {
    await runCommandText(engine, '/grant test2 nosuchtool');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('grant: неизвестный тул — отказ', threw.includes('nosuchtool'));

  lines = await runCommandText(engine, '/project');
  check('project: без подкоманды — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await runCommandText(
    engine,
    '/project add web; prod: deploy@10.0.0.1:2202; backup: 10.0.0.2',
  );
  check('project add: отчёт с серверами', lines[0]?.includes('prod, backup') ?? false);
  const projects = JSON.parse(readFileSync(join(proj, 'projects.json'), 'utf8')) as {
    web?: { hosts: Record<string, { host: string; user?: string; port?: number }> };
  };
  check(
    'project add: user и порт разобраны',
    projects.web?.hosts.prod?.user === 'deploy' && projects.web.hosts.prod.port === 2202
      && projects.web.hosts.backup?.host === '10.0.0.2',
  );
  lines = await runCommandText(engine, '/project host web staging=10.0.0.3');
  check('project host: отчёт ✓', lines[0]?.includes('staging') ?? false);
  threw = '';
  try {
    await runCommandText(engine, '/project host nope x=1.2.3.4');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('project host: нет проекта — отказ', threw.includes('nope'));
}

// ── края: синтаксис, отказы, свой тул из tools/ ─────────────────────────────
{
  await runCommandText(engine, '/session abc');
  check('session: не-номер — заметка через presenter', notices.some((t) => t.includes('Не нашёл разговор №abc')));
  const d = await runCommandText(engine, '/delete abc');
  check('delete: не-номер — отказ', d[0]?.includes('Не нашёл') ?? false);
  const m = await runCommandText(engine, '/memory 1');
  check('memory: номер не имя — внятный отказ', m[0]?.includes('Нет участника «1»') ?? false);
  const o = await runCommandText(engine, '/out 99');
  check('out: нет номера — отказ', o[0]?.includes('Нет участника «99»') ?? false);

  // свой тул: достаточно файла tools/<id>.ts — включается командой
  writeFileSync(
    join(proj, 'tools', 'mytool.ts'),
    'export default () => ({ desc: "Мой тул", check: () => "allow" as const, async run() { return "ок"; } });\n',
  );
  const g = await runCommandText(engine, '/grant test2 mytool');
  check('grant: свой тул из tools/ — отчёт', g[0]?.startsWith('✓') ?? false);
  const team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  check('grant: свой тул записан агенту', Boolean((team.find((a) => a.id === 'test2')?.tools as { mytool?: unknown })?.mytool));

  let threw = '';
  try {
    await runCommandText(engine, '/agent set test2 foo=bar');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('agent set: только неизвестные поля — ошибка helper', threw.includes('не понятно, что менять'));

  const p = await runCommandText(engine, '/project add lonely');
  check('project add: без серверов — синтаксис', p[0]?.includes('Синтаксис') ?? false);
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
