/**
 * Проверка первого запуска (без TUI и LLM):
 *  - runWizard: выбор провайдера, параметры, ключ (не эхоится в вывод),
 *    запись models/<id>.json (ключ прямо в карточке, поле "apiKey");
 *  - ensureLayers: пустой дом → wizard, настройки с дефолтами, стартовая
 *    команда, менеджер, tools/, .env из примера; существующие слои не
 *    трогаются; проект wizard не выбирает и ничего кроме дома не создаёт
 *    (проекты заводит человек: /project new);
 *  - не-TTY без models/<id>.json — внятный отказ, а не тихий mock.
 *
 * Все функции принимают явные пути (дом) — каждый сценарий в своём
 * временном каталоге. Импорт src — после выставления DT_HOME,
 * чтобы случайное обращение к дефолтам тоже попало в песочницу.
 * Запуск: npm run probe (входит в общий прогон).
 */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
const {
  runWizard,
  ensureLayers,
  defaultModelId,
} = await import('../src/wizard.js');

// --- ensureLayers на пустом доме: wizard (mock) + настройки + скаффолдинг дома ---
{
  const home = join(root, 'h1');
  const { io, out } = makeIo(['ru', '4', 'n'], true);
  const notes = await ensureLayers(io, home);
  const mockCard = JSON.parse(readFileSync(join(home, 'models', 'mock.json'), 'utf8'));
  check('wizard mock: карточка mock, адаптер mock', mockCard.provider === 'mock', JSON.stringify(mockCard));
  check('wizard: заметка о карточке модели', notes.some((n) => n.includes('mock.json')), notes.join(' | '));
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  check('настройки: созданы с дефолтами', settings.width === 100 && settings.screen === true, JSON.stringify(settings));
  check('настройки: язык по умолчанию из скелета', settings.language === 'русский', JSON.stringify(settings));
  check('настройки: язык интерфейса из ответа мастера', settings.ui === 'ru', JSON.stringify(settings));
  check('настройки: модель по умолчанию из мастера', settings.model?.id === 'mock', JSON.stringify(settings));
  check('команда: стартовая пятёрка в доме', (() => {
    const teamDir = join(home, 'agents');
    const cards = readdirSync(teamDir).filter((f) => f.endsWith('.json'));
    return ['analyst', 'secretary', 'developer', 'designer', 'writer'].every((id) => cards.includes(`${id}.json`));
  })());
  check('команда: менеджер в доме на модели mock', JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')).model?.id === 'mock');
  check('команда: полка тулов в доме', existsSync(join(home, 'tools')));
  check('дом: отдельных hosts/mails/messengers больше нет — секреты в project.json',
    !existsSync(join(home, 'hosts.json')) && !existsSync(join(home, 'mails.json')) && !existsSync(join(home, 'messengers.json')));
  check('дом: wizard не заводит проекты — их создаёт человек', !existsSync(join(home, 'projects')));

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
    check('скелет: home/settings.json валиден по loadSettings', (() => {
      try { return loadSettings(join(SCAFFOLD_DIR, 'home', 'settings.json'), 0).language === 'русский'; } catch { return false; }
    })());
    check('скелет: интерфейс по умолчанию английский (ui:"en")', (() => {
      try { return JSON.parse(readFileSync(join(SCAFFOLD_DIR, 'home', 'settings.json'), 'utf8')).ui === 'en'; } catch { return false; }
    })());
    check('скелет: home/agents/ валиден по loadTeam, стартовая пятёрка', (() => {
      try {
        const team = loadTeam(join(SCAFFOLD_DIR, 'home', 'agents'));
        return ['analyst', 'secretary', 'developer', 'designer', 'writer'].every((id) => team.some((a) => a.id === id));
      } catch { return false; }
    })());
    check('скелет: project/ в скаффолде больше нет — один уровень владения', !existsSync(join(SCAFFOLD_DIR, 'project')));
    const mgrTpl = JSON.parse(readFileSync(join(SCAFFOLD_DIR, 'home', 'manager.json'), 'utf8'));
    check('скелет: home/manager.json — менеджер без id модели (проставит мастер)', typeof mgrTpl.model === 'object' && !mgrTpl.model?.id && typeof mgrTpl.name === 'string', JSON.stringify(mgrTpl));
    check('скелет: models/ — карточки моделей', (() => {
      const dir = join(SCAFFOLD_DIR, 'home', 'models');
      const cards = readdirSync(dir).filter((f) => f.endsWith('.json'));
      return cards.includes('openai.json') && cards.includes('mock.json') && cards.includes('claude.json');
    })());
  }
  check('wizard: в выводе меню и приветствие', out().includes('Тип провайдера') && out().includes('живой менеджер'), out().slice(-200));

  // --- повторный ensureLayers: всё на месте — тишина, файлы не переписываются ---
  const before = readFileSync(join(home, 'settings.json'), 'utf8');
  const notes2 = await ensureLayers(makeIo([]).io, home);
  check('повтор: без заметок', notes2.length === 0, notes2.join(' | '));
  check('повтор: настройки не тронуты', readFileSync(join(home, 'settings.json'), 'utf8') === before);
}

// --- openai-compatible: baseUrl/модель/ключ; ключ не эхоится и лежит в карточке ---
{
  const home = join(root, 'h2');
  const { io, out } = makeIo(['ru', '1', 'https://api.test/v1', 'test-model', 'секрет-ключ-42', 'n'], true);
  const notes = await ensureLayers(io, home);
  const main = JSON.parse(readFileSync(join(home, 'models', 'main.json'), 'utf8'));
  check('openai-совместимый: карточка main', main.provider === 'openai-compatible', JSON.stringify(main));
  check('openai-совместимый: baseUrl и модель', main.baseUrl === 'https://api.test/v1' && main.model === 'test-model', JSON.stringify(main));
  check('openai-совместимый: ключ прямо в карточке', main.apiKey === 'секрет-ключ-42' && !('apiKeyEnv' in main), JSON.stringify(main));
  check('ключ не эхоится в выводе мастера', !out().includes('секрет-ключ-42'), out());
  check('мастер: заметка, куда лёг ключ', notes.some((n) => n.includes('"apiKey"')), notes.join(' | '));
  const envText = readFileSync(join(home, '.env'), 'utf8');
  check('ключ в .env не дублируется', !envText.includes('секрет-ключ-42'), envText);
  check('менеджер в доме: на main', JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')).model?.id === 'main');
}

// --- обязательный ключ: пустой ввод переспрашивается (anthropic/gigachat) ---
{
  const home = join(root, 'h3');
  const { io, out } = makeIo(['ru', '3', '', 'giga-ключ', 'n'], true);
  await runWizard(io, home);
  const giga = JSON.parse(readFileSync(join(home, 'models', 'gigachat.json'), 'utf8'));
  check('gigachat: apiKey + повтор вопроса при пустом вводе', giga.apiKey === 'giga-ключ' && out().includes('без ключа GigaChat'), JSON.stringify(giga));

  const home4 = join(root, 'h4');
  const { io: io4, out: out4 } = makeIo(['ru', '2', '', '', '', 'claude-ключ', 'n'], true);
  await runWizard(io4, home4);
  const claude = JSON.parse(readFileSync(join(home4, 'models', 'claude.json'), 'utf8'));
  check('anthropic: два отказа ключа — два повтора', claude.model === 'claude-sonnet-4-5' && claude.apiKey === 'claude-ключ' && (out4().match(/без ключа Claude/g) ?? []).length === 2, out4());
}

// --- не-TTY без моделей — честный отказ, а не тихий mock ---
{
  const home = join(root, 'h5');
  let threw = '';
  try {
    await ensureLayers({ input: new PassThrough(), output: new PassThrough(), isTTY: false }, home);
  } catch (e) {
    threw = (e as Error).message;
  }
  check('не-TTY: отказ с подсказкой про терминал', threw.includes('мастер') && threw.includes('терминал'), threw);
  check('не-TTY: settings.model.id не задан', (() => { try { const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')); return !s.model?.id; } catch { return true; } })());
}

// --- пустой models/: реестр моделей отдаёт fallback ---
{
  const home = join(root, 'h6');
  mkdirSync(join(home, 'models'), { recursive: true });
  check('пустой models/: defaultModelId → mock', defaultModelId(join(home, 'models')) === 'mock');
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
