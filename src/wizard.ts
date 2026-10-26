/**
 * Первый запуск: wizard и скаффолдинг слоёв.
 *
 * В доме (DT_HOME) обязательна хотя бы одна модель — карточка models/<id>.json.
 * Нет ни одной → мастер в обычном терминале (до TUI): тип адаптера, параметры,
 * ключ (ввод не отображается) — карточка сохраняется в models/<id>.json,
 * settings.model получает id, manager.json — ту же модель. Остальное добирается
 * само: settings.json с дефолтами, в проекте — .dreamteam с пустой командой
 * и пустым реестром серверов.
 *
 * Не молча: каждый созданный файл — заметка, которую печатает вызывающий.
 * Битый конфиг мастером не лечится: чтение конфигов позже уронит приложение
 * с внятной ошибкой, как и раньше (явное лучше неявного).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { applyLocale, knownLanguages, t, tf } from './i18n.js';
import { createShortcut } from './shortcut.js';
import { DT_HOME, DT_PROJECT, WORKSPACE } from './paths.js';

/** Куда мастер читает вопросы и пишет ответы (в пробах — потоки, не TTY). */
export interface WizardIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** true — настоящий терминал: ввод ключа глушится, как у sudo */
  isTTY: boolean;
}

/** --- вопросы --- */

function makeAsk(io: WizardIo) {
  const rl = createInterface({ input: io.input, output: io.output, terminal: io.isTTY });
  const anyRl = rl as unknown as { output?: NodeJS.WritableStream };

  /** Обычный вопрос: ответ виден. */
  const ask = async (prompt: string): Promise<string> => {
    const a = (await rl.question(prompt)).trim();
    if (!io.isTTY) io.output.write('\n'); // в трубе Enter не эхоится — переводим строку сами
    return a;
  };

  /** Вопрос с выбором из вариантов: пустой ввод — значение по умолчанию. */
  const askChoice = async (prompt: string, allowed: string[], fallback: string): Promise<string> => {
    for (;;) {
      const a = await ask(prompt);
      if (!a) return fallback;
      if (allowed.includes(a)) return a;
      io.output.write(pc.yellow(`  ${t('скажи один из:')} ${allowed.join(', ')}\n`));
    }
  };

  /**
   * Секрет: ввод не отображается (sudo-стиль). Глушим не только эхо набора:
   * readline перерисовывает строку по своей инициативе — в том числе уже после
   * того, как вопрос разрешился, — поэтому на время секрета карманом становится
   * весь вывод readline, а не отдельные его вызовы.
   */
  const askSecret = async (prompt: string): Promise<string> => {
    io.output.write(prompt);
    if (typeof anyRl.output !== 'object') return (await rl.question(prompt)).trim();
    const pocket = new PassThrough();
    pocket.resume(); // писать в карман некому — просто сливаем
    anyRl.output = pocket;
    try {
      const a = (await rl.question('')).trim();
      io.output.write('\n');
      return a;
    } finally {
      anyRl.output = io.output; // дальше readline снова рисует в настоящий вывод
    }
  };

  const close = (): void => rl.close();
  return { ask, askChoice, askSecret, close };
}

/** Дописывает «ИМЯ=значение» в .env, убрав прежнее значение того же имени. */
function writeEnvKey(file: string, name: string, value: string): void {
  let lines: string[] = [];
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith(`${name}=`));
  } catch {
    // файла нет — начнём с чистого
  }
  lines.push(`${name}=${value}`, '');
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}

/** Мастер: язык интерфейса → модель (адаптер + параметры) → models/<id>.json (+ настройки, + .env дома). */
export async function runWizard(io: WizardIo, homeDir: string = DT_HOME): Promise<string[]> {
  const modelsDir = join(homeDir, 'models');
  const envFile = join(homeDir, '.env');
  const settingsFile = join(homeDir, 'settings.json');
  const { ask, askChoice, askSecret, close } = makeAsk(io);
  const notes: string[] = [];
  try {
    io.output.write(pc.bold('\n  Первый запуск: настроим модель — без неё команде нечем говорить.\n\n'));
    // Язык интерфейса — первый вопрос, и сам он на трёх встроенных языках:
    // дальше мастер (и всё приложение) говорит на выбранном.
    io.output.write('  Язык интерфейса / Interface language / 界面语言:\n');
    for (const l of knownLanguages(homeDir)) {
      io.output.write(`  · ${l.id} — ${l.name}${l.builtIn ? '' : ` (${join(homeDir, 'lang', l.id + '.json')})`}\n`);
    }
    const lang = await askChoice('  Language [en]: ', knownLanguages(homeDir).map((l) => l.id), 'en');
    applyLocale(lang, homeDir);
    // выбранный язык — в settings.json (его ensureHome скаффолдил раньше мастера)
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
      settings.ui = lang;
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    } catch {
      // settings.json нет/не читается — loadSettings ниже разберётся громко
    }

    io.output.write(`\n  ${t('Тип адаптера:')}\n`);
    io.output.write(`  1 — ${t('OpenAI-совместимый API (Z.ai GLM, OpenAI, OpenRouter, DeepSeek, Ollama…)')}\n`);
    io.output.write(`  2 — ${t('Anthropic (Claude)')}\n`);
    io.output.write(`  3 — GigaChat\n`);
    io.output.write(`  4 — ${t('mock — без API, заготовленные ответы (посмотреть, как всё работает)')}\n`);
    const pick = await askChoice(`  ${t('Выбор [1]:')} `, ['1', '2', '3', '4'], '1');

    let id: string;
    let card: Record<string, unknown>;
    let key = '';
    if (pick === '1') {
      id = 'main';
      const baseUrl = await ask(`  ${t('baseUrl API [https://api.openai.com/v1]:')} `) || 'https://api.openai.com/v1';
      const model = await ask(`  ${t('Модель [gpt-4o-mini]:')} `) || 'gpt-4o-mini';
      key = await askSecret(`  ${t('Ключ API (ввод скрыт; Enter — пропустить, если API локальный):')} `);
      card = { adapter: 'openai-compatible', baseUrl, model };
      if (key) card.apiKey = key;
    } else if (pick === '2') {
      id = 'claude';
      const model = await ask(`  ${t('Модель [claude-sonnet-4-5]:')} `) || 'claude-sonnet-4-5';
      for (;;) {
        key = await askSecret(`  ${t('Ключ API (ввод скрыт):')} `);
        if (key) break;
        io.output.write(pc.yellow(`  ${t('без ключа Claude отвечать не сможет — возьми его в кабинете Anthropic')}\n`));
      }
      card = { adapter: 'anthropic', model, apiKey: key };
    } else if (pick === '3') {
      id = 'gigachat';
      for (;;) {
        key = await askSecret(`  ${t('Ключ из кабинета GigaChat (ввод скрыт):')} `);
        if (key) break;
        io.output.write(pc.yellow(`  ${t('без ключа GigaChat отвечать не сможет')}\n`));
      }
      card = { adapter: 'gigachat', apiKey: key };
    } else {
      id = 'mock';
      card = { adapter: 'mock' };
    }

    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, `${id}.json`), JSON.stringify(card, null, 2) + '\n');
    notes.push(tf('создал {file} (модель «{id}» по умолчанию)', { file: join(modelsDir, `${id}.json`), id }));
    if (key) {
      notes.push(tf('ключ сохранил в {file} (поле "apiKey")', { file: join(modelsDir, `${id}.json`) }));
    } else {
      notes.push(t('ключ не указан — модель будет работать в mock-режиме'));
    }
    // модель по умолчанию — в settings.json (его ensureHome скаффолдил раньше)
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
      settings.model = { id };
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    } catch {
      // settings.json нет/не читается — loadSettings ниже разберётся громко
    }
    // токен доступа к API (dreamteam serve): мастер генерирует сам, вручную
    // можно перегенерировать (README «Доступ извне»). Файл начинается
    // с примера, чтобы PORT/HOST были перед глазами.
    if (!existsSync(envFile)) {
      writeFileSync(envFile, readFileSync(join(SCAFFOLD_DIR, 'home', 'env.example'), 'utf8'), { mode: 0o600 });
      notes.push(tf('создал {file} из примера (env.example)', { file: envFile }));
    }
    writeEnvKey(envFile, 'TOKEN', randomBytes(32).toString('base64url'));
    notes.push(tf('создал токен доступа TOKEN в {file} (для dreamteam serve)', { file: envFile }));
    // Ярлык быстрого запуска: dreamteam serve --open — сервер + браузер одним
    // кликом с рабочего стола. Только живой терминал: в трубе вопросов нет.
    if (io.isTTY) {
      const want = await askChoice(`  ${t('Ярлык быстрого запуска (dreamteam serve + браузер) на рабочем столе? [Y/n]:')} `, ['y', 'n'], 'y');
      if (want === 'y') {
        try {
          notes.push(...(await createShortcut(homeDir)));
        } catch (err) {
          notes.push(tf('ярлык создать не удалось: {err}', { err: err instanceof Error ? err.message : String(err) }));
        }
      }
    }
    io.output.write(pc.green(`\n  ${t('Готово. Дальше — живой менеджер: спроси его «что ты умеешь?»')}\n`));
    return notes;
  } finally {
    close();
  }
}

/**
 * id первой модели из models/ дома (по алфавиту) — для скаффолдинга, когда
 * мастер не нужен. Битые карточки здесь не валидируем: loadModels чуть позже
 * уронит приложение с внятной ошибкой.
 */
export function defaultModelId(dir: string = join(DT_HOME, 'models')): string {
  try {
    const cards = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    return cards[0]?.replace(/\.json$/, '') ?? 'mock';
  } catch {
    return 'mock';
  }
}

/**
 * Предупреждение про git: в projects.json бывают пароли серверов. Есть смысл
 * показывать один раз — при создании .dreamteam (первый запуск в проекте).
 */
export function gitignoreNotice(projectDir: string = WORKSPACE): string | null {
  if (!existsSync(join(projectDir, '.git'))) return null;
  const gi = join(projectDir, '.gitignore');
  let lines: string[] = [];
  try {
    lines = readFileSync(gi, 'utf8').split(/\r?\n/);
  } catch {
    return t('в проекте git, но нет .gitignore — добавь строку «.dreamteam/»: в hosts.json бывают пароли серверов');
  }
  const ignored = lines.some((l) => {
    const tr = l.trim().replace(/\/+$/, '');
    return tr && !tr.startsWith('#') && (tr === '.dreamteam' || tr === '/.dreamteam' || tr === '**/.dreamteam');
  });
  return ignored
    ? null
    : t('в .dreamteam бывают пароли серверов (hosts.json), а git её не игнорирует — добавь в .gitignore строку «.dreamteam/»');
}

/** Каталог скелетов конфигов рядом с src/ — как gui/, едет с пакетом. */
export const SCAFFOLD_DIR = fileURLToPath(new URL('../scaffold/', import.meta.url));

/** Шаблон из scaffold/ как объект: файл обязан существовать и быть валидным JSON. */
function readScaffold(rel: string): Record<string, unknown> {
  const file = join(SCAFFOLD_DIR, rel);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`скелет ${rel} повреждён (${err instanceof Error ? err.message : err}) — это файл пакета, лечится переустановкой`);
  }
}

/** Дом: модели (wizard, если нет ни одной), настройки и КОМАНДА (агенты, менеджер, тула). */
export async function ensureHome(io: WizardIo, homeDir: string = DT_HOME): Promise<string[]> {
  const modelsDir = join(homeDir, 'models');
  const settingsFile = join(homeDir, 'settings.json');
  const notes: string[] = [];
  if (!existsSync(settingsFile)) {
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(readScaffold(join('home', 'settings.json')), null, 2) + '\n');
    notes.push(tf('создал {file} (язык и экран по умолчанию)', { file: settingsFile }));
  }
  // команда — вещь машины: скаффолдим один раз, дальше живёт между проектами
  const agentsFile = join(homeDir, 'agents.json');
  if (!existsSync(agentsFile)) {
    mkdirSync(homeDir, { recursive: true });
    const roster = readScaffold(join('home', 'agents.json'));
    writeFileSync(agentsFile, JSON.stringify(roster, null, 2) + '\n');
    const names = Array.isArray(roster)
      ? roster.map((a) => (typeof a === 'object' && a !== null && 'name' in a ? String((a as { name: unknown }).name) : '')).filter(Boolean)
      : [];
    notes.push(names.length > 0
      ? tf('создал {file} (стартовая команда: {names})', { file: agentsFile, names: names.join(', ') })
      : tf('создал {file} (пустая команда — менеджер позовёт и настроит)', { file: agentsFile }));
  }
  const toolsDir = join(homeDir, 'tools');
  if (!existsSync(toolsDir)) {
    mkdirSync(toolsDir, { recursive: true });
    notes.push(tf('создал {file} (полка для своих тулов)', { file: toolsDir }));
  }
  // полка кастомных адаптеров провайдеров: providers/<id>.ts — как tools/, только адаптеры
  const providersDir = join(homeDir, 'providers');
  if (!existsSync(providersDir)) {
    mkdirSync(providersDir, { recursive: true });
    notes.push(tf('создал {file} (полка своих адаптеров: <id>.ts — export default фабрика (id, config) => LLMProvider)', { file: providersDir }));
  }
  // полка своих языков: lang/<id>.json — как tools/, только переводы
  const langDir = join(homeDir, 'lang');
  if (!existsSync(langDir)) {
    mkdirSync(langDir, { recursive: true });
    notes.push(tf('создал {file} (полка своих языков: <id>.json — { "name": "…", "translations": { … } })', { file: langDir }));
  }
  // полка моделей: scaffold-карточки копируются как примеры; без ключей — «не настроены»
  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true });
    try {
      for (const f of readdirSync(join(SCAFFOLD_DIR, 'home', 'models')).filter((x) => x.endsWith('.json'))) {
        writeFileSync(join(modelsDir, f), readFileSync(join(SCAFFOLD_DIR, 'home', 'models', f)));
      }
      notes.push(tf('создал {file} (карточки моделей — примеры; впишите apiKey или удалите лишние)', { file: modelsDir }));
    } catch { /* scaffold models/ отсутствует — не беда */ }
  }
  // wizard нужен пока settings.model.id не задан (первый запуск или сброс)
  const needsWizard = (() => {
    try {
      const s = JSON.parse(readFileSync(settingsFile, 'utf8')) as { model?: { id?: string } };
      return !s.model?.id;
    } catch {
      return true;
    }
  })();
  if (needsWizard) {
    if (!io.isTTY) {
      throw new Error(
        tf('нет ни одной модели в {dir} — первый запуск проходит мастер: запусти приложение в терминале', { dir: modelsDir }),
      );
    }
    notes.push(...(await runWizard(io, homeDir)));
  }
  // менеджер — после wizard: его модель = основная, выбранная только что
  const managerFile = join(homeDir, 'manager.json');
  if (!existsSync(managerFile)) {
    mkdirSync(homeDir, { recursive: true });
    const manager = readScaffold(join('home', 'manager.json'));
    const modelId = defaultModelOf(homeDir);
    manager.model = { id: modelId };
    delete manager.provider;
    writeFileSync(managerFile, JSON.stringify(manager, null, 2) + '\n');
    notes.push(tf('создал {file} (менеджер переговорки на модели «{id}»)', { file: managerFile, id: modelId }));
  }
  return notes;
}

/** id модели по умолчанию из settings.model.id (мастер записал) или первая по алфавиту. */
function defaultModelOf(homeDir: string): string {
  try {
    const s = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8')) as { model?: { id?: string } };
    if (typeof s.model?.id === 'string' && s.model.id) return s.model.id;
  } catch { /* читаем ниже */ }
  return defaultModelId(join(homeDir, 'models'));
}

/** Проект: нет .dreamteam — создать реестры (серверы, ящики, боты) и предупредить про git. */
export function ensureProject(defaultProvider: string, projectDir: string = DT_PROJECT): string[] {
  void defaultProvider;
  if (existsSync(projectDir)) return [];
  mkdirSync(projectDir, { recursive: true });
  for (const f of ['hosts.json', 'mails.json', 'messengers.json']) {
    writeFileSync(join(projectDir, f), JSON.stringify(readScaffold(join('project', f)), null, 2) + '\n');
  }
  const notes = [
    tf('создал {dir} (реестры проекта: hosts.json — ssh-серверы, mails.json — почтовые ящики, messengers.json — боты; заполняются руками или через менеджера)', { dir: projectDir }),
  ];
  const gi = gitignoreNotice(dirname(projectDir));
  if (gi) notes.push(gi);
  return notes;
}

export function defaultIo(): WizardIo {
  return {
    input: process.stdin,
    output: process.stdout,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

/** Всё сразу: дом + проект; заметки печатает вызывающий. */
export async function ensureLayers(
  io: WizardIo = defaultIo(),
  homeDir: string = DT_HOME,
  projectDir: string = DT_PROJECT,
): Promise<string[]> {
  const notes = await ensureHome(io, homeDir);
  notes.push(...ensureProject(defaultModelId(join(homeDir, 'models')), projectDir));
  return notes;
}
