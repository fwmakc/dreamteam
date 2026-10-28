/**
 * Первый запуск: wizard и скаффолдинг дома.
 *
 * В доме (DT_HOME) обязательна хотя бы одна модель — карточка models/<id>.json.
 * Нет ни одной → мастер в обычном терминале (до TUI): тип адаптера, параметры,
 * ключ (ввод не отображается) — карточка сохраняется в models/<id>.json,
 * settings.model получает id, manager.json — ту же модель. Остальное добирается
 * само: settings.json с дефолтами, полки команды (агенты, тулы, адаптеры, языки).
 *
 * Не молча: каждый созданный файл — заметка, которую печатает вызывающий.
 * Битый конфиг мастером не лечится: чтение конфигов позже уронит приложение
 * с внятной ошибкой, как и раньше (явное лучше неявного).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { PassThrough, Readable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { applyLocale, knownLanguages, t, tf } from './i18n.js';
import { createShortcut } from './shortcut.js';
import { DT_HOME } from './paths.js';

/** Куда мастер читает вопросы и пишет ответы (в пробах — потоки, не TTY). */
export interface WizardIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** true — настоящий терминал: ввод ключа глушится, как у sudo */
  isTTY: boolean;
}

/** --- вопросы --- */

function makeAsk(io: WizardIo) {
  let rl = createInterface({ input: io.input, output: io.output, terminal: io.isTTY });
  let anyRl = rl as unknown as { output?: NodeJS.WritableStream };

  /** Свежая строка ввода: прежняя закрыта — её клавиатура была у пикера. */
  const reopen = (): void => {
    rl = createInterface({ input: io.input, output: io.output, terminal: io.isTTY });
    anyRl = rl as unknown as { output?: NodeJS.WritableStream };
  };

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
   * Выбор из списка. В живом терминале — стрелки: ↑/↓ — шаг, PgUp/PgDn —
   * страница, Home/End — края, Enter — подтвердить. В трубе (пробы, пайпы) —
   * номер или текст пункта строкой, пустой ввод — пункт по умолчанию.
   */
  const pick = async (title: string, items: string[], def = 0): Promise<number> => {
    io.output.write(`\n  ${title}\n`);
    const realTty = io.isTTY && (io.input as { isTTY?: unknown }).isTTY === true;
    if (realTty && items.length > 1) {
      rl.close(); // на время списка клавиатура принадлежит только пикеру
      io.output.write(pc.dim(`  ${t('выбор: стрелки ↑/↓, PgUp/PgDn, Home/End, Enter')}\n`));
      const sel = await new Promise<number>((resolve) => {
        let cur = Math.min(Math.max(def, 0), items.length - 1);
        let drawn = 0;
        const draw = (): void => {
          if (drawn > 0) io.output.write(`\x1b[${drawn}A\x1b[J`); // вверх и стереть прежний список
          io.output.write(
            items.map((it, i) => `  ${i === cur ? pc.inverse(` ${i + 1}. ${it} `) : `  ${i + 1}. ${it}`}`).join('\n') + '\n',
          );
          drawn = items.length;
        };
        draw();
        const stream = io.input as Readable & { setRawMode?: (m: boolean) => void; isRaw?: boolean };
        const wasRaw = stream.isRaw === true;
        stream.setRawMode?.(true);
        const onKey = (_s: string, key?: { name?: string; ctrl?: boolean }): void => {
          const k = key?.name ?? '';
          if (key?.ctrl && k === 'c') {
            cleanup();
            process.exit(130); // в сыром режиме Ctrl+C не приходит SIGINT'ом — выходим сами
          }
          if (k === 'up') cur = Math.max(0, cur - 1);
          else if (k === 'down') cur = Math.min(items.length - 1, cur + 1);
          else if (k === 'pageup') cur = Math.max(0, cur - 6);
          else if (k === 'pagedown') cur = Math.min(items.length - 1, cur + 6);
          else if (k === 'home') cur = 0;
          else if (k === 'end') cur = items.length - 1;
          else if (k === 'return' || k === 'enter') {
            cleanup();
            resolve(cur);
            return;
          } else return;
          draw();
        };
        const cleanup = (): void => {
          io.input.removeListener('keypress', onKey);
          stream.setRawMode?.(wasRaw);
        };
        io.input.on('keypress', onKey);
      });
      reopen();
      return sel;
    }
    for (;;) {
      const a = await ask(`  ${t('Выбор [1]:')} `);
      if (!a) return Math.min(Math.max(def, 0), items.length - 1);
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
      const byText = items.findIndex((it) => it === a || it.split(' — ')[0] === a);
      if (byText >= 0) return byText;
      io.output.write(pc.yellow(`  ${t('скажи один из:')} ${items.map((_, i) => i + 1).join(', ')}\n`));
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
  return { ask, askChoice, askSecret, pick, close };
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

/** Строка списка моделей: «id — provider · model · baseUrl» из карточки. */
function cardLine(file: string): string {
  const id = file.replace(/.*[/\\]/, '').replace(/\.json$/, '');
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as { provider?: string; model?: string; baseUrl?: string };
    const rest = [c.provider, c.model, c.baseUrl].filter(Boolean).join(' · ');
    return rest ? `${id} — ${rest}` : id;
  } catch {
    return `${id} — ${t('карточка не читается')}`;
  }
}

/** Мастер: язык интерфейса → модель (адаптер + параметры) → models/<id>.json (+ настройки, + .env дома). */
export async function runWizard(io: WizardIo, homeDir: string = DT_HOME): Promise<string[]> {
  const modelsDir = join(homeDir, 'models');
  const envFile = join(homeDir, '.env');
  const settingsFile = join(homeDir, 'settings.json');
  const { ask, askChoice, askSecret, pick, close } = makeAsk(io);
  const notes: string[] = [];
  try {
    io.output.write(pc.bold('\n  Первый запуск: настроим модель — без неё команде нечем говорить.\n\n'));
    // Язык интерфейса — первый вопрос, и сам он на трёх встроенных языках:
    // дальше мастер (и всё приложение) говорит на выбранном.
    const langs = knownLanguages(homeDir);
    const langIdx = await pick(
      'Язык интерфейса / Interface language / 界面语言:',
      langs.map((l) => `${l.id} — ${l.name}${l.builtIn ? '' : ` (${t('свой')})`}`),
      Math.max(0, langs.findIndex((l) => l.id === 'en')),
    );
    const lang = langs[langIdx].id;
    applyLocale(lang, homeDir);
    // выбранный язык — в settings.json (его ensureHome скаффолдил раньше мастера)
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
      settings.ui = lang;
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    } catch {
      // settings.json нет/не читается — loadSettings ниже разберётся громко
    }

    // ── модель: сперва существующие карточки дома, отдельным пунктом — новая ──
    mkdirSync(modelsDir, { recursive: true });
    const cards = readdirSync(modelsDir).filter((f) => f.endsWith('.json')).sort();
    const mpick = await pick(
      t('Модель для команды:'),
      [...cards.map((f) => cardLine(join(modelsDir, f))), t('создать новую модель')],
      cards.length, // по умолчанию — создать новую (как велел прежний мастер)
    );

    let id: string;
    let card: Record<string, unknown>;
    let key = '';
    if (mpick < cards.length) {
      // существующая карточка — ничего не пишем, только выбираем её основной
      id = cards[mpick].replace(/\.json$/, '');
      notes.push(tf('взял существующую модель «{id}» (карточка {file})', { id, file: join(modelsDir, cards[mpick]) }));
    } else {
      const ppick = await pick(t('Тип провайдера:'), [
        t('OpenAI-совместимый API (Z.ai GLM, OpenAI, OpenRouter, DeepSeek, Ollama…)'),
        t('Anthropic (Claude)'),
        'GigaChat',
        t('mock — без API, заготовленные ответы (посмотреть, как всё работает)'),
      ]);
      if (ppick === 0) {
        id = 'main';
        const baseUrl = (await ask(`  ${t('baseUrl API [https://api.openai.com/v1]:')} `)) || 'https://api.openai.com/v1';
        const model = (await ask(`  ${t('Модель [gpt-4o-mini]:')} `)) || 'gpt-4o-mini';
        key = await askSecret(`  ${t('Ключ API (ввод скрыт; Enter — пропустить, если API локальный):')} `);
        card = { provider: 'openai-compatible', baseUrl, model };
        if (key) card.apiKey = key;
      } else if (ppick === 1) {
        id = 'claude';
        const model = (await ask(`  ${t('Модель [claude-sonnet-4-5]:')} `)) || 'claude-sonnet-4-5';
        for (;;) {
          key = await askSecret(`  ${t('Ключ API (ввод скрыт):')} `);
          if (key) break;
          io.output.write(pc.yellow(`  ${t('без ключа Claude отвечать не сможет — возьми его в кабинете Anthropic')}\n`));
        }
        card = { provider: 'anthropic-compatible', model, apiKey: key };
      } else if (ppick === 2) {
        id = 'gigachat';
        for (;;) {
          key = await askSecret(`  ${t('Ключ из кабинета GigaChat (ввод скрыт):')} `);
          if (key) break;
          io.output.write(pc.yellow(`  ${t('без ключа GigaChat отвечать не сможет')}\n`));
        }
        card = { provider: 'gigachat', apiKey: key };
      } else {
        id = 'mock';
        card = { provider: 'mock' };
      }

      writeFileSync(join(modelsDir, `${id}.json`), JSON.stringify(card, null, 2) + '\n');
      notes.push(tf('создал {file} (модель «{id}» по умолчанию)', { file: join(modelsDir, `${id}.json`), id }));
      if (key) {
        notes.push(tf('ключ сохранил в {file} (поле "apiKey")', { file: join(modelsDir, `${id}.json`) }));
      } else {
        notes.push(t('ключ не указан — модель будет работать в mock-режиме'));
      }
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

/** Дом: модели (wizard, если нет ни одной), настройки и КОМАНДА (агенты, менеджер, тулы). */
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
  const agentsDir = join(homeDir, 'agents');
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
    try {
      for (const f of readdirSync(join(SCAFFOLD_DIR, 'home', 'agents')).filter((x) => x.endsWith('.json'))) {
        writeFileSync(join(agentsDir, f), readFileSync(join(SCAFFOLD_DIR, 'home', 'agents', f)));
      }
      const names = readdirSync(agentsDir).filter((x) => x.endsWith('.json')).map((x) => {
        try { return String(JSON.parse(readFileSync(join(agentsDir, x), 'utf8')).name ?? ''); } catch { return ''; }
      }).filter(Boolean);
      notes.push(names.length > 0
        ? tf('создал {file} (стартовая команда: {names})', { file: agentsDir, names: names.join(', ') })
        : tf('создал {file} (пустая команда — менеджер позовёт и настроит)', { file: agentsDir }));
    } catch { /* scaffold agents/ отсутствует — не беда */ }
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

export function defaultIo(): WizardIo {
  return {
    input: process.stdin,
    output: process.stdout,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

/** Всё сразу — дом; заметки печатает вызывающий. Проект человек выбирает сам:
 *  /project new или /project open (стартуем в состоянии «без проекта»). */
export async function ensureLayers(io: WizardIo = defaultIo(), homeDir: string = DT_HOME): Promise<string[]> {
  return ensureHome(io, homeDir);
}
