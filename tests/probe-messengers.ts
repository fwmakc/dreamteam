/**
 * Проба тулов «telegram» и «max» — офлайн: оба API подменяются локальными
 * mock-серверами через "api" в поле "messengers" project.json проекта (в доме).
 *   конфиг: нет файла, пустой токен, лишние поля, кривой json, нет блока;
 *   telegram: list/in из getUpdates, send текстом и файлом (sendDocument),
 *     ошибки API (ok:false) и неверный токен;
 *   max: me/chats/in, send в чат и user:<id>, вложения через /uploads →
 *     POST файла → token (картинка → type=image);
 *   check(): чтение — allow, send — ask, ерунда — deny; карточки строгие.
 * Запуск: npx tsx tests/probe-messengers.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// DT_HOME читается при импорте paths — подменяем до загрузки модулей
const home = mkdtempSync(join(tmpdir(), 'dt-msg-home-'));
process.env.DT_HOME = home;

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'dt-msg-cwd-'));
mkdirSync(join(cwd, 'сканы'), { recursive: true });
writeFileSync(join(cwd, 'паспорта.xlsx'), 'xlsx-данные', 'utf8');
writeFileSync(join(cwd, 'сканы', 'паспорт.png'), 'png-данные', 'utf8');

// ─── mock-сервер: /tg/* — Telegram Bot API, /max/* — MAX, /upload/* — файлы ──
const tgSent: Array<{ chat_id?: unknown; text?: string }> = [];
const tgFiles: string[] = [];
const maxSent: Array<{ url: string; body: { text?: string; attachments?: Array<{ type: string; payload: { token: string } }> } }> = [];
const uploadKinds: Array<string | null> = [];
const uploadBodies: string[] = [];
const TG_UPDATES = [
  { update_id: 1, message: { message_id: 10, date: 1761000000, chat: { id: 555, type: 'private', first_name: 'Хозяин' }, from: { first_name: 'Хозяин', username: 'host' }, text: 'привет, бот' } },
  { update_id: 2, message: { message_id: 11, date: 1761000100, chat: { id: -100200, type: 'group', title: 'Команда' }, from: { first_name: 'Петя' }, text: 'всем привет' } },
];
const MAX_UPDATES = [
  { update_type: 'bot_started' },
  { update_type: 'message_created', message: { sender: { user_id: 1, name: 'Хозяин' }, recipient: { chat_id: 777 }, body: { text: 'отчёт готов?' } } },
];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = req.url ?? '';
    const json = (obj: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.startsWith('/tg/botTESTTOKEN/')) {
      const method = url.slice('/tg/botTESTTOKEN/'.length);
      if (method === 'sendMessage') {
        tgSent.push(JSON.parse(raw) as { chat_id?: unknown; text?: string });
        return json({ ok: true, result: { message_id: 1 } });
      }
      if (method === 'sendDocument') {
        tgFiles.push(raw);
        return json({ ok: true, result: { message_id: 2 } });
      }
      if (method === 'getUpdates') return json({ ok: true, result: TG_UPDATES });
      return json({ ok: false, description: `метод ${method} не знает` });
    }
    if (url.startsWith('/tg/')) return json({ ok: false, description: 'Unauthorized' });
    if (url.startsWith('/tgfail/')) return json({ ok: false, description: 'такой метод боту не знаком' });
    if (url === '/max/me') return json({ name: 'Робот', user_id: 9 });
    if (url === '/max/chats') return json({ chats: [{ chat_id: 777, type: 'dialog', title: 'Избранное' }, { chat_id: 888, type: 'group', title: 'Отдел' }] });
    if (url === '/max/updates') return json({ updates: MAX_UPDATES });
    if (url.startsWith('/max/uploads')) {
      const kind = new URL(`http://x${url}`).searchParams.get('type');
      uploadKinds.push(kind);
      return json({ url: `http://127.0.0.1:${port}/upload/f-${uploadKinds.length}` });
    }
    if (url.startsWith('/max/messages')) {
      maxSent.push({ url, body: JSON.parse(raw) as (typeof maxSent)[number]['body'] });
      return json({ message: { body: { text: 'ок' } } });
    }
    if (url.startsWith('/upload/')) {
      uploadBodies.push(raw);
      return json({ token: `tok-${uploadBodies.length}` });
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

// ─── конфиг и импорты ────────────────────────────────────────────────────────
// проект «открыт»: боты — поле "messengers" в project.json дома
const { setProjectRoot } = await import('../src/paths.js');
const projFile = join(home, 'projects', 'dev', 'project.json');
mkdirSync(join(home, 'projects', 'dev'), { recursive: true });
setProjectRoot(join(home, 'projects', 'dev'), '');
const goodConfig = {
  telegram: { token: 'TESTTOKEN' },
  max: { token: 'MAXTOKEN' },
  api: { telegram: `http://127.0.0.1:${port}/tg`, max: `http://127.0.0.1:${port}/max` },
};
function writeConfig(obj: unknown): void {
  writeFileSync(projFile, JSON.stringify({ id: 'dev', createdAt: 1, hosts: {}, mails: {}, messengers: obj }));
}
writeConfig(goodConfig);

const { default: makeTg } = await import('../src/tools/telegram/telegram.js');
const { default: makeMax } = await import('../src/tools/max/max.js');
const { TELEGRAM_API, MAX_API, parseSendText } = await import('../src/messengers.js');

const tg = makeTg({});
const mx = makeMax({});
const ctx = { cwd, run: async () => ({ ok: true, output: '' }), http: async () => ({ ok: true, output: '' }), confirm: async () => false };
const run = (tool: typeof tg, body: string): Promise<string> => tool.run(body, ctx);
const errOf = async (tool: typeof tg, body: string): Promise<string> => {
  try {
    await run(tool, body);
    return '(не бросил)';
  } catch (e) {
    return String((e as Error).message);
  }
};

// ─── дефолтные адреса и парсер тела ──────────────────────────────────────────
check('дефолт api.telegram.org', TELEGRAM_API === 'https://api.telegram.org');
check('дефолт platform-api2.max.ru', MAX_API === 'https://platform-api2.max.ru');
{
  const p = parseSendText('файлы: a.xlsx, b.pdf\n\nотчёт готов');
  check('parseSendText: файлы и текст', p.files.join(',') === 'a.xlsx,b.pdf' && p.body === 'отчёт готов', JSON.stringify(p));
  check('parseSendText: без файлов', parseSendText('просто текст').files.length === 0);
}

// ─── конфиг: валидация ───────────────────────────────────────────────────────
{
  writeFileSync(projFile, JSON.stringify({ id: 'dev', createdAt: 1, hosts: {}, mails: {} })); // поля messengers нет
  check('нет поля messengers — отказ с примером', (await errOf(tg, 'list')).includes('нет поля "messengers"') && (await errOf(tg, 'list')).includes('BotFather'));
  writeConfig({ telegram: { token: '' } });
  check('пустой token', (await errOf(tg, 'list')).includes('пустой "token"'));
  writeConfig({ telegram: { token: 'x', бот: 1 } });
  check('лишнее поле в блоке', (await errOf(tg, 'list')).includes('неизвестные поля "бот"'));
  writeFileSync(projFile, 'это не json'); // битый project.json
  check('кривой json', (await errOf(mx, 'me')).includes('кривой JSON'));
  writeConfig({ max: { token: 'x' } });
  check('нет блока telegram', (await errOf(tg, 'list')).includes('нет блока "telegram"'));
  writeConfig(goodConfig);
}


// ─── telegram: list / in ─────────────────────────────────────────────────────
{
  const list = await run(tg, 'list');
  check('tg list: оба чата с именами', list.includes('555 — Хозяин (private)') && list.includes('-100200 — Команда (group)'), list);
  const incoming = await run(tg, 'in');
  check('tg in: тексты входящих', incoming.includes('привет, бот') && incoming.includes('всем привет'), incoming);
  check('tg in: от кого', incoming.includes('от Хозяин') && incoming.includes('от Петя'), incoming);
}

// ─── telegram: send ──────────────────────────────────────────────────────────
{
  const rep = await run(tg, 'send 555\nготово: отчёт собран');
  check('tg send текстом: отчёт', rep.includes('✓ отправлено в чат 555'), rep);
  check('tg send текстом: дошло (chat_id строкой — валидно для Bot API)', String(tgSent[0]?.chat_id) === '555' && tgSent[0]?.text === 'готово: отчёт собран', JSON.stringify(tgSent[0]));

  const rep2 = await run(tg, 'send 555\nфайлы: паспорта.xlsx\n\nсмотрите вложение');
  check('tg send файлом: отчёт', rep2.includes('паспорта.xlsx'), rep2);
  check('tg send файлом: multipart с именем', tgFiles[0]?.includes('filename="паспорта.xlsx"') ?? false);
  check('tg send файлом: chat_id и подпись', tgFiles[0]?.includes('555') === true && tgFiles[0]?.includes('смотрите вложение') === true);

  check('tg send: нет цели', (await errOf(tg, 'send\nтекст')).includes('send <chat_id>'));
  check('tg send: пустое тело', (await errOf(tg, 'send 555\n')).includes('тело пустое'));
  check('tg send: файл наружу', (await errOf(tg, 'send 555\nфайлы: ../паспорта.xlsx\n\nт')).includes('вне рабочей папки'));
  check('tg send: секрет', (await errOf(tg, 'send 555\nфайлы: .env\n\nт')).includes('секретный'));
}

// ─── telegram: ошибки API и неверный токен ───────────────────────────────────
{
  writeConfig({ telegram: { token: 'TESTTOKEN' }, api: { telegram: `http://127.0.0.1:${port}/tgfail` } });
  check('tg: ok:false → description в ошибке', (await errOf(tg, 'in')).includes('такой метод боту не знаком'));
  writeConfig({ telegram: { token: 'WRONG' }, api: { telegram: `http://127.0.0.1:${port}/tg` } });
  check('tg: неверный токен → Unauthorized', (await errOf(tg, 'list')).includes('Unauthorized'));
  writeConfig(goodConfig);
}

// ─── max: me / chats / in ────────────────────────────────────────────────────
{
  check('max me: имя и user_id', (await run(mx, 'me')).includes('«Робот» (user_id 9)'));
  const chats = await run(mx, 'chats');
  check('max chats: chat_id и названия', chats.includes('777 — Избранное (dialog)') && chats.includes('888 — Отдел (group)'), chats);
  const incoming = await run(mx, 'in');
  check('max in: входящее от Хозяина', incoming.includes('отчёт готов?') && incoming.includes('от Хозяин'), incoming);
}

// ─── max: send ───────────────────────────────────────────────────────────────
{
  await run(mx, 'send 777\nготово');
  check('max send: chat_id в query, текст в теле', maxSent[0]?.url.includes('chat_id=777') === true && maxSent[0]?.body.text === 'готово', JSON.stringify(maxSent[0]));

  await run(mx, 'send user:42\nлично');
  check('max send user: → user_id в query', maxSent[1]?.url.includes('user_id=42') === true, JSON.stringify(maxSent[1]));

  await run(mx, 'send 777\nфайлы: паспорта.xlsx\n\nпаспорта в таблице');
  check('max send файлом: /uploads?type=file', uploadKinds[0] === 'file', String(uploadKinds[0]));
  check('max send файлом: файл ушел на upload-url', uploadBodies[0]?.includes('filename="паспорта.xlsx"') === true && uploadBodies[0]?.includes('xlsx-данные') === true);
  check('max send файлом: token в attachments', maxSent[2]?.body.attachments?.[0]?.payload.token === 'tok-1' && maxSent[2]?.body.text === 'паспорта в таблице', JSON.stringify(maxSent[2]));

  await run(mx, 'send 777\nфайлы: сканы/паспорт.png\n\nскан');
  check('max send картинкой: /uploads?type=image', uploadKinds[1] === 'image' && maxSent[3]?.body.attachments?.[0]?.type === 'image', JSON.stringify({ k: uploadKinds[1], m: maxSent[3] }));

  check('max send: кривая цель', (await errOf(mx, 'send раз-два\nтекст')).includes('send <chat_id>'));
  check('max send: пустое тело', (await errOf(mx, 'send 777\n')).includes('тело пустое'));
  check('max send: секрет', (await errOf(mx, 'send 777\nфайлы: .env\n\nт')).includes('секретный'));
}

// ─── check(): вердикты и карточки ────────────────────────────────────────────
{
  for (const body of ['list', 'in 5'] as const) check(`tg check: ${body} — allow`, tg.check(body) === 'allow');
  check('tg check: send — ask', tg.check('send 555') === 'ask');
  check('tg check: ерунда — deny', typeof tg.check('стоп') === 'object');
  for (const body of ['me', 'chats', 'in'] as const) check(`max check: ${body} — allow`, mx.check(body) === 'allow');
  check('max check: send — ask', mx.check('send 777') === 'ask');
  check('max check: ерунда — deny', typeof mx.check('frobnicate') === 'object');

  let threw = '';
  try { makeTg({ sites: [] }); } catch (e) { threw = (e as Error).message; }
  check('tg карточка: лишнее поле — отказ', threw.includes('неизвестные поля'), threw);
  threw = '';
  try { makeMax({ lang: 'ru' }); } catch (e) { threw = (e as Error).message; }
  check('max карточка: лишнее поле — отказ', threw.includes('неизвестные поля'), threw);
}

server.close();
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
const { rmTemp } = await import('./rm-tmp.js');
rmTemp(cwd);
rmTemp(home);
