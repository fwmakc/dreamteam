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
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
// рабочая папка инструментов = cwd на момент импорта: уводим процесс в tmp
process.chdir(base);

writeModels(home, { mock: { adapter: 'mock' } });
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
let opened = 0;
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
  sessionOpened(_session) { opened++; },
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

// консьерж-старт: в чате один менеджер — как после /new или первого запуска
app.session!.participants = [MANAGER_ID];
app.store!.save(app.session!);

const run = (_e: unknown, line: string): Promise<string[]> => runOperationText(engine, line);
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
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
  check('session new: новый разговор (сессий 2)', app.store!.list().length === 2);
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
  // событие чата — реплика менеджера в хронике разговора, а не заметка
  const chronicle = () => app.session!.messages.at(-1)?.text ?? '';
  let lines = await run(engine, '/chat add');
  check('chat add: без аргумента — подсказка', lines[0]?.includes('Кого позвать?') ?? false);
  lines = await run(engine, '/chat add Тест');
  check(
    'chat add: событие — реплика менеджера в хронике',
    lines.length === 0 && chronicle().includes('присоединился'),
    `lines=${JSON.stringify(lines)} last=${JSON.stringify(chronicle())}`,
  );
  check(
    'chat add: автор события — менеджер-модератор',
    app.session!.messages.at(-1)?.authorId === MANAGER_ID && app.session!.messages.at(-1)?.authorRole === 'менеджер переговорки',
  );
  lines = await run(engine, '/chat add Тест');
  check('chat add: повтор — уже в чате (без события)', lines[0]?.includes('уже в чате') ?? false);
  lines = await run(engine, '/chat add 2');
  check('chat add: по номеру из /team', lines.length === 0);
  lines = await run(engine, '/chat remove Тест');
  check('chat remove: событие — реплика в хронике', lines.length === 0 && chronicle().includes('покинул'));
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

// ── модели ───────────────────────────────────────────────────────────────────
{
  let lines = await run(engine, '/model');
  check('model: обзор — готовые модели', lines.some((l) => l.includes('mock') && l.includes('готов')) ?? false);
  lines = await run(engine, '/model set mock');
  check('model set: смена на ту же', lines[0]?.includes('Основная модель: mock') ?? false);
  lines = await run(engine, '/model set nope');
  check('model set: неизвестный id — отказ', lines[0]?.includes('Нет модели «nope»') ?? false);

  lines = await run(engine, '/model update mock model=mock-9');
  check('model update: отчёт', lines[0]?.includes('mock-9') ?? false);
  const card = JSON.parse(readFileSync(join(home, 'models', 'mock.json'), 'utf8')) as { model?: string };
  check('model update: модель на диске', card.model === 'mock-9');
  let threw = '';
  try {
    await run(engine, '/model update nope model=x');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('model update: нет модели — отказ', threw.includes('«nope» нет'));
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
  let team = (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
  const second = team.find((a) => a.id === 'test2');
  check('team add: записан', second?.name === 'Второй');
  check('team add: дефолты эмодзи/цвета', second?.emoji === '🤖' && second?.color === 'white');
  let threw = '';
  try {
    await run(engine, '/team add test2 Дубль');
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('team add: дубликат id — ошибка', threw.includes('уже есть'));

  lines = await run(engine, '/team update test2 role=сметана model=mock');
  check('team update: отчёт с полями', lines[0]?.includes('role="сметана"') ?? false);
  team = (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
  check('team update: роль и провайдер записаны', team.find((a) => a.id === 'test2')?.role === 'сметана');
  const badTemp = await run(engine, '/team update test2 temperature=жарко');
  check('team update: temperature не число — отказ', badTemp[0]?.includes('числом') ?? false);

  lines = await run(engine, '/team grant');
  check('team grant: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  lines = await run(engine, '/team grant test2 files');
  check('team grant: отчёт ✓', lines[0]?.startsWith('✓') ?? false);
  team = (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
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
  team = (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
  check('team delete: агента нет на диске', !team.some((a) => a.id === 'test2'));

  // список: и через запятую, и через пробел, вперемешку; чужой id не валит остальных
  for (const id of ['t3', 't4', 't5']) {
    lines = await run(engine, `/team add ${id} Тест-${id}`);
  }
  lines = await run(engine, '/team delete t3, t4 t5');
  check('team delete: список — три отчёта ✓', lines.filter((l) => l.startsWith('✓')).length === 3);
  team = (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
  check('team delete: список — все удалены с диска', !team.some((a) => ['t3', 't4', 't5'].includes(a.id)));
  lines = await run(engine, '/team delete t3, призрак');
  check(
    'team delete: чужой id — ✗, без падения',
    lines.length === 2 && lines.every((l) => l.startsWith('✗')) && lines[1].includes('призрак'),
  );
  lines = await run(engine, '/team delete');
  check('team delete: без аргументов — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
}

// ── проекты: обзор/list/host add/host delete/delete ──────────────────────────
{
  let lines = await run(engine, '/project');
  check('project: обзор — текущий проект', lines.some((l) => l.includes('← текущий')) ?? false);
  check('project: обзор пустого — подсказка про серверы', lines.some((l) => l.includes('host add')) ?? false);

  lines = await run(engine, '/project host add prod=deploy@10.0.0.1:2202');
  check('project host add: отчёт ✓', lines[0]?.includes('prod') ?? false);
  lines = await run(engine, '/project host add backup=10.0.0.2');
  check('project host add: второй сервер — отчёт ✓', lines[0]?.includes('backup') ?? false);
  const hosts = readProj().hosts as Record<string, { host: string; user?: string; port?: number }>
  check(
    'project host add: user и порт разобраны',
    hosts.prod?.user === 'deploy' && hosts.prod.port === 2202 && hosts.backup?.host === '10.0.0.2',
  );
  lines = await run(engine, '/project host add staging=10.0.0.3');
  check('project host add: ещё сервер — отчёт ✓', lines[0]?.includes('staging') ?? false);
  lines = await run(engine, '/project');
  check('project: обзор — список серверов', lines.some((l) => l.includes('prod: deploy@10.0.0.1:2202')) ?? false);
  lines = await run(engine, '/project host delete staging');
  check('project host delete: сервер убран', !(readProj().hosts as typeof hosts).staging);
}

// ── почта: list/add/remove ───────────────────────────────────────────────────
{
  let lines = await run(engine, '/mail');
  check('mail: обзор пустого — подсказка', lines[0]?.includes('Ящиков нет') ?? false);

  lines = await run(engine, '/mail add работа user=робот@corp.ru password=пароль-приложения imap=imap.corp.ru smtp=smtp.corp.ru smtpPort=587 tlsNoVerify');
  check('mail add: отчёт ✓', lines[0]?.includes('работа') ?? false);
  const mails = readProj().mails as Record<string, { user?: string; smtpPort?: number; tlsNoVerify?: boolean }>
  check(
    'mail add: пары разобраны (порт числом, флаг булевым)',
    mails['работа']?.user === 'робот@corp.ru' && mails['работа']?.smtpPort === 587 && mails['работа']?.tlsNoVerify === true,
  );
  lines = await run(engine, '/mail');
  check('mail: обзор — ящик виден', lines.some((l) => l.includes('работа') && l.includes('imap.corp.ru:993') && l.includes('smtp.corp.ru:587')) ?? false);
  // ошибки записи летят вызывающему (как у team.add) — оболочка сама их форматирует
  let threw = '';
  try {
    await run(engine, '/mail add работа user=x@ya.ru password=p imap=imap.yandex.ru smtp=smtp.yandex.ru');
  } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  check('mail add: дубликат — ошибка', threw.includes('уже есть'));
  lines = await run(engine, '/mail add кривая');
  check('mail add: без пар — синтаксис', lines[0]?.includes('Синтаксис') ?? false);
  threw = '';
  try {
    await run(engine, '/mail add бред user=x password=p smtp=s');
  } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  check('mail add: нет imap — отказ валидатора', threw.includes('imap'));
  lines = await run(engine, '/mail remove работа');
  check('mail remove: ящик убран', !(readProj().mails as typeof mails)['работа']);
}

// ── мессенджеры: list/add/remove ─────────────────────────────────────────────
{
  let lines = await run(engine, '/messenger');
  check('messenger: обзор пустого — подсказка', lines[0]?.includes('Ботов нет') ?? false);

  lines = await run(engine, '/messenger add telegram 123456:ABC-cmd');
  check('messenger add: отчёт ✓', lines[0]?.includes('telegram') ?? false);
  const mess = readProj().messengers as Record<string, { token?: string } | undefined>
  check('messenger add: токен на диске', mess.telegram?.token === '123456:ABC-cmd');
  lines = await run(engine, '/messenger');
  check('messenger: обзор — бот виден', lines.some((l) => l.includes('telegram')) ?? false);
  let threw = '';
  try {
    await run(engine, '/messenger add slack x');
  } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  check('messenger add: чужой ключ — ошибка', threw.includes('telegram'));
  threw = '';
  try {
    await run(engine, '/messenger add telegram другой');
  } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  check('messenger add: дубликат — ошибка', threw.includes('уже есть'));
  lines = await run(engine, '/messenger remove telegram');
  check('messenger remove: бот убран', !(readProj().messengers as typeof mess).telegram);
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
  lines = await run(engine, '/settings set maxTurns=2');
  check('settings set: отчёт', lines[0]?.includes('обновлены') ?? false);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { maxTurns: number };
  check('settings set: значение на диске', settings.maxTurns === 2);

  lines = await run(engine, '/manager');
  check('manager: обзор — модель', lines.some((l) => l.includes('модель: mock')) ?? false);
  lines = await run(engine, '/manager set temperature=0.4');
  check('manager set: отчёт', lines[0]?.includes('temperature="0.4"') ?? false);
  const manager = JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')) as { temperature: number };
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
    join(home, 'tools', 'mytool.ts'),
    'export default () => ({ desc: "Мой тул", check: () => "allow" as const, async run() { return "ок"; } });\n',
  );
  writeFileSync(join(home, 'agents', 'test2.json'), JSON.stringify({ name: 'Второй', prompt: 'Ты Второй.', color: 'white' }, null, 2));
  const g = await run(engine, '/team grant test2 mytool');
  check('team grant: свой тул из tools/ — отчёт', g[0]?.startsWith('✓') ?? false);
  const team = (await import('../src/agents.js')).loadTeam(join(home, 'agents'));
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

// ── перехват в handleMessage: команда исполняется, сам текст не пишется ──────
{
  app.session!.participants = [MANAGER_ID];
  app.store!.save(app.session!);
  const before = app.session!.messages.length;
  await engine.handleMessage('/chat add Тест', new AbortController().signal);
  check('handleMessage: /chat add исполнен (строка через presenter.service)', notices.some((t) => t.includes('присоединился')) ?? false);
  const msgs = app.session!.messages;
  check(
    'handleMessage: событие чата — в хронике репликой менеджера',
    msgs.length === before + 1 && msgs.at(-1)?.authorId === MANAGER_ID && (msgs.at(-1)?.text.includes('присоединился') ?? false),
    `before=${before} after=${msgs.length} last=${JSON.stringify(msgs.at(-1))}`,
  );
  check('handleMessage: текст команды в историю не попал', !msgs.some((m) => m.authorId === 'user' && m.text.startsWith('/chat')));
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
