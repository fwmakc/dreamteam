/**
 * Проверка первого запуска (без TUI и LLM):
 *  - runWizard: выбор провайдера, параметры, ключ (не эхоится в вывод),
 *    запись providers.json (ключ прямо в карточке, поле "apiKey");
 *  - ensureLayers: пустой дом + пустой проект → wizard, настройки с дефолтами,
 *    .dreamteam (стартовая команда из скаффолда, менеджер на дефолтном
 *    провайдере, пустые серверы, tools/); существующие слои не трогаются;
 *  - не-TTY без providers.json — внятный отказ, а не тихий mock;
 *  - gitignoreNotice: git без .gitignore / без строки / уже скрыто / без git.
 *
 * Все функции принимают явные пути (дом/проект) — каждый сценарий в своём
 * временном каталоге. Импорт src — после выставления DT_HOME/DT_PROJECT,
 * чтобы случайное обращение к дефолтам тоже попало в песочницу.
 * Запуск: npm run probe (входит в общий прогон).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  }
}

/** Карман-ввод: ответы отдаются построчно, вывод копится для проверок. */
function makeIo(lines: string[], isTTY = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d: Buffer) => (out += d.toString('utf8')));
  if (!isTTY) {
    // труба: readline читает строки по мере готовности — можно всё сразу
    input.end(lines.map((l) => `${l}\n`).join(''));
  } else {
    // терминальный readline съедает весь чанк разом: лишние строки пропадут,
    // а close придёт раньше следующего вопроса — кормим по одной с паузой
    let i = 0;
    const t = setInterval(() => {
      if (i < lines.length) input.write(`${lines[i++]}\n`);
      else clearInterval(t);
    }, 25);
  }
  return { io: { input, output, isTTY }, out: () => out };
}

const root = mkdtempSync(join(tmpdir(), 'dt-wizard-'));
process.env.DT_HOME = join(root, 'home');
process.env.DT_PROJECT = join(root, 'proj', '.dreamteam');
const {
  runWizard,
  ensureLayers,
  ensureProject,
  defaultProviderId,
  gitignoreNotice,
} = await import('../src/wizard.js');

// --- ensureLayers на пустых слоях: wizard (mock) + настройки + скаффолдинг проекта ---
{
  const home = join(root, 'h1');
  const proj = join(root, 'p1', '.dreamteam');
  const { io, out } = makeIo(['ru', '4', 'n'], true);
  const notes = await ensureLayers(io, home, proj);
  const providers = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8'));
  check('wizard mock: default=mock, адаптер mock', providers.default === 'mock' && providers.providers.mock.adapter === 'mock', JSON.stringify(providers));
  check('wizard: заметка о providers.json', notes.some((n) => n.includes('providers.json')), notes.join(' | '));
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  check('настройки: созданы с дефолтами', settings.width === 100 && settings.screen === true, JSON.stringify(settings));
  check('настройки: язык по умолчанию из скелета', settings.language === 'русский', JSON.stringify(settings));
  check('настройки: язык интерфейса из ответа мастера', settings.ui === 'ru', JSON.stringify(settings));
  check('команда: стартовая пятёрка в доме', (() => {
    const team = JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8')) as { id: string }[];
    return ['analyst', 'secretary', 'developer', 'designer', 'writer'].every((id) => team.some((a) => a.id === id));
  })());
  check('команда: менеджер в доме на дефолтном провайдере', JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')).provider === 'mock');
  check('команда: полка тулов в доме', existsSync(join(home, 'tools')));
  check('проект: hosts.json — пустой реестр серверов', (() => {
    const p = JSON.parse(readFileSync(join(proj, 'hosts.json'), 'utf8')) as Record<string, unknown>;
    return typeof p === 'object' && p !== null && Object.keys(p).length === 0;
  })());
  check('проект: mails.json — пустой реестр ящиков', (() => {
    const p = JSON.parse(readFileSync(join(proj, 'mails.json'), 'utf8')) as Record<string, unknown>;
    return typeof p === 'object' && p !== null && Object.keys(p).length === 0;
  })());
  check('проект: messengers.json — пустой реестр ботов', (() => {
    const p = JSON.parse(readFileSync(join(proj, 'messengers.json'), 'utf8')) as Record<string, unknown>;
    return typeof p === 'object' && p !== null && Object.keys(p).length === 0;
  })());

  // --- .env создаётся из примера: только настройки serve, права 600 ---
  const envFile = join(home, '.env');
  const envMode = (await import('node:fs')).statSync(envFile).mode & 0o777;
  check('env: создан из примера', existsSync(envFile));
  const envText0 = readFileSync(envFile, 'utf8');
  check('env: только настройки serve — ключей моделей в примере нет', !/OPENAI_API_KEY=|ANTHROPIC_API_KEY=|GIGA_API_KEY=|DREAMTEAM_API_KEY=|apiKey/m.test(envText0) && envText0.includes('# TOKEN='), envText0);
  check('env: порт и адрес примера на месте', envText0.includes('# PORT=8080') && envText0.includes('# HOST=127.0.0.1'));
  check('env: права только у владельца (POSIX)', process.platform === 'win32' || envMode === 0o600, envMode.toString(8));
  check('env: мастер создал токен доступа TOKEN', /^TOKEN=.+/m.test(envText0));

  // --- скелеты конфигов: настоящие JSON-файлы в пакете, валидны по загрузчикам ---
  {
    const { SCAFFOLD_DIR } = await import('../src/wizard.js');
    const { loadSettings } = await import('../src/settings.js');
    const { loadTeam } = await import('../src/agents.js');
    const { loadHosts } = await import('../src/actions.js');
    check('скелет: home/settings.json валиден по loadSettings', (() => {
      try { return loadSettings(join(SCAFFOLD_DIR, 'home', 'settings.json'), 0).language === 'русский'; } catch { return false; }
    })());
    check('скелет: интерфейс по умолчанию английский (ui:"en")', (() => {
      try { return JSON.parse(readFileSync(join(SCAFFOLD_DIR, 'home', 'settings.json'), 'utf8')).ui === 'en'; } catch { return false; }
    })());
    check('скелет: home/agents.json валиден по loadTeam, стартовая пятёрка', (() => {
      try {
        const team = loadTeam(join(SCAFFOLD_DIR, 'home', 'agents.json'));
        return ['analyst', 'secretary', 'developer', 'designer', 'writer'].every((id) => team.some((a) => a.id === id));
      } catch { return false; }
    })());
    check('скелет: project/hosts.json валиден по loadHosts', (() => {
      try { return loadHosts(join(SCAFFOLD_DIR, 'project', 'hosts.json')).size === 0; } catch { return false; }
    })());
    check('скелет: project/mails.json и messengers.json — пустые словари', (() => {
      try {
        const mails = JSON.parse(readFileSync(join(SCAFFOLD_DIR, 'project', 'mails.json'), 'utf8')) as Record<string, unknown>;
        const mess = JSON.parse(readFileSync(join(SCAFFOLD_DIR, 'project', 'messengers.json'), 'utf8')) as Record<string, unknown>;
        return Object.keys(mails).length === 0 && Object.keys(mess).length === 0;
      } catch { return false; }
    })());
    const mgrTpl = JSON.parse(readFileSync(join(SCAFFOLD_DIR, 'home', 'manager.json'), 'utf8'));
    check('скелет: home/manager.json — заглушка провайдера', typeof mgrTpl.provider === 'string' && mgrTpl.provider.length > 0, JSON.stringify(mgrTpl));
  }
  check('wizard: в выводе меню и приветствие', out().includes('Тип провайдера') && out().includes('живой менеджер'), out().slice(-200));
  check('gitignore: без git — тишина', !notes.some((n) => n.includes('.gitignore')), notes.join(' | '));

  // --- повторный ensureLayers: всё на месте — тишина, файлы не переписываются ---
  const before = readFileSync(join(home, 'settings.json'), 'utf8');
  const notes2 = await ensureLayers(makeIo([]).io, home, proj);
  check('повтор: без заметок', notes2.length === 0, notes2.join(' | '));
  check('повтор: настройки не тронуты', readFileSync(join(home, 'settings.json'), 'utf8') === before);
}

// --- openai-compatible: baseUrl/модель/ключ; ключ не эхоится и лежит в карточке ---
{
  const home = join(root, 'h2');
  const proj = join(root, 'p2', '.dreamteam');
  const { io, out } = makeIo(['ru', '1', 'https://api.test/v1', 'test-model', 'секрет-ключ-42', 'n'], true);
  const notes = await ensureLayers(io, home, proj);
  const providersFile = readFileSync(join(home, 'providers.json'), 'utf8');
  const providers = JSON.parse(providersFile);
  const main = providers.providers.main;
  check('openai-совместимый: id main, дефолт', providers.default === 'main' && main.adapter === 'openai-compatible', JSON.stringify(providers));
  check('openai-совместимый: baseUrl и модель', main.baseUrl === 'https://api.test/v1' && main.model === 'test-model', JSON.stringify(main));
  check('openai-совместимый: ключ прямо в карточке', main.apiKey === 'секрет-ключ-42' && !('apiKeyEnv' in main), JSON.stringify(main));
  check('ключ не эхоится в выводе мастера', !out().includes('секрет-ключ-42'), out());
  check('мастер: заметка, куда лёг ключ', notes.some((n) => n.includes('"apiKey"')), notes.join(' | '));
  const envText = readFileSync(join(home, '.env'), 'utf8');
  check('ключ в .env не дублируется', !envText.includes('секрет-ключ-42'), envText);
  check('менеджер в доме: на main', JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')).provider === 'main');
  check('проект: .env не создаётся', !existsSync(join(proj, '.env')));
}

// --- обязательный ключ: пустой ввод переспрашивается (anthropic/gigachat) ---
{
  const home = join(root, 'h3');
  const { io, out } = makeIo(['ru', '3', '', 'giga-ключ', 'n'], true);
  await runWizard(io, home);
  const providers = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8'));
  check('gigachat: apiKey + повтор вопроса при пустом вводе', providers.providers.gigachat.apiKey === 'giga-ключ' && out().includes('без ключа GigaChat'), JSON.stringify(providers));

  const home4 = join(root, 'h4');
  const { io: io4, out: out4 } = makeIo(['ru', '2', '', '', '', 'claude-ключ', 'n'], true);
  await runWizard(io4, home4);
  const p4 = JSON.parse(readFileSync(join(home4, 'providers.json'), 'utf8'));
  check('anthropic: два отказа ключа — два повтора', p4.providers.claude.model === 'claude-sonnet-4-5' && p4.providers.claude.apiKey === 'claude-ключ' && (out4().match(/без ключа Claude/g) ?? []).length === 2, out4());
}

// --- не-TTY без providers.json — честный отказ, а не тихий mock ---
{
  const home = join(root, 'h5');
  let threw = '';
  try {
    await ensureLayers({ input: new PassThrough(), output: new PassThrough(), isTTY: false }, home, join(root, 'p5', '.dreamteam'));
  } catch (e) {
    threw = (e as Error).message;
  }
  check('не-TTY: отказ с подсказкой про терминал', threw.includes('мастер') && threw.includes('терминал'), threw);
  check('не-TTY: providers.json не создан', !existsSync(join(home, 'providers.json')));
}

// --- битый providers.json: мастер не лечит, но скаффолдинг проекта идёт с fallback'ом ---
{
  const home = join(root, 'h6');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'providers.json'), '{ битый');
  check('битый файл: defaultProviderId → mock', defaultProviderId(join(home, 'providers.json')) === 'mock');
  const proj = join(root, 'p6', '.dreamteam');
  const notes = ensureProject('mock', proj);
  check('битый файл: проект всё равно скаффолдится', notes.some((n) => n.includes('hosts.json')), notes.join(' | '));
}

// --- gitignoreNotice: состояния ---
{
  const p = join(root, 'gitproj');
  mkdirSync(join(p, '.git'), { recursive: true });
  check('gitignore: git есть, .gitignore нет — предупреждение', (gitignoreNotice(p) ?? '').includes('.dreamteam/'));
  writeFileSync(join(p, '.gitignore'), 'node_modules/\n# .dreamteam не трогаем — коммент\n');
  check('gitignore: без нужной строки (комментарий не считается)', (gitignoreNotice(p) ?? '').includes('.dreamteam/'));
  writeFileSync(join(p, '.gitignore'), 'node_modules/\n.dreamteam/\n');
  check('gitignore: строка есть — тишина', gitignoreNotice(p) === null);
  writeFileSync(join(p, '.gitignore'), '/.dreamteam\n');
  check('gitignore: форма со слэшем тоже считается', gitignoreNotice(p) === null);
  const nogit = join(root, 'nogit');
  mkdirSync(nogit, { recursive: true });
  check('gitignore: без git — null', gitignoreNotice(nogit) === null);
}

// --- ensureProject на существующем проекте: ничего не делает ---
{
  const proj = join(root, 'p1', '.dreamteam');
  check('существующий проект: не трогается', ensureProject('mock', proj).length === 0);
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
