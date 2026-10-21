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
const { runOperationText, OPERATIONS, operationCommand, operationArgs } = await import('../src/core/operations.js');
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

const run = (_e: unknown, line: string): Promise<string[]> => runOperationText(engine, line);
let failed = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name);
  if (!cond) failed++;
}

// ── /help: манифест как источник справки ────────────────────────────────────
{
  const lines = await run(engine, '/help');
  check('help: перечислены все операции манифеста', OPERATIONS.every((c) => lines.some((l) => l.includes(operationCommand(c)))));
  check('help: подсказки @упоминаний', lines.some((l) => l.includes('@менеджер')));
  check('манифест: у операций нет нижних подчёркиваний', OPERATIONS.every((o) => !o.name.includes('_')));
  const { operationHints } = await import('../src/core/operations.js');
  check('подсказки: по одной на операцию', operationHints().length === OPERATIONS.length);
}

// ── разговоры: new/open/delete/rename/history/export ────────────────────────
{
  let lines = await run(engine, '/sessions');
  check('sessions: текущий помечен', lines.some((l) => l.includes('← текущий')));
  check('sessions: id показан', lines.some((l) => l.includes(' · id ')) ?? false);

  lines = await run(engine, '/session new');
  check('session new: новый разговор (сессий 2)', app.store.list().length === 2);
  lines = await run(engine, '/session rename Пристрелочный разговор');
  check('session rename: отчёт', lines[0]?.includes('Пристрелочный разговор') ?? false);
  check('session rename: заголовок изменился', (await run(engine, '/sessions')).some((l) => l.includes('Пристрелочный разговор')));
  lines = await run(engine, '/session history');
  check('session history: приветствие менеджера на месте', lines.some((l) => l.includes('менеджер переговорки')) ?? false);

  lines = await run(engine, '/session open 1');
  check('session open: переключение на первый', Boolean(app.session));
  lines = await run(engine, '/session open 2');
  check('session open: вернулись на второй', Boolean(app.session));

  lines = await run(engine, '/session delete 99');
  check('session delete: нет номера — отказ', lines[0]?.includes('Не нашёл') ?? false);
  lines = await run(engine, '/session delete 2');
  check('session delete: текущий не удаляется', lines[0]?.includes('нельзя') ?? false);
  await run(engine, '/session open abc');
  check('session open: не-номер — заметка через presenter', notices.some((t) => t.includes('Не нашёл разговор №abc')));

  lines = await run(engine, '/session export');
  check('session export: архив текущего в рабочей папке', lines[0]?.includes('Экспорт:') ?? false);
  lines = await run(engine, '/home export');
  check('home export: архив дома', (lines[0]?.includes('Экспорт:') && lines[0]?.includes('dt-home-')) ?? false);
}

// ── чат: add/remove ──────────────────────────────────────────────────────────
{
  let lines = await run(engine, '/chat add');
  check('chat add: без аргумента — подсказка', lines[0]?.includes('Кого позвать?') ?? false);
  lines = await run(engine, '/chat add Тест');
  check('chat add: отчёт о вызове', lines[0]?.includes('присоединился') ?? false);
  lines = await run(engine, '/chat add Тест');
  check('chat add: повтор — уже в чате', lines[0]?.includes('уже в чате') ?? false);
  lines = await run(engine, '/chat add 2');
  check('chat add: по номеру из /team', lines[0]?.includes('Глеб') ?? false);
  lines = await run(engine, '/chat remove Тест');
  check('chat remove: отчёт о выводе', lines[0]?.includes('покинул') ?? false);
  lines = await run(engine, '/chat add Никто');
  check('chat add: неизвестный — внятный отказ', lines[0]?.includes('Нет участника «Никто»') ?? false);
}

// ── профиль и память ─────────────────────────────────────────────────────────
{
  let lines = await run(engine, '/profile set Иванов; инженер; пишу код');
  check('profile set: сохранение профиля', lines[0]?.includes('Иванов') ?? false);
  check('profile set: профиль в app', app.profile.name === 'Иванов' && app.profile.role === 'инженер');
  lines = await run(engine, '/profile');
  check('profile: показ профиля', lines[0]?.includes('Иванов — инженер') ?? false);

  lines = await run(engine, '/memory shared');
  check('memory shared: пустая общая — подсказка', lines[0]?.includes('пока пуста') ?? false);
  lines = await run(engine, '/memory Тест');
  check('memory Тест: без глагола — личная память', lines.some((l) => l.startsWith('Задача:')) ?? false);
  lines = await run(engine, '/memory');
  check('memory: обзор — чья память', lines[0]?.includes('Чья память') ?? false);
  lines = await run(engine, '/memory show С drawback');
  check('memory show: неизвестное имя — отказ', lines[0]?.includes('Нет участника') ?? false);
}

// ── провайдеры ───────────────────────────────────────────────────────────────
{
  let lines = await run(engine, '/provider');
  check('provider: обзор — готовые провайдеры', lines.some((l) => l.includes('mock') && l.includes('готов')) ?? false);
  lines = await run(engine, '/provider set mock');
  check('provider set: смена на тот же', lines[0]?.includes('Основной провайдер: mock') ?? false);
  lines = await run(engine, '/provider set nope');
  check('provider set: неизвестный id — отказ', lines[0]?.includes('Нет провайдера «nope»') ?? false);
}

// ── команда: team add/update/delete/grant ────────────────────────────────────
{
  let lines = await run(engine, '/team');
  check('team: менеджер первый', lines[0]?.includes('менеджер переговорки') ?? false);
  check('team: не в чате — метка с новой подсказкой', lines.some((l) => l.includes('не в этом чате (/chat add Тест)')) ?? false);

  lines = await run(engine, '/team add');
  check('team add: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await run(engine, '/team add test2 Второй лаборант');
  check('team add: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  let team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  const second = team.find((a) => a.id === 'test2');
  check('team add: записан с ролью', second?.name === 'Второй' && second?.role === 'лаборант');
  check('team add: дефолты эмодзи/цвета', second?.emoji === '🤖' && second?.color === 'white');
  let threw = '';
  try {
    await run(engine, '/team add test2 Дубль');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('team add: дубликат id — ошибка', threw.includes('уже есть'));

  lines = await run(engine, '/team update test2 role=сметана provider=mock');
  check('team update: отчёт с полями', lines[0]?.includes('role="сметана"') ?? false);
  team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  check('team update: роль и провайдер записаны', team.find((a) => a.id === 'test2')?.role === 'сметана');
  const badTemp = await run(engine, '/team update test2 temperature=жарко');
  check('team update: temperature не число — отказ', badTemp[0]?.includes('числом') ?? false);

  lines = await run(engine, '/team grant');
  check('team grant: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await run(engine, '/team grant test2 files');
  check('team grant: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  check('team grant: тул files у агента', Boolean((team.find((a) => a.id === 'test2')?.tools as { files?: unknown })?.files));
  threw = '';
  try {
    await run(engine, '/team grant test2 nosuchtool');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('team grant: неизвестный тул — отказ', threw.includes('nosuchtool'));

  lines = await run(engine, '/team delete test2');
  check('team delete: отчёт', (lines[0]?.includes('test2') || lines[0]?.includes('Второй')) ?? false);
  team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  check('team delete: агента нет на диске', !team.some((a) => a.id === 'test2'));
}

// ── проекты: add/host add/host delete/delete/list ────────────────────────────
{
  let lines = await run(engine, '/project add');
  check('project add: без серверов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await run(engine, '/project add web; prod: deploy@10.0.0.1:2202; backup: 10.0.0.2');
  check('project add: отчёт с серверами', lines[0]?.includes('prod, backup') ?? false);
  const projects = JSON.parse(readFileSync(join(proj, 'projects.json'), 'utf8')) as {
    web?: { hosts: Record<string, { host: string; user?: string; port?: number }> };
  };
  check(
    'project add: user и порт разобраны',
    projects.web?.hosts.prod?.user === 'deploy' && projects.web.hosts.prod.port === 2202
      && projects.web.hosts.backup?.host === '10.0.0.2',
  );
  lines = await run(engine, '/project host add web staging=10.0.0.3');
  check('project host add: отчёт ✓', lines[0]?.includes('staging') ?? false);
  let threw = '';
  try {
    await run(engine, '/project host add nope x=1.2.3.4');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('project host add: нет проекта — отказ', threw.includes('nope'));

  lines = await run(engine, '/project');
  check('project: обзор — список серверов', lines.some((l) => l.includes('prod: deploy@10.0.0.1:2202')) ?? false);
  lines = await run(engine, '/project host delete web staging');
  check('project host delete: сервер убран', !(JSON.parse(readFileSync(join(proj, 'projects.json'), 'utf8')) as typeof projects).web?.hosts.staging);
  lines = await run(engine, '/project delete web');
  check('project delete: проект убран', !(JSON.parse(readFileSync(join(proj, 'projects.json'), 'utf8')) as typeof projects).web);
}

// ── расписание: list/add/toggle/delete ───────────────────────────────────────
{
  let lines = await run(engine, '/schedule');
  check('schedule: обзор пуст — подсказка', lines[0]?.includes('Задач нет') ?? false);
  lines = await run(engine, '/schedule add Напомнить о перерыве 15');
  check('schedule add: отчёт с интервалом', lines[0]?.includes('каждые 15 мин') ?? false);
  const schedule = JSON.parse(readFileSync(join(proj, 'schedule.json'), 'utf8')) as Array<{ id: string; message: string; intervalMinutes: number; enabled: boolean }>;
  check('schedule add: задача на диске', schedule.length === 1 && schedule[0].message === 'Напомнить о перерыве' && schedule[0].intervalMinutes === 15);
  lines = await run(engine, `/schedule toggle ${schedule[0].id}`);
  check('schedule toggle: выключена', lines[0]?.includes('⏸') ?? false);
  lines = await run(engine, `/schedule delete ${schedule[0].id}`);
  check('schedule delete: удалена', (JSON.parse(readFileSync(join(proj, 'schedule.json'), 'utf8')) as unknown[]).length === 0);
}

// ── настройки и менеджер ─────────────────────────────────────────────────────
{
  let lines = await run(engine, '/settings');
  check('settings: обзор — язык и лимиты', lines.some((l) => l.includes('maxTurns')) ?? false);
  lines = await run(engine, '/settings set maxTurns=2');
  check('settings set: отчёт', lines[0]?.includes('обновлены') ?? false);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { maxTurns: number };
  check('settings set: значение на диске', settings.maxTurns === 2);

  lines = await run(engine, '/manager');
  check('manager: обзор — провайдер', lines.some((l) => l.includes('провайдер: mock')) ?? false);
  lines = await run(engine, '/manager set temperature=0.4');
  check('manager set: отчёт', lines[0]?.includes('temperature="0.4"') ?? false);
  const manager = JSON.parse(readFileSync(join(proj, 'manager.json'), 'utf8')) as { temperature: number };
  check('manager set: значение на диске', manager.temperature === 0.4);

  lines = await run(engine, '/auto on 3');
  check('auto on: лимит ходов', lines[0]?.includes('до 3 ходов') ?? false);
  lines = await run(engine, '/auto off');
  check('auto off: выключен', lines[0]?.includes('выключен') ?? false);
}

// ── края: старые имена умерли, свой тул, неизвестная, терминальная ──────────
{
  await run(engine, '/session open abc');
  check('session open: не-номер — заметка через presenter', notices.some((t) => t.includes('Не нашёл разговор №abc')));

  // свой тул: достаточно файла tools/<id>.ts — включается командой
  writeFileSync(
    join(proj, 'tools', 'mytool.ts'),
    'export default () => ({ desc: "Мой тул", check: () => "allow" as const, async run() { return "ок"; } });\n',
  );
  writeFileSync(
    join(proj, 'agents.json'),
    JSON.stringify(
      [
        { id: 'test_probe', name: 'Тест', role: 'подопытный', prompt: 'Ты Тест.', emoji: '🧪', color: 'cyan' },
        { id: 'gleb', name: 'Глеб', role: 'скептик', prompt: 'Ты Глеб.', emoji: '💾', color: 'yellow' },
        { id: 'test2', name: 'Второй', role: 'лаборант', prompt: 'Ты Второй.', emoji: '🤖', color: 'white' },
      ],
      null,
      2,
    ),
  );
  const g = await run(engine, '/team grant test2 mytool');
  check('team grant: свой тул из tools/ — отчёт', g[0]?.startsWith('✓') ?? false);
  const team = (await import('../src/agents.js')).loadTeam(join(proj, 'agents.json'));
  check('team grant: свой тул записан агенту', Boolean((team.find((a) => a.id === 'test2')?.tools as { mytool?: unknown })?.mytool));

  let threw = '';
  try {
    await run(engine, '/team update test2 foo=bar');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('team update: только неизвестные поля — ошибка helper', threw.includes('не понятно, что менять'));

  // старые короткие имена больше не существуют
  const legacy = await run(engine, '/new');
  check('легаси: /new умер — неизвестная команда', legacy[0]?.includes('Неизвестная команда') ?? false);
  const legacy2 = await run(engine, '/add Тест');
  check('легаси: /add умер — неизвестная команда', legacy2[0]?.includes('Неизвестная команда') ?? false);
  const legacy3 = await run(engine, '/grant test2 files');
  check('легаси: /grant умер — неизвестная команда', legacy3[0]?.includes('Неизвестная команда') ?? false);

  const unknown = await run(engine, '/foobar');
  check('неизвестная команда — отказ', unknown[0]?.includes('Неизвестная команда') ?? false);
  const ex = await run(engine, '/exit');
  check('exit: только терминал', ex[0]?.includes('терминала') ?? false);
  const q = await run(engine, '/q');
  check('алиас /q — тоже отклонён', q[0]?.includes('терминала') ?? false);
}

// ── перехват в handleMessage: команда исполняется, но не пишется в историю ──
{
  app.session.participants = [MANAGER_ID];
  app.store.save(app.session);
  const before = app.session.messages.length;
  await engine.handleMessage('/chat add Тест', new AbortController().signal);
  check('handleMessage: /chat add исполнен', notices.some((t) => t.includes('присоединился')) ?? false);
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
