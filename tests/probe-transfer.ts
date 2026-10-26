/**
 * Импорт-экспорт: четыре уровня переноса (дом / настройки / проект / разговор).
 *  - уровень 2 (настройки): settings+профиль+менеджер+модели с ключами;
 *    импорт заменяет файлы и ПЕРЕЧИТЫВАЕТ модели и менеджера в живом
 *    приложении; проекты и разговоры не трогаются;
 *  - уровень 4 (разговор): session.json + карточки ТОЛЬКО участников;
 *    импорт — как новый разговор (новый id, дата создания сохранена,
 *    digestInLog сброшен), участники вливаются по id, чужая команда — нет;
 *  - уровень 3 (проект): project.json (секреты внутри) + все разговоры;
 *    импорт: свободный id → новый проект (чужая рабочая папка не тащится
 *    вслепую), занятый → влив разговоров, локальные настройки сильнее,
 *    открытый разговор перечитывается с диска;
 *  - уровень 1 (дом): всё сразу — настройки, память, расписание, тула,
 *    команда, модели и ВСЕ проекты с разговорами; .env (вещь машины) не
 *    пакуется; импорт заменяет дом, проекты вливаются по id (локальные
 *    сильнее), zip-slip и мусорные записи — мимо.
 * Герметично: временный DT_HOME, mock-провайдер, confirm-заглушка.
 * Запуск: npm run probe:transfer
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Presenter, SpeakerRef, TurnSink } from '../src/core/presenter.js';
import { loadTeam } from '../src/agents.js';
import { rmTemp } from './rm-tmp.js';
import { writeModels } from './models.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── песочница: дом + рабочая папка во временной директории ───────────────────
const base = mkdtempSync(join(tmpdir(), 'dt-transfer-'));
const home = join(base, 'home');
const ws1 = join(base, 'ws1');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.chdir(base);

writeModels(home, {
  mock: { adapter: 'mock' },
  fake: { adapter: 'openai-compatible', baseUrl: 'https://api.test/v1', model: 'mock-1', apiKey: 'СЕКРЕТ-КЛЮЧ-ПРОВИДЕРА' },
});
writeFileSync(join(home, '.env'), 'TOKEN=секрет-токен-serve\n');
writeFileSync(join(home, 'user.json'), JSON.stringify({ name: 'Хозяин', role: 'босс' }, null, 2) + '\n');
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

// все импорты src — только после установки env и chdir: статический импорт
// закэшировал бы paths.js с реальным домом (пробник трогал бы машину)
const { MANAGER_ID } = await import('../src/manager.js');
const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const {
  settingsEntries,
  projectEntries,
  homeEntries,
  sessionEntriesById,
  packEntriesZip,
  readZipEntries,
  applySettingsImport,
  applyProjectImport,
  applyHomeImport,
  applySessionImport,
} = await import('../src/core/transfer.js');
const { loadProjectConfig } = await import('../src/core/projects.js');

// confirm-заглушка: ответ настраивается тестом
let confirmAnswer = true;
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice() {},
  error() {},
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
const engine = new Engine(app, stub);
// старт без проекта — проект открываем как живой пользователь
engine.newProject('alpha', ws1);
check('сетап: проект alpha создан и открыт', app.store !== null && app.session !== null && loadProjectConfig('alpha') !== undefined);

const s1 = app.store!.create();
s1.title = 'Альфа';
s1.messages.push(
  { authorId: 'user', authorName: 'Вы', text: 'сообщение альфы 1', ts: 1 },
  { authorId: 'manager', authorName: 'Менеджер', text: 'ответ альфы', ts: 2 },
);
app.store!.save(s1);
const s2 = app.store!.create();
s2.title = 'Бета';
s2.messages.push({ authorId: 'user', authorName: 'Вы', text: 'сообщение беты', ts: 3 });
app.store!.save(s2);
// newProject открыл автосозданный «Новый разговор» — открываем Бету как живой пользователь
app.session = app.store!.load(s2.id)!;
check('сетап: открыт последний разговор (Бета)', app.session?.id === s2.id, app.session?.title);

// ═══ уровень 2 — настройки: экспорт и импорт с перечиткой ═════════════════════
{
  const entries = settingsEntries();
  const rels = entries.map((e) => e.rel);
  check('экспорт настроек: базовые файлы на месте',
    ['settings.json', 'user.json', 'manager.json'].every((f) => rels.includes(f)), JSON.stringify(rels));
  const fakeEntry = entries.find((e) => e.rel === 'models/fake.json');
  const fakeText = fakeEntry ? fakeEntry.data.toString('utf8') : '';
  check('экспорт настроек: карточка модели с ключом — снимок полный',
    fakeText.includes('"adapter": "openai-compatible"') && fakeText.includes('СЕКРЕТ-КЛЮЧ-ПРОВИДЕРА'), fakeText);
  check('экспорт настроек: разговоров и проектов в архиве нет',
    !rels.some((r) => r.startsWith('sessions/') || r.startsWith('projects/')), JSON.stringify(rels));
  const back = readZipEntries(packEntriesZip(entries));
  check('экспорт настроек: zip roundtrip без потерь', back.length === entries.length);

  // архив с другой настройкой и другим именем менеджера
  const archive = packEntriesZip(entries.map((e) => {
    if (e.rel === 'settings.json') {
      return { rel: e.rel, data: Buffer.from(JSON.stringify({ ui: 'ru', width: 200, language: 'english' }, null, 2) + '\n') };
    }
    if (e.rel === 'manager.json') {
      const mgr = JSON.parse(e.data.toString('utf8')) as Record<string, unknown>;
      mgr.name = 'Импортный Босс';
      return { rel: e.rel, data: Buffer.from(JSON.stringify(mgr, null, 2) + '\n') };
    }
    return e;
  }));

  // живые данные уезжают от архива: настройка другая, модель удалена с диска
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 999 }, null, 2) + '\n');
  rmSync(join(home, 'models', 'mock.json'));
  const report = applySettingsImport(app, readZipEntries(archive));
  check('импорт настроек: отчёт', report.includes('Импорт настроек выполнен'), report);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { width?: number; language?: string };
  check('импорт настроек: settings.json заменён из архива', settings.width === 200 && settings.language === 'english', JSON.stringify(settings));
  check('импорт настроек: менеджер перечитан (не до перезапуска)', app.mgr.name === 'Импортный Босс', app.mgr.name);
  check('импорт настроек: модели перечитаны — удалённая карточка вернулась', app.models.get('mock') !== undefined);
}

// ═══ уровень 4 — разговор: экспорт участников, импорт как новый ═══════════════
{
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'agents', 'lawyer.json'), JSON.stringify({ name: 'Юрист', emoji: '⚖', color: 'blue', prompt: 'Ты юрист.' }, null, 2) + '\n');
  writeFileSync(join(home, 'agents', 'observer.json'), JSON.stringify({ name: 'Наблюдатель', emoji: '👁', color: 'white', prompt: 'Ты наблюдатель.' }, null, 2) + '\n');
  const alpha = app.store!.load(s1.id)!;
  alpha.participants = [MANAGER_ID, 'lawyer'];
  alpha.createdAt = 1_700_000_000_000;
  alpha.digestInLog = true; // при импорте должен сброситься: памяти команды в архиве сессии нет
  app.store!.save(alpha);

  const entries = sessionEntriesById(app, s1.id);
  const rels = entries.map((e) => e.rel);
  check('экспорт сессии: session.json + карточки, настроек в архиве нет',
    rels.includes('session.json') && rels.some((r) => r.startsWith('agents/')) && !rels.includes('settings.json'), JSON.stringify(rels));
  const agentsInZip = entries.filter((e) => e.rel.startsWith('agents/')).map((e) => JSON.parse(e.data.toString('utf8')) as { id: string });
  check('экспорт сессии: только участники — юрист едет, наблюдатель остаётся',
    agentsInZip.some((a) => a.id === 'lawyer') && !agentsInZip.some((a) => a.id === 'observer'), JSON.stringify(agentsInZip.map((a) => a.id)));
  const session = JSON.parse(entries.find((e) => e.rel === 'session.json')!.data.toString('utf8')) as { messages: { text: string }[] };
  check('экспорт сессии: история внутри', session.messages.some((m) => m.text.includes('сообщение альфы 1')));

  // древний разговор без participants: карточек в архиве быть не должно
  const stale = app.store!.create();
  stale.title = 'Старый разговор';
  stale.messages.push({ authorId: 'user', authorName: 'Вы', text: 'старое сообщение', ts: 20 });
  app.store!.save(stale);
  const staleEntries = sessionEntriesById(app, stale.id);
  check('экспорт сессии: без participants агенты не пакуются',
    staleEntries.some((e) => e.rel === 'session.json') && !staleEntries.some((e) => e.rel.startsWith('agents/')),
    JSON.stringify(staleEntries.map((e) => e.rel)));

  let badId = '';
  try { sessionEntriesById(app, 'нет-такого'); } catch (err) { badId = (err as Error).message; }
  check('экспорт сессии: неизвестный id — честная ошибка', badId.includes('не читается'), badId);

  // импорт: юриста и наблюдателя убираем — импорт должен вернуть участника
  rmSync(join(home, 'agents', 'lawyer.json'), { force: true });
  rmSync(join(home, 'agents', 'observer.json'), { force: true });
  const archive = packEntriesZip(entries);
  const before = app.store!.list().length;
  const report = applySessionImport(app, readZipEntries(archive));
  check('импорт сессии: отчёт', report.includes('Импорт сессии выполнен'), report);
  const list = app.store!.list();
  check('импорт сессии: разговор появился как новый', list.length === before + 1, JSON.stringify(list.map((s) => s.title)));
  check('импорт сессии: история внутри новой сессии', list.filter((m) => m.title === 'Альфа').length === 2);
  const team = loadTeam(join(home, 'agents'));
  check('импорт сессии: участник вернулся в команду (merge по id)', team.some((a: { id: string }) => a.id === 'lawyer'));
  check('импорт сессии: чужая команда не переезжает (наблюдатель не влит)', !team.some((a: { id: string }) => a.id === 'observer'));
  check('импорт сессии: совпавшие агенты не дублируются', team.filter((a: { name: string }) => a.name === 'Юрист').length === 1);
  const importedMeta = list.find((m) => m.title === 'Альфа' && m.id !== s1.id)!;
  const imported = app.store!.load(importedMeta.id)!;
  check('импорт сессии: дата создания сохранена из архива', imported.createdAt === 1_700_000_000_000, String(imported.createdAt));
  check('импорт сессии: digestInLog сброшен (памяти команды в архиве нет)', imported.digestInLog === false, String(imported.digestInLog));

  let threw = '';
  try { applySessionImport(app, [{ rel: 'session.json', data: Buffer.from('это не разговор') }]); } catch (err) { threw = (err as Error).message; }
  check('импорт сессии: кривой session.json — честный отказ', threw.includes('не похож'), threw);

  // архив без карточек: разговор вливается, команда не трогается
  const bare = packEntriesZip(sessionEntriesById(app, importedMeta.id).filter((e) => e.rel === 'session.json'));
  const teamBefore = loadTeam(join(home, 'agents')).length;
  const bareReport = applySessionImport(app, readZipEntries(bare));
  check('импорт сессии: архив без агентов — разговор влит, команда не тронута',
    bareReport.includes('Импорт сессии выполнен') && !bareReport.includes('участников влито')
      && loadTeam(join(home, 'agents')).length === teamBefore, bareReport);
}

// ═══ уровень 3 — проект: экспорт, импорт новым id и вливом ════════════════════
{
  const entries = projectEntries('alpha');
  const rels = entries.map((e) => e.rel);
  check('экспорт проекта: project.json + оба разговора, чужого нет',
    rels.includes('project.json') && rels.some((r) => r === `sessions/${s1.id}.json`) && rels.some((r) => r === `sessions/${s2.id}.json`)
      && !rels.some((r) => r.startsWith('projects/')), JSON.stringify(rels));

  let noProj = '';
  try { projectEntries('призрак'); } catch (err) { noProj = (err as Error).message; }
  check('экспорт проекта: неизвестный id — «нет — см. /project»', noProj.includes('нет — см. /project'), noProj);
  const back = readZipEntries(packEntriesZip(entries));
  check('экспорт проекта: zip roundtrip без потерь', back.length === entries.length);

  // вливаем как новый проект под другим именем; в архиве — все разговоры
  // alpha на момент экспорта (к этому моменту их уже несколько — сравниваем по факту)
  const expected = entries.filter((e) => e.rel.startsWith('sessions/')).length;
  const report = applyProjectImport(app, readZipEntries(packEntriesZip(entries)), 'omega');
  check('импорт проекта: свободный id — отчёт о создании',
    report.includes('проект «omega» создан') && report.includes(`разговоров влито: ${expected}`), report);
  const omegaDir = join(home, 'projects', 'omega', 'sessions');
  check('импорт проекта: разговоры легли в projects/omega/sessions',
    readdirSync(omegaDir).some((f) => f === `${s1.id}.json`) && readdirSync(omegaDir).some((f) => f === `${s2.id}.json`),
    readdirSync(omegaDir).join(','));
  check('импорт проекта: рабочая папка есть на этой машине — переехала', loadProjectConfig('omega')?.path === ws1);

  // влив в существующий: локальные правки разговоров откатываются к архиву,
  // созданные после архива разговоры остаются, открытый перечитывается
  const beforeCount = app.store!.list().length;
  s2.messages.push({ authorId: 'user', authorName: 'Вы', text: 'локальная правка после архива', ts: 9 });
  app.store!.save(s2);
  const delta = app.store!.create();
  delta.title = 'Дельта';
  app.store!.save(delta);
  const report2 = applyProjectImport(app, readZipEntries(packEntriesZip(entries)), 'alpha');
  check('импорт проекта: занятый id — настройки сохранены локальные', report2.includes('уже был — настройки сохранены локальные'), report2);
  check('импорт проекта: разговоры влиты', report2.includes('разговоров влито'), report2);
  check('импорт проекта: правка после архива откатилась', !(app.store!.load(s1.id)?.messages ?? []).some((m) => m.text.includes('локальная правка')));
  check('импорт проекта: разговоры вне архива не удаляются', app.store!.list().some((m) => m.title === 'Дельта') && app.store!.list().length >= beforeCount + 1);
  check('импорт проекта: открытый разговор перечитан с диска', !app.session?.messages.some((m) => m.text.includes('локальная правка')));

  // чужая рабочая папка: нет на этой машине — проект без workspace, с подсказкой
  const ghost = packEntriesZip([
    { rel: 'project.json', data: Buffer.from(JSON.stringify({ id: 'ghost', path: join(base, 'nowhere'), createdAt: 1, hosts: {}, mails: {}, messengers: {} }, null, 2) + '\n') },
    { rel: 'sessions/x.json', data: Buffer.from(JSON.stringify({ id: 'x1', title: 'призрачный', messages: [], createdAt: 1, updatedAt: 1 }, null, 2)) },
  ]);
  const report3 = applyProjectImport(app, readZipEntries(ghost));
  check('импорт проекта: чужой путь не тащится вслепую — подсказка /project path',
    report3.includes('проект «ghost» создан') && report3.includes('/project path'), report3);
  check('импорт проекта: ghost остался без рабочей папки', loadProjectConfig('ghost')?.path === undefined);

  // битый архив — честный отказ, ничего не создаётся
  let corrupt = '';
  try { applyProjectImport(app, [{ rel: 'project.json', data: Buffer.from('это не json') }]); } catch (err) { corrupt = (err as Error).message; }
  check('импорт проекта: кривой project.json — отказ', corrupt.includes('не читается'), corrupt);
  let empty = '';
  try { applyProjectImport(app, [{ rel: 'sessions/x.json', data: Buffer.from('{}') }]); } catch (err) { empty = (err as Error).message; }
  check('импорт проекта: без project.json — «не экспорт проекта»', empty.includes('не экспорт проекта'), empty);
}

// ═══ уровень 1 — дом: всё приложение ══════════════════════════════════════════
{
  // память команды, расписание и тула — тоже дом: должны уехать в архив
  writeFileSync(join(home, 'memory.json'), JSON.stringify({
    log: [{ title: 'Архивный разговор', digest: 'заметка памяти из архива' }],
    logVersion: 1,
    agents: {},
  }, null, 2) + '\n');
  writeFileSync(join(home, 'schedule.json'), JSON.stringify([
    { id: 't1', message: 'напоминание из архива', intervalMinutes: 30, enabled: true },
  ], null, 2) + '\n');
  writeFileSync(join(home, 'tools', 'hello.ts'), 'export const x = 1;\n');

  const entries = homeEntries();
  const rels = entries.map((e) => e.rel);
  check('экспорт дома: базовые файлы на месте',
    ['settings.json', 'user.json', 'manager.json', 'memory.json', 'schedule.json'].every((f) => rels.includes(f)), JSON.stringify(rels));
  check('экспорт дома: тула и команда внутри',
    rels.includes('tools/hello.ts') && rels.includes('agents/lawyer.json'), JSON.stringify(rels));
  check('экспорт дома: все проекты с разговорами',
    rels.includes('projects/alpha/project.json') && rels.includes('projects/omega/project.json')
      && rels.some((r) => r === `projects/alpha/sessions/${s1.id}.json`), JSON.stringify(rels));
  check('экспорт дома: .env (вещь машины) не включён', !rels.some((r) => r.includes('.env')));
  check('экспорт дома: модель с ключом внутри', entries.some((e) => e.rel === 'models/fake.json' && e.data.toString('utf8').includes('СЕКРЕТ')));
  const back = readZipEntries(packEntriesZip(entries));
  check('экспорт дома: zip roundtrip без потерь', back.length === entries.length);

  // снимок «как было»; живые данные уезжают: настройка, память, расписание,
  // менеджер переименован, в разговор дописано, заведён новый «Жета»,
  // в alpha добавлен хост (локальные настройки проекта должны выжить)
  const archive = packEntriesZip(entries);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 777 }, null, 2) + '\n');
  writeFileSync(join(home, 'memory.json'), JSON.stringify({ log: [], logVersion: 99, agents: {} }, null, 2) + '\n');
  writeFileSync(join(home, 'schedule.json'), '[]');
  rmSync(join(home, 'tools', 'hello.ts'));
  const mgrRaw = JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')) as Record<string, unknown>;
  mgrRaw.name = 'Локальный Босс';
  writeFileSync(join(home, 'manager.json'), JSON.stringify(mgrRaw, null, 2) + '\n');
  s2.messages.push({ authorId: 'user', authorName: 'Вы', text: 'реплика открытого после архива', ts: 10 });
  app.store!.save(s2);
  const zeta = app.store!.create();
  zeta.title = 'Жета';
  app.store!.save(zeta);
  const { addProjectHosts } = await import('../src/manager.js');
  addProjectHosts(loadProjectConfig('alpha')! ? join(home, 'projects', 'alpha', 'project.json') : '', { prod: { host: 'local-only.example' } });

  const report = applyHomeImport(app, readZipEntries(archive));
  check('импорт дома: отчёт', report.includes('Импорт приложения выполнен'), report);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { width?: number };
  check('импорт дома: настройки заменены из архива', settings.width === 200, JSON.stringify(settings));
  check('импорт дома: менеджер перечитан (не до перезапуска)', app.mgr.name === 'Импортный Босс', app.mgr.name);
  check('импорт дома: память команды заменена из архива',
    readFileSync(join(home, 'memory.json'), 'utf8').includes('заметка памяти из архива'));
  check('импорт дома: app.memory перечитана', JSON.stringify(app.memory).includes('заметка памяти из архива'));
  check('импорт дома: расписание заменено из архива',
    readFileSync(join(home, 'schedule.json'), 'utf8').includes('напоминание из архива'));
  check('импорт дома: тула записана', existsSync(join(home, 'tools', 'hello.ts')));
  check('импорт дома: правки разговоров откатились к архиву',
    !((app.store!.load(s1.id)?.messages ?? []).some((m) => m.text.includes('реплика открытого после архива'))));
  check('импорт дома: разговоры вне архива не удаляются', app.store!.list().some((m) => m.title === 'Жета'));
  check('импорт дома: открытый разговор перечитан с диска', !app.session?.messages.some((m) => m.text.includes('реплика открытого после архива')));
  check('импорт дома: локальный проект сильнее архива — хост выжил',
    (loadProjectConfig('alpha')?.hosts as Record<string, { host?: string } | undefined>)?.prod?.host === 'local-only.example',
    JSON.stringify(loadProjectConfig('alpha')?.hosts));
  check('импорт дома: app.models жив', app.models.get('mock') !== undefined);
}

// ═══ zip-slip и мусор в архиве — мимо ═════════════════════════════════════════
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

// ═══ отменённый импорт (confirm=false) — через команду ядра ═══════════════════
{
  confirmAnswer = false;
  const before = readFileSync(join(home, 'settings.json'), 'utf8');
  const entries = homeEntries();
  const ok = await (engine as unknown as { confirmAction: (l: string, d?: string) => Promise<boolean> })
    .confirmAction('Импортировать всё приложение из этого архива?');
  const report = ok ? applyHomeImport(app, entries) : 'Импорт дома отменён.';
  check('команда: отменённый импорт ничего не меняет', report.includes('отменён') && readFileSync(join(home, 'settings.json'), 'utf8') === before);
  confirmAnswer = true;
}

// ── чистка ───────────────────────────────────────────────────────────────────
process.chdir(tmpdir());
rmTemp(base);
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
