/**
 * Проба оболочки Vue (gui-src): контракт WS проверяется без браузера, разбором
 * исходников. Повод — реальная дыра: диспетчер ws.ts не обрабатывал rpc_result,
 * и каждый rpc оболочки висел 30 секунд до «нет ответа сервера», хотя сервер
 * всё исполнял. Статикой это ловится, браузером — только вручную.
 *
 *  - диспетчер событий обрабатывает КАЖДЫЙ тип из WsEvent (types.ts);
 *  - сервер не шлёт типы вне контракта, оболочка не шлёт необработанное;
 *  - rpc-методы из оболочки существуют в handleRpc сервера;
 *  - gui-dist собран: index.html ссылается на существующие ассеты и свежее
 *    всех исходников gui-src (правка без пересборки = провал).
 *
 * Запуск: npm run probe:gui
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

/** Все литералы `type: 'x'` из среза исходника. */
const typeLiterals = (src: string): Set<string> =>
  new Set([...src.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]));

/** Все метки `case 'x'` из среза исходника. */
const caseLabels = (src: string): Set<string> =>
  new Set([...src.matchAll(/case '([a-z_./]+)'/g)].map((m) => m[1]));

/** Срез исходника от маркера до следующего маркера (границы функций serve). */
const slice = (src: string, from: string, to?: string): string => {
  const a = src.indexOf(from);
  if (a === -1) throw new Error(`маркер не найден: ${from}`);
  const b = to === undefined ? src.length : src.indexOf(to, a);
  return src.slice(a, b === -1 ? src.length : b);
};

// --- контракты ---
const typesSrc = read('gui-src/types.ts');
const wsEventTypes = typeLiterals(slice(typesSrc, 'export type WsEvent', 'export type WsMessage'));
const wsMessageTypes = typeLiterals(slice(typesSrc, 'export type WsMessage'));

const wsSrc = read('gui-src/stores/ws.ts');
const appSrc = read('gui-src/App.vue');
const serveSrc = read('src/serve.ts');

// --- 1. каждое событие контракта обрабатывается где-то в ws.ts ---
// (auth_* разбираются до dispatchEvent, поэтому смотрим case по всему файлу)
const dispatchSrc = slice(wsSrc, 'function dispatchEvent', '// ── ответы на вопросы');
const dispatchCases = caseLabels(dispatchSrc);
const wsHandled = caseLabels(wsSrc);
const unhandled = [...wsEventTypes].filter((t) => !wsHandled.has(t));
check(
  `диспетчер GUI обрабатывает все ${wsEventTypes.size} событий контракта`,
  unhandled.length === 0,
  `нет case: ${unhandled.join(', ')}`,
);
check('в диспетчере нет мёртвых case вне контракта', [...dispatchCases].every((c) => wsEventTypes.has(c)),
  `лишние: ${[...dispatchCases].filter((c) => !wsEventTypes.has(c)).join(', ')}`);

// --- 2. сервер шлёт только то, что контракт GUI понимает ---
const serveSends = typeLiterals(serveSrc);
const alienFromServer = [...serveSends].filter((t) => !wsEventTypes.has(t));
check('сервер не шлёт события вне контракта GUI', alienFromServer.length === 0,
  `вне контракта: ${alienFromServer.join(', ')}`);

// --- 3. оболочка шлёт только то, что сервер обрабатывает ---
const clientCases = caseLabels(slice(serveSrc, 'async function handleClientMessage', 'async function handleRpc'));
clientCases.add('auth'); // auth разбирается до switch (special-case)
const guiSends = new Set<string>();
for (const src of [wsSrc, appSrc]) {
  for (const m of src.matchAll(/send\(\{ type: '([a-z_]+)'/g)) guiSends.add(m[1]);
}
const alienToServer = [...guiSends].filter((t) => !clientCases.has(t));
check('оболочка не шлёт сообщений вне обработчика сервера', alienToServer.length === 0,
  `сервер не знает: ${alienToServer.join(', ')}`);
// «использует все» — по наличию литерала: импорты уходят тернарником
// (send({ type: cond ? 'import_home' : 'import_session' }) регулярке не ловится)
const guiAll = wsSrc + appSrc;
const unusedByGui = [...wsMessageTypes].filter((t) => !guiAll.includes(`'${t}'`));
check('оболочка использует все исходящие типы контракта', unusedByGui.length === 0,
  `не используются: ${unusedByGui.join(', ')}`);

// --- 4. rpc-методы оболочки существуют в handleRpc ---
const rpcCases = caseLabels(slice(serveSrc, 'async function handleRpc', 'function serveStatic'));

// манифест операций — единственный источник имён rpc (имена операций — с отступом 4)
const operationsSrc = read('src/core/operations.ts');
const manifestOps = new Set([...operationsSrc.matchAll(/\n    name: '([a-z.]+)'/g)].map((m) => m[1]));
check('манифест: имена — группа.глагол (или глобальный глагол) без подчёркиваний',
  [...manifestOps].every((m) => /^[a-z]+(\.[a-z]+){0,2}$/.test(m)));
const rpcWithoutManifest = [...rpcCases].filter((m) => m !== 'state' && !manifestOps.has(m));
check('сервер: rpc не бывает вне манифеста (кроме state)', rpcWithoutManifest.length === 0,
  `вне манифеста: ${rpcWithoutManifest.join(', ')}`);
// мутации обязаны быть доступны rpc-методом (скриптовый API); просмотры и
// транспорт (export/import) имеют право жить только командой или WS-сообщением
const mutations = [...manifestOps].filter((m) => /\.(new|open|delete|rename|add|update|grant|set|toggle|on|off)$/.test(m));
const mutantWithoutRpc = mutations.filter((m) => !rpcCases.has(m));
check('манифест: каждая мутация доступна rpc', mutantWithoutRpc.length === 0,
  `нет rpc: ${mutantWithoutRpc.join(', ')}`);
const guiRpc = new Set<string>();
for (const src of [wsSrc, appSrc]) {
  for (const m of src.matchAll(/\brpc\('([a-z_.]+)'/g)) guiRpc.add(m[1]);
}
const unknownRpc = [...guiRpc].filter((m) => !rpcCases.has(m));
check(`rpc-методы оболочки существуют на сервере (${guiRpc.size} шт.)`, unknownRpc.length === 0,
  `нет на сервере: ${unknownRpc.join(', ')}`);

// --- 4b. каждая форма сохраняет по протоколу: в onSave есть rpc или send ---
// Повод — заглушка формы провайдера: кнопка «Сохранить» печатала уведомление
// и не вызывала ничего; контракт имён такое не видит, а форма выглядела рабочей.
/** Тело вызова openForm — баланс скобок соSkip строковых литералов. */
function balancedCall(src: string, openAt: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openAt, i + 1);
    }
  }
  return '';
}

function checkForms(file: string, src: string): void {
  let at = 0;
  let total = 0;
  const dead: string[] = [];
  while (true) {
    at = src.indexOf('openForm(', at);
    if (at === -1) break;
    const isDefinition = src.slice(Math.max(0, at - 9), at) === 'function ';
    const body = balancedCall(src, at + 'openForm'.length);
    if (!isDefinition) {
      total++;
      if (body && !/\brpc\(|\bsend\(/.test(body)) dead.push(body.slice(0, 80));
    }
    at += 9;
  }
  check(`${file}: каждая форма сохраняет по протоколу (${total} шт.)`, dead.length === 0,
    `onSave без rpc/send: ${dead.join(' | ')}`);
}
checkForms('gui-src/App.vue', appSrc);

// --- 5. собранная оболочка ---
const distIndex = join(root, 'gui-dist', 'index.html');
check('gui-dist/index.html собран', existsSync(distIndex));
if (existsSync(distIndex)) {
  const html = read('gui-dist/index.html');
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  check('index.html ссылается на js- и css-ассеты', assets.length >= 2);
  for (const a of assets) {
    check(`ассет ${a} существует`, existsSync(join(root, 'gui-dist', a.replace(/^\//, ''))));
  }
  // правка исходников без пересборки: сборка должна быть свежее каждого файла gui-src
  let newest: { f: string; t: number } | null = null;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const t = statSync(p).mtimeMs;
        if (!newest || t > newest.t) newest = { f: p, t };
      }
    }
  };
  walk(join(root, 'gui-src'));
  const builtAt = statSync(distIndex).mtimeMs;
  check('gui-dist свежее всех исходников gui-src (пересборка после правок)',
    newest === null || builtAt >= (newest as { f: string; t: number }).t,
    `новее сборки: ${(newest as { f: string; t: number } | null)?.f ?? '?'}`);
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
