/**
 * Проба карточек моделей: встроенный набор scaffold/home/models должен
 * загружаться реестром без ошибок — это те же карточки, которые мастер
 * копирует в дом при первом запуске.
 *  - поле провайдера называется "provider" (не adapter); claude → anthropic-compatible;
 *    glm → zai-coding-plan;
 *  - каждая карточка проходит валидацию контракта своего провайдера
 *    (неизвестный или обязательный ключ — громкая ошибка loadModels);
 *  - устаревших env-ключей (apiKeyEnv/keyEnv) нет — ключ живёт в apiKey;
 *  - облачные карточки несут явное поле apiKey, пусть пустое;
 *  - флаг vision доходит до статуса модели (glm-vision, qwen*-vl → зрение);
 *  - карточки без ключа (anthropic, gigachat) — «не настроены», а не падение;
 *  - строковые "true"/"false" и числа (команды /model, действия менеджера)
 *    приводятся к типам контракта: vision:true, maxTokens числом, числовой
 *    apiKey остаётся строкой.
 *
 * Герметично: не трогает дом — читает scaffold, правки пишет во временную папку.
 * Запуск: npm run probe:models
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addModelConfig, loadModels, updateModelConfig } from '../src/providers/registry.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const scaffoldModels = fileURLToPath(new URL('../scaffold/home/models', import.meta.url));

// --- 1. валидация контрактов: loadModels громко падает на любом нарушении ----
const { models, images } = loadModels(scaffoldModels);

const files = readdirSync(scaffoldModels).filter((f) => f.endsWith('.json'));
check('все карточки прочитаны', models.size + images.size === files.length,
  `${models.size} LLM + ${images.size} image из ${files.length}`);

// --- 2. поле называется provider, не adapter (legacy-имя не вернулось) --------
const legacyField: string[] = [];
const providers: Record<string, string> = {};
for (const f of files) {
  const card = JSON.parse(readFileSync(join(scaffoldModels, f), 'utf8')) as Record<string, unknown>;
  if ('adapter' in card) legacyField.push(f);
  else if (typeof card.provider === 'string') providers[f.replace(/\.json$/, '')] = card.provider;
}
check('нет поля "adapter" — во всех карточках "provider"', legacyField.length === 0, legacyField.join(', '));
check('claude → anthropic-compatible', providers['claude'] === 'anthropic-compatible', providers['claude']);
check('glm → zai-coding-plan', providers['glm'] === 'zai-coding-plan', providers['glm']);
check('известные провайдеры в карточках',
  ['openai-compatible', 'anthropic-compatible', 'zai-coding-plan', 'gigachat', 'mock']
    .every((p) => Object.values(providers).includes(p)), JSON.stringify(providers));

// --- 3. env-ключи не вернулись: ключ живёт в apiKey карточки ------------------
const envKeys: string[] = [];
for (const f of files) {
  const card = JSON.parse(readFileSync(join(scaffoldModels, f), 'utf8')) as Record<string, unknown>;
  for (const bad of ['apiKeyEnv', 'keyEnv']) if (bad in card) envKeys.push(`${f}:${bad}`);
}
check('нет apiKeyEnv/keyEnv — ключ только в apiKey', envKeys.length === 0, envKeys.join(', '));

// у облачных карточек ключ вписывается в карточку — поле apiKey есть явно
// (пусть пустое: пустая строка = «не задан»); локальным его можно опустить
const cloudIds = ['claude', 'gigachat', 'glm', 'glm-vision', 'openai'];
const noKey = cloudIds.filter(
  (id) => !('apiKey' in (JSON.parse(readFileSync(join(scaffoldModels, `${id}.json`), 'utf8')) as object)),
);
check('облачные карточки несут поле apiKey (пусть пустое)', noKey.length === 0, noKey.join(', '));

// --- 3. флаг vision доходит до статуса модели --------------------------------
const visionIds = ['glm-vision', 'qwen3-vl-2b', 'qwen3-vl-8b'];
for (const id of visionIds) {
  check(`vision-флаг у «${id}»`, models.get(id)?.vision === true, String(models.get(id)?.vision));
}
check('«openai» без vision-флага', models.get('openai')?.vision === false);

// --- 3a. contextWindow: в карточках скелета число, в статус не попадает -------
check('окно у qwen3-vl-2b', (JSON.parse(readFileSync(join(scaffoldModels, 'qwen3-vl-2b.json'), 'utf8')) as { contextWindow?: unknown }).contextWindow === 32768);
check('окно у claude', (JSON.parse(readFileSync(join(scaffoldModels, 'claude.json'), 'utf8')) as { contextWindow?: unknown }).contextWindow === 200000);
check('у gigachat окна нет — не выдумываем', !('contextWindow' in (JSON.parse(readFileSync(join(scaffoldModels, 'gigachat.json'), 'utf8')) as object)));

// --- 4. карточки без ключа — «не настроен» с внятной заметкой, не падение ----
for (const id of ['claude', 'gigachat', 'glm']) {
  const s = models.get(id);
  check(`«${id}» без ключа — не настроен`, s?.ok === false && /apiKey/.test(s?.note ?? ''), s?.note);
}

// --- 5. image-карточки на месте ----------------------------------------------
check('image-модели загружены', ['sd-turbo', 'flux-dev', 'mock-images'].every((id) => images.has(id)));

// --- 6. строковые true|false и числа приводятся к типам контракта -------------
const tmp = mkdtempSync(join(tmpdir(), 'dt-probe-models-'));
try {
  const report = addModelConfig(tmp, 'typed', {
    provider: 'openai-compatible',
    model: 'glm-4.6v',
    baseUrl: 'http://127.0.0.1:8000/api/paas/v4',
    apiKey: '12345',
    vision: 'true',
    maxTokens: '4096',
  });
  const card = JSON.parse(readFileSync(join(tmp, 'typed.json'), 'utf8')) as Record<string, unknown>;
  check('addModelConfig принял строковые true|false и числа', report.startsWith('✓'), report);
  check('vision:"true" → настоящий true в файле', card.vision === true, String(card.vision));
  check('maxTokens:"4096" → настоящее число в файле', card.maxTokens === 4096, String(card.maxTokens));
  check('числовой apiKey остался строкой', card.apiKey === '12345', String(card.apiKey));
  const upd = updateModelConfig(tmp, 'typed', { vision: 'false', temperature: '0.5', contextWindow: '128000' });
  const card2 = JSON.parse(readFileSync(join(tmp, 'typed.json'), 'utf8')) as Record<string, unknown>;
  check('updateModelConfig: vision:"false" → false', card2.vision === false, String(card2.vision));
  check('updateModelConfig: temperature:"0.5" → число', card2.temperature === 0.5, String(card2.temperature));
  check('updateModelConfig: contextWindow:"128000" → число', card2.contextWindow === 128000, String(card2.contextWindow));
  check('в отчёте типизированные значения', /vision="false"/.test(upd), upd);
  let rejected = false;
  try {
    updateModelConfig(tmp, 'typed', { vision: 'да' });
  } catch (err) {
    rejected = /true или false/.test(err instanceof Error ? err.message : String(err));
  }
  check('не-булево строкой — прежняя громкая ошибка', rejected);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
