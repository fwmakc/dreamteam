/**
 * Проба карточек моделей: встроенный набор scaffold/home/models должен
 * загружаться реестром без ошибок — это те же карточки, которые мастер
 * копирует в дом при первом запуске.
 *  - поле провайдера называется "provider" (не adapter); claude → anthropic-compatible;
 *  - каждая карточка проходит валидацию контракта своего провайдера
 *    (неизвестный или обязательный ключ — громкая ошибка loadModels);
 *  - устаревших env-ключей (apiKeyEnv/keyEnv) нет — ключ живёт в apiKey;
 *  - облачные карточки несут явное поле apiKey, пусть пустое;
 *  - флаг vision доходит до статуса модели (glm-vision, qwen*-vl → зрение);
 *  - карточки без ключа (anthropic, gigachat) — «не настроены», а не падение.
 *
 * Герметично: не трогает дом, читает только scaffold.
 * Запуск: npm run probe:models
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModels } from '../src/providers/registry.js';

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
check('известные провайдеры в карточках',
  ['openai-compatible', 'anthropic-compatible', 'gigachat', 'mock']
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
const cloudIds = ['claude', 'gigachat', 'glm-vision', 'openai'];
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

// --- 4. карточки без ключа — «не настроен» с внятной заметкой, не падение ----
for (const id of ['claude', 'gigachat']) {
  const s = models.get(id);
  check(`«${id}» без ключа — не настроен`, s?.ok === false && /apiKey/.test(s?.note ?? ''), s?.note);
}

// --- 5. image-карточки на месте ----------------------------------------------
check('image-модели загружены', ['sd-turbo', 'flux-dev', 'mock-images'].every((id) => images.has(id)));

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
