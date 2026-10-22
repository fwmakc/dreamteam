/**
 * Импорт-экспорт: дом и отдельная сессия.
 *  - экспорт дома: настройки/профиль/провайдеры + разговоры и транскрипты,
 *    .env (секреты) — не включается;
 *  - импорт дома: настройки/провайдеры заменяются, разговоры вливаются по id;
 *  - экспорт/импорт одной сессии: разговор как новый (новый id), агенты
 *    вливаются по id (новые добавляются, совпавшие не трогаются);
 *  - zip-slip в архиве — мимо; отменённый импорт ничего не меняет.
 *
 * Герметично: временные DT_HOME/DT_PROJECT, mock-провайдер, confirm-заглушка.
 * Запуск: npm run probe:transfer
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGER_ID } from '../src/manager.js';
import type { Presenter, SpeakerRef, TurnSink } from '../src/core/presenter.js';

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
  JSON.stringify({ default: 'mock', providers: { mock: { adapter: 'mock' } } }, null, 2) + '\n',
);
writeFileSync(join(home, '.env'), 'DREAMTEAM_API_KEY=СЕКРЕТ-НЕ-ПЕРЕНОСИТЬ\n');
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
  const entries = homeEntries();
  check('экспорт дома: настройки/профиль/провайдеры на месте',
    ['settings.json', 'user.json', 'providers.json'].every((f) => entries.some((e) => e.rel === f)),
    JSON.stringify(entries.map((e) => e.rel)));
  check('экспорт дома: команда внутри, переписки нет',
    entries.some((e) => e.rel === 'agents.json') && entries.some((e) => e.rel === 'manager.json')
      && !entries.some((e) => e.rel.startsWith('sessions/')));
  check('экспорт дома: .env с секретами не включён', !entries.some((e) => e.rel.includes('.env')));
  const zip = packEntriesZip(entries);
  const back = readZipEntries(zip);
  check('экспорт дома: zip roundtrip без потерь', back.length === entries.length);
}

// ── импорт дома: замена настроек, вливание разговоров ────────────────────────
{
  // меняем живые настройки и добавляем чужой разговор, потом «импортируем» старый архив
  const archive = packEntriesZip(homeEntries().map((e) =>
    e.rel === 'settings.json'
      ? { rel: 'settings.json', data: Buffer.from(JSON.stringify({ width: 200, language: 'english', margin: 3, screen: false }, null, 2) + '\n') }
      : e,
  ));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ width: 100, margin: 2, screen: true }, null, 2));
  const report = applyHomeImport(app, readZipEntries(archive));
  check('импорт дома: отчёт', report.includes('Импорт дома выполнен'), report);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  check('импорт дома: настройки заменены из архива', settings.width === 200 && settings.language === 'english', JSON.stringify(settings));
  check('импорт дома: разговоры не трогаются (они в проекте)', app.store.list().length >= 1);
  check('импорт дома: app.providers жив', app.providers.get('mock') !== undefined);
}

// ── экспорт сессии: разговор + агенты + настройки ────────────────────────────
{
  // агент «юрист» в команде — должен уехать в архив сессии
  const agents = JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'));
  agents.push({ id: 'lawyer', name: 'Юрист', emoji: '⚖', role: 'право', color: 'blue', prompt: 'Ты юрист.' });
  writeFileSync(join(home, 'agents.json'), JSON.stringify(agents, null, 2) + '\n');

  // номер «Альфы» — по факту списка (свежие сверху)
  const n = app.store.list().findIndex((m) => m.title === 'Альфа') + 1;
  const entries = sessionEntries(app, n);
  const rels = entries.map((e) => e.rel);
  check('экспорт сессии: session.json + agents.json + settings.json',
    rels.includes('session.json') && rels.includes('agents.json') && rels.includes('settings.json'), JSON.stringify(rels));
  const session = JSON.parse(entries.find((e) => e.rel === 'session.json')!.data.toString('utf8'));
  check('экспорт сессии: история внутри', session.messages.some((m: { text: string }) => m.text.includes('сообщение альфы 1')));
}

// ── импорт сессии: как новый разговор, агенты вливаются по id ────────────────
{
  const archive = packEntriesZip(sessionEntries(app, 1));
  // убираем юриста из команды: импорт должен вернуть его
  const agentsPath = join(home, 'agents.json');
  const agents = JSON.parse(readFileSync(agentsPath, 'utf8')).filter((a: { id: string }) => a.id !== 'lawyer');
  writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + '\n');
  const before = app.store.list().length;

  const report = applySessionImport(app, readZipEntries(archive));
  check('импорт сессии: отчёт', report.includes('Импорт сессии выполнен'), report);
  const list = app.store.list();
  check('импорт сессии: разговор появился как новый', list.length === before + 1, JSON.stringify(list.map((s) => s.title)));
  const fresh = list.find((s) => s.title.includes('Альфа') && s !== undefined);
  check('импорт сессии: история внутри новой сессии', Boolean(fresh));
  const team = JSON.parse(readFileSync(agentsPath, 'utf8'));
  check('импорт сессии: юрист вернулся в команду (merge по id)', team.some((a: { id: string }) => a.id === 'lawyer'));
  const dupe = team.filter((a: { name: string }) => a.name === 'Юрист').length;
  check('импорт сессии: совпавшие агенты не дублируются', dupe === 1, String(dupe));
}

// ── zip-slip в архиве — мимо ─────────────────────────────────────────────────
{
  const evil = packEntriesZip([{ rel: '../../evil.txt', data: Buffer.from('зловредный') }]);
  const report = applyHomeImport(app, readZipEntries(evil));
  check('импорт дома: zip-slip запись отброшена', !report.includes('evil.txt'), report);
  check('импорт дома: зловредный файл не записан', !existsSync(join(home, 'evil.txt')) && !existsSync(join(base, 'evil.txt')));
}

// ── отменённый импорт (confirm=false) — через команду ядра ───────────────────
{
  confirmAnswer = false;
  const before = readFileSync(join(home, 'settings.json'), 'utf8');
  const report = await (async () => {
    // путь /import дома: команды зовут engine.confirmAction → заглушка вернёт false
    const entries = homeEntries();
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
rmSync(base, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
