/**
 * Боевой дым GigaChat: полный цикл нативного function calling на НАСТОЯЩЕМ
 * API Сбера — от вопроса до исполненной команды. Запускается руками
 * (боевые запросы: деньги, квоты, недетерминизм):
 *
 *   npm run smoke:gigachat
 *
 * Требования (каждое проверяется с ясной подсказкой):
 *  - карточка ~/.dreamteam/models/gigachat.json с ключом: "apiKey" из
 *    кабинета (developers.sber.ru → GigaChat API) или пара
 *    "clientId"/"clientSecret";
 *  - корневой сертификат Минцифры по пути из "caCertPath" (по умолчанию
 *    certs/russian_trusted_root_ca.pem; относительный путь ищется и от дома
 *    ~/.dreamteam, и от текущей папки). Скачать: gu-st.ru → «Сертификаты
 *    Минцифры» (russian_trusted_root_ca.pem).
 *
 * Ход проверки: во временную папку пишется файл с секретной фразой (ASCII —
 * чтобы кодировки cmd.exe не мешали), модель просят вывести его командой.
 * Команда исполняется ТОЛЬКО если это строго cat/type нашего файла; вывод
 * возвращается сообщением «⚙ Результаты твоих действий» (адаптер конвертирует
 * пару в нативные role: assistant/function), и модель должна назвать секрет.
 */
import { exec } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LLMMessage, RoundUsage, ToolSpec } from '../src/types.js';

let fails = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  }
};

const userHome = resolve(process.env.DT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dreamteam'));
const cardPath = join(userHome, 'models', 'gigachat.json');

// ── карточка и сертификат: без них нет и захода ─────────────────────────────
if (!existsSync(cardPath)) {
  console.log(`Нет карточки ${cardPath} — создайте её (см. README, «Сбер GigaChat»).`);
  process.exit(2);
}
const card = JSON.parse(readFileSync(cardPath, 'utf8')) as {
  apiKey?: string; clientId?: string; clientSecret?: string; scope?: string;
  baseUrl?: string; authUrl?: string; caCertPath?: string; insecureTLS?: boolean; model?: string;
};
const hasKey = Boolean(card.apiKey) || Boolean(card.clientId && card.clientSecret);
if (!hasKey) {
  console.log('В карточке gigachat.json нет ключа. Впишите "apiKey" из кабинета');
  console.log('(developers.sber.ru → GigaChat API) или пару "clientId"/"clientSecret".');
  process.exit(2);
}
let certPath = card.caCertPath ? String(card.caCertPath) : '';
if (certPath) {
  const candidates = [resolve(certPath), resolve(userHome, certPath)];
  certPath = candidates.find((p) => existsSync(p)) ?? '';
  if (!certPath) {
    console.log(`Сертификат «${card.caCertPath}» не найден (искал в текущей папке и в ~/.dreamteam).`);
    console.log('Скачайте корневой сертификат Минцифры (gu-st.ru → «Сертификаты Минцифры»)');
    console.log('и положите по пути из "caCertPath" карточки.');
    process.exit(2);
  }
} else if (card.insecureTLS !== true) {
  console.log('В карточке нет "caCertPath" — API Сбера отвечает сертификатом Минцифры,');
  console.log('которого нет в стандартных хранилищах. Скачайте его (gu-st.ru → «Сертификаты');
  console.log('Минцифры») и впишите путь в "caCertPath" (для теста можно и "insecureTLS": true).');
  process.exit(2);
}
console.log(`Боевой GigaChat: ${card.model ?? 'GigaChat'}, дом ${userHome}`);

const { gigachatFactory } = await import('../src/providers/gigachat.js');
const { parseActions } = await import('../src/actions.js');
const provider = gigachatFactory('giga', {
  provider: 'gigachat',
  ...card,
  caCertPath: certPath || undefined,
} as Parameters<typeof gigachatFactory>[1]);

const runSpec: ToolSpec = {
  name: 'run',
  description: 'Выполнить команду оболочки в рабочей папке.',
  parameters: {
    type: 'object',
    properties: { body: { type: 'string', description: 'команда' } },
    required: ['body'],
  },
};

// ── файл с секретом: ASCII-фраза, чтобы кодировки консоли не мешали ─────────
const proj = mkdtempSync(join(tmpdir(), 'dt-giga-'));
const secretFile = join(proj, 'smoke.txt');
writeFileSync(secretFile, 'smoke ok\nsecret: SUN42\n', 'utf8');
process.on('exit', () => {
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* Windows держит файлы */ }
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const collect = async (messages: LLMMessage[]): Promise<{ text: string; usage: RoundUsage }> => {
  let text = '';
  const usage: RoundUsage = {};
  for await (const chunk of provider.stream({
    system: 'Ты — смоук-агент. Действуй точно по инструкции пользователя.',
    messages,
    tools: [runSpec],
    signal: AbortSignal.timeout(120_000),
  }, (u) => Object.assign(usage, u))) {
    text += chunk;
  }
  return { text: text.trim(), usage };
};

// ── 1. вопрос → модель должна ответить вызовом функции (блок run) ───────────
const task = `Выведи содержимое файла ${secretFile} командой ${process.platform === 'win32' ? 'type' : 'cat'}. Только команда.`;
const round1 = await collect([{ role: 'user', content: task }]);
check('1: OAuth и чат живьём (ответ получен, usage пришёл)', round1.text.length > 0, round1.text || '(пусто)');
console.log(`      ответ: ${round1.text.slice(0, 160).replaceAll('\n', ' ⏎ ')}`);
console.log(`      токены: ${JSON.stringify(round1.usage)}`);

const actions = parseActions(round1.text, ['run']);
check('2: модель вызвала функцию run (нативный function_call → блок)', actions.length === 1 && actions[0]!.kind === 'run' && actions[0]!.command.trim().length > 0, round1.text);

// ── 2. исполнение: строго cat/type нашего файла, иначе отказ ────────────────
let result: string;
const cmd = actions[0] && actions[0].kind === 'run' ? actions[0].command.trim() : '';
const target = cmd.replace(/^(cat|type)\s+/i, '').replaceAll('"', '').replaceAll('/', '\\').toLowerCase();
const allowed = /^(cat|type)\s+/i.test(cmd) && target === secretFile.toLowerCase();
if (allowed) {
  try {
    const { stdout } = await new Promise<{ stdout: string }>((done, fail) =>
      exec(`${process.platform === 'win32' ? 'type' : 'cat'} "${secretFile}"`, { timeout: 15_000 }, (err, stdout) =>
        err ? fail(err) : done({ stdout: String(stdout) }),
      ),
    );
    result = stdout.trim();
  } catch (err) {
    result = `ошибка: ${err instanceof Error ? err.message : err}`;
  }
} else {
  result = '';
}
check('3: команда адресована нашему файлу (исполняем только её)', Boolean(result), `команда: «${cmd}»`);

// ── 3. результат обратно → модель называет секрет из файла ───────────────────
// хвост — содержательная инструкция (как у движка после результатов всегда
// стоит слово модератора): голый «Продолжай.» модель читает как «продолжай
// действие» и вызывает функцию повторно
const round2 = await collect([
  { role: 'user', content: task },
  { role: 'user', content: round1.text },
  { role: 'user', content: `⚙ Результаты твоих действий:\n✅ ${result}` },
  { role: 'user', content: 'Прочитай результат выполнения команды и назови секрет из файла одной строкой.' },
]);
check('4: модель прочитала результат и назвала секрет SUN42', round2.text.includes('SUN42'), round2.text || '(пусто)');
console.log(`      ответ: ${round2.text.slice(0, 160).replaceAll('\n', ' ⏎ ')}`);

console.log(fails === 0 ? '\nБоевой дым GigaChat пройден: коннект, вызов функции, исполнение, ответ' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
