/**
 * Проверка менеджера переговорки (без LLM и терминала):
 *  - loadManagerConfig: дефолты, строгая валидация (нет файла, битый JSON,
 *    неизвестный провайдер), цвет;
 *  - managerMentioned: @менеджер/@manager/@имя и синоним «№», регистр и «ё» не важны;
 *  - parseManagerReply: текст + JSON-действия, мусор и чужие op отсеиваются;
 *  - addTeamAgent/updateTeamAgent на временных agents.json: валидность после
 *    записи (loadTeam), дефолты, белый список tools, сохранение неизвестных
 *    полей корня, дубликаты, «неудачная правка не портит файл».
 *  - loadProjects/resolveHost/checkPermission: проекты с папками и серверами,
 *    ssh-адресация «проект:хост», права через проекты; loadSettings: лимиты.
 * Запуск: npm run probe:manager
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { findMentions, loadTeam } from '../src/agents.js';
import { checkPermission, loadProjects, resolveHost, type ToolsConfig } from '../src/actions.js';
import { loadSettings } from '../src/settings.js';
import {
  MANAGER_PROMPT,
  addTeamAgent,
  loadManagerConfig,
  managerAsAgent,
  managerMentioned,
  managerStateInput,
  parseManagerReply,
  updateTeamAgent,
} from '../src/manager.js';
import type { Agent, AgentTools, SessionMeta } from '../src/types.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dt-manager-'));
const cfgFile = join(dir, 'manager.json');
const agentsFile = join(dir, 'agents.json');

// --- loadManagerConfig ---
{
  writeFileSync(cfgFile, JSON.stringify({ provider: 'openai' }));
  const cfg = loadManagerConfig(cfgFile, ['openai', 'mock']);
  check('конфиг: провайдер сохранён', cfg.provider === 'openai');
  check('конфиг: дефолтное имя', cfg.name === 'Менеджер', cfg.name);
  check('конфиг: дефолтный эмодзи', cfg.emoji === '🛎', cfg.emoji);
  check('конфиг: дефолтный цвет', cfg.color === 'yellow', cfg.color);
  check('конфиг: дефолтная температура', cfg.temperature === 0.2, String(cfg.temperature));
}
{
  writeFileSync(cfgFile, JSON.stringify({ provider: 'mock', name: 'Пчёлка', emoji: '🎩', color: 'magenta', temperature: 0.5 }));
  const cfg = loadManagerConfig(cfgFile, ['mock']);
  check('конфиг: свои значения читаются', cfg.name === 'Пчёлка' && cfg.emoji === '🎩' && cfg.color === 'magenta' && cfg.temperature === 0.5);
  check('конфиг: обращение по «ё»-имени без «ё»', managerMentioned('@пчелка, добавь', cfg));
  check('конфиг: обращение с «ё»', managerMentioned('@Пчёлка', cfg));
}
{
  let threw = '';
  try { loadManagerConfig(join(dir, 'нет-файла.json'), ['openai']); } catch (e) { threw = (e as Error).message; }
  check('конфиг: нет файла — внятная ошибка с путём', threw.includes('нет-файла.json'), threw);
}
{
  writeFileSync(cfgFile, '{ битый json');
  let threw = '';
  try { loadManagerConfig(cfgFile, ['openai']); } catch (e) { threw = (e as Error).message; }
  check('конфиг: битый JSON — ошибка', threw.includes(cfgFile) || threw.includes('manager.json'), threw);
}
{
  writeFileSync(cfgFile, JSON.stringify({ name: 'Менеджер' }));
  let threw = '';
  try { loadManagerConfig(cfgFile, ['openai']); } catch (e) { threw = (e as Error).message; }
  check('конфиг: нет provider — ошибка', threw.includes('provider'), threw);
}
{
  writeFileSync(cfgFile, JSON.stringify({ provider: 'чужой' }));
  let threw = '';
  try { loadManagerConfig(cfgFile, ['openai', 'mock']); } catch (e) { threw = (e as Error).message; }
  check('конфиг: неизвестный провайдер — ошибка со списком', threw.includes('чужой') && threw.includes('openai, mock'), threw);
}
{
  writeFileSync(cfgFile, JSON.stringify({ provider: 'openai', color: 'бирюзовый' }));
  check('конфиг: незнакомый цвет → yellow', loadManagerConfig(cfgFile, ['openai']).color === 'yellow');
}
// конфиг из репозитория валиден
{
  const repoCfg = loadManagerConfig(join('config', 'manager.json'), ['openai', 'mock']);
  check('конфиг: config/manager.json из репозитория читается', repoCfg.provider === 'openai' && repoCfg.name === 'Менеджер');
}

// --- managerMentioned ---
{
  const cfg = loadManagerConfig(cfgFile, ['openai']); // name: Менеджер
  check('mention: @менеджер', managerMentioned('@менеджер, добавь Катю', cfg));
  check('mention: регистр не важен', managerMentioned('@Менеджер', cfg));
  check('mention: @manager — английский вариант', managerMentioned('а @manager пусть зайдёт', cfg));
  check('mention: № — синоним @', managerMentioned('№менеджер, позови всех', cfg));
  check('mention: № перед своим именем', managerMentioned('№Менеджер', cfg));
  check('mention: без @/№ — не упоминание', !managerMentioned('менеджер, ты тут?', cfg));
  check('mention: чужое @имя — мимо', !managerMentioned('@катя, привет', cfg));
  check('mention: мимо и без слова вообще', !managerMentioned('привет всем', cfg));
  // триггер № для обычных участников (findMentions); результат — уникальные агенты
  const team: Agent[] = [{ id: 'katya', name: 'Катя', emoji: '🎨', role: 'дизайнер', color: 'cyan', prompt: 'p' }];
  check('mention: findMentions @имя и @id', findMentions('@Катя и @katya', team).length === 1);
  check('mention: findMentions №имя и №id', findMentions('№катя, №katya', team).length === 1);
  check('mention: findMentions «ё» и регистр', findMentions('Ёжик №КАТЯ', team).length === 1);
  check('mention: findMentions чужое имя — мимо', findMentions('№кира, привет', team).length === 0);
}
{
  // псевдо-агент пригоден для шапки: есть все поля рендера
  const cfg = loadManagerConfig(cfgFile, ['openai']);
  const agent = managerAsAgent(cfg);
  check('псевдо-агент: id/имя/роль/эмодзи/цвет',
    agent.id === 'manager' && agent.name === cfg.name && agent.role === 'менеджер переговорки' &&
    agent.emoji === cfg.emoji && agent.color === cfg.color);
  check('промпт менеджера короткий и с маркером', MANAGER_PROMPT.length < 1600 && MANAGER_PROMPT.startsWith('Ты — менеджер переговорки'), String(MANAGER_PROMPT.length));
}

// --- parseManagerReply ---
{
  const r = parseManagerReply('Просто ответ без изменений.');
  check('парсер: чистый текст — say без действий', r.say === 'Просто ответ без изменений.' && r.actions.length === 0);
}
{
  const r = parseManagerReply(
    'Готово, зову Катю.\n\n{"say":"Зову Катю.","actions":[{"op":"chat.add","who":"Катя"}]}',
  );
  check('парсер: say выделен', r.say === 'Зову Катю.', r.say);
  check('парсер: действие прочитано', r.actions.length === 1 && r.actions[0].op === 'chat.add' && r.actions[0].who === 'Катя');
}
{
  const r = parseManagerReply(
    '{"say":"делаю","actions":[{"op":"chat.add","who":"Катя"},{"op":"взломать.все"},{"op":"session.open","n":2}]}',
  );
  check('парсер: чужие op отсеяны', r.actions.length === 2 && r.actions[1].op === 'session.open', JSON.stringify(r.actions));
}
{
  const r = parseManagerReply('Модель написала ерунду {не json и не скобка}');
  check('парсер: битый JSON — весь текст как say', r.say.includes('ерунду') && r.actions.length === 0);
}
{
  const r = parseManagerReply('["не объект"]');
  check('парсер: массив вместо объекта — весь текст как say', r.say === '["не объект"]' && r.actions.length === 0);
}
{
  const r = parseManagerReply('{"say":"только сказать"}');
  check('парсер: say без actions — валидно', r.say === 'только сказать' && r.actions.length === 0);
}
{
  const r = parseManagerReply('{"actions":[{"op":"team.add","id":"x","name":"X"}]}');
  check('парсер: действия без say — работают', r.actions.length === 1 && r.actions[0].op === 'team.add');
}
{
  const r = parseManagerReply('до {\"say\":\"s\",\"actions\":[{\"op\":\"team.update\",\"id\":\"x\",\"fields\":{\"role\":\"ведущий\"}}]} после');
  check('парсер: JSON в середине текста', r.say === 's' && r.actions.length === 1 && r.actions[0].op === 'team.update');
}

// --- managerStateInput ---
{
  const team: Agent[] = [
    { id: 'katya', name: 'Катя', emoji: '🎨', role: 'дизайнер', color: 'cyan', prompt: 'p', provider: 'claude', temperature: 0.3 },
    { id: 'gleb', name: 'Глеб', emoji: '💾', role: 'разработчик', color: 'green', prompt: 'p' },
  ];
  const sessions: SessionMeta[] = [
    { id: 's1', title: 'Текущий', updatedAt: 1, count: 4 },
    { id: 's2', title: 'Прошлый', updatedAt: 0, count: 9 },
  ];
  const input = managerStateInput({
    team,
    participants: ['katya'],
    sessions,
    currentSessionId: 's1',
    userName: 'Хозяин',
    history: [{ authorId: 'user', authorName: 'Хозяин', text: 'привет', ts: 1 }],
    request: '@менеджер, позови Глеба',
  });
  check('стейт: ростер с провайдером и temp', input.includes('katya — Катя (дизайнер), провайдер: claude, temp 0.3'), input);
  check('стейт: состав чата', input.includes('В этом чате: katya'));
  check('стейт: список разговоров с номерами и текущим', input.includes('1. Текущий — 4 сообщ. (текущий)') && input.includes('2. Прошлый — 9 сообщ.'), input);
  check('стейт: просьба руководителя', input.includes('Просьба руководителя: «@менеджер, позови Глеба»'));
}

// --- team.add / team.update на временном agents.json (канонично — голый массив) ---
{
  writeFileSync(agentsFile, JSON.stringify([{ id: 'gleb', name: 'Глеб', emoji: '💾', role: 'разработчик', color: 'green', prompt: 'Ты — Глеб.' }], null, 2) + '\n');

  const report = addTeamAgent(agentsFile, {
    id: 'katya', name: 'Катя', role: 'дизайнер', tools: { files: {}, shell: null }, temperature: 0.4,
  });
  check('team.add: отчёт с именем и ролью', report.includes('Катя') && report.includes('дизайнер'), report);

  const agents = loadTeam(agentsFile);
  const katya = agents.find((a) => a.id === 'katya');
  check('team.add: loadTeam валиден, участник на месте', !!katya);
  check('team.add: дефолты эмодзи/цвета', katya?.emoji === '🤖' && katya?.color === 'white', JSON.stringify(katya));
  check('team.add: дефолтный промпт', katya?.prompt === 'Ты — Катя, дизайнер.', katya?.prompt);
  // карточки доходят как есть, null → {} (настройки по умолчанию)
  const kt = katya?.tools;
  check(
    'team.add: tools-карточки записаны, null → {}',
    !!kt && !Array.isArray(kt) && Object.keys(kt).length === 2 && 'files' in kt && JSON.stringify(kt.shell) === '{}',
    JSON.stringify(kt),
  );
  check('team.add: temperature записана', katya?.temperature === 0.4);
  check('team.add: корень остался массивом', Array.isArray(JSON.parse(readFileSync(agentsFile, 'utf8'))));
  check('team.add: tmp-файл убран за собой', !existsSync(agentsFile + '.tmp'));

  const before = readFileSync(agentsFile, 'utf8');
  let threw = '';
  try { addTeamAgent(agentsFile, { id: 'katya', name: 'Дубль' }); } catch (e) { threw = (e as Error).message; }
  check('team.add: дубликат id — ошибка', threw.includes('уже есть'), threw);
  check('team.add: неудачная правка файл не меняла', readFileSync(agentsFile, 'utf8') === before);

  threw = '';
  try { addTeamAgent(agentsFile, { id: 'zina', name: 'Зина', tools: ['files'] as unknown as AgentTools }); } catch (e) { threw = (e as Error).message; }
  check('team.add: массив tools — ошибка с подсказкой', threw.includes('массивов больше нет'), threw);
  check('team.add: отказ из-за tools файл не менял', readFileSync(agentsFile, 'utf8') === before);

  threw = '';
  try { addTeamAgent(agentsFile, { id: 'кривой id', name: 'X' }); } catch (e) { threw = (e as Error).message; }
  check('team.add: id с пробелами — ошибка', threw.includes('id'), threw);
  threw = '';
  try { addTeamAgent(agentsFile, { id: 'ok', name: '' }); } catch (e) { threw = (e as Error).message; }
  check('team.add: без имени — ошибка', threw.includes('name') || threw.includes('имя'), threw);
}
{
  const report = updateTeamAgent(agentsFile, 'gleb', { role: 'ведущий разработчик', provider: 'openai', temperature: 0.1 });
  check('team.update: отчёт перечисляет правки', report.includes('ведущий разработчик') && report.includes('openai') && report.includes('temperature=0.1'), report);
  const agents = loadTeam(agentsFile);
  const gleb = agents.find((a) => a.id === 'gleb');
  check('team.update: роль/провайдер/temp применились', gleb?.role === 'ведущий разработчик' && gleb?.provider === 'openai' && gleb?.temperature === 0.1, JSON.stringify(gleb));
  check('team.update: остальные поля целы', gleb?.prompt === 'Ты — Глеб.' && gleb?.emoji === '💾');
  check('team.update: loadTeam по-прежнему валиден', agents.length === 2);

  let threw = '';
  try { updateTeamAgent(agentsFile, 'никого', { role: 'x' }); } catch (e) { threw = (e as Error).message; }
  check('team.update: чужой id — ошибка', threw.includes('никого'), threw);
  threw = '';
  try { updateTeamAgent(agentsFile, 'gleb', { projects: ['x'] } as never); } catch (e) { threw = (e as Error).message; }
  check('team.update: вне белого списка — ошибка «не понятно»', threw.includes('не понятно'), threw);
  threw = '';
  try { updateTeamAgent(agentsFile, 'gleb', {}); } catch (e) { threw = (e as Error).message; }
  check('team.update: пустые fields — ошибка', threw.includes('не понятно'), threw);
}

// --- легаси-форма { agents: [...] } со своими полями корня всё ещё работает ---
{
  writeFileSync(agentsFile, JSON.stringify({ agents: [{ id: 'gleb', name: 'Глеб', color: 'green', prompt: 'x' }], note: 'не трогать' }, null, 2) + '\n');
  check('легаси: loadTeam читает обёртку', loadTeam(agentsFile).length === 1);
  addTeamAgent(agentsFile, { id: 'katya', name: 'Катя' });
  const legacy = JSON.parse(readFileSync(agentsFile, 'utf8'));
  check('легаси: правка сохранила обёртку и поля корня', Array.isArray(legacy.agents) && legacy.agents.length === 2 && legacy.note === 'не трогать', JSON.stringify(legacy).slice(0, 120));
}

// --- loadProjects / resolveHost / checkPermission: проекты с папками и серверами ---
{
  const cfgDir = join(dir, 'config');
  mkdirSync(cfgDir, { recursive: true });
  const projFile = join(cfgDir, 'projects.json');
  writeFileSync(
    projFile,
    JSON.stringify({
      shop: {
        dir: 'repo',
        hosts: { prod: { user: 'deploy', host: '203.0.113.10', port: 22 }, staging: { host: 'stg.example.com' } },
      },
      infra: { hosts: { prod: { host: '10.0.0.1' } } },
    }),
  );
  let threw = '';
  try { loadProjects(dir); } catch (e) { threw = (e as Error).message; }
  check('projects: два проекта с «prod» читаются', threw === '' && true, threw);
  const projects = loadProjects(dir);
  const shop = projects.get('shop');
  check('projects: папка разрешена от корня', shop?.dirAbs === join(dir, 'repo'), shop?.dirAbs);
  check('projects: хосты с user/port', shop?.hosts.get('prod')?.host === '203.0.113.10' && shop?.hosts.get('prod')?.port === 22, JSON.stringify([...shop?.hosts ?? []]));
  check('projects: infra без папки', projects.get('infra')?.dirAbs === undefined);

  const cfg: ToolsConfig = { workspaceAbs: join(dir, 'ws'), runTimeoutMs: 1000, maxOutputChars: 100, projects };
  const full = resolveHost('shop:prod', cfg);
  check('ssh: «проект:хост» резолвится', !('error' in full) && full.project === 'shop' && full.host.user === 'deploy', JSON.stringify(full));
  const bare = resolveHost('staging', cfg);
  check('ssh: голое имя, хост у одного проекта', !('error' in bare) && bare.project === 'shop', JSON.stringify(bare));
  const ambiguous = resolveHost('prod', cfg);
  check('ssh: общее имя у двух проектов — отказ с подсказкой', 'error' in ambiguous && ambiguous.error.includes('shop:prod') && ambiguous.error.includes('infra:prod'), JSON.stringify(ambiguous));
  check('ssh: чужой хост — отказ', 'error' in resolveHost('shop:nope', cfg), '');
  const devops: Agent = { id: 'y', name: 'Яна', emoji: '🏍', role: 'devops', color: 'cyan', prompt: 'x', tools: { ssh: {} }, projects: ['shop'] };
  check('права: ssh по проекту разрешён', checkPermission(devops, { kind: 'ssh', host: 'shop:prod', command: 'uptime' }, cfg) === null);
  check('права: ssh по голому имени уникального хоста разрешён', checkPermission(devops, { kind: 'ssh', host: 'staging', command: 'uptime' }, cfg) === null);
  const deny = checkPermission(devops, { kind: 'ssh', host: 'infra:prod', command: 'uptime' }, cfg);
  check('права: ssh чужого проекта — отказ «не назначен»', deny !== null && deny.includes('не назначен'), deny ?? '');
  const noSsh: Agent = { ...devops, tools: { files: {} } };
  check('права: без инструмента ssh — отказ', checkPermission(noSsh, { kind: 'ssh', host: 'shop:prod', command: 'x' }, cfg)?.includes('ssh') === true);
  const fileDeny = checkPermission({ ...devops, tools: { ssh: {}, files: {} }, projects: ['shop', 'infra'] }, { kind: 'file', path: 'a.txt', content: 'x', project: 'infra' }, cfg);
  check('права: файл в проект без папки — отказ', fileDeny !== null && fileDeny.includes('нет папки'), fileDeny ?? '');

  writeFileSync(projFile, JSON.stringify({ bad: {} }));
  threw = '';
  try { loadProjects(dir); } catch (e) { threw = (e as Error).message; }
  check('projects: без dir и без hosts — ошибка', threw.includes('bad') && threw.includes('dir'), threw);
  writeFileSync(projFile, JSON.stringify({ bad: { hosts: { h1: { user: 'x' } } } }));
  threw = '';
  try { loadProjects(dir); } catch (e) { threw = (e as Error).message; }
  check('projects: хост без поля host — ошибка', threw.includes('h1') && threw.includes('host'), threw);
  writeFileSync(projFile, JSON.stringify({ Bad: {} }));
  threw = '';
  try { loadProjects(dir); } catch (e) { threw = (e as Error).message; }
  check('projects: id не по шаблону — ошибка', threw.includes('Bad'), threw);
  unlinkSync(projFile);
  threw = '';
  try { loadProjects(dir); } catch (e) { threw = (e as Error).message; }
  check('projects: файла нет — ошибка', threw.includes('не удалось прочитать'), threw);

  // --- loadSettings: лимиты и дефолты ---
  const sf = join(cfgDir, 'settings.json');
  writeFileSync(sf, JSON.stringify({ width: 100 }));
  const s = loadSettings(sf, 0);
  check('settings: дефолты лимитов', s.margin === 2 && s.screen === true && s.runTimeoutMs === 180000 && s.maxOutputChars === 4000, JSON.stringify(s));
  check('settings: рабочая папка по умолчанию — config/..', s.workspaceAbs === dirname(cfgDir), s.workspaceAbs);
  writeFileSync(sf, JSON.stringify({ width: 100, workspace: 'ws', runTimeoutMs: 5000 }));
  const s2 = loadSettings(sf, 0);
  check('settings: свой workspace разрешается', s2.workspaceAbs === join(dir, 'ws'), s2.workspaceAbs);
  check('settings: свой таймаут читается', s2.runTimeoutMs === 5000);
}

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
