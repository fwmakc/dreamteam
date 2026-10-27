/**
 * Проба канонических команд: ядро исполняет `/…` для любой оболочки —
 * терминал, сервер (WS-тип command) и перехват в handleMessage.
 * Герметично: временный DT_HOME, mock-провайдер, команды не пишутся
 * в историю разговора. Запуск: npm run probe:commands
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeModels } from './models.js';

const base = mkdtempSync(join(tmpdir(), 'dt-cmds-'));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
// рабочая папка инструментов = cwd на момент импорта: уводим процесс в tmp
process.chdir(base);

writeModels(home, { mock: { provider: 'mock' } });
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { runOperationText, OPERATIONS, operationCommand, operationArgs } = await import('../src/core/operations.js');
const { MANAGER_ID } = await import('../src/manager.js');
import type { Presenter, SpeakerRef, TurnSink } from '../src/core/presenter.js';

// ── заглушка Presenter: собирает всё, что ядро говорит оболочке ─────────────
const notices: string[] = [];
const errors: string[] = [];
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice(text) { notices.push(text); },
  // события чата (реплики менеджера в хронике) показываются как заметки
  service(text) { notices.push(text); },
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
  sessionOpened(_session) {},
};

const { app } = await bootstrapApp();
const engine = new Engine(app, stub);
// старт без проекта — открываем свой: разговоры живут в доме
engine.newProject('dev', join(base, 'ws'));
// project.json открытого проекта — сюда все helpers пишут секреты (hosts/mails/messengers)
const readProj = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, 'projects', 'dev', 'project.json'), 'utf8')) as Record<string, unknown>;

// команда из двух агентов — в уже скаффолденный проект
mkdirSync(join(home, 'agents'), { recursive: true });
writeFileSync(join(home, 'agents', 'test_probe.json'), JSON.stringify({ name: 'Тест', prompt: 'Ты Тест.', emoji: '🧪', color: 'cyan' }, null, 2));
writeFileSync(join(home, 'agents', 'gleb.json'), JSON.stringify({ name: 'Глеб', prompt: 'Ты Глеб.', emoji: '💾', color: 'yellow' }, null, 2));

// консьерж-старт: в чате один менеджер — как после первого запуска
app.session!.participants = [MANAGER_ID];
app.store!.save(app.session!);

const run = (_e: unknown, line: string): Promise<string[]> => runOperationText(engine, line);
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) failed++;
}
const threw = async (line: string): Promise<string> => {
  try {
    await run(engine, line);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
};

// ── /help: манифест как источник справки ────────────────────────────────────
{
  const lines = await run(engine, '/help');
  check('help: перечислены все операции манифеста', OPERATIONS.every((c) => lines.some((l) => l.includes(operationCommand(c)))));
  check('help: подсказки @упоминаний', lines.some((l) => l.includes('@менеджер')));
  check('манифест: у операций нет нижних подчёркиваний', OPERATIONS.every((o) => !o.name.includes('_')));
  const { operationHints } = await import('../src/core/operations.js');
  check('подсказки: по одной на операцию', operationHints().length === OPERATIONS.length);
}

// ── разговоры: new/update/history/open/close/delete/export ──────────────────
{
  let lines = await run(engine, '/sessions');
  check('sessions: текущий помечен', lines.some((l) => l.includes('← текущий')));
  check('sessions: id в строке списка', lines.some((l) => l.includes(`• ${app.session!.id} —`)));

  lines = await run(engine, '/session new');
  check('session new: новый разговор создан и открыт (сессий 2)', app.store!.list().length === 2);
  const fresh = app.session!.id;
  const older = app.store!.list().map((s) => s.id).find((id) => id !== fresh)!;

  lines = await run(engine, '/session update title=Пристрелочный разговор');
  check('session update: отчёт', lines[0]?.includes('Пристрелочный разговор') ?? false);
  check(
    'session update: заголовок изменился (пробел в значении склеен)',
    (await run(engine, '/sessions')).some((l) => l.includes('Пристрелочный разговор')),
  );

  lines = await run(engine, '/session history');
  check('session history: приветствие менеджера на месте', lines.some((l) => l.includes('менеджер переговорки')) ?? false);
  lines = await run(engine, '/session history 1 1');
  check('session history: срез включительно — одно сообщение', lines.some((l) => l.includes('показано 1 из')) ?? false);
  lines = await run(engine, '/session history abc');
  check('session history: from не число — отказ', lines[0]?.includes('from — номер сообщения') ?? false);
  lines = await run(engine, '/session history 5 2');
  check('session history: to меньше from — отказ', lines[0]?.includes('to — номер сообщения') ?? false);

  lines = await run(engine, `/session open ${older}`);
  check('session open: переключение на первый', app.session?.id === older);
  lines = await run(engine, `/session open ${fresh}`);
  check('session open: вернулись на свежий', app.session?.id === fresh);

  lines = await run(engine, '/session delete 99');
  check('session delete: нет такого id — отказ', lines[0]?.includes('Разговора с id «99» нет') ?? false);
  lines = await run(engine, `/session delete ${fresh}`);
  check('session delete: текущий — отказ «сначала close»', lines[0]?.includes('нельзя') ?? false);
  lines = await run(engine, `/session delete ${older}`);
  check('session delete: не-текущий удалён', !app.store!.list().some((s) => s.id === older));

  await run(engine, '/session open abc');
  check('session open: нет такого id — заметка через presenter', notices.some((t) => t.includes('Разговора с id «abc» нет')));

  lines = await run(engine, '/session close');
  check('session close: разговор закрыт, проект открыт', lines[0]?.includes('Проект открыт') ?? false);
  lines = await run(engine, '/session history');
  check('history без разговора — отказ с подсказкой', lines[0]?.includes('нет открытого разговора') ?? false);
  lines = await run(engine, '/sessions');
  check('sessions: список живёт и без разговора', lines.some((l) => l.includes('Пристрелочный разговор')) ?? false);
  lines = await run(engine, `/session open ${fresh}`);
  check('session open: вернулись после close', app.session?.id === fresh);

  lines = await run(engine, '/session export');
  check('session export: архив текущего в рабочей папке', lines[0]?.includes('Экспорт:') ?? false);
  lines = await run(engine, '/export');
  check('export: архив дома', (lines[0]?.includes('Экспорт:') && lines[0]?.includes('home-')) ?? false);
}

// ── чат: /session agent add|delete ───────────────────────────────────────────
{
  // событие чата — реплика менеджера в хронике разговора, а не заметка
  const chronicle = () => app.session!.messages.at(-1)?.text ?? '';
  let lines = await run(engine, '/session agent add');
  check('session agent add: без аргумента — подсказка', lines[0]?.includes('Кого позвать?') ?? false);
  lines = await run(engine, '/session agent add test_probe');
  check(
    'session agent add: событие — реплика менеджера в хронике',
    lines.length === 0 && chronicle().includes('присоединился'),
    `lines=${JSON.stringify(lines)} last=${JSON.stringify(chronicle())}`,
  );
  check(
    'session agent add: автор события — менеджер-модератор',
    app.session!.messages.at(-1)?.authorId === MANAGER_ID && app.session!.messages.at(-1)?.authorRole === 'менеджер переговорки',
  );
  lines = await run(engine, '/session agent add test_probe');
  check('session agent add: повтор — уже в чате (без события)', lines[0]?.includes('уже в чате') ?? false);
  lines = await run(engine, '/session agent delete test_probe');
  check('session agent delete: событие — реплика в хронике', lines.length === 0 && chronicle().includes('покинул'));
  lines = await run(engine, '/session agent add ghost');
  check('session agent add: неизвестный id — внятный отказ', lines[0]?.includes('Нет агента с id «ghost»') ?? false);
}

// ── профиль и память ─────────────────────────────────────────────────────────
{
  let lines = await run(engine, '/profile update name=Иванов role=инженер about=пишу код');
  check('profile update: сохранение профиля', lines[0]?.includes('Иванов') ?? false);
  check(
    'profile update: поля в app (пробел в about склеен)',
    app.profile.name === 'Иванов' && app.profile.role === 'инженер' && app.profile.about === 'пишу код',
  );
  lines = await run(engine, '/profile');
  check('profile: показ профиля', lines[0]?.includes('Иванов — инженер') ?? false);

  lines = await run(engine, '/memory shared');
  check('memory shared: пустая общая — подсказка', lines[0]?.includes('пока пуста') ?? false);
  lines = await run(engine, '/memory test_probe');
  check('memory: по id — личная память', lines.some((l) => l.startsWith('Задача:')) ?? false);
  lines = await run(engine, '/memory');
  check('memory: обзор — чья память', lines[0]?.includes('Чья память') ?? false);
  lines = await run(engine, '/memory призрак');
  check('memory: неизвестный id — отказ', lines[0]?.includes('Нет агента с id «призрак»') ?? false);
}

// ── модели: список, смена основной через settings.update ─────────────────────
{
  let lines = await run(engine, '/models');
  check('models: обзор — готовые модели', lines.some((l) => l.includes('mock') && l.includes('готов')) ?? false);
  lines = await run(engine, '/settings update model.id=mock');
  check('settings update model.id: смена на ту же', lines[0]?.includes('обновлены') ?? false);
  lines = await run(engine, '/settings update model.id=nope');
  check('settings update model.id: неизвестный id — отказ', lines[0]?.includes('Нет модели «nope»') ?? false);

  lines = await run(engine, '/model update mock model=mock-9');
  check('model update: отчёт', lines[0]?.includes('mock-9') ?? false);
  const card = JSON.parse(readFileSync(join(home, 'models', 'mock.json'), 'utf8')) as { model?: string };
  check('model update: модель на диске', card.model === 'mock-9');
  const miss = await threw('/model update nope model=x');
  check('model update: нет модели — отказ', miss.includes('«nope» нет'));
}

// ── команда: /agent new/update/tool/delete ───────────────────────────────────
{
  let lines = await run(engine, '/agents');
  check('agents: менеджер первый', lines[0]?.includes('менеджер переговорки') ?? false);
  check('agents: не в чате — метка с подсказкой по id', lines.some((l) => l.includes('не в этом чате (/session agent add test_probe)')) ?? false);

  lines = await run(engine, '/agent new');
  check('agent new: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await run(engine, '/agent new test2 name=Второй');
  check('agent new: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  const load = async () => (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
  let team = await load();
  const second = team.find((a) => a.id === 'test2');
  check('agent new: записан', second?.name === 'Второй');
  check('agent new: дефолты эмодзи/цвета', second?.emoji === '🤖' && second?.color === 'white');
  const dup = await threw('/agent new test2 name=Дубль');
  check('agent new: дубликат id — ошибка', dup.includes('уже есть'));

  lines = await run(engine, '/agent update test2 role=сметана model.id=mock');
  check('agent update: отчёт с полями', lines[0]?.includes('role="сметана"') ?? false);
  team = await load();
  const t2 = team.find((a) => a.id === 'test2');
  check('agent update: роль записана', t2?.role === 'сметана');
  check('agent update: вложенная модель записана', t2?.model?.id === 'mock');
  const badTemp = await run(engine, '/agent update test2 temperature=жарко');
  check('agent update: temperature не число — отказ', badTemp[0]?.includes('числом') ?? false);

  lines = await run(engine, '/agent tool add');
  check('agent tool add: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await run(engine, '/agent tool add test2 files');
  check('agent tool add: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  team = await load();
  check('agent tool add: тул files у агента', Boolean((team.find((a) => a.id === 'test2')?.tools as { files?: unknown })?.files));
  const noTool = await threw('/agent tool add test2 nosuchtool');
  check('agent tool add: неизвестный тул — отказ', noTool.includes('nosuchtool'));

  lines = await run(engine, '/agent delete test2');
  check('agent delete: отчёт', (lines[0]?.includes('test2') || lines[0]?.includes('Второй')) ?? false);
  team = await load();
  check('agent delete: агента нет на диске', !team.some((a) => a.id === 'test2'));

  // список: и через запятую, и через пробел, вперемешку; чужой id не валит остальных
  for (const id of ['t3', 't4', 't5']) {
    lines = await run(engine, `/agent new ${id} name=Тест-${id}`);
  }
  lines = await run(engine, '/agent delete t3, t4 t5');
  check('agent delete: список — три отчёта ✓', lines.filter((l) => l.startsWith('✓')).length === 3);
  team = await load();
  check('agent delete: список — все удалены с диска', !team.some((a) => ['t3', 't4', 't5'].includes(a.id)));
  lines = await run(engine, '/agent delete t3, призрак');
  check(
    'agent delete: чужой id — ✗, без падения',
    lines.length === 2 && lines.every((l) => l.startsWith('✗')) && lines[1].includes('призрак'),
  );
  lines = await run(engine, '/agent delete');
  check('agent delete: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
}

// ── проекты: реестр + секреты (серверы) ──────────────────────────────────────
{
  let lines = await run(engine, '/projects');
  check('projects: реестр — текущий помечен', lines.some((l) => l.includes('← текущий')) ?? false);

  lines = await run(engine, '/project hosts');
  check('project hosts: пустой — подсказка', lines[0]?.includes('Серверов нет') ?? false);

  lines = await run(engine, '/project host add prod');
  check('project host add: отчёт ✓', lines[0]?.includes('prod') ?? false);
  lines = await run(engine, '/project host update prod host=10.0.0.1 user=deploy port=2202');
  check('project host update: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  const hosts = readProj().hosts as Record<string, { host: string; user?: string; port?: number }>;
  check(
    'project host update: поля разобраны (порт числом)',
    hosts.prod?.user === 'deploy' && hosts.prod?.port === 2202 && hosts.prod?.host === '10.0.0.1',
  );
  await run(engine, '/project host add backup');
  await run(engine, '/project host update backup host=10.0.0.2');
  lines = await run(engine, '/project hosts');
  check('project hosts: список серверов', lines.some((l) => l.includes('prod: deploy@10.0.0.1:2202')) ?? false);
  lines = await run(engine, '/project host delete backup');
  check('project host delete: сервер убран', !(readProj().hosts as typeof hosts).backup);
  const badId = await threw('/project host add Сервер');
  check('project host add: кириллический id — маска отклоняет', badId.includes('маске'));
}

// ── почта: list/add/update/delete ────────────────────────────────────────────
{
  let lines = await run(engine, '/project mails');
  check('project mails: пустой — подсказка', lines[0]?.includes('Ящиков нет') ?? false);

  lines = await run(engine, '/project mail add work');
  check('project mail add: отчёт ✓', lines[0]?.includes('work') ?? false);
  lines = await run(
    engine,
    '/project mail update work user=робот@corp.ru password=пароль-приложения imap=imap.corp.ru smtp=smtp.corp.ru smtpPort=587 tlsNoVerify=true',
  );
  check('project mail update: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  const mails = readProj().mails as Record<string, { user?: string; smtpPort?: number; tlsNoVerify?: boolean }>;
  check(
    'project mail update: пары разобраны (порт числом, флаг булевым)',
    mails.work?.user === 'робот@corp.ru' && mails.work?.smtpPort === 587 && mails.work?.tlsNoVerify === true,
  );
  lines = await run(engine, '/project mails');
  check(
    'project mails: ящик виден',
    lines.some((l) => l.includes('робот@corp.ru') && l.includes('imap.corp.ru:993') && l.includes('smtp.corp.ru:587')) ?? false,
  );
  const dup = await threw('/project mail add work');
  check('project mail add: дубликат — ошибка', dup.includes('уже есть'));
  lines = await run(engine, '/project mail update work');
  check('project mail update: без полей — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  const badPort = await threw('/project mail update work port=abc');
  check('project mail update: порт не число — отказ валидатора', badPort.includes('целое число больше нуля'));
  lines = await run(engine, '/project mail delete work');
  check('project mail delete: ящик убран', !(readProj().mails as typeof mails).work);
}

// ── мессенджеры: list/add/update/delete ──────────────────────────────────────
{
  let lines = await run(engine, '/project messengers');
  check('project messengers: пустой — подсказка', lines[0]?.includes('Ботов нет') ?? false);

  lines = await run(engine, '/project messenger add telegram');
  check('project messenger add: отчёт ✓', lines[0]?.includes('telegram') ?? false);
  lines = await run(engine, '/project messenger update telegram token=123456:ABC-cmd');
  check('project messenger update: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  const mess = readProj().messengers as Record<string, { token?: string } | undefined>;
  check('project messenger update: токен на диске', mess.telegram?.token === '123456:ABC-cmd');
  lines = await run(engine, '/project messengers');
  check(
    'project messengers: бот виден (токен не светится)',
    lines.some((l) => l.includes('telegram') && l.includes('токен сохранён')) ?? false,
  );
  const alien = await threw('/project messenger add slack');
  check('project messenger add: чужой ключ — ошибка', alien.includes('telegram'));
  const dup = await threw('/project messenger add telegram');
  check('project messenger add: дубликат — ошибка', dup.includes('уже есть'));
  lines = await run(engine, '/project messenger delete telegram');
  check('project messenger delete: бот убран', !(readProj().messengers as typeof mess).telegram);
}

// ── расписание: list/add/toggle/delete ───────────────────────────────────────
{
  let lines = await run(engine, '/schedule');
  check('schedule: обзор пуст — подсказка', lines[0]?.includes('Задач нет') ?? false);
  lines = await run(engine, '/schedule add Напомнить о перерыве 15');
  check('schedule add: отчёт с интервалом', lines[0]?.includes('каждые 15 мин') ?? false);
  const schedule = JSON.parse(readFileSync(join(home, 'schedule.json'), 'utf8')) as Array<{ id: string; message: string; intervalMinutes: number; enabled: boolean }>;
  check('schedule add: задача на диске', schedule.length === 1 && schedule[0].message === 'Напомнить о перерыве' && schedule[0].intervalMinutes === 15);
  lines = await run(engine, `/schedule toggle ${schedule[0].id}`);
  check('schedule toggle: выключена', lines[0]?.includes('⏸') ?? false);
  lines = await run(engine, `/schedule delete ${schedule[0].id}`);
  check('schedule delete: удалена', (JSON.parse(readFileSync(join(home, 'schedule.json'), 'utf8')) as unknown[]).length === 0);
}

// ── настройки и менеджер ─────────────────────────────────────────────────────
{
  let lines = await run(engine, '/settings');
  check('settings: обзор — язык и лимиты', lines.some((l) => l.includes('maxTurns')) ?? false);
  lines = await run(engine, '/settings update maxTurns=2');
  check('settings update: отчёт', lines[0]?.includes('обновлены') ?? false);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { maxTurns: number };
  check('settings update: значение на диске', settings.maxTurns === 2);

  lines = await run(engine, '/manager');
  check('manager: обзор — модель', lines.some((l) => l.includes('модель: mock')) ?? false);
  lines = await run(engine, '/manager update temperature=0.4');
  check('manager update: отчёт', lines[0]?.includes('temperature="0.4"') ?? false);
  const manager = JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')) as { temperature: number };
  check('manager update: значение на диске', manager.temperature === 0.4);

  lines = await run(engine, '/auto on 3');
  check('auto on: лимит ходов', lines[0]?.includes('до 3 ходов') ?? false);
  lines = await run(engine, '/auto off');
  check('auto off: выключен', lines[0]?.includes('выключен') ?? false);
}

// ── края: старые имена умерли, свой тул, неизвестная, терминальная ──────────
{
  // свой тул: достаточно файла tools/<id>.ts — включается командой
  writeFileSync(
    join(home, 'tools', 'mytool.ts'),
    'export default () => ({ desc: "Мой тул", check: () => "allow" as const, async run() { return "ок"; } });\n',
  );
  writeFileSync(join(home, 'agents', 'test2.json'), JSON.stringify({ name: 'Второй', prompt: 'Ты Второй.', color: 'white' }, null, 2));
  const g = await run(engine, '/agent tool add test2 mytool');
  check('agent tool add: свой тул из tools/ — отчёт', g[0]?.startsWith('✓') ?? false);
  const team = (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
  check('agent tool add: свой тул записан агенту', Boolean((team.find((a) => a.id === 'test2')?.tools as { mytool?: unknown })?.mytool));

  const mystery = await threw('/agent update test2 foo=bar');
  check('agent update: только неизвестные поля — ошибка helper', mystery.includes('не понятно, что менять'));

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

// ── перехват в handleMessage: команда исполняется, сам текст не пишется ──────
{
  app.session!.participants = [MANAGER_ID];
  app.store!.save(app.session!);
  const before = app.session!.messages.length;
  await engine.handleMessage('/session agent add test_probe', new AbortController().signal);
  check(
    'handleMessage: /session agent add исполнен (строка через presenter.service)',
    notices.some((t) => t.includes('присоединился')) ?? false,
  );
  const msgs = app.session!.messages;
  check(
    'handleMessage: событие чата — в хронике репликой менеджера',
    msgs.length === before + 1 && msgs.at(-1)?.authorId === MANAGER_ID && (msgs.at(-1)?.text.includes('присоединился') ?? false),
    `before=${before} after=${msgs.length} last=${JSON.stringify(msgs.at(-1))}`,
  );
  check('handleMessage: текст команды в историю не попал', !msgs.some((m) => m.authorId === 'user' && m.text.startsWith('/session')));
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
