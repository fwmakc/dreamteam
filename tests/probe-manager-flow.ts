/**
 * Менеджер переговорки как шлюз конфигурации — сквозной конвейер (по схеме
 * «снимок → проектирование → выполнение/проверка/чистка»):
 *  1. СНИМОК: что менеджер видит в момент решения — system = MANAGER_PROMPT,
 *     пользовательская часть = состояние переговорки (ростер с тула­ми и
 *     провайдерами, состав чата, разговоры с номерами, проекты, команды,
 *     окно истории, просьба).
 *  2. ПРОЕКТИРОВАНИЕ: промт объявляет все 15 операций и JSON-протокол
 *     {say, actions}; сценарии с заготовленными ответами скриптового LLM.
 *  3. ВЫПОЛНЕНИЕ: каждый op через настоящий managerTurn на герметичных слоях —
 *     итог в файлах (агенты — в доме, hosts/mails/messengers.json — в проекте),
 *     отчёты ✓/✗ в истории разговора, реплика менеджера сохраняется в СТАРЫЙ
 *     разговор до переключения (pendingSwitches), мусорный ответ — без правок.
 * Запуск: npm run probe:manager-flow
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, StreamRequest } from '../src/types.js';
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

// ── герметичные слои: дом и проект во временных папках ──────────────────────
const base = mkdtempSync(join(tmpdir(), 'dt-mflow-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
const agentsDir = join(home, 'agents');
const agentsSnapshot = (): string => readdirSync(agentsDir).sort().map(f => f + ':' + readFileSync(join(agentsDir, f), 'utf8')).join('|');
const hostsFile = join(proj, 'hosts.json');
const mailsFile = join(proj, 'mails.json');
const messFile = join(proj, 'messengers.json');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = proj;
process.chdir(base); // рабочая папка инструментов — песочница

// src-модули — строго после подмены слоёв: paths.ts вычисляет пути в момент
// загрузки, а manager.ts теперь транзитно тянет paths.js (через mail.js)
const { MANAGER_PROMPT, MANAGER_ID } = await import('../src/manager.js');

mkdirSync(join(home, 'models'), { recursive: true });
writeFileSync(join(home, 'models', 'mock.json'), JSON.stringify({ adapter: 'mock' }, null, 2) + '\n');
writeFileSync(join(home, 'models', 'claude.json'), JSON.stringify({ adapter: 'mock' }, null, 2) + '\n');
// язык общения задаём до старта: ensureHome не перезаписывает существующий settings
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ width: 100, language: 'english', model: { id: 'mock' } }, null, 2) + '\n',
);

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');

// ── скриптовый LLM: менеджерские ходы — из очереди, остальное — болтовня ────
const managerReplies: string[] = [];
const requests: { system?: string; user?: string }[] = [];
const fakeProvider: LLMProvider = {
  id: 'mock',
  kind: 'mock',
  model: 'scripted',
  async *stream(req: StreamRequest) {
    requests.push({
      system: req.system,
      user: req.messages.map((m) => m.content).join('\n---\n'),
    });
    // менеджеру — заготовленный ответ; остальным (агенты, конспекты) — болтовня,
    // чтобы фон (вливания памяти) не съедал сценарную очередь
    const reply = req.system?.startsWith(MANAGER_PROMPT) ? (managerReplies.shift() ?? '') : 'Принято.';
    if (req.signal?.aborted) return;
    yield reply;
  },
};

// ── заглушка Presenter: собирает всё, что ядро говорит оболочке ─────────────
const says: string[] = [];
const notices: string[] = [];
const errors: string[] = [];
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice(text) { notices.push(text); },
  error(text) { errors.push(text); },
  turnHeader(_agent: SpeakerRef) {},
  busy(_label: string) { return { stop() {} }; },
  stream(_label: string) { return sink; },
  turnEnd(_full: string) {},
  say(text) { says.push(text); },
  toolLines(_results: string[]) {},
  attachment(_title: string, _digest: string) {},
  async confirm() { return false; },
  async chooseSession() { return null; },
  sessionOpened(_session) {},
};

const { app } = await bootstrapApp();
const engine = new Engine(app, stub);
// все провайдеры дома (mock и claude) — под одним скриптовым LLM
for (const p of app.models.values()) p.provider = fakeProvider;
const signal = () => new AbortController().signal;

/** Ход менеджера: заготовленный ответ + просьба руководителя. */
async function askManager(reply: string, request: string): Promise<void> {
  managerReplies.push(reply);
  await engine.handleMessage(`@менеджер ${request}`, signal());
}

/** Реплика менеджера в истории текущего разговора (последняя). */
function lastManagerMessage(): string {
  const mine = app.session.messages.filter((m) => m.authorId === 'manager');
  return mine.at(-1)?.text ?? '';
}

// ═══ 1. СНИМОК: что менеджер видит в момент решения ══════════════════════════
{
  // пустая переговорка: скаффолд без команды, разговор один и пуст
  await askManager('Слушаю.', 'докладывай');
  const req = requests.at(-1)!;
  check('снимок: system начинается с промта менеджера', req.system?.startsWith(MANAGER_PROMPT) ?? false);
  check('снимок: язык общения в промте менеджера', req.system?.includes('отвечай строго на языке: english') ?? false, req.system?.slice(-80));
  check('снимок: пустые участники — «вся команда»', req.user?.includes('В этом чате: вся команда') ?? false, req.user);
  check('снимок: разговоры с номерами и текущим', (req.user?.includes('1. ') && req.user?.includes('(текущий)')) ?? false);
  check('снимок: без проектов блока нет', !req.user?.includes('Проекты (реестр серверов для ssh)'), String(req.user?.slice(0, 80)));
  check('снимок: руководитель из user.json', req.user?.includes('Руководитель: Пользователь') ?? false);
  check('снимок: операции манифеста со справкой', req.user?.includes('/session new — новый разговор') ?? false, req.user);
  check('снимок: история — сама просьба уже в ней', (req.user?.includes('Последние сообщения') && req.user?.includes('@менеджер докладывай')) ?? false, req.user);
  check('снимок: просьба дословно', req.user?.includes('Просьба руководителя: «@менеджер докладывай»') ?? false, req.user);
}

{
  // наполняем переговорку: команда с тула­ми и моделями, проект, история
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'katya.json'), JSON.stringify({ name: 'Катя', emoji: '🎨', color: 'cyan', prompt: 'Ты — Катя.', model: { id: 'claude' }, temperature: 0.3, tools: { files: {}, look: {} } }, null, 2) + '\n');
  writeFileSync(join(agentsDir, 'gleb.json'), JSON.stringify({ name: 'Глеб', emoji: '💾', color: 'green', prompt: 'Ты — Глеб.', projects: ['project'] }, null, 2) + '\n');
  writeFileSync(hostsFile, JSON.stringify({ prod: { host: '203.0.113.10' }, staging: { host: 'stg.example.com' } }, null, 2) + '\n');
  for (let i = 1; i <= 14; i++) {
    app.session.messages.push({ authorId: 'user', authorName: 'Хозяин', text: `строка ${i}`, ts: i });
  }
  app.session.participants = [MANAGER_ID, 'katya'];
  app.store.save(app.session);

  await askManager('Принято к сведению.', 'что видишь?');
  const req = requests.at(-1)!;
  check('снимок: ростер — id, роль, провайдер, temp, тула',
    req.user?.includes('- katya — Катя, модель: claude, temp 0.3; тула: files, look') ?? false, req.user);
  check('снимок: агент без тула — пометка', req.user?.includes('- gleb — Глеб, модель: основная; тула нет') ?? false, req.user);
  check('снимок: состав чата — только позванные', req.user?.includes('В этом чате: katya') ?? false, req.user);
  check('снимок: проект — серверы',
    req.user?.includes('- project: серверы prod, staging') ?? false, req.user);
  const historyBlock = req.user?.slice(req.user.indexOf('Последние сообщения'), req.user.indexOf('Просьба руководителя')) ?? '';
  const historyLines = historyBlock.split('\n').filter((l) => l.includes(': ')).length;
  check('снимок: окно истории — ровно 12 сообщений', historyLines === 12, `${historyLines}: ${historyBlock.slice(0, 160)}`);
  check('снимок: свежие строки ближе к просьбе', historyBlock.includes('строка 14') && !historyBlock.includes('строка 1\n'), historyBlock.slice(0, 160));
}

// ═══ 2. ПРОЕКТИРОВАНИЕ: промт объявляет протокол и все операции ══════════════
{
  for (const op of [
    'team.add', 'team.update', 'chat.add', 'chat.remove',
    'session.list', 'session.open', 'session.new', 'session.delete',
    'tool.grant', 'project.host.add',
    'mail.add', 'mail.remove', 'messenger.add', 'messenger.remove',
  ]) {
    check(`проектирование: промт объявляет ${op}`, MANAGER_PROMPT.includes(op));
  }
  check('проектирование: JSON-протокол {say, actions}', MANAGER_PROMPT.includes('"say"') && MANAGER_PROMPT.includes('"actions"'));
  check('проектирование: дисциплина «только то, о чём попросили»', MANAGER_PROMPT.includes('Делай только те действия'));
}

// ═══ 3. ВЫПОЛНЕНИЕ, ПРОВЕРКА, ЧИСТКА ═════════════════════════════════════════

// team.add: полная спецификация доходит до agents.json, отчёт — в историю
{
  const before = agentsSnapshot();
  await askManager(
    'Готово, зову Пашу.\n{"say":"Зову Пашу.","actions":[{"op":"team.add","id":"pasha","name":"Паша","role":"тестировщик","model":"claude","temperature":0.4,"tools":{"files":{},"shell":null}}]}',
    'добавь Пашу тестировщиком',
  );
  const team = (await import('../src/agents.js')).loadTeam(agentsDir);
  const pasha = team.find((a) => a.id === 'pasha');
  check('team.add: участник в agents/', !!pasha);
  check('team.add: спецификация целиком', pasha?.name === 'Паша' && pasha?.model?.id === 'claude' && pasha?.temperature === 0.4, JSON.stringify(pasha));
  check('team.add: дефолты эмодзи/цвета/промпта', pasha?.emoji === '🤖' && pasha?.color === 'white' && pasha?.prompt === 'Ты — Паша, тестировщик.', JSON.stringify(pasha));
  check('team.add: карточки тула­ов записаны', JSON.stringify(pasha?.tools?.shell) === '{}', JSON.stringify(pasha?.tools));
  const msg = lastManagerMessage();
  check('team.add: say + ✓-отчёт в истории менеджера', msg.includes('Зову Пашу.') && msg.includes('✓ Паша'), msg.slice(0, 160));
  check('team.add: конфиг до просьбы не менялся', !before.includes('pasha'));
}

// team.update: белые поля правятся, соседние целы
{
  await askManager(
    'Правлю.\n{"say":"Правлю.","actions":[{"op":"team.update","id":"pasha","fields":{"role":"ведущий тестировщик","temperature":0.1}}]}',
    'Пашу — ведущим',
  );
  const team = (await import('../src/agents.js')).loadTeam(agentsDir);
  const pasha = team.find((a) => a.id === 'pasha');
  check('team.update: роль и temp применились', pasha?.role === 'ведущий тестировщик' && pasha?.temperature === 0.1, JSON.stringify(pasha));
  check('team.update: соседние поля целы', pasha?.model?.id === 'claude' && pasha?.emoji === '🤖');
  check('team.update: отчёт в истории', lastManagerMessage().includes('role="ведущий тестировщик"'), lastManagerMessage().slice(0, 160));
}

// chat.add + chat.remove одной репликой: состав чата меняется
{
  app.session.participants = [MANAGER_ID, 'katya'];
  app.store.save(app.session);
  await askManager(
    'Меняю состав.\n{"say":"Меняю состав.","actions":[{"op":"chat.add","who":"Глеб"},{"op":"chat.remove","who":"Катя"}]}',
    'Глеба в чат, Катю выведи',
  );
  check('состав: Глеб позван', app.session.participants?.includes('gleb') ?? false, JSON.stringify(app.session.participants));
  check('состав: Катя выведена', !app.session.participants?.includes('katya'), JSON.stringify(app.session.participants));
  // события чата теперь отдельные реплики менеджера в хронике, say — отдельной сводкой
  const mine = app.session.messages.filter((m) => m.authorId === 'manager');
  check(
    'состав: позвание — отдельная реплика менеджера',
    mine.at(-3)?.text.includes('💾 Глеб присоединился к чату.') ?? false,
    JSON.stringify(mine.slice(-3).map((m) => m.text)),
  );
  check(
    'состав: вывод — отдельная реплика менеджера',
    mine.at(-2)?.text.includes('Катя покинул(а) чат.') ?? false,
    JSON.stringify(mine.slice(-2).map((m) => m.text)),
  );
  check('состав: say без продублированных отчётов', lastManagerMessage().trim() === 'Меняю состав.', lastManagerMessage());
}

// session.list + session.open: реплика менеджера остаётся в СТАРОМ разговоре
{
  const oldId = app.session.id;
  const second = app.store.create();
  second.title = 'Старый разговор';
  second.messages.push({ authorId: 'user', authorName: 'Хозяин', text: 'это старый разговор', ts: 1 });
  // цель строго свежее текущего: раунд сам сохранит сообщение пользователя и
  // обновит updatedAt текущего разговора — цель должна остаться первой в списке
  // save() штампует updatedAt = сейчас, поэтому «свежесть» цели пишем в файл напрямую
  app.store.save(second);
  second.updatedAt = Date.now() + 60_000;
  writeFileSync(join(proj, 'sessions', `${second.id}.json`), JSON.stringify(second, null, 2), 'utf8');

  // номер цели берём по факту: раунд сам сохраняет сообщение пользователя и
  // обновляет updatedAt текущего разговора — порядок списка не угадать заранее
  const n = app.store.list().findIndex((s) => s.id === second.id) + 1;
  await askManager(
    `Показываю.\n{"say":"Показываю и открываю.","actions":[{"op":"session.list"},{"op":"session.open","n":${n}}]}`,
    'покажи разговоры и открой свежий',
  );
  check('session.open: разговор переключился', app.session.id === second.id, `${oldId} -> ${app.session.id}`);
  const oldSession = app.store.load(oldId)!;
  const managerMsg = oldSession.messages.filter((m) => m.authorId === 'manager').at(-1)?.text ?? '';
  check('session.open: реплика с отчётами — в СТАРОМ разговоре', managerMsg.includes('Показываю и открываю.') && managerMsg.includes('✓ Открываю разговор'), managerMsg.slice(-200));
  check('session.open: в отчёте список разговоров', managerMsg.includes('1. Старый разговор') || managerMsg.includes('Разговоров пока нет'), managerMsg.slice(-200));
  console.log('  [диагностика] says:', JSON.stringify(says.slice(-3)), 'notices:', JSON.stringify(notices.slice(-10)));
  check('session.open: sessionOpened дошёл до оболочки', notices.some((t) => t.includes('Открыт разговор')));
}

// session.new с фильтром участников: неизвестные отбрасываются, пусто → менеджер
{
  const oldId = app.session.id;
  await askManager(
    'Создаю.\n{"say":"Создаю с Катей.","actions":[{"op":"session.new","title":"Проект","participants":["katya","ghost"]}]}',
    'новый разговор с Катей',
  );
  check('session.new: разговор создан с заголовком', app.session.title === 'Проект', app.session.title);
  check('session.new: неизвестный участник отфильтрован', JSON.stringify(app.session.participants) === JSON.stringify(['katya']), JSON.stringify(app.session.participants));
  const oldSession = app.store.load(oldId)!;
  check('session.new: реплика — в прежнем разговоре', oldSession.messages.some((m) => m.authorId === 'manager' && m.text.includes('Создаю с Катей.')));
  check('session.new: ✓-отчёт в истории', oldSession.messages.some((m) => m.authorId === 'manager' && m.text.includes('✓ Создаю разговор')), '');
}

// session.delete текущего — отказ с отчётом, разговор цел
{
  const id = app.session.id;
  await askManager(
    'Не выйдет.\n{"say":"Не выйдет.","actions":[{"op":"session.delete","n":1}]}',
    'удали этот разговор',
  );
  check('session.delete: текущий жив', app.session.id === id && app.store.list().some((s) => s.id === id));
  check('session.delete: отказ — в истории менеджера', lastManagerMessage().includes('нельзя') && lastManagerMessage().includes('Не выйдет.'), lastManagerMessage().slice(-160));
}

// tool.grant: первый ✓, второй ✗ — раунд продолжается после неудачи
{
  await askManager(
    'Включаю.\n{"say":"Включаю Паше files.","actions":[{"op":"tool.grant","agent":"pasha","tool":"files"},{"op":"tool.grant","agent":"pasha","tool":"ghost_tool"}]}',
    'включи Паше files',
  );
  const team = (await import('../src/agents.js')).loadTeam(agentsDir);
  const pasha = team.find((a) => a.id === 'pasha');
  check('tool.grant: files включён', Boolean(pasha?.tools?.files), JSON.stringify(pasha?.tools));
  check('tool.grant: призрака нет', !pasha?.tools?.ghost_tool, JSON.stringify(pasha?.tools));
  const msg = lastManagerMessage();
  check('tool.grant: ✓ и ✗ в одной реплике', msg.includes('✓') && msg.includes('✗') && msg.includes('не существует'), msg.slice(-200));
}

// project.host.add + дубликат: серверы текущего проекта
{
  await askManager(
    'Завожу.\n{"say":"Завожу проект.","actions":[{"op":"project.host.add","name":"dev","host":"203.0.113.10"},{"op":"project.host.add","name":"qa","host":"stg.example.com","port":2222},{"op":"project.host.add"}]}',
    'заведи серверы проекта',
  );
  const raw = JSON.parse(readFileSync(hostsFile, 'utf8')) as Record<string, { host: string; port?: number }>;
  check('project: сервер с хостом добавлен', raw.dev?.host === '203.0.113.10', JSON.stringify(raw));
  check('project: сервер с портом добавлен', raw.qa?.port === 2222, JSON.stringify(raw));
  check('project: отчёты ✓ в истории менеджера',
    app.session.messages.some((m) => m.authorId === 'manager' && m.text.includes('сервер(а) добавлены')), lastManagerMessage().slice(-160));
}

// mail.add + messenger.add + кривой ключ: ящики и боты текущего проекта
{
  await askManager(
    'Подключаю.\n{"say":"Подключаю ящик и бота.","actions":[' +
    '{"op":"mail.add","name":"работа","user":"робот@corp.ru","password":"пароль-приложения","imap":"imap.corp.ru","smtp":"smtp.corp.ru","smtpPort":587},' +
    '{"op":"messenger.add","key":"telegram","token":"123456:ABC-flow"},' +
    '{"op":"messenger.add","key":"slack","token":"чужой"},' +
    '{"op":"mail.add","name":"работа","user":"дубль@corp.ru","password":"p","imap":"i","smtp":"s"}]}',
    'заведи ящик и телеграм-бота',
  );
  const mails = JSON.parse(readFileSync(mailsFile, 'utf8')) as Record<string, { imap?: string; smtpPort?: number }>;
  check('mail: ящик добавлен с портом', mails['работа']?.imap === 'imap.corp.ru' && mails['работа']?.smtpPort === 587, JSON.stringify(mails));
  const mess = JSON.parse(readFileSync(messFile, 'utf8')) as Record<string, { token?: string } | undefined>;
  check('messenger: токен telegram записан', mess.telegram?.token === '123456:ABC-flow', JSON.stringify(mess));
  check('messenger: чужой ключ отфильтрован', mess.slack === undefined, JSON.stringify(mess));
  check('mail: дубликат — ✗ в истории, файл без дубля',
    Object.keys(mails).length === 1 &&
    app.session.messages.some((m) => m.authorId === 'manager' && m.text.includes('✗') && m.text.includes('уже есть')),
    lastManagerMessage().slice(-200));
}

// session.rename: менеджер переименовывает текущий разговор
{
  await askManager(
    'Переименовываю.\n{"say":"Переименовываю.","actions":[{"op":"session.rename","title":"Название от менеджера"}]}',
    'переименуй разговор',
  );
  check('rename: разговор переименован менеджером', app.session.title === 'Название от менеджера', app.session.title);
  check('rename: отчёт в истории', lastManagerMessage().includes('Разговор переименован: «Название от менеджера»'), lastManagerMessage().slice(-160));
  const stateInput = requests.filter((r) => r.system?.startsWith(MANAGER_PROMPT)).at(-1)!;
  // снимок собирается ДО исполнения действий: в нём ещё старое имя — но ярлык
  // «имя: «…»» и дайджест (когда появится) менеджер видит
  check('rename: снимок показывает имя разговора', stateInput.user?.includes('имя: «') ?? false, stateInput.user?.slice(-160));
}

// мусорный ответ: конфиг не тронут, реплика — чистый текст
{
  const agentsBefore = agentsSnapshot();
  const hostsBefore = readFileSync(hostsFile, 'utf8');
  await askManager('Просто болтаю без изменений.', 'как дела?');
  check('мусор: реплика менеджера — чистый текст', lastManagerMessage() === 'Просто болтаю без изменений.', lastManagerMessage());
  check('мусор: agents/ не тронут', agentsSnapshot() === agentsBefore);
  check('мусор: hosts.json не тронут', readFileSync(hostsFile, 'utf8') === hostsBefore);
}

// пустой ответ: менеджер молчит — заметка, без реплики в истории
{
  const before = app.session.messages.filter((m) => m.authorId === 'manager').length;
  await askManager('', '…');
  check('молчание: заметка оболочке', notices.some((t) => t.includes('менеджер молчит')), notices.slice(-3).join(' | '));
  check('молчание: реплики менеджера в истории нет', app.session.messages.filter((m) => m.authorId === 'manager').length === before);
}

// роутинг: без @менеджер ход уходит участнику чата, а не менеджеру
{
  const managersBefore = app.session.messages.filter((m) => m.authorId === 'manager').length;
  await engine.handleMessage('привет команде, как продвигается?', signal());
  const agentReq = requests.filter((r) => !r.system?.startsWith(MANAGER_PROMPT)).at(-1);
  check('роутинг: язык общения в промте агента', agentReq?.system?.includes('отвечай строго на языке: english') ?? false, agentReq?.system?.slice(-80));
  const last = app.session.messages.at(-1)!;
  check('роутинг: без @менеджер отвечает участник', last.authorId === 'katya', JSON.stringify({ authorId: last.authorId }));
  check('роутинг: менеджер молчал', app.session.messages.filter((m) => m.authorId === 'manager').length === managersBefore);
}

// авто-имя: в mock-режиме менеджер не переименовывает — остаётся имя по первому сообщению
{
  const title = app.session.title;
  check('авто-имя: mock не придумывает имена', title !== 'Новый разговор' && title.length > 0, title);
}

// ── чистка ───────────────────────────────────────────────────────────────────
process.chdir(tmpdir()); // Windows не даёт удалить каталог процесса
rmTemp(base);
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
