/**
 * Боевые сценарии на реальных моделях и данных. НЕ входит в npm run probe:
 * тратит токены провайдера, ходит в боевую почту и в интернет, читает и
 * создаёт файлы в настоящем проекте. Запуск руками:
 *
 *   npx tsx tests/scenarios-live.ts          — все сценарии
 *   npx tsx tests/scenarios-live.ts 2 3      — только выбранные
 *
 * Сценарии: 1 Елена docx→md→pdf · 2 Андрей ocr скана ДДУ · 3 Тимур web
 * consultant.ru · 4 Андрей письмо с вложением · 5 Ольга проверка почты.
 *
 * Требует: дом ~/.dreamteam (провайдер с ключом), поле "mails" в project.json
 * проекта рабочей папки — с ящиками test1/test2 (tlsNoVerify при чужом
 * сертификате хостера),
 * у агентов — тула (elena: files+docs; andrey: files+ocr+mail;
 * olga: files+mail; timur: web с sites consultant.ru).
 *
 * Слои: проекты живут в доме, поэтому драйвер открывает проект рабочей папки
 * (известен дому — откроется, нет — зарегистрируется), рабочая папка
 * инструментов — cwd процесса, поэтому драйвер делает chdir в корень проекта.
 * Дом не подменяем: реальный провайдер. Каждый прогон создаёт свежий
 * разговор — его можно открыть в приложении и прочитать переписку целиком.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const proj = 'C:\\Users\\user\\project'; // рабочая папка агентов (cwd)
process.chdir(proj);
// DT_HOME не подменяем: реальный дом, реальные ящики, реальный провайдер.

const only = process.argv.slice(2).map(Number);
const want = (n: number): boolean => only.length === 0 || only.includes(n);

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const notices: string[] = [];
const errors: string[] = [];
const tools: string[] = [];
const reply: { text: string } = { text: '' };
const sink = { delta() {}, done() {} };
const stub = {
  notice(text: string) { notices.push(text); },
  error(text: string) { errors.push(text); },
  turnHeader(_a: unknown) {},
  busy(_l: string) { return { stop() {} }; },
  stream(_l: string) { return sink; },
  turnEnd(full: string) { reply.text += full; },
  say(text: string) { reply.text += text; },
  toolLines(rows: string[]) { tools.push(...rows); },
  attachment(_t: string, _d: string) {},
  // отправка почты — «ask»: драйвер отвечает «да» за хозяина
  async confirm() { return true; },
  async chooseSession() { return null; },
  sessionOpened() {},
};

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
import type { Presenter } from '../src/core/presenter.js';

const { app } = await bootstrapApp();
const engine = new Engine(app, stub as unknown as Presenter);
// проект рабочей папки: известен дому — откроется, нет — зарегистрируется
engine.switchProject(proj);
// свежий разговор на прогон: сценарии не подмешиваются в переписку хозяина
app.session = app.store!.create();
app.store!.save(app.session!);
console.log(`Разговор сценария: ${app.session.id} (${app.session.title})`);

const round = async (agent: string, text: string, ms = 300_000): Promise<void> => {
  notices.length = 0; errors.length = 0; tools.length = 0; reply.text = '';
  app.session!.participants = [agent];
  app.store!.save(app.session!);
  const started = Date.now();
  process.stdout.write(`\n[${agent}] ${text.slice(0, 90)}…\n`);
  try {
    await engine.handleMessage(text, AbortSignal.timeout(ms));
  } catch (err) {
    console.log(`  !! раунд упал: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`  (${Math.round((Date.now() - started) / 1000)} с, тулов: ${tools.length})`);
  console.log(reply.text.trim().slice(0, 1200) || '(ответа нет)');
  for (const e of errors) console.log(`  [ошибка] ${e.slice(0, 300)}`);
};

if (want(1)) {
  console.log('\nСценарий 1: Елена — docx → резюме.md → PDF');
  await round('elena',
    'В рабочей папке лежит исковое заявление «isk-o-priznanii-sdelok-s-kvartiroj-nedejstvitelnymi.docx». ' +
    'Работай тула́ми: (1) прочитай иск тулом docs; (2) напиши краткое резюме в файл «rezume-iska.md» тулом files — ' +
    'суть спора, истец и ответчик, требования, куда подан; (3) из текста этого резюме создай PDF-версию ' +
    '«rezume-iska.pdf» тулом docs (write). В конце — короткий итог, что сделано.');
  const md = join(proj, 'rezume-iska.md');
  const pdf = join(proj, 'rezume-iska.pdf');
  check('1. резюме-иска.md создан и не пуст', existsSync(md) && statSync(md).size > 200,
    existsSync(md) ? `${statSync(md).size} байт` : 'файла нет');
  check('2. rezume-iska.pdf создан и начинается с %PDF', existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === '%PDF-',
    existsSync(pdf) ? `${statSync(pdf).size} байт` : 'файла нет');
}

if (want(2)) {
  console.log('\nСценарий 2: Андрей — распознавание скана ДДУ (ocr)');
  await round('andrey',
    'В рабочей папке лежит скан договора «2_ДДУ Ховряков Александр Николаевич кв. 15 К.17.pdf». ' +
    'Распознай первые три страницы тулом ocr (text, страницы «1-3»; имя файла с пробелами — в кавычках) ' +
    'и выпиши тулом files в файл «karkas-ddu.md»: номер и дату договора, стороны, объект (адрес/квартиру), ' +
    'цену договора. Если какого-то реквизита на этих страницах нет — так и напиши.', 420_000);
  const ddu = join(proj, 'karkas-ddu.md');
  check('3. karkas-ddu.md создан и не пуст', existsSync(ddu) && statSync(ddu).size > 200,
    existsSync(ddu) ? `${statSync(ddu).size} байт` : 'файла нет');
}

if (want(3)) {
  console.log('\nСценарий 3: Тимур — серфинг consultant.ru за статьями ГК');
  await round('timur',
    'Проверь правовую основу для иска о признании сделок с квартирой недействительными: нужны точные ' +
    'формулировки статей 166 и 168 ГК РФ с consultant.ru. Маршрут: главная страница раздела ' +
    'https://www.consultant.ru/document/ рисуется скриптами — не трать на неё шаги, часть первая ГК живёт ' +
    'на https://www.consultant.ru/document/cons_doc_LAW_5142/. Дальше вниз по ссылкам (web links с фильтром ' +
    'по названию): Раздел I → подраздел «Сделки. Решения собраний. Представительство» → Глава 9 → ' +
    '§ 2 «Недействительность сделок» → статьи 166 и 168 (web read). Цитаты со ссылками (url) запиши тулом ' +
    'files в файл «gk-statyi.md». В ответе — короткий итог.', 420_000);
  const gk = join(proj, 'gk-statyi.md');
  check('4. gk-statyi.md создан, есть ссылки на consultant.ru и обе статьи',
    existsSync(gk) && /consultant\.ru/.test(readFileSync(gk, 'utf8')) && /166/.test(readFileSync(gk, 'utf8')) && /168/.test(readFileSync(gk, 'utf8')),
    existsSync(gk) ? readFileSync(gk, 'utf8').slice(0, 200) : 'файла нет');
}

if (want(4)) {
  console.log('\nСценарий 4: Андрей — отправка письма с вложением');
  await round('andrey',
    'Отправь письмо с ящика test1 на адреса test2@doy14pyatigorsk.ru, fwmakcpro@yandex.ru ' +
    'с темой «Резюме иска (тест почты)» и вложенным файлом «rezume-iska.pdf» из рабочей папки. ' +
    'Текст письма — 2-3 строки: что это за файл и кто его подготовил.', 240_000);
  check('5. тул mail отчитался об отправке', /отправлено/i.test(reply.text + tools.join(' ')),
    (reply.text + tools.join(' ')).slice(0, 200));
}

if (want(5)) {
  console.log('\nСценарий 5: Ольга — проверка почты и сохранение вложения');
  await round('olga',
    'Проверь почту на ящике test2 тулом mail: найди письмо с темой «Резюме иска» (find), ' +
    'прочитай его целиком (read), вложение должно сохраниться. В ответе — от кого письмо, тема, ' +
    'текст письма и куда сохранилось вложение.', 240_000);
  const mailDir = join(proj, 'mail');
  const got = existsSync(mailDir) ? readdirSync(mailDir) : [];
  check('6. вложение сохранилось в mail/ рабочей папки', got.length > 0, got.join(', ') || 'папки/файлов нет');
}

console.log('\nФайлы рабочей папки после сценариев:');
for (const f of readdirSync(proj)) {
  const p = join(proj, f);
  if (statSync(p).isFile()) console.log(`  ${f} — ${statSync(p).size} байт`);
}

writeFileSync(join(proj, 'scenarios-live-evidence.json'), JSON.stringify({ заметки: notices, ошибки: errors, тула: tools }, null, 2));

console.log(fails === 0 ? '\nВсе сценарии прошли' : `\nПровалено проверок: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
