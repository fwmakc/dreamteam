/**
 * Проверка менеджера переговорки (без LLM и терминала):
 *  - loadManagerConfig: дефолты, строгая валидация (нет файла, битый JSON,
 *    неизвестный провайдер), цвет;
 *  - managerMentioned: @менеджер/@manager/@имя и синоним «!», регистр и «ё» не важны;
 *  - parseManagerReply: текст + JSON-действия, мусор и чужие op отсеиваются;
 *  - addTeamAgent/updateTeamAgent на временных agents.json: валидность после
 *    записи (loadTeam), дефолты, белый список tools, сохранение неизвестных
 *    полей корня, дубликаты, «неудачная правка не портит файл».
 *  - loadHosts/resolveHost/checkPermission: серверы проекта, ssh-адресация
 *    «проект:хост», права через проекты; loadSettings: лимиты.
 * Запуск: npm run probe:manager
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMentions, loadTeam } from '../src/agents.js';
import { checkPermission, loadHosts, resolveHost, type ToolsConfig } from '../src/actions.js';
import { loadSettings } from '../src/settings.js';
import {
  MANAGER_PROMPT,
  addMailAccount,
  addMessengerBot,
  addProjectHosts,
  loadHostsFile,
  loadMailsFile,
  loadMessengersFile,
  removeMailAccount,
  removeMessengerBot,
  removeProjectHost,
  addTeamAgent,
  grantTool,
  loadManagerConfig,
  managerAsAgent,
  managerMentioned,
  managerStateInput,
  parseManagerReply,
  updateTeamAgent,
} from '../src/manager.js';
import { loadAccounts } from '../src/mail.js';
import { loadMessengers } from '../src/messengers.js';
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
// реестр провайдеров для правок команды (как App.providers)
const providers: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['openai', null],
  ['claude', null],
]);

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
  const repoCfg = loadManagerConfig(join('.dreamteam', 'manager.json'), ['openai', 'mock']);
  check('конфиг: .dreamteam/manager.json из репозитория читается', repoCfg.provider === 'openai' && repoCfg.name === 'Менеджер');
}

// --- managerMentioned ---
{
  const cfg = loadManagerConfig(cfgFile, ['openai']); // name: Менеджер
  check('mention: @менеджер', managerMentioned('@менеджер, добавь Катю', cfg));
  check('mention: регистр не важен', managerMentioned('@Менеджер', cfg));
  check('mention: @manager — английский вариант', managerMentioned('а @manager пусть зайдёт', cfg));
  check('mention: ! — синоним @', managerMentioned('!менеджер, позови всех', cfg));
  check('mention: ! перед своим именем', managerMentioned('!Менеджер', cfg));
  check('mention: без @/! — не упоминание', !managerMentioned('менеджер, ты тут?', cfg));
  check('mention: чужое @имя — мимо', !managerMentioned('@катя, привет', cfg));
  check('mention: мимо и без слова вообще', !managerMentioned('привет всем', cfg));
  // триггер ! для обычных участников (findMentions); результат — уникальные агенты
  const team: Agent[] = [{ id: 'katya', name: 'Катя', emoji: '🎨', role: 'дизайнер', color: 'cyan', prompt: 'p' }];
  check('mention: findMentions @имя и @id', findMentions('@Катя и @katya', team).length === 1);
  check('mention: findMentions !имя и !id', findMentions('!катя, !katya', team).length === 1);
  check('mention: findMentions «ё» и регистр', findMentions('Ёжик !КАТЯ', team).length === 1);
  check('mention: findMentions чужое имя — мимо', findMentions('!кира, привет', team).length === 0);
}
{
  // псевдо-агент пригоден для шапки: есть все поля рендера
  const cfg = loadManagerConfig(cfgFile, ['openai']);
  const agent = managerAsAgent(cfg);
  check('псевдо-агент: id/имя/роль/эмодзи/цвет',
    agent.id === 'manager' && agent.name === cfg.name && agent.role === 'менеджер переговорки' &&
    agent.emoji === cfg.emoji && agent.color === cfg.color);
  check('промпт менеджера короткий и с маркером', MANAGER_PROMPT.length < 2450 && MANAGER_PROMPT.startsWith('Ты — менеджер переговорки'), String(MANAGER_PROMPT.length));
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
{
  const r = parseManagerReply(
    '{"say":"включаю","actions":[{"op":"tool.grant","agent":"gleb","tool":"shell"},{"op":"project.host.add","name":"staging","host":"stg.example.com","port":2222},{"op":"project.host.add"}]}',
  );
  check('парсер: действия прочитаны, host.add без name отсеян',
    r.actions.length === 2 &&
    r.actions[0].op === 'tool.grant' &&
    (r.actions[1] as { name: string }).name === 'staging' &&
    (r.actions[1] as { host: string }).host === 'stg.example.com',
    JSON.stringify(r.actions));
}

// --- managerStateInput ---
{
  const team: Agent[] = [
    { id: 'katya', name: 'Катя', emoji: '🎨', role: 'дизайнер', color: 'cyan', prompt: 'p', provider: 'claude', temperature: 0.3, tools: { files: {}, look: null } },
    { id: 'gleb', name: 'Глеб', emoji: '💾', role: 'разработчик', color: 'green', prompt: 'p', projects: ['shop'] },
  ];
  const sessions: SessionMeta[] = [
    { id: 's1', title: 'Текущий', createdAt: 0, updatedAt: 1, count: 4 },
    { id: 's2', title: 'Прошлый', createdAt: 0, updatedAt: 0, count: 9 },
  ];
  const input = managerStateInput({
    team,
    participants: ['katya'],
    sessions,
    currentSessionId: 's1',
    sessionTitle: 'Текущий',
    digest: 'Краткое содержание для проверки.',
    userName: 'Хозяин',
    history: [{ authorId: 'user', authorName: 'Хозяин', text: 'привет', ts: 1 }],
    request: '@менеджер, позови Глеба',
    projects: [{ id: 'shop', hosts: ['prod', 'staging'] }],
    operations: [{ cmd: '/session new', help: 'новый разговор' }, { cmd: '/session open', args: '<номер>', help: 'открыть разговор' }],
  });
  check('стейт: ростер с провайдером и temp', input.includes('katya — Катя (дизайнер), провайдер: claude, temp 0.3'), input);
  check('стейт: тула агента в ростере', input.includes('тула: files, look') && input.includes('тула нет'), input);
  check('стейт: состав чата', input.includes('В этом чате: katya'));
  check('стейт: список разговоров с номерами и текущим', input.includes('1. Текущий — 4 сообщ. (текущий)') && input.includes('2. Прошлый — 9 сообщ.'), input);
  check('стейт: проект с серверами', input.includes('- shop: серверы prod, staging'), input);
  check('стейт: операции манифеста с аргументами', input.includes('/session open <номер>'), input);
  check('стейт: просьба руководителя', input.includes('Просьба руководителя: «@менеджер, позови Глеба»'));
  check('стейт: имя и краткое содержание разговора', input.includes('имя: «Текущий»') && input.includes('Краткое содержание разговора:'), input.slice(-400));
}

// --- team.add / team.update на временном agents.json (канонично — голый массив) ---
{
  writeFileSync(agentsFile, JSON.stringify([{ id: 'gleb', name: 'Глеб', emoji: '💾', role: 'разработчик', color: 'green', prompt: 'Ты — Глеб.' }], null, 2) + '\n');

  const report = addTeamAgent(agentsFile, {
    id: 'katya', name: 'Катя', role: 'дизайнер', tools: { files: {}, shell: null }, temperature: 0.4,
  }, providers);
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
  try { addTeamAgent(agentsFile, { id: 'katya', name: 'Дубль' }, providers); } catch (e) { threw = (e as Error).message; }
  check('team.add: дубликат id — ошибка', threw.includes('уже есть'), threw);
  check('team.add: неудачная правка файл не меняла', readFileSync(agentsFile, 'utf8') === before);

  threw = '';
  try { addTeamAgent(agentsFile, { id: 'zina', name: 'Зина', tools: ['files'] as unknown as AgentTools }, providers); } catch (e) { threw = (e as Error).message; }
  check('team.add: массив tools — ошибка с подсказкой', threw.includes('массивов больше нет'), threw);
  check('team.add: отказ из-за tools файл не менял', readFileSync(agentsFile, 'utf8') === before);

  threw = '';
  try { addTeamAgent(agentsFile, { id: 'кривой id', name: 'X' }, providers); } catch (e) { threw = (e as Error).message; }
  check('team.add: id с пробелами — ошибка', threw.includes('id'), threw);
  threw = '';
  try { addTeamAgent(agentsFile, { id: 'ok', name: '' }, providers); } catch (e) { threw = (e as Error).message; }
  check('team.add: без имени — ошибка', threw.includes('name') || threw.includes('имя'), threw);
  threw = '';
  try { addTeamAgent(agentsFile, { id: 'mira', name: 'Мира', provider: 'основной' }, providers); } catch (e) { threw = (e as Error).message; }
  check('team.add: чужой провайдер — отказ со списком', threw.includes('неизвестный провайдер «основной»') && threw.includes('openai'), threw);
  check('team.add: отказ из-за провайдера файл не менял', readFileSync(agentsFile, 'utf8') === before);
  addTeamAgent(agentsFile, { id: 'mira', name: 'Мира', provider: 'claude' }, providers);
  check('team.add: существующий провайдер записан', loadTeam(agentsFile).find((a) => a.id === 'mira')?.provider === 'claude');
}
{
  const report = updateTeamAgent(agentsFile, 'gleb', { role: 'ведущий разработчик', provider: 'openai', temperature: 0.1 }, providers);
  check('team.update: отчёт перечисляет правки', report.includes('ведущий разработчик') && report.includes('openai') && report.includes('temperature=0.1'), report);
  const agents = loadTeam(agentsFile);
  const gleb = agents.find((a) => a.id === 'gleb');
  check('team.update: роль/провайдер/temp применились', gleb?.role === 'ведущий разработчик' && gleb?.provider === 'openai' && gleb?.temperature === 0.1, JSON.stringify(gleb));
  check('team.update: остальные поля целы', gleb?.prompt === 'Ты — Глеб.' && gleb?.emoji === '💾');
  check('team.update: loadTeam по-прежнему валиден', agents.length === 3);

  const before2 = readFileSync(agentsFile, 'utf8');
  let threw = '';
  try { updateTeamAgent(agentsFile, 'никого', { role: 'x' }, providers); } catch (e) { threw = (e as Error).message; }
  check('team.update: чужой id — ошибка', threw.includes('никого'), threw);
  threw = '';
  try { updateTeamAgent(agentsFile, 'gleb', { projects: ['x'] } as never, providers); } catch (e) { threw = (e as Error).message; }
  check('team.update: вне белого списка — ошибка «не понятно»', threw.includes('не понятно'), threw);
  threw = '';
  try { updateTeamAgent(agentsFile, 'gleb', {} , providers); } catch (e) { threw = (e as Error).message; }
  check('team.update: пустые fields — ошибка', threw.includes('не понятно'), threw);
  threw = '';
  try { updateTeamAgent(agentsFile, 'gleb', { provider: 'основной' }, providers); } catch (e) { threw = (e as Error).message; }
  check('team.update: чужой провайдер — отказ, файл цел', threw.includes('неизвестный провайдер «основной»') && readFileSync(agentsFile, 'utf8') === before2, threw);
}

// --- tool.grant: включение тула и карточки, свои тула — только существующие ---
{
  writeFileSync(agentsFile, JSON.stringify([{ id: 'gleb', name: 'Глеб', emoji: '💾', role: 'разработчик', color: 'green', prompt: 'Ты — Глеб.' }], null, 2) + '\n');
  const toolsDir = join(dir, 'tools');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, 'reporter.ts'), 'export const make = () => ({ desc: "d", check: () => "allow" as const, run: async () => "ok" });\n');

  const report = grantTool(agentsFile, 'gleb', 'files', { deny: ['rm -rf *'] });
  check('tool.grant: отчёт о включении', report.includes('Глеб') && report.includes('files'), report);
  const gleb = loadTeam(agentsFile).find((a) => a.id === 'gleb');
  check('tool.grant: карточка записана', JSON.stringify(gleb?.tools?.files) === '{"deny":["rm -rf *"]}', JSON.stringify(gleb?.tools));

  const report2 = grantTool(agentsFile, 'gleb', 'reporter', undefined, toolsDir);
  const gleb2 = loadTeam(agentsFile).find((a) => a.id === 'gleb');
  check('tool.grant: свой тул по файлу в tools/', report2.includes('reporter') && JSON.stringify(gleb2?.tools?.reporter) === '{}', report2);

  const report3 = grantTool(agentsFile, 'gleb', 'reporter', { workdir: 'sub' }, toolsDir);
  check('tool.grant: повтор — обновление карточки', report3.includes('обновил'), report3);

  const before = readFileSync(agentsFile, 'utf8');
  let threw = '';
  try { grantTool(agentsFile, 'gleb', 'ghost_tool', {}, toolsDir); } catch (e) { threw = (e as Error).message; }
  check('tool.grant: своего тула нет — отказ', threw.includes('ghost_tool') && threw.includes('не существует'), threw);
  threw = '';
  try { grantTool(agentsFile, 'gleb', 'reporter', {}, join(dir, 'пусто')); } catch (e) { threw = (e as Error).message; }
  check('tool.grant: без папки tools свой тул не включить', threw.includes('reporter'), threw);
  threw = '';
  try { grantTool(agentsFile, 'gleb', 'Кривой id'); } catch (e) { threw = (e as Error).message; }
  check('tool.grant: кривой id — отказ', threw.includes('Кривой id'), threw);
  threw = '';
  try { grantTool(agentsFile, 'gleb', 'shell', ['массив']); } catch (e) { threw = (e as Error).message; }
  check('tool.grant: массив вместо карточки — отказ', threw.includes('объект'), threw);
  threw = '';
  try { grantTool(agentsFile, 'никого', 'files'); } catch (e) { threw = (e as Error).message; }
  check('tool.grant: чужой агент — отказ', threw.includes('никого'), threw);
  check('tool.grant: неудачные правки файл не меняли', readFileSync(agentsFile, 'utf8') === before);
  check('tool.grant: loadTeam по-прежнему валиден', loadTeam(agentsFile).length === 1);
}

// --- hosts.json: серверы проекта с откатом ---
{
  const hostsFile = join(dir, 'hosts.json');
  writeFileSync(
    hostsFile,
    JSON.stringify({ prod: { host: '203.0.113.10', user: 'deploy', port: 22 } }, null, 2) + '\n',
  );

  const report = addProjectHosts(hostsFile, { staging: { host: 'stg.example.com', dir: '/srv/app' } });
  check('project.host add: отчёт', report.includes('staging'), report);
  check('project.host add: loadHostsFile видит серверы', loadHostsFile(hostsFile).staging?.dir === '/srv/app');
  check('project.host add: старый сервер на месте', loadHostsFile(hostsFile).prod?.host === '203.0.113.10');

  const before = readFileSync(hostsFile, 'utf8');
  let threw = '';
  try { addProjectHosts(hostsFile, { staging: { host: 'x' } }); } catch (e) { threw = (e as Error).message; }
  check('project.host add: дубликат — отказ', threw.includes('уже есть'), threw);
  threw = '';
  try { addProjectHosts(hostsFile, { 'two words': { host: 'x' } }); } catch (e) { threw = (e as Error).message; }
  check('project.host add: пробелы в имени — отказ', threw.includes('пробел'), threw);
  threw = '';
  try { addProjectHosts(hostsFile, { badport: { host: 'x', port: -1 } }); } catch (e) { threw = (e as Error).message; }
  check('project.host add: кривой порт — отказ', threw.includes('port'), threw);
  threw = '';
  try { addProjectHosts(hostsFile, { nohost: { user: 'x' } as never }); } catch (e) { threw = (e as Error).message; }
  check('project.host add: сервер без host — отказ', threw.includes('host'), threw);
  threw = '';
  try { addProjectHosts(hostsFile, {}); } catch (e) { threw = (e as Error).message; }
  check('project.host add: пусто — отказ', threw.includes('хоть один'), threw);
  threw = '';
  try { removeProjectHost(hostsFile, 'nope'); } catch (e) { threw = (e as Error).message; }
  check('project host delete: нет сервера — отказ', threw.includes('nope'), threw);
  check('project: неудачные правки файл не меняли', readFileSync(hostsFile, 'utf8') === before);
  check('project: tmp-файл убран за собой', !existsSync(hostsFile + '.tmp'));
}

// --- mails.json: ящики проекта с откатом ---
{
  const mailsFile = join(dir, 'mails.json');
  writeFileSync(
    mailsFile,
    JSON.stringify({ личное: { user: 'я@yandex.ru', password: 'секрет', imap: 'imap.yandex.ru', smtp: 'smtp.yandex.ru' } }, null, 2) + '\n',
  );

  const report = addMailAccount(mailsFile, 'работа', { user: 'робот@corp.ru', password: 'пароль-приложения', imap: 'imap.corp.ru', smtp: 'smtp.corp.ru', smtpPort: 587, tlsNoVerify: true });
  check('mail add: отчёт', report.includes('работа') && report.includes('smtp.corp.ru'), report);
  check('mail add: пароль в отчёт не попал', !report.includes('пароль-приложения'), report);
  const mails = loadMailsFile(mailsFile);
  check('mail add: loadMailsFile видит ящик', mails['работа']?.smtpPort === 587 && mails['работа']?.tlsNoVerify === true);
  check('mail add: старый ящик на месте', mails['личное']?.imap === 'imap.yandex.ru');
  check('mail add: файл валиден по loadAccounts', (() => { try { return Object.keys(loadAccounts(mailsFile)).length === 2; } catch { return false; } })());

  const before = readFileSync(mailsFile, 'utf8');
  let threw = '';
  try { addMailAccount(mailsFile, 'работа', { user: 'x', password: 'p', imap: 'i', smtp: 's' }); } catch (e) { threw = (e as Error).message; }
  check('mail add: дубликат — отказ', threw.includes('уже есть'), threw);
  threw = '';
  try { addMailAccount(mailsFile, 'два слова', { user: 'x', password: 'p', imap: 'i', smtp: 's' }); } catch (e) { threw = (e as Error).message; }
  check('mail add: пробелы в имени — отказ', threw.includes('пробел'), threw);
  threw = '';
  try { addMailAccount(mailsFile, 'лишнее', { user: 'x', password: 'p', imap: 'i', smtp: 's', preset: 'yandex' }); } catch (e) { threw = (e as Error).message; }
  check('mail add: неизвестное поле — отказ', threw.includes('неизвестные поля'), threw);
  threw = '';
  try { addMailAccount(mailsFile, 'безпароля', { user: 'x', imap: 'i', smtp: 's' }); } catch (e) { threw = (e as Error).message; }
  check('mail add: нет пароля — отказ', threw.includes('password'), threw);
  threw = '';
  try { addMailAccount(mailsFile, 'безсерверов', { user: 'x', password: 'p' }); } catch (e) { threw = (e as Error).message; }
  check('mail add: нет imap/smtp — отказ', threw.includes('imap'), threw);
  threw = '';
  try { addMailAccount(mailsFile, 'кривойпорт', { user: 'x', password: 'p', imap: 'i', smtp: 's', port: '993' }); } catch (e) { threw = (e as Error).message; }
  check('mail add: порт строкой — отказ', threw.includes('port'), threw);
  threw = '';
  try { removeMailAccount(mailsFile, 'nope'); } catch (e) { threw = (e as Error).message; }
  check('mail remove: нет ящика — отказ', threw.includes('nope'), threw);
  check('mail: неудачные правки файл не меняли', readFileSync(mailsFile, 'utf8') === before);
  check('mail: tmp-файл убран за собой', !existsSync(mailsFile + '.tmp'));
  check('mail remove: убирает ящик', removeMailAccount(mailsFile, 'работа').includes('работа'));
  check('mail remove: остался один ящик', Object.keys(loadMailsFile(mailsFile)).length === 1);
}

// --- messengers.json: боты проекта с откатом ---
{
  const messFile = join(dir, 'messengers.json');
  writeFileSync(messFile, '{}\n');

  const report = addMessengerBot(messFile, 'telegram', '123456:ABC-secret');
  check('messenger add: отчёт', report.includes('telegram'), report);
  check('messenger add: токен в отчёт не попал', !report.includes('ABC-secret'), report);
  addMessengerBot(messFile, 'MAX', 'max-token-1');
  check('messenger add: ключ без учёта регистра записан', loadMessengersFile(messFile).max !== undefined);

  const before = readFileSync(messFile, 'utf8');
  let threw = '';
  try { addMessengerBot(messFile, 'slack', 'x'); } catch (e) { threw = (e as Error).message; }
  check('messenger add: чужой ключ — отказ', threw.includes('telegram') && threw.includes('max'), threw);
  threw = '';
  try { addMessengerBot(messFile, 'telegram', '   '); } catch (e) { threw = (e as Error).message; }
  check('messenger add: пустой токен — отказ', threw.includes('токен'), threw);
  threw = '';
  try { addMessengerBot(messFile, 'telegram', 'другой'); } catch (e) { threw = (e as Error).message; }
  check('messenger add: дубликат — отказ', threw.includes('уже есть'), threw);
  threw = '';
  try { removeMessengerBot(messFile, 'vk'); } catch (e) { threw = (e as Error).message; }
  check('messenger remove: чужой ключ — отказ', threw.includes('telegram'), threw);
  check('messenger: неудачные правки файл не меняли', readFileSync(messFile, 'utf8') === before);
  check('messenger remove: убирает бота', removeMessengerBot(messFile, 'max').includes('max'));
  threw = '';
  try { removeMessengerBot(messFile, 'max'); } catch (e) { threw = (e as Error).message; }
  check('messenger remove: бота уже нет — отказ', threw.includes('нет'), threw);
  const rest = loadMessengersFile(messFile);
  check('messenger: telegram остался, max убран', rest.telegram !== undefined && rest.max === undefined);
  check('messenger: файл валиден по loadMessengers', (() => { try { loadMessengers(messFile); return true; } catch { return false; } })());
  check('messenger: tmp-файл убран за собой', !existsSync(messFile + '.tmp'));
}

// --- легаси-форма { agents: [...] } со своими полями корня всё ещё работает ---
{
  writeFileSync(agentsFile, JSON.stringify({ agents: [{ id: 'gleb', name: 'Глеб', color: 'green', prompt: 'x' }], note: 'не трогать' }, null, 2) + '\n');
  check('легаси: loadTeam читает обёртку', loadTeam(agentsFile).length === 1);
  addTeamAgent(agentsFile, { id: 'katya', name: 'Катя' }, providers);
  const legacy = JSON.parse(readFileSync(agentsFile, 'utf8'));
  check('легаси: правка сохранила обёртку и поля корня', Array.isArray(legacy.agents) && legacy.agents.length === 2 && legacy.note === 'не трогать', JSON.stringify(legacy).slice(0, 120));
}

// --- loadHosts / resolveHost / checkPermission: серверы текущего проекта ---
{
  const hostsFile = join(dir, 'hosts.json');
  writeFileSync(
    hostsFile,
    JSON.stringify({ prod: { user: 'deploy', host: '203.0.113.10', port: 22 }, staging: { host: 'stg.example.com' } }),
  );
  const hosts = loadHosts(hostsFile);
  check('hosts: хосты с user/port', hosts.get('prod')?.host === '203.0.113.10' && hosts.get('prod')?.port === 22, JSON.stringify([...hosts]));
  check('hosts: оба сервера прочитаны', hosts.size === 2);

  const projects = new Map([['project', { hosts }]]);
  const cfg: ToolsConfig = { workspaceAbs: join(dir, 'ws'), runTimeoutMs: 1000, maxOutputChars: 100, projects };
  const full = resolveHost('project:prod', cfg);
  check('ssh: «project:хост» резолвится', !('error' in full) && full.project === 'project' && full.host.user === 'deploy', JSON.stringify(full));
  const bare = resolveHost('staging', cfg);
  check('ssh: голое имя резолвится', !('error' in bare) && bare.project === 'project', JSON.stringify(bare));
  check('ssh: чужой хост — отказ', 'error' in resolveHost('project:nope', cfg), '');
  const devops: Agent = { id: 'y', name: 'Яна', emoji: '🏍', role: 'devops', color: 'cyan', prompt: 'x', tools: { ssh: {} }, projects: ['project'] };
  check('права: ssh по проекту разрешён', checkPermission(devops, { kind: 'ssh', host: 'project:prod', command: 'uptime' }, cfg) === null);
  check('права: ssh по голому имени разрешён', checkPermission(devops, { kind: 'ssh', host: 'staging', command: 'uptime' }, cfg) === null);
  const deny = checkPermission(devops, { kind: 'ssh', host: 'ghost:prod', command: 'uptime' }, cfg);
  check('права: ssh несуществующего проекта — отказ резолвера', deny !== null && deny.includes('не настроен'), deny ?? '');
  const noSsh: Agent = { ...devops, tools: { files: {} } };
  check('права: без инструмента ssh — отказ', checkPermission(noSsh, { kind: 'ssh', host: 'project:prod', command: 'x' }, cfg)?.includes('ssh') === true);
  const fileDeny = checkPermission({ ...devops, tools: { ssh: {}, files: {} }, projects: ['project', 'ghost'] }, { kind: 'file', path: 'a.txt', content: 'x', project: 'ghost' }, cfg);
  check('права: проект не настроен — отказ', fileDeny !== null && fileDeny.includes('не известен'), fileDeny ?? '');

  writeFileSync(hostsFile, JSON.stringify(['nope']));
  let threw = '';
  try { loadHosts(hostsFile); } catch (e) { threw = (e as Error).message; }
  check('hosts: не объект — ошибка', threw.includes('ожидается объект'), threw);
  writeFileSync(hostsFile, JSON.stringify({ h1: { user: 'x' } }));
  threw = '';
  try { loadHosts(hostsFile); } catch (e) { threw = (e as Error).message; }
  check('hosts: сервер без поля host — ошибка', threw.includes('h1') && threw.includes('host'), threw);
  writeFileSync(hostsFile, 'это не json');
  threw = '';
  try { loadHosts(hostsFile); } catch (e) { threw = (e as Error).message; }
  check('hosts: кривой json — ошибка', threw.includes('не удалось прочитать'), threw);
  unlinkSync(hostsFile);
  check('hosts: файла нет — серверов нет (пусто)', loadHosts(hostsFile).size === 0);

  // --- loadSettings: лимиты и дефолты ---
  const sf = join(dir, 'settings.json');
  writeFileSync(sf, JSON.stringify({ width: 100 }));
  const s = loadSettings(sf, 0);
  check('settings: дефолты лимитов', s.margin === 2 && s.screen === true && s.runTimeoutMs === 180000 && s.maxOutputChars === 4000, JSON.stringify(s));
  check('settings: дефолт maxTurns — 3', s.maxTurns === 3, JSON.stringify(s));
  writeFileSync(sf, JSON.stringify({ width: 100, maxTurns: 0 }));
  check('settings: maxTurns 0 — без ограничения', loadSettings(sf, 0).maxTurns === 0);
  writeFileSync(sf, JSON.stringify({ width: 100, maxTurns: -1 }));
  let maxTurnsErr = '';
  try { loadSettings(sf, 0); } catch (e) { maxTurnsErr = (e as Error).message; }
  check('settings: maxTurns отрицательный — ошибка', maxTurnsErr.includes('maxTurns'), maxTurnsErr);
  writeFileSync(sf, JSON.stringify({ width: 100, workspace: 'ws' }));
  threw = '';
  try { loadSettings(sf, 0); } catch (e) { threw = (e as Error).message; }
  check('settings: поле workspace удалено — ошибка', threw.includes('workspace'), threw);
  writeFileSync(sf, JSON.stringify({ width: 100, runTimeoutMs: 5000 }));
  check('settings: свой таймаут читается', loadSettings(sf, 0).runTimeoutMs === 5000);
}

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
