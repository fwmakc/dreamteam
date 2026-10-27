/**
 * Проба тула «mail» — офлайн: реальных серверов не касаемся.
 *   ящики — поле "mails" в project.json проекта (в доме): нет поля, битые
 *   поля, custom;
 *   boxes — имена и хосты, пароли не светятся; выбор ящика при нескольких;
 *   check(): чтение — allow, send — ask, ерунда — deny;
 *   send: шапка кому:/тема:/файлы:, пустое тело, пути наружу и секреты;
 *   resolveEndpoints — адреса пресетов и переопределения портов.
 * Запуск: npx tsx tests/probe-mail.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './tool-ctx.js';

// DT_HOME читается при импорте paths — подменяем до загрузки модулей
const home = mkdtempSync(join(tmpdir(), 'dt-mail-home-'));
process.env.DT_HOME = home;

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'dt-mail-cwd-'));
// проект «открыт»: слой путей указывает в project.json дома — там живут ящики
const { setProjectRoot } = await import('../src/paths.js');
const projFile = join(home, 'projects', 'dev', 'project.json');
mkdirSync(join(home, 'projects', 'dev'), { recursive: true });
setProjectRoot(join(home, 'projects', 'dev'), '');
const writeMails = (mails: unknown): void => {
  writeFileSync(projFile, JSON.stringify({ id: 'dev', createdAt: 1, hosts: {}, messengers: {}, mails }));
};
writeMails({});
const { default: makeTool } = await import('../src/tools/mail/mail.js');
const { resolveEndpoints, loadAccounts } = await import('../src/mail.js');

const tool = makeTool({});
const run = (body: string): Promise<string> => tool.run(body, makeCtx(cwd));
const errOf = async (body: string): Promise<string> => {
  try {
    await run(body);
    return '(не бросил)';
  } catch (e) {
    return String((e as Error).message);
  }
};

// ─── нет mails.json ──────────────────────────────────────────────────────────
{
  writeFileSync(projFile, JSON.stringify({ id: 'dev', createdAt: 1, hosts: {} })); // поля mails нет
  const msg = await errOf('boxes');
  check('нет поля mails — отказ с примером', msg.includes('нет поля "mails"') && msg.includes('imap.yandex.ru') && msg.includes('smtp'), msg.slice(0, 160));
}

// ─── битый конфиг: каждое поле со своей ошибкой ──────────────────────────────
{
  writeMails({ a: { preset: 'yandex', user: 'x@x.ru', password: 'p', imap: 'imap.x.ru', smtp: 'smtp.x.ru' } });
  check('поле preset больше не знает — отказ', (await errOf('boxes')).includes('неизвестные поля "preset"'));
  writeMails({ a: { user: 'x@x.ru' } });
  check('нет password/imap/smtp — сначала user/password', (await errOf('boxes')).includes('"user" и "password"'));
  writeMails({ a: { user: 'x@corp.ru', password: 'p' } });
  check('без imap/smtp — отказ', (await errOf('boxes')).includes('"imap" (входящая почта) и "smtp"'));
  writeMails({ a: { user: 'x', password: 'p', imap: 'imap.x.ru', smtp: 'smtp.x.ru', fromName: 'Я' } });
  check('лишнее поле в ящике', (await errOf('boxes')).includes('неизвестные поля "fromName"'));
  writeMails({ a: { user: 'x', password: 'p', imap: 'imap.x.ru', smtp: 'smtp.x.ru', port: 'девятьсот' } });
  check('порт не число', (await errOf('boxes')).includes('"port"'));
  writeMails({ a: { user: 'x', password: 'p', imap: 'imap.x.ru', smtp: 'smtp.x.ru', tlsNoVerify: 'конечно' } });
  check('tlsNoVerify не булево — отказ', (await errOf('boxes')).includes('"tlsNoVerify" должен быть true или false'));
  writeFileSync(projFile, 'это не json'); // битый project.json
  check('битый json', (await errOf('boxes')).includes('кривой JSON'));
}

// ─── валидный конфиг: два ящика ──────────────────────────────────────────────
{
  writeMails({
    личное: { user: 'я@yandex.ru', password: 'секрет-1', imap: 'imap.yandex.ru', smtp: 'smtp.yandex.ru' },
    работа: { user: 'я@corp.ru', password: 'секрет-2', imap: 'imap.corp.ru', smtp: 'smtp.corp.ru', smtpPort: 587, tlsNoVerify: true },
  });
  const boxes = await run('boxes');
  check('boxes: оба ящика с хостами', boxes.includes('личное — я@yandex.ru (imap: imap.yandex.ru') && boxes.includes('smtp.corp.ru'), boxes);
  check('boxes: пароли не светятся', !boxes.includes('секрет-1') && !boxes.includes('секрет-2'), boxes);

  check('list без имени при двух ящиках — отказ', (await errOf('list')).includes('укажите ящик'));
  check('list неизвестный ящик', (await errOf('list черновики')).includes('ящика «черновики» нет — есть:'));
}

// ─── check(): вердикты ───────────────────────────────────────────────────────
{
  for (const [body, label] of [
    ['boxes', 'boxes'],
    ['list личное', 'list'],
    ['find личное счет', 'find'],
    ['read личное 42', 'read'],
  ] as const) {
    check(`check: ${label} — allow`, tool.check(body) === 'allow', String(tool.check(body)));
  }
  check('check: send — ask (наружу только с y/n)', tool.check('send личное') === 'ask', String(tool.check('send личное')));
  const bad = tool.check('frobnicate');
  check('check: ерунда — deny', typeof bad === 'object' && 'deny' in bad, String(bad));
}

// ─── send: разбор шапки и пути (до сети не доходит) ──────────────────────────
{
  writeFileSync(join(cwd, 'акт.pdf'), '%PDF-1.4', 'utf8');
  check('send: нет кому', (await errOf('send личное\nтема: Привет\n\nтекст')).includes('кому:'));
  check('send: пустое тело', (await errOf('send личное\nкому: a@b.ru\n\n')).includes('тело письма пустое'));
  check('send: кривая строка шапки', (await errOf('send личное\nотправь скорее\n\nтекст')).includes('шапки'));
  check('send: файл наружу', (await errOf('send личное\nкому: a@b.ru\nфайлы: ../секрет.txt\n\nтекст')).includes('вне рабочей папки'));
  check('send: секретный файл', (await errOf('send личное\nкому: a@b.ru\nфайлы: .env\n\nтекст')).includes('секретный'));
}

// ─── прикладные папки проекта: префиксы inbox/mail/images ведут в дом ────────
{
  const { attachmentPath } = await import('../src/tools/mail/mail.js');
  const { pathScan } = await import('../src/tools-api.js');
  const store = join(home, 'projects', 'dev');
  check('attachmentPath: images/… — папка проекта в доме', attachmentPath(cwd, 'images/pic.png') === join(store, 'images', 'pic.png'), attachmentPath(cwd, 'images/pic.png'));
  check('attachmentPath: inbox/… — тоже дом', attachmentPath(cwd, 'inbox/акт.pdf') === join(store, 'inbox', 'акт.pdf'));
  check('attachmentPath: обычный путь — рабочая папка', attachmentPath(cwd, 'акт.pdf') === join(cwd, 'акт.pdf'));
  check('pathScan: абсолютный путь в прикладное проекта — можно', pathScan(`type "${join(store, 'inbox', 'акт.pdf')}"`, cwd, store) === null, String(pathScan(`type "${join(store, 'inbox', 'акт.pdf')}"`, cwd, store)));
  check('pathScan: project.json — нельзя', pathScan(`type "${projFile}"`, cwd, store) !== null, String(pathScan(`type "${projFile}"`, cwd, store)));
  check('pathScan: sessions/ — нельзя', pathScan(`type "${join(store, 'sessions', 'x.json')}"`, cwd, store) !== null);
  check('pathScan: models/ дома — нельзя', pathScan(`type "${join(home, 'models', 'mock.json')}"`, cwd, store) !== null);
}

// ─── resolveEndpoints: явные хосты и переопределения ─────────────────────────
{
  const accounts = loadAccounts();
  const yandex = resolveEndpoints(accounts['личное']!);
  check('хосты из конфига', yandex.imap.host === 'imap.yandex.ru' && yandex.smtp.host === 'smtp.yandex.ru', JSON.stringify(yandex));
  check('порты 993/465 secure по умолчанию', yandex.imap.port === 993 && yandex.imap.secure && yandex.smtp.port === 465 && yandex.smtp.secure);
  const corp = resolveEndpoints(accounts['работа']!);
  check('порт smtp 587 → без implicit TLS', corp.smtp.port === 587 && !corp.smtp.secure && corp.imap.secure, JSON.stringify(corp));
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
const { rmTemp } = await import('./rm-tmp.js');
rmTemp(cwd);
rmTemp(home);
