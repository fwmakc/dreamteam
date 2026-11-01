/**
 * Проба расписания: schedule.json в доме и тикер serve.
 *  - load/save: roundtrip, битый JSON, не-массив, записи без обязательных полей;
 *  - dueTasks: enabled-фильтр, срок по nextDue, сдвиг на интервал;
 *  - операции /schedule add|list|toggle|delete на живом движке (mock-модель).
 *
 * Герметично: временный DT_HOME, сети нет.
 * Запуск: npm run probe:schedule
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Presenter } from '../src/core/presenter.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const root = mkdtempSync(join(tmpdir(), 'dt-schedule-'));
const home = join(root, 'home');
mkdirSync(join(home, 'agents'), { recursive: true });
mkdirSync(join(home, 'models'), { recursive: true });
process.env.DT_HOME = home;
writeFileSync(join(home, 'models', 'flagship.json'),
  JSON.stringify({ provider: 'mock' }, null, 2));
writeFileSync(join(home, 'settings.json'),
  JSON.stringify({ ui: 'ru', width: 100, model: { id: 'flagship' } }, null, 2) + '\n');

// ── 1. load/save: файл расписания ────────────────────────────────────────────
{
  const { scheduleFile, loadSchedule, saveSchedule } = await import('../src/core/schedule.js');

  check('файл: schedule.json в корне дома', scheduleFile(home) === join(home, 'schedule.json'), scheduleFile(home));
  check('файл: нет файла — пустое расписание', JSON.stringify(loadSchedule(home)) === '[]');

  const tasks = [
    { id: 'task-a', message: 'покормить кота', intervalMinutes: 15, enabled: true },
    { id: 'task-b', message: 'полить цветы', intervalMinutes: 10, enabled: false },
  ];
  saveSchedule(home, tasks);
  const back = loadSchedule(home);
  check('файл: roundtrip — обе задачи, поля целы', back.length === 2 && back[0].id === 'task-a' && back[1].enabled === false && back[1].intervalMinutes === 10, JSON.stringify(back));

  writeFileSync(scheduleFile(home), '{ битый json');
  check('файл: битый JSON — пустое расписание', JSON.stringify(loadSchedule(home)) === '[]');

  writeFileSync(scheduleFile(home), JSON.stringify({ nope: true }));
  check('файл: не массив — пустое расписание', JSON.stringify(loadSchedule(home)) === '[]');

  writeFileSync(scheduleFile(home), JSON.stringify([
    { id: 'good', message: 'ок', intervalMinutes: 5, enabled: true },
    null,
    { id: 42, message: 'ок', intervalMinutes: 5, enabled: true },
    { id: 'x', message: 7, intervalMinutes: 5, enabled: true },
    { id: 'x', message: 'ок', intervalMinutes: '5', enabled: true },
    'строка вместо задачи',
  ]));
  const filtered = loadSchedule(home);
  check('файл: кривые записи отфильтрованы', filtered.length === 1 && filtered[0].id === 'good', JSON.stringify(filtered));

  rmSync(scheduleFile(home));
}

// ── 2. dueTasks: что исполнять на этом тике ─────────────────────────────────
{
  const { dueTasks } = await import('../src/core/schedule.js');
  const on15 = { id: 't15', message: 'раз в 15', intervalMinutes: 15, enabled: true };
  const on30 = { id: 't30', message: 'раз в 30', intervalMinutes: 30, enabled: true };
  const off = { id: 'off', message: 'выключена', intervalMinutes: 5, enabled: false };
  const now = 1_000_000;
  const nextDue = new Map<string, number>();

  const first = dueTasks([on15, on30, off], now, nextDue);
  check('тик: первый запуск — все включенные сразу', first.map((t) => t.id).join(',') === 't15,t30', JSON.stringify(first.map((t) => t.id)));
  check('тик: срок сдвинут на интервал', nextDue.get('t15') === now + 15 * 60_000 && nextDue.get('t30') === now + 30 * 60_000, JSON.stringify([...nextDue]));
  check('тик: выключенная срока не получила', !nextDue.has('off'));

  const soon = dueTasks([on15, on30, off], now + 60_000, nextDue);
  check('тик: до срока — никто', soon.length === 0, JSON.stringify(soon.map((t) => t.id)));

  const at15 = dueTasks([on15, on30, off], now + 15 * 60_000, nextDue);
  check('тик: через 15 мин — только 15-минутная', at15.length === 1 && at15[0].id === 't15', JSON.stringify(at15.map((t) => t.id)));
  const at30 = dueTasks([on15, on30, off], now + 30 * 60_000, nextDue);
  check('тик: через 30 мин — обе подошли', at30.map((t) => t.id).join(',') === 't15,t30', JSON.stringify(at30.map((t) => t.id)));
}

// ── 3. операции /schedule на живом движке ───────────────────────────────────
{
  const { bootstrapApp } = await import('../src/core/bootstrap.js');
  const { Engine } = await import('../src/core/engine.js');
  const { runOperationText } = await import('../src/core/operations.js');
  const { loadSchedule } = await import('../src/core/schedule.js');
  const sink = { delta() {}, done() {} };
  const stub: Presenter = {
    notice() {},
    error() {},
    turnHeader() {},
    busy() { return { stop() {} }; },
    stream() { return sink; },
    turnEnd() {},
    say() {},
    toolLines() {},
    attachment() {},
    async confirm() { return true; },
    async chooseSession() { return null; },
    sessionOpened() {},
  };
  const { app } = await bootstrapApp();
  const engine = new Engine(app, stub);
  engine.newProject('dev', join(root, 'ws'));
  const run = (line: string): Promise<string[]> => runOperationText(engine, line);
  const file = join(home, 'schedule.json');

  const empty = await run('/schedule');
  check('add: пусто — подсказка и призыв add', empty.some((l) => l.includes('Задач нет')), empty.join(' | '));

  const added = await run('/schedule add покормить кота 15');
  const onDisk = loadSchedule(home);
  check('add: подтверждение с задачей и интервалом', added.some((l) => l.includes('✓') && l.includes('покормить кота') && l.includes('15') && l.includes('[task-')), added.join(' | '));
  check('add: на диске одна включенная задача', onDisk.length === 1 && onDisk[0].enabled === true && onDisk[0].intervalMinutes === 15 && onDisk[0].message === 'покормить кота', JSON.stringify(onDisk));
  const idCat = onDisk[0].id;

  await run('/schedule add полить цветы');
  const defaults = loadSchedule(home);
  check('add: без минут — интервал 10 по умолчанию', defaults.length === 2 && defaults[1].intervalMinutes === 10 && defaults[1].message === 'полить цветы', JSON.stringify(defaults));

  const noArgs = await run('/schedule add');
  check('add: без аргументов — синтаксис', noArgs.some((l) => l.includes('Синтаксис')), noArgs.join(' | '));
  const onlyNumber = await run('/schedule add 7');
  check('add: одно число — пустое задание, синтаксис', onlyNumber.some((l) => l.includes('Синтаксис')), onlyNumber.join(' | '));
  const negative = await run('/schedule add убрать -5');
  const negDisk = loadSchedule(home);
  check('add: кривые минуты — текст цел, интервал 10', negDisk.length === 3 && negDisk[2].intervalMinutes === 10 && negDisk[2].message === 'убрать -5', JSON.stringify(negDisk));
  check('add: кривые минуты — подтверждение без «-5 мин»', negative.some((l) => l.includes('каждые 10 мин')), negative.join(' | '));

  const listed = await run('/schedule');
  check('list: шапка, маркер, интервалы и id', listed.some((l) => l.includes('Расписание:')) && listed.some((l) => l.includes('▶') && l.includes('покормить кота') && l.includes('каждые 15 мин') && l.includes(idCat)), listed.join(' | '));

  const off = await run(`/schedule toggle ${idCat}`);
  check('toggle: выключение', off.some((l) => l.includes('⏸ Выключена') && l.includes('покормить кота')), off.join(' | '));
  check('toggle: на диске enabled:false', loadSchedule(home).find((t) => t.id === idCat)?.enabled === false);

  const on = await run(`/schedule toggle ${idCat}`);
  check('toggle: включение обратно', on.some((l) => l.includes('▶ Включена')), on.join(' | '));

  const missing = await run('/schedule toggle нет-такой');
  check('toggle: неизвестный id — вежливо', missing.some((l) => l.includes('Нет задачи «нет-такой»')), missing.join(' | '));
  const noIds = await run('/schedule toggle');
  check('toggle: без аргументов — синтаксис', noIds.some((l) => l.includes('Синтаксис')), noIds.join(' | '));

  const idFlower = loadSchedule(home).find((t) => t.message === 'полить цветы')?.id ?? '';
  const both = await run(`/schedule toggle ${idCat},${idFlower}`);
  check('toggle: список через запятую — обе выключены', both.filter((l) => l.includes('⏸ Выключена')).length === 2, both.join(' | '));
  const diskOff = loadSchedule(home).filter((t) => !t.enabled);
  check('toggle: на диске обе выключены', diskOff.length === 2, JSON.stringify(diskOff.map((t) => t.id)));
  await run(`/schedule toggle ${idCat},${idFlower}`); // вернуть обе

  const del = await run(`/schedule delete ${idCat}`);
  check('delete: осталось две', del.some((l) => l.includes('Удалено: задач осталось 2')), del.join(' | '));
  check('delete: задачи нет на диске', !loadSchedule(home).some((t) => t.id === idCat));

  const delMissing = await run('/schedule delete нет-1,нет-2');
  check('delete: никого не нашли — честно', delMissing.some((l) => l.includes('Удалено: задач осталось 2')) && delMissing.some((l) => l.includes('Не нашёл: 2')), delMissing.join(' | '));
  const noIds2 = await run('/schedule delete');
  check('delete: без аргументов — синтаксис', noIds2.some((l) => l.includes('Синтаксис')), noIds2.join(' | '));
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
