/**
 * Проба i18n: словари-ключи и переключение языка интерфейса.
 *  - встроенные локали ru/en/zh: KEY → перевод; русский — полный словарь,
 *    а не тождество; нет ключа в активной — русский, нет и его — сам ключ;
 *  - tf: подстановка {переменных} в переводе;
 *  - внешние языки: lang/<id>.json в доме — валидные работают (новый формат:
 *    ключи-идентификаторы; старый до-0.0.21 с русскими ключами перебивается
 *    автоматически), битые — громкая ошибка, строка без соответствия — отказ
 *    со списком, коллизия со встроенным id — отказ, шаблоны «_*.json» и
 *    не-<id>.json игнорируются; непереведённое — русский фолбэком;
 *  - loadSettings: поле "ui" валидируется (непустая строка);
 *  - preloadLocale: лёгкое чтение "ui" до мастера;
 *  - через ядро: /settings update ui=en — интерфейс переключается на лету,
 *    отчёты операций (/help, /schedule add) сразу на английском; назад — на русском.
 *
 * Герметично: временный DT_HOME, mock-провайдер.
 * Запуск: npm run probe:i18n
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeModels } from './models.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const base = mkdtempSync(join(tmpdir(), 'dt-i18n-'));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });
process.env.DT_HOME = home;
process.chdir(base);
process.on('exit', () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows держит файлы */ } });

const i18n = await import('../src/i18n.js');
const { t, tf, applyLocale, knownLanguages, localeId, preloadLocale } = i18n;

// ── встроенные локали: русский — словарь, промахи деградируют читаемо ─────────
check('старт: активна русская, ключ переводится словарём',
  localeId() === 'ru' && t('SETTINGS') === 'Настройки' && t('AGENTS') === 'Агенты');
check('фолбэк: нет ключа нигде — сам ключ', t('NO_SUCH_KEY_ANYWHERE') === 'NO_SUCH_KEY_ANYWHERE');

applyLocale('en', home);
check('en: t переводит', t('SETTINGS') === 'Settings' && t('AGENTS') === 'Agents' && t('COMMAND') === 'Command');
check('en: tf подставляет переменные',
  tf('CREATED_FILE_MODEL_ID_AS_THE_DEFAULT', { file: 'p.json', id: 'mock' })
    === 'created p.json (model «mock» as the default)');

applyLocale('zh', home);
check('zh: t переводит', t('SETTINGS') === '设置' && t('AGENTS') === '智能体' && t('COMMAND') === '命令');

applyLocale('ru', home);
check('ru: возврат к русскому словарю', t('SETTINGS') === 'Настройки' && localeId() === 'ru');

// ── внешние языки: lang/<id>.json в доме (новый формат — ключи) ───────────────
const langDir = join(home, 'lang');
mkdirSync(langDir, { recursive: true });
writeFileSync(join(langDir, 'de.json'), JSON.stringify({
  name: 'Deutsch',
  translations: {
    SETTINGS: 'Einstellungen',
    CREATED_FILE_MODEL_ID_AS_THE_DEFAULT: 'erstellt {file} (Modell «{id}» als Standard)',
  },
}, null, 2));

const names = knownLanguages(home).map((l) => l.id);
check('knownLanguages: встроенные + внешний', ['ru', 'en', 'zh', 'de'].every((id) => names.includes(id)));
const de = knownLanguages(home).find((l) => l.id === 'de');
check('knownLanguages: de — внешний, имя из файла', de?.builtIn === false && de?.name === 'Deutsch');

applyLocale('de', home);
check('внешний: t переводит из lang/de.json', t('SETTINGS') === 'Einstellungen');
check('внешний: tf подставляет в перевод файла', tf('CREATED_FILE_MODEL_ID_AS_THE_DEFAULT', { file: 'p.json', id: 'mock' })
  === 'erstellt p.json (Modell «mock» als Standard)');
check('внешний: непереведённое — русский фолбэком', t('COMMAND') === 'Команда');
applyLocale('ru', home);

// старый формат (до 0.0.21): русские ключи перебиваются в наши KEY по ru-словарю
writeFileSync(join(langDir, 'fr.json'), JSON.stringify({
  name: 'Français',
  translations: {
    'Настройки': 'Réglages',
  },
}, null, 2));
applyLocale('fr', home);
check('легаси-формат: русские ключи автоконвертируются в KEY', t('SETTINGS') === 'Réglages');
check('легаси-формат: непокрытое — русский фолбэком', t('AGENTS') === 'Агенты');
applyLocale('ru', home);

// строка без соответствия — громкая ошибка со списком
writeFileSync(join(langDir, 'orphan.json'), JSON.stringify({
  name: 'Orphan',
  translations: { 'строки нет в русском словаре': 'x' },
}, null, 2));
let threw = '';
try { knownLanguages(home); } catch (e) { threw = (e as Error).message; }
check('легаси-ключ без соответствия — отказ со списком',
  threw.includes('orphan.json') && threw.includes('строки нет в русском словаре'), threw);
rmSync(join(langDir, 'orphan.json'), { force: true });

// неизвестный id — громкая ошибка со списком
threw = '';
try { applyLocale('xx', home); } catch (e) { threw = (e as Error).message; }
check('неизвестный id — отказ со списком', threw.includes('xx') && threw.includes('ru, en, zh, de, fr'), threw);

// битый JSON языка — ошибка с путём
writeFileSync(join(langDir, 'broken.json'), '{ битый');
threw = '';
try { knownLanguages(home); } catch (e) { threw = (e as Error).message; }
check('битый файл языка — отказ с путём', threw.includes('broken.json'), threw);
rmSync(join(langDir, 'broken.json'), { force: true });

// неправильная форма — отказ
writeFileSync(join(langDir, 'badform.json'), JSON.stringify({ name: 'X', translations: 'не объект' }));
threw = '';
try { knownLanguages(home); } catch (e) { threw = (e as Error).message; }
check('translations не объект — отказ', threw.includes('badform.json') && threw.includes('translations'), threw);
rmSync(join(langDir, 'badform.json'), { force: true });

// коллизия со встроенным id — отказ
writeFileSync(join(langDir, 'en.json'), JSON.stringify({ name: 'Fake', translations: {} }));
threw = '';
try { knownLanguages(home); } catch (e) { threw = (e as Error).message; }
check('коллизия id с встроенным — отказ', threw.includes('en.json') && threw.includes('занят'), threw);

// applyLocale('en') бьёт в встроенный, несмотря на файл-коллизию: порядок не менялся
applyLocale('en', home);
check('встроенный приоритетнее файла-коллизии', t('SETTINGS') === 'Settings');
applyLocale('ru', home);

rmSync(join(langDir, 'en.json'), { force: true });

// шаблоны и не-<id>.json игнорируются
writeFileSync(join(langDir, '_template.json'), '{ не читаем');
writeFileSync(join(langDir, 'Not an id.txt'), 'мусор');
let okSilent = false;
try { okSilent = knownLanguages(home).every((l) => l.id !== 'Not an id' && l.id !== '_template'); } catch { okSilent = false; }
check('шаблон _*.json и не-id файлы игнорируются', okSilent);

// ── loadSettings: поле "ui" валидируется ─────────────────────────────────────
{
  const { loadSettings } = await import('../src/settings.js');
  const sf = join(home, 'settings.json');
  writeFileSync(sf, JSON.stringify({ ui: '', width: 100 }));
  let uiThrew = '';
  try { loadSettings(sf, 0); } catch (e) { uiThrew = (e as Error).message; }
  check('loadSettings: пустой ui — отказ', uiThrew.includes('ui'), uiThrew);
  writeFileSync(sf, JSON.stringify({ ui: 5, width: 100 }));
  uiThrew = '';
  try { loadSettings(sf, 0); } catch (e) { uiThrew = (e as Error).message; }
  check('loadSettings: ui не строка — отказ', uiThrew.includes('ui'), uiThrew);
  writeFileSync(sf, JSON.stringify({ ui: 'de', width: 100 }));
  let uiOk = false;
  try { uiOk = loadSettings(sf, 0).ui === 'de'; } catch { uiOk = false; }
  check('loadSettings: валидный ui проходит', uiOk);

  // preloadLocale: включает локаль до мастера; без поля — остаётся русская
  preloadLocale(sf, home);
  check('preloadLocale: включил язык из settings.json', localeId() === 'de' && t('SETTINGS') === 'Einstellungen');
  applyLocale('ru', home);
  writeFileSync(sf, JSON.stringify({ width: 100 }));
  preloadLocale(sf, home);
  check('preloadLocale: без ui — остаётся русская', localeId() === 'ru');
  writeFileSync(sf, JSON.stringify({ width: 100 }));
}

// ── через ядро: /settings update ui=… переключает интерфейс на лету ─────────────
writeModels(home, { mock: { provider: 'mock' } });
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { runOperationText } = await import('../src/core/operations.js');
import type { Presenter, TurnSink } from '../src/core/presenter.js';

const notices: string[] = [];
const errors: string[] = [];
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice(text) { notices.push(text); },
  service(text) { notices.push(text); },
  error(text) { errors.push(text); },
  turnHeader() {},
  busy() { return { stop() {} }; },
  stream() { return sink; },
  turnEnd() {},
  say() {},
  toolLines() {},
  attachment() {},
  async confirm() { return false; },
  async chooseSession() { return null; },
  sessionOpened() {},
};

const { app } = await bootstrapApp();
const engine = new Engine(app, stub);
const run = (_e: unknown, line: string): Promise<string[]> => runOperationText(engine, line);

let lines = await run(engine, '/settings update ui=en');
check('settings set ui=en — отчёт на английском', lines.some((l) => l.includes('Settings updated')), lines.join(' | '));
check('t() переключилась на лету', t('SETTINGS') === 'Settings' && localeId() === 'en');

lines = await run(engine, '/help');
check('/help на английском: заголовок операций', lines.some((l) => l.startsWith('  Operations')), lines.slice(0, 5).join(' | '));
check('/help на английском: help операции переведён', lines.some((l) => l.includes('newest first')), lines.join(' | '));

lines = await run(engine, '/schedule add проверка 5');
check('отчёт операции на английском', lines.some((l) => l.includes('Task «проверка» every 5 min')), lines.join(' | '));

threw = '';
try { await run(engine, '/settings update ui=nope'); } catch (e) { threw = (e as Error).message; }
check('неизвестный ui — отказ со списком', threw.includes('не известен') && threw.includes('de'), threw);
check('после отказа — язык не менялся', localeId() === 'en');

lines = await run(engine, '/settings update ui=ru');
check('назад на русский', lines.some((l) => l.includes('Настройки обновлены')) && t('SETTINGS') === 'Настройки', lines.join(' | '));
check('settings.json хранит ui:ru', JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).ui === 'ru');

// ── serve.stateSnapshot: в state.ui уезжает список языков — селектор ⚙ в GUI ──
const { stateSnapshot } = await import('../src/serve.js');
const snap = stateSnapshot(app, engine) as {
  settings?: { language?: string; compressThreshold?: number };
  ui?: { id: string; languages?: { id: string; name: string; builtIn: boolean }[]; strings?: Record<string, string> };
};
const langList = snap.ui?.languages ?? [];
check('state.ui.languages: системные ru/en/zh встроенные',
  ['ru', 'en', 'zh'].every((id) => langList.find((l) => l.id === id)?.builtIn === true));
const deInfo = langList.find((l) => l.id === 'de');
check('state.ui.languages: свой de из lang/ — не встроенный, имя из файла',
  deInfo?.builtIn === false && deInfo?.name === 'Deutsch');
check('state.ui.id — активная локаль', snap.ui?.id === 'ru');
// словарь для GUI: ключ → строка активной локали с русским фолбэком
const strings = snap.ui?.strings ?? {};
check('state.ui.strings: русский словарь целиком', strings['SETTINGS'] === 'Настройки' && Object.keys(strings).length > 900);

// ── пустой язык общения следует языку интерфейса: ядро — для TUI и GUI сразу ──
const { conversationLanguage } = await import('../src/i18n.js');
check('язык общения: встроенные — подсказки для промтов',
  conversationLanguage('ru', home) === 'русский' && conversationLanguage('en', home) === 'english' && conversationLanguage('zh', home) === '中文');
check('язык общения: свой — name из lang/<id>.json', conversationLanguage('de', home) === 'Deutsch');
check('язык общения: неизвестный id — сам id', conversationLanguage('xx', home) === 'xx');
check('settings без language: в state поле пустое (форма честно показывает «не задан»)',
  snap.settings?.language === undefined);
check('settings: порог автосжатия в state (дефолт 85 — scaffold без поля)',
  snap.settings?.compressThreshold === 85);

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
