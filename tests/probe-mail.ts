/**
 * Проба тула «mail» — офлайн: реальных серверов не касаемся.
 *   конфиг mail.json проекта (служебная папка .dreamteam): нет файла, битые
 *   поля, пресеты, custom;
 *   boxes — имена и хосты, пароли не светятся; выбор ящика при нескольких;
 *   check(): чтение — allow, send — ask, ерунда — deny;
 *   send: шапка кому:/тема:/файлы:, пустое тело, пути наружу и секреты;
 *   resolveEndpoints — адреса пресетов и переопределения портов.
 * Запуск: npx tsx tests/probe-mail.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DT_HOME и DT_PROJECT читаются при импорте paths — подменяем до загрузки модулей
const home = mkdtempSync(join(tmpdir(), 'dt-mail-home-'));
process.env.DT_HOME = home;
const proj = mkdtempSync(join(tmpdir(), 'dt-mail-proj-'));
process.env.DT_PROJECT = proj;

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'dt-mail-cwd-'));
const mailFile = join(proj, 'mail.json');
const { default: makeTool } = await import('../src/tools/mail/mail.js');
const { resolveEndpoints, loadAccounts } = await import('../src/mail.js');

const tool = makeTool({});
const run = (body: string): Promise<string> =>
  tool.run(body, { cwd, run: async () => ({ ok: true, output: '' }), http: async () => ({ ok: true, output: '' }), confirm: async () => false });
const errOf = async (body: string): Promise<string> => {
  try {
    await run(body);
    return '(не бросил)';
  } catch (e) {
    return String((e as Error).message);
  }
};

// ─── нет mail.json ───────────────────────────────────────────────────────────
{
  const msg = await errOf('boxes');
  check('нет mail.json — отказ с примером', msg.includes('mail.json') && msg.includes('preset'), msg.slice(0, 160));
}

// ─── битый конфиг: каждое поле со своей ошибкой ──────────────────────────────
{
  writeFileSync(mailFile, JSON.stringify({ a: { preset: 'outlook', user: 'x@x.ru', password: 'p' } }));
  check('неизвестный пресет', (await errOf('boxes')).includes('preset «outlook» не знаю'));
  writeFileSync(mailFile, JSON.stringify({ a: { preset: 'gmail' } }));
  check('нет user/password', (await errOf('boxes')).includes('"user" и "password"'));
  writeFileSync(mailFile, JSON.stringify({ a: { preset: 'custom', user: 'x@corp.ru', password: 'p' } }));
  check('custom без host/smtpHost', (await errOf('boxes')).includes('"host" (IMAP) и "smtpHost"'));
  writeFileSync(mailFile, JSON.stringify({ a: { preset: 'gmail', user: 'x', password: 'p', fromName: 'Я' } }));
  check('лишнее поле в ящике', (await errOf('boxes')).includes('неизвестные поля "fromName"'));
  writeFileSync(mailFile, JSON.stringify({ a: { preset: 'gmail', user: 'x', password: 'p', port: 'девятьсот' } }));
  check('порт не число', (await errOf('boxes')).includes('"port"'));
  writeFileSync(mailFile, JSON.stringify({ a: { preset: 'gmail', user: 'x', password: 'p', tlsNoVerify: 'конечно' } }));
  check('tlsNoVerify не булево — отказ', (await errOf('boxes')).includes('"tlsNoVerify" должен быть true или false'));
  writeFileSync(mailFile, 'это не json');
  check('битый json', (await errOf('boxes')).includes('кривой JSON'));
}

// ─── валидный конфиг: два ящика ──────────────────────────────────────────────
{
  writeFileSync(mailFile, JSON.stringify({
    личное: { preset: 'yandex', user: 'я@yandex.ru', password: 'секрет-1' },
    работа: { preset: 'custom', user: 'я@corp.ru', password: 'секрет-2', host: 'imap.corp.ru', smtpHost: 'smtp.corp.ru', smtpPort: 587, tlsNoVerify: true },
  }));
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

// ─── resolveEndpoints: пресеты и переопределения ─────────────────────────────
{
  const accounts = loadAccounts();
  const yandex = resolveEndpoints(accounts['личное']!);
  check('пресет yandex: адреса', yandex.imap.host === 'imap.yandex.ru' && yandex.smtp.host === 'smtp.yandex.ru', JSON.stringify(yandex));
  check('пресет yandex: порты 993/465 secure', yandex.imap.port === 993 && yandex.imap.secure && yandex.smtp.port === 465 && yandex.smtp.secure);
  const corp = resolveEndpoints(accounts['работа']!);
  check('custom: хосты из конфига', corp.imap.host === 'imap.corp.ru' && corp.smtp.host === 'smtp.corp.ru');
  check('custom: smtpPort 587 → без implicit TLS', corp.smtp.port === 587 && !corp.smtp.secure && corp.imap.secure, JSON.stringify(corp));
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
const { rmTemp } = await import('./rm-tmp.js');
rmTemp(cwd);
rmTemp(home);
rmTemp(proj);
