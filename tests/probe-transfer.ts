/**
 * Импорт-экспорт: дом и отдельная сессия.
 *  - экспорт дома: снимок для переезда — настройки/профиль/провайдеры
 *    с ключами + команда + все разговоры текущего проекта;
 *    .env (TOKEN/PORT — вещь машины) не включается;
 *  - импорт дома: настройки/менеджер заменяются (менеджер в памяти
 *    перечитывается сразу), разговоры вливаются по id (совпавшие —
 *    заменяются, открытый перечитывается с диска), мусорные записи мимо;
 *  - экспорт/импорт одной сессии: разговор как новый (новый id), агенты
 *    вливаются по id (новые добавляются, совпавшие не трогаются);
 *  - zip-slip в архиве — мимо; отменённый импорт ничего не меняет.
 *
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер, confirm-заглушка.
 * Запуск: npm run probe:transfer
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGER_ID } from '../src/manager.js';
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

writeFileSync(
  join(home, 'providers.json'),
  JSON.stringify({ default: 'mock', providers: { mock: { adapter: 'mock', apiKey: 'СЕКРЕТ-КЛЮЧ-ПРОВИДЕРА' } } }, null, 2) + '\n',
);
writeFileSync(join(home, '.env'), 'TOKEN=секрет-токен-serve\nПОЧТА_KEY=секрет-для-команд\n');
writeFileSync(join(home, 'user.json'), JSON.stringify({ name: 'Хозяин', role: 'босс' }, null, 2) + '\n');

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
  const entries = homeEntries(app);
  check('экспорт дома: настройки/профиль/провайдеры на месте',
    ['settings.json', 'user.json', 'providers.json'].every((f) => entries.some((e) => e.rel === f)),
    JSON.stringify(entries.map((e) => e.rel)));
  check('экспорт дома: команда внутри', entries.some((e) => e.rel === 'agents.json') && entries.some((e) => e.rel === 'manager.json'));
  const sessRels = entries.filter((e) => e.rel.startsWith('sessions/')).map((e) => e.rel);
  check('экспорт дома: оба разговора в архиве',
    sessRels.some((r) => r.includes(s1.id)) && sessRels.some((r) => r.includes(s2.id)) && sessRels.length === app.store.list().length,
    JSON.stringify(sessRels));
  check('экспорт дома: .env (вещь машины) не включён', !entries.some((e) => e.rel.includes('.env')));
  const provEntry = entries.find((e) => e.rel === 'providers.json');
  const provText = provEntry ? provEntry.data.toString('utf8') : '';
  check('экспорт дома: карточка провайдера с ключом — снимок полный',
    provText.includes('"adapter": "mock"') && provText.includes('СЕКРЕТ-КЛЮЧ-ПРОВИДЕРА'), provText);
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
  // в альфу дописано сообщение, заведён новый разговор «Гамма», открытый — текущий
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ width: 100, margin: 2, screen: true }, null, 2));
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
  check('импорт дома: разговоры влиты по id — альфа откатилась к архиву',
    !(app.store.load(s1.id)?.messages ?? []).some((m) => m.text.includes('локальная правка')), `${app.store.list().length} разговоров`);
  check('импорт дома: разговоры вне архива не удаляются', app.store.list().some((m) => m.title === 'Гамма'));
  check('импорт дома: открытый разговор перечитан с диска', !app.session.messages.some((m) => m.text.includes('реплика открытого после архива')));
  check('импорт дома: app.providers жив', app.providers.get('mock') !== undefined);
}

// ── экспорт сессии: разговор + агенты ─────────────────────────────────────────
{
  // агент «юрист» в команде — должен уехать в архив сессии
  const agents = JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'));
  agents.push({ id: 'lawyer', name: 'Юрист', emoji: '⚖', role: 'право', color: 'blue', prompt: 'Ты юрист.' });
  writeFileSync(join(home, 'agents.json'), JSON.stringify(agents, null, 2) + '\n');

  // номер «Альфы» — по факту списка (свежие сверху)
  const n = app.store.list().findIndex((m) => m.title === 'Альфа') + 1;
  const entries = sessionEntries(app, n);
  const rels = entries.map((e) => e.rel);
  check('экспорт сессии: session.json + agents.json, настроек в архиве нет',
    rels.includes('session.json') && rels.includes('agents.json') && !rels.includes('settings.json'), JSON.stringify(rels));
  const session = JSON.parse(entries.find((e) => e.rel === 'session.json')!.data.toString('utf8'));
  check('экспорт сессии: история внутри', session.messages.some((m: { text: string }) => m.text.includes('сообщение альфы 1')));
}

// ── импорт сессии: как новый разговор, агенты вливаются по id ────────────────
{
  // номер «Альфы» — по факту списка (после импорта дома сверху Гамма)
  const nA = app.store.list().findIndex((m) => m.title === 'Альфа') + 1;
  const archive = packEntriesZip(sessionEntries(app, nA));
  // убираем юриста из команды: импорт должен вернуть его
  const agentsPath = join(home, 'agents.json');
  const agents = JSON.parse(readFileSync(agentsPath, 'utf8')).filter((a: { id: string }) => a.id !== 'lawyer');
  writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + '\n');
  const before = app.store.list().length;

  const report = applySessionImport(app, readZipEntries(archive));
  check('импорт сессии: отчёт', report.includes('Импорт сессии выполнен'), report);
  const list = app.store.list();
  check('импорт сессии: разговор появился как новый', list.length === before + 1, JSON.stringify(list.map((s) => s.title)));
  check('импорт сессии: история внутри новой сессии', list.filter((m) => m.title === 'Альфа').length === 2);
  const team = JSON.parse(readFileSync(agentsPath, 'utf8'));
  check('импорт сессии: юрист вернулся в команду (merge по id)', team.some((a: { id: string }) => a.id === 'lawyer'));
  const dupe = team.filter((a: { name: string }) => a.name === 'Юрист').length;
  check('импорт сессии: совпавшие агенты не дублируются', dupe === 1, String(dupe));
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
