/**
 * Локальная проба на реальных документах из data/ (папка в .gitignore — в гит
 * не входит): золотой мастер для движка документов.
 *   xlsx  «Расчет задолженности Остапенко.xlsx» — настоящий Excel: объединённые
 *         ячейки, шапки-«простыни», числа с точкой, текстовые суммы;
 *   docx  иск — текстовые якоря сверены с оракулом rezume-iska.md;
 *   pdf   согласие на обработку ПДн — текстовый слой.
 * Замена движка чтения/записи (exceljs → read-excel-file/write-excel-file)
 * обязана сохранить показания этой пробы. Объединённые ячейки: в самом файле
 * значение стоит только в мастер-ячейке, покрытые пусты (проба проверяет
 * именно это; старый exceljs размножал значение мастера по всему span —
 * артефакт, а не контракт). Хвостовые никогда не заполнявшиеся колонки
 * (AD–AF: только стиль, ни одного значения) читатель отбрасывает — ширина
 * по содержимому (29), а не 32, как материализовал exceljs.
 * Если data/ нет (CI, свежий клон) — пропуск с нулевым кодом выхода.
 * Запуск: npm run probe:data
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let fails = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const data = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const xlsxPath = join(data, 'Расчет задолженности Остапенко.xlsx');
const docxPath = join(data, 'isk-o-priznanii-sdelok-s-kvartiroj-nedejstvitelnymi.docx');
const pdfPath = join(data, '3СОГЛАСИЕ_на_обработку_персоональных_данных_Академия_3_2.pdf');
if (!existsSync(data) || (!existsSync(xlsxPath) && !existsSync(docxPath) && !existsSync(pdfPath))) {
  console.log('probe:data — папки data/ с образцами нет (для CI это норма): пропуск');
  process.exit(0);
}

const { xlsxSheets, docxText, docxTables, pdfText } = await import('../src/documents.js');

// ─── xlsx: настоящий расчёт ЖКУ ─────────────────────────────────────────────
if (existsSync(xlsxPath)) {
  const sheets = await xlsxSheets(xlsxPath);
  check('xlsx: один лист «Лист1»', sheets.length === 1 && sheets[0].name === 'Лист1', String(sheets.map((s) => s.name)));
  const s = sheets[0];
  const cols = s.rows[0]?.length ?? 0;
  check('xlsx: 416 строк × 29 колонок, прямоугольник', s.rows.length === 416 && s.rows.every((r) => r.length === cols) && cols === 29, `${s.rows.length}×${cols}`);
  const title = s.rows[0][2];
  check(
    'xlsx: титул в мастер-ячейке C1, покрытые пусты',
    title.includes('Расчет задолженности за период с 01.10.2023') &&
      title.includes('ИНН 7743416690') &&
      title.includes('Остапенко Татьяны Алексеевны') &&
      title.includes('по договору Договор управления от 01 октября 2023г.') &&
      s.rows[0][9] === '',
    JSON.stringify(title.slice(0, 120)),
  );
  check(
    'xlsx: месяц и акт',
    s.rows[5][1] === 'за октябрь 2023 года' && s.rows[5][2] === 'за октябрь 2023 г.' && s.rows[5][4] === 'Акт № 12 от 31 октября 2023 г.',
    JSON.stringify([s.rows[5][1], s.rows[5][2], s.rows[5][4]]),
  );
  check(
    'xlsx: шапка таблицы (мастера объединений)',
    s.rows[6][0] === '№' && s.rows[6][2] === 'Наименование работ, услуг' && s.rows[6][19] === 'Кол-во' && s.rows[6][22] === 'Ед.' && s.rows[6][24].startsWith('Це'),
    JSON.stringify([s.rows[6][0], s.rows[6][2], s.rows[6][19], s.rows[6][22], s.rows[6][24]]),
  );
  check(
    'xlsx: первая услуга',
    s.rows[8][0] === '1' && s.rows[8][2].startsWith('Содержание, техническое обслуживание'),
    JSON.stringify([s.rows[8][0], s.rows[8][2]?.slice(0, 60)]),
  );
  check('xlsx: число — строка с точкой', s.rows[16][19] === '0.128', String(s.rows[16][19]));
  check(
    'xlsx: итоги — мастер и текстовая сумма',
    s.rows[20][19] === 'Итого за 10.2023' && s.rows[20][27] === 'Итого:' && s.rows[20][28] === '5 763,42',
    JSON.stringify([s.rows[20][19], s.rows[20][27], s.rows[20][28]]),
  );
  const last = s.rows[s.rows.length - 1][2];
  check('xlsx: последняя строка — отопление за ноябрь 2025', last.startsWith('Отопление') && last.includes('ноябрь 2025'), JSON.stringify(last.slice(0, 60)));
}

// ─── docx: иск (оракул — rezume-iska.md) ────────────────────────────────────
if (existsSync(docxPath)) {
  const text = await docxText(docxPath);
  check('docx: шапка — Дорогомиловский суд', text.includes('Дорогомиловский районный суд'), text.slice(0, 80));
  check('docx: предмет иска', text.includes('ИСКОВОЕ ЗАЯВЛЕНИЕ') && text.includes('признании сделки недействительной'), text.slice(0, 200));
  check('docx: стороны и представитель', text.includes('У.В.В.') && text.includes('Щ.А.А.') && text.includes('ХоруженкоА.С.'), text.slice(0, 200));
  check('docx: квартира и первый ДКП', text.includes('Кутузовский проспект') && text.includes('16.02.2012'), '');
  check('docx: оспариваемые сделки и ЕГРП', text.includes('20.09.2012') && text.includes('12.10.2012') && text.includes('ЕГРП') && text.includes('Постановления'), '');
  check('docx: хвост — подпись и дата', text.trimEnd().endsWith('14.11.2012 г.'), JSON.stringify(text.slice(-40)));
  try {
    await docxTables(docxPath);
    check('docx: таблиц нет — честный отказ', false, 'не бросил');
  } catch (e) {
    check('docx: таблиц нет — честный отказ', (e as Error).message.includes('таблиц не найдено'), (e as Error).message);
  }
}

// ─── pdf: согласие на обработку ПДн ────────────────────────────────────────
if (existsSync(pdfPath)) {
  const text = await pdfText(pdfPath);
  check('pdf: текстовый слой существенный', text.length > 3000, String(text.length));
  check('pdf: заголовок согласия', text.includes('СОГЛАСИЕ') && text.includes('НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ'), text.slice(0, 80));
  check('pdf: оператор и адрес', text.includes('Академия') && text.includes('Ростовская') && text.includes('Оператор'), '');
  check('pdf: сайт оферты', text.includes('lms.1t.ru'), '');
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
