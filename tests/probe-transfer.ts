/**
 * Импорт-экспорт: дом и отдельная сессия.
 *  - экспорт дома: снимок для переезда — настройки/профиль/провайдеры
 *    с ключами + команда + память команды + расписание + все разговоры
 *    текущего проекта; .env (TOKEN/PORT — вещь машины) не включается;
 *  - импорт дома: настройки/менеджер заменяются (менеджер в памяти
 *    перечитывается сразу), память и расписание заменяются из архива,
 *    разговоры вливаются по id (совпавшие — заменяются, даты не
 *    перетираются, открытый перечитывается с диска), мусорные записи мимо;
 *  - экспорт/импорт одной сессии: разговор как новый (новый id, дата создания
 *    сохраняется, digestInLog сбрасывается — памяти команды в архиве нет);
 *    в архив пакуются только карточки участников, при импорте вливаются
 *    только они (чужая команда целиком — не переезжает; кривая session.json —
 *    честный отказ);
 *  - zip-slip в архиве — мимо; отменённый импорт ничего не меняет.
 *
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер, confirm-заглушка.
 * Запуск: npm run probe:transfer
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Presenter, SpeakerRef, TurnSink } from '../src/core/presenter.js';
import { rmTemp } from './rm-tmp.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const base = mkdtempSync(join(tmpdir(), 'dt-transfer-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = proj;
process.chdir(base);

mkdirSync(join(home, 'models'), { recursive: true });
writeFileSync(
  join(home, 'models', 'fake.json'),
  JSON.stringify({ adapter: 'openai-compatible', baseUrl: 'https://api.test/v1', model: 'mock-1', apiKey: 'СЕКРЕТ-КЛЮЧ-ПРОВИДЕРА' }, null, 2) + '\n',
);
writeFileSync(join(home, 'models', 'mock.json'), JSON.stringify({ adapter: 'mock' }, null, 2) + '\n');
writeFileSync(join(home, '.env'), 'TOKEN=секрет-токен-serve\nПОЧТА_KEY=секрет-для-команд\n');
writeFileSync(join(home, 'user.json'), JSON.stringify({ name: 'Хозяин', role: 'босс' }, null, 2) + '\n');
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

// все импорты src — только после установки env и chdir: статический импорт
// закэшировал бы paths.js с реальным домом (пробник трогал бы машину)
const { MANAGER_ID } = await import('../src/manager.js');
const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const {
  homeEntries,
  sessionEntries,
  packEntriesZip,
  readZipEntries,
  applyHomeImport,
  applySessionImport,
} = await import('../src/core/transfer.js');

// confirm-заглушка: ответ настраивается тестом
let confirmAnswer = true;
const notices: string[] = [];
const errors: string[] = [];
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice(t) { notices.push(t); },
  error(t) { errors.push(t); },
  turnHeader(_a: SpeakerRef) {},
  busy(_l: string) { return { stop() {} }; },
  stream(_l: string) { return sink; },
  turnEnd(_f: string) {},
  say(_t: string) {},
  toolLines(_r: string[]) {},
  attachment(_t: string, _d: string) {},
  async confirm() { return confirmAnswer; },
  async chooseSession() { return null; },
  sessionOpened(_s) {},
};

const { app } = await bootstrapApp();
console.log('  [диагностика] дом после bootstrap:', existsSync(join(home, 'user.json')), '|', readdirSync(home).join(','));
const engine = new Engine(app, stub);

// разговоры с содержимым
const s1 = app.store.create();
s1.title = 'Альфа';
s1.messages.push(
  { authorId: 'user', authorName: 'Вы', text: 'сообщение альфы 1', ts: 1 },
  { authorId: 'manager', authorName: 'Менеджер', text: 'ответ альфы', ts: 2 },
);
app.store.save(s1);
const s2 = app.store.create();
s2.title = 'Бета';
s2.messages.push({ authorId: 'user', authorName: 'Вы', text: 'сообщение беты', ts: 3 });
app.store.save(s2);

// ── экспорт дома ─────────────────────────────────────────────────────────────
{
  // память команды и расписание — тоже дом: должны уехать в архив
  writeFileSync(join(home, 'memory.json'), JSON.stringify({
    log: [{ title: 'Архивный разговор', digest: 'заметка памяти из архива' }],
    logVersion: 1,
    agents: {},
  }, null, 2) + '\n');
  writeFileSync(join(home, 'schedule.json'), JSON.stringify([
    { id: 't1', message: 'напоминание из архива', intervalMinutes: 30, enabled: true },
  ], null, 2) + '\n');

  const entries = homeEntries(app);
  check('экспорт дома: настройки/профиль на месте',
    ['settings.json', 'user.json'].every((f) => entries.some((e) => e.rel === f)),
    JSON.stringify(entries.map((e) => e.rel)));
  check('экспорт дома: модель на месте', entries.some((e) => e.rel === 'models/mock.json'), JSON.stringify(entries.map((e) => e.rel)));
  check('экспорт дома: память и расписание в архиве',
    entries.some((e) => e.rel === 'memory.json') && entries.some((e) => e.rel === 'schedule.json'),
    JSON.stringify(entries.map((e) => e.rel)));
  check('экспорт дома: команда внутри', entries.some((e) => e.rel === 'agents.json') && entries.some((e) => e.rel === 'manager.json'));
  const sessRels = entries.filter((e) => e.rel.startsWith('sessions/')).map((e) => e.rel);
  check('экспорт дома: оба разговора в архиве',
    sessRels.some((r) => r.includes(s1.id)) && sessRels.some((r) => r.includes(s2.id)) && sessRels.length === app.store.list().length,
    JSON.stringify(sessRels));
  check('экспорт дома: .env (вещь машины) не включён', !entries.some((e) => e.rel.includes('.env')));
  const provEntry = entries.find((e) => e.rel === 'models/fake.json');
  const provText = provEntry ? provEntry.data.toString('utf8') : '';
  check('экспорт дома: карточка модели с ключом — снимок полный',
    provText.includes('"adapter": "openai-compatible"') && provText.includes('СЕКРЕТ-КЛЮЧ-ПРОВИДЕРА'), provText);
  const zip = packEntriesZip(entries);
  const back = readZipEntries(zip);
  check('экспорт дома: zip roundtrip без потерь', back.length === entries.length);
}

// ── импорт дома: замена настроек/менеджера, влив разговоров по id ────────────
{
  // снимок: настройки и менеджер «как было», разговоры на момент архива
  const archive = packEntriesZip(homeEntries(app).map((e) => {
    if (e.rel === 'settings.json') {
      return { rel: e.rel, data: Buffer.from(JSON.stringify({ width: 200, language: 'english', margin: 3, screen: false }, null, 2) + '\n') };
    }
    if (e.rel === 'manager.json') {
      const mgr = JSON.parse(e.data.toString('utf8')) as Record<string, unknown>;
      mgr.name = 'Импортный Босс';
      return { rel: e.rel, data: Buffer.from(JSON.stringify(mgr, null, 2) + '\n') };
    }
    return e;
  }));

  // живые данные уезжают от архива: настройки другие, менеджер переименован,
  // в альфу дописано сообщение, заведён новый разговор «Гамма», открытый — текущий;
  // память и расписание — другие (архив их должен вернуть)
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ width: 100, margin: 2, screen: true }, null, 2));
  writeFileSync(join(home, 'memory.json'), JSON.stringify({ log: [], logVersion: 99, agents: {} }, null, 2) + '\n');
  writeFileSync(join(home, 'schedule.json'), '[]');
  s1.messages.push({ authorId: 'user', authorName: 'Вы', text: 'локальная правка после архива', ts: 9 });
  app.store.save(s1);
  const opened = app.session;
  opened.messages.push({ authorId: 'user', authorName: 'Вы', text: 'реплика открытого после архива', ts: 10 });
  app.store.save(opened);
  const gamma = app.store.create();
  gamma.title = 'Гамма';
  app.store.save(gamma);

  const report = applyHomeImport(app, readZipEntries(archive));
  check('импорт дома: отчёт', report.includes('Импорт дома выполнен'), report);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  check('импорт дома: настройки заменены из архива', settings.width === 200 && settings.language === 'english', JSON.stringify(settings));
  check('импорт дома: менеджер перечитан (не до перезапуска)', app.mgr.name === 'Импортный Босс', app.mgr.name);
  check('импорт дома: память команды заменена из архива',
    readFileSync(join(home, 'memory.json'), 'utf8').includes('заметка памяти из архива'),
    readFileSync(join(home, 'memory.json'), 'utf8').slice(0, 120));
  check('импорт дома: app.memory перечитана', JSON.stringify(app.memory).includes('заметка памяти из архива'));
  check('импорт дома: расписание заменено из архива',
    readFileSync(join(home, 'schedule.json'), 'utf8').includes('напоминание из архива'));
  const alphaUpdatedAt = JSON.parse(
    (readZipEntries(archive).find((e) => e.rel === `sessions/${s1.id}.json`) ?? { data: Buffer.from('{}') }).data.toString('utf8'),
  ).updatedAt as number;
  check('импорт дома: updatedAt влитых разговоров не перетирается',
    app.store.load(s1.id)?.updatedAt === alphaUpdatedAt,
    `${app.store.load(s1.id)?.updatedAt} !== ${alphaUpdatedAt}`);
  check('импорт дома: разговоры влиты по id — альфа откатилась к архиву',
    !(app.store.load(s1.id)?.messages ?? []).some((m) => m.text.includes('локальная правка')), `${app.store.list().length} разговоров`);
  check('импорт дома: разговоры вне архива не удаляются', app.store.list().some((m) => m.title === 'Гамма'));
  check('импорт дома: открытый разговор перечитан с диска', !app.session.messages.some((m) => m.text.includes('реплика открытого после архива')));
  check('импорт дома: app.models жив', app.models.get('mock') !== undefined);
}

// ── экспорт сессии: разговор + агенты ─────────────────────────────────────────
{
  // агент «юрист» в команде — должен уехать в архив сессии
  const agents = JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'));
  agents.push({ id: 'lawyer', name: 'Юрист', emoji: '⚖', role: 'право', color: 'blue', prompt: 'Ты юрист.' });
  agents.push({ id: 'observer', name: 'Наблюдатель', emoji: '👁', role: 'контроль', color: 'white', prompt: 'Ты наблюдатель.' });
  writeFileSync(join(home, 'agents.json'), JSON.stringify(agents, null, 2) + '\n');
  const alpha = app.store.load(s1.id)!;
  alpha.participants = [MANAGER_ID, 'lawyer'];
  alpha.createdAt = 1_700_000_000_000;
  alpha.digestInLog = true; // при импорте должен сброситься: памяти команды в архиве сессии нет
  app.store.save(alpha);

  // номер «Альфы» — по факту списка (свежие сверху)
  const n = app.store.list().findIndex((m) => m.title === 'Альфа') + 1;
  const entries = sessionEntries(app, n);
  const rels = entries.map((e) => e.rel);
  check('экспорт сессии: session.json + agents.json, настроек в архиве нет',
    rels.includes('session.json') && rels.includes('agents.json') && !rels.includes('settings.json'), JSON.stringify(rels));
  const session = JSON.parse(entries.find((e) => e.rel === 'session.json')!.data.toString('utf8'));
  check('экспорт сессии: история внутри', session.messages.some((m: { text: string }) => m.text.includes('сообщение альфы 1')));
  const agentsInZip = JSON.parse(entries.find((e) => e.rel === 'agents.json')!.data.toString('utf8')) as Array<{ id: string }>;
  check('экспорт сессии: в архиве только участники — юрист едет, наблюдатель остаётся',
    agentsInZip.some((a) => a.id === 'lawyer') && !agentsInZip.some((a) => a.id === 'observer'),
    JSON.stringify(agentsInZip.map((a) => a.id)));

  // старый разговор без participants (древний формат): карточек в архиве быть не должно
  const stale = app.store.create();
  stale.title = 'Старый разговор';
  stale.messages.push({ authorId: 'user', authorName: 'Вы', text: 'старое сообщение', ts: 20 });
  app.store.save(stale);
  const staleEntries = sessionEntries(app, app.store.list().findIndex((m) => m.id === stale.id) + 1);
  check('экспорт сессии: без participants агенты в архив не пакуются',
    staleEntries.some((e) => e.rel === 'session.json') && !staleEntries.some((e) => e.rel === 'agents.json'),
    JSON.stringify(staleEntries.map((e) => e.rel)));

  let badNum = '';
  try {
    sessionEntries(app, 999);
  } catch (err) {
    badNum = err instanceof Error ? err.message : String(err);
  }
  check('экспорт сессии: кривой номер — честная ошибка', badNum.includes('не нашёл'), badNum);
}

// ── импорт сессии: как новый разговор, агенты вливаются по id ────────────────
{
  // номер «Альфы» — по факту списка (после импорта дома сверху Гамма)
  const nA = app.store.list().findIndex((m) => m.title === 'Альфа') + 1;
  const archive = packEntriesZip(sessionEntries(app, nA));
  // убираем юриста и наблюдателя: импорт должен вернуть только участника
  const agentsPath = join(home, 'agents.json');
  const agents = JSON.parse(readFileSync(agentsPath, 'utf8'))
    .filter((a: { id: string }) => a.id !== 'lawyer' && a.id !== 'observer');
  writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + '\n');
  const before = app.store.list().length;

  const report = applySessionImport(app, readZipEntries(archive));
  check('импорт сессии: отчёт', report.includes('Импорт сессии выполнен'), report);
  const list = app.store.list();
  check('импорт сессии: разговор появился как новый', list.length === before + 1, JSON.stringify(list.map((s) => s.title)));
  check('импорт сессии: история внутри новой сессии', list.filter((m) => m.title === 'Альфа').length === 2);
  const team = JSON.parse(readFileSync(agentsPath, 'utf8'));
  check('импорт сессии: участник вернулся в команду (merge по id)', team.some((a: { id: string }) => a.id === 'lawyer'));
  check('импорт сессии: чужая команда не переезжает (наблюдатель не влит)', !team.some((a: { id: string }) => a.id === 'observer'));
  const dupe = team.filter((a: { name: string }) => a.name === 'Юрист').length;
  check('импорт сессии: совпавшие агенты не дублируются', dupe === 1, String(dupe));
  let threw = '';
  try {
    applySessionImport(app, [{ rel: 'session.json', data: Buffer.from('это не разговор') }]);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('импорт сессии: кривой session.json — честный отказ', threw.includes('не похож'), threw);

  const importedMeta = list.find((m) => m.title === 'Альфа' && m.id !== s1.id)!;
  const importedSession = app.store.load(importedMeta.id)!;
  check('импорт сессии: дата создания сохранена из архива',
    importedSession.createdAt === 1_700_000_000_000, String(importedSession.createdAt));
  check('импорт сессии: digestInLog сброшен (памяти команды в архиве нет)',
    importedSession.digestInLog === false, String(importedSession.digestInLog));

  // архив без агентов: разговор вливается, команда не трогается
  const bare = packEntriesZip(sessionEntries(app, app.store.list().findIndex((m) => m.title === 'Альфа' && m.id !== s1.id) + 1)
    .filter((e) => e.rel === 'session.json'));
  const beforeTeam = JSON.parse(readFileSync(agentsPath, 'utf8')).length;
  const bareReport = applySessionImport(app, readZipEntries(bare));
  check('импорт сессии: архив без агентов — разговор влит, команда не тронута',
    bareReport.includes('Импорт сессии выполнен') && !bareReport.includes('участников влито')
      && JSON.parse(readFileSync(agentsPath, 'utf8')).length === beforeTeam, bareReport);
}

// ── zip-slip и мусор в архиве — мимо ──────────────────────────────────────────
{
  const evil = packEntriesZip([
    { rel: '../../evil.txt', data: Buffer.from('зловредный') },
    { rel: 'sessions/evil.json', data: Buffer.from(JSON.stringify({ id: '../../evil2', title: 'злой', messages: [{ authorId: 'x', authorName: 'x', text: 'x', ts: 0 }] }), 'utf8') },
    { rel: 'sessions/broken.json', data: Buffer.from('это не json') },
  ]);
  const report = applyHomeImport(app, readZipEntries(evil));
  check('импорт дома: zip-slip запись отброшена', !report.includes('evil'), report);
  check('импорт дома: зловредный файл не записан',
    !existsSync(join(home, 'evil.txt')) && !existsSync(join(base, 'evil.txt')) && !existsSync(join(base, 'evil2.json')));
  check('импорт дома: кривые разговоры не вливаются', !report.includes('разговоров влито'), report);
}

// ── отменённый импорт (confirm=false) — через команду ядра ───────────────────
{
  confirmAnswer = false;
  const before = readFileSync(join(home, 'settings.json'), 'utf8');
  const report = await (async () => {
    // путь /import дома: команды зовут engine.confirmAction → заглушка вернёт false
    const entries = homeEntries(app);
    const ok = await (engine as unknown as { confirmAction: (l: string, d?: string) => Promise<boolean> })
      .confirmAction('Импортировать домашние настройки из этого архива?');
    if (!ok) return 'Импорт дома отменён.';
    return applyHomeImport(app, entries);
  })();
  check('команда: отменённый импорт ничего не меняет', report.includes('отменён') && readFileSync(join(home, 'settings.json'), 'utf8') === before);
  confirmAnswer = true;
}

// ── чистка ───────────────────────────────────────────────────────────────────
process.chdir(tmpdir());
rmTemp(base);
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
