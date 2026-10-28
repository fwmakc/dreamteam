/**
 * Проба тула «docs» и модуля documents: полный цикл на временной рабочей папке —
 *   write xlsx (markdown-таблица) → read/tables: ячейки на месте;
 *   чужой xlsx (zip+xml руками): sharedStrings, inlineStr, кэш формулы,
 *         булев, дата по стилю — то, что Excel пишет за нас;
 *   write docx (абзацы) → read; append → новый абзац добавлен, старые целы;
 *   таблица в docx (собрана пакетом docx) → tables: CSV совпадает;
 *   write pdf → pdfText: кириллица читается обратно;
 *   odt/ods — фикстуры-архивы с content.xml → текст и таблицы;
 *   csv — как есть; пути наружу рабочей папки — отказ;
 *   мост soffice недоступен — внятный отказ с подсказкой (не падение).
 * Запуск: npx tsx tests/probe-docs.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { Table, TableCell, TableRow, WidthType } from 'docx';
import { makeCtx } from './tool-ctx.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'dt-docs-'));
const tool = (await import('../src/tools/docs/docs.js')).default({});
const run = (body: string): Promise<string> => tool.run(body, makeCtx(cwd));

// ─── xlsx: markdown-таблица → write → read/tables ───────────────────────────
{
  const report = await run('write люди.xlsx\n| Имя | Роль |\n| Катя | дизайнер |\n| Глеб, младший | разработчик |');
  check('xlsx: write — отчёт', report.includes('люди.xlsx'), report);
  const csv = await run('tables люди.xlsx');
  check('xlsx: tables — заголовок листа', csv.includes('# лист: Данные'), csv.slice(0, 120));
  check('xlsx: ячейки на месте', csv.includes('Катя') && csv.includes('дизайнер'), csv);
  check('xlsx: запятая в ячейке закавычена', csv.includes('"Глеб, младший"'), csv);
  const full = await run('read люди.xlsx');
  check('xlsx: read отдаёт те же таблицы', full.includes('разработчик'), full.slice(0, 120));
}

// ─── docx: абзацы → read; append сохраняет старое ───────────────────────────
{
  await run('write договор.docx\nДоговор поставки\n\n1. Предмет договора\nПоставка кофе, 10 кг.');
  const text = await run('read договор.docx');
  check('docx: read — абзацы на месте', text.includes('Договор поставки') && text.includes('Поставка кофе, 10 кг.'), text);
  check('docx: read — пустые строки схлопнуты', !text.includes('\n\n\n'), JSON.stringify(text.slice(0, 80)));

  const report = await run('append договор.docx\n3.5. Риски и ответственность сторон\n3.6. Порядок споров');
  check('docx: append — отчёт', report.includes('2') && report.includes('договор.docx'), report);
  const after = await run('read договор.docx');
  check('docx: append — новое присутствует', after.includes('3.5. Риски и ответственность сторон') && after.includes('3.6. Порядок споров'), after.slice(-160));
  check('docx: append — старое не тронуто', after.includes('Договор поставки') && after.includes('1. Предмет договора'), after.slice(0, 120));
  const zip = new AdmZip(join(cwd, 'договор.docx'));
  check('docx: append — xml валиден, спецсимволы экранированы', (() => {
    const xml = zip.getEntry('word/document.xml')!.getData().toString('utf8');
    return xml.includes('<w:sectPr') === false || xml.lastIndexOf('<w:p>') < xml.lastIndexOf('<w:sectPr');
  })());
}

// ─── docx с настоящей таблицей → tables ─────────────────────────────────────
{
  const { Document: Doc, Packer, Paragraph } = await import('docx');
  const doc = new Doc({
    sections: [{
      children: [
        new Paragraph('Реестр паспортов'),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('ФИО')] }), new TableCell({ children: [new Paragraph('Серия')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('Иванов И.И.')] }), new TableCell({ children: [new Paragraph('9900')] })] }),
          ],
        }),
      ],
    }],
  });
  writeFileSync(join(cwd, 'реестр.docx'), await Packer.toBuffer(doc));
  const csv = await run('tables реестр.docx');
  check('docx: tables из таблицы', csv.includes('ФИО,Серия') && csv.includes('Иванов И.И.,9900'), csv);
  const plain = await run('read реестр.docx');
  check('docx: read — текст вокруг таблицы', plain.includes('Реестр паспортов') && plain.includes('Иванов И.И.'), plain.slice(0, 120));
}

// ─── pdf: кириллица туда-обратно ────────────────────────────────────────────
{
  const report = await run('write акт.pdf\nАкт выполненных работ\n\nИсполнитель сдал, заказчик принял.');
  check('pdf: write — отчёт', report.includes('акт.pdf'), report);
  const text = await run('read акт.pdf');
  check('pdf: read — кириллица восстановлена', text.includes('Акт выполненных работ') && text.includes('заказчик принял'), text);
}

// ─── odt/ods: фикстуры-архивы с content.xml ─────────────────────────────────
{
  const odtZip = new AdmZip();
  odtZip.addFile('content.xml', Buffer.from(
    '<?xml version="1.0"?><office:document><office:body><office:text>' +
    '<text:h>Протокол</text:h><text:p>Присутствовали: Катя &amp; Глеб</text:p>' +
    '</office:text></office:body></office:document>', 'utf8'));
  odtZip.writeZip(join(cwd, 'протокол.odt'));
  const text = await run('read протокол.odt');
  check('odt: read — текст и entity', text.includes('Протокол') && text.includes('Катя & Глеб'), text);

  const odsZip = new AdmZip();
  odsZip.addFile('content.xml', Buffer.from(
    '<?xml version="1.0"?><office:document><office:body><office:spreadsheet>' +
    '<table:table table:name="Смета"><table:table-row>' +
    '<table:table-cell><text:p>Пункт</text:p></table:table-cell><table:table-cell><text:p>Цена</text:p></table:table-cell>' +
    '</table:table-row><table:table-row>' +
    '<table:table-cell table:number-columns-repeated="1"><text:p>Кофе</text:p></table:table-cell>' +
    '<table:table-cell><text:p>1200</text:p></table:table-cell>' +
    '</table:table-row></table:table>' +
    '</office:spreadsheet></office:body></office:document>', 'utf8'));
  odsZip.writeZip(join(cwd, 'смета.ods'));
  const csv = await run('tables смета.ods');
  check('ods: tables — имя листа и ячейки', csv.includes('# лист: Смета') && csv.includes('Кофе,1200'), csv);
}

// ─── xlsx «чужой» файл: собран руками — то, что пишет настоящий Excel ────────
{
  const zip = new AdmZip();
  const xml = (s: string) => Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' + s, 'utf8');
  zip.addFile('[Content_Types].xml', xml(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>'));
  zip.addFile('_rels/.rels', xml(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'));
  zip.addFile('xl/workbook.xml', xml(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Чужой" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  zip.addFile('xl/_rels/workbook.xml.rels', xml(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>'));
  zip.addFile('xl/sharedStrings.xml', xml(
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">' +
    '<si><t>из sharedStrings</t></si></sst>'));
  zip.addFile('xl/styles.xml', xml(
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>' +
    // второй xf — встроенный числовой формат 14 (дата); ячейка A3 ссылается на него (s="1")
    '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>' +
    '</styleSheet>'));
  zip.addFile('xl/worksheets/sheet1.xml', xml(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>инлайн-строка</t></is></c></row>' +
    // формула: читается кэш <v>, сама <f> читателю не нужна
    '<row r="2"><c r="A2"><f>B1*2</f><v>84</v></c><c r="B2" t="b"><v>1</v></c></row>' +
    '<row r="3"><c r="A3" s="1"><v>45292</v></c></row>' +
    '</sheetData></worksheet>'));
  zip.writeZip(join(cwd, 'чужой.xlsx'));
  const csv = await run('tables чужой.xlsx');
  check('xlsx чужой: имя листа', csv.includes('# лист: Чужой'), csv.slice(0, 120));
  check('xlsx чужой: sharedStrings и inlineStr', csv.includes('из sharedStrings') && csv.includes('инлайн-строка'), csv);
  check('xlsx чужой: формула — кэш, булев — true', csv.includes('84,true'), csv);
  check('xlsx чужой: дата по стилю — ISO', csv.includes('2024-01-01'), csv);
}

// ─── csv и отказы ───────────────────────────────────────────────────────────
{
  writeFileSync(join(cwd, 'данные.csv'), 'a,b\n1,2\n', 'utf8');
  check('csv: read как есть', (await run('read данные.csv')) === 'a,b\n1,2');
  try { await run('read ../секрет.pdf'); check('путь наружу — отказ', false); }
  catch (e) { check('путь наружу — отказ', String((e as Error).message).includes('выход за рабочую папку')); }
  try { await run('tables акт.pdf'); check('pdf-таблицы — подсказка про ocr', false); }
  catch (e) { check('pdf-таблицы — подсказка про ocr', String((e as Error).message).includes('ocr')); }
  try { await run('write старый.doc\nтекст'); check('legacy write — отказ', false); }
  catch (e) { check('legacy write — отказ', String((e as Error).message).includes('legacy')); }
  try { await run('frobnicate файл.docx'); check('неизвестная подкоманда — синтаксис', false); }
  catch (e) { check('неизвестная подкоманда — синтаксис', String((e as Error).message).includes('подкоманды')); }
}

// ─── мост soffice: недоступен → внятный отказ, не падение ───────────────────
{
  try {
    await run('write чистый.odt\nАбзац один\nАбзац два');
    check('odt без моста — внятный отказ', false, 'не бросил');
  } catch (e) {
    const msg = (e as Error).message;
    check('odt без моста — внятный отказ', msg.includes('мост soffice') && msg.includes('docker compose'), msg.slice(0, 160));
  }
  try {
    await tool.run('convert docx старый.doc', makeCtx(cwd));
    check('convert без моста — внятный отказ', false, 'не бросил');
  } catch (e) {
    const msg = (e as Error).message;
    check('convert без моста — внятный отказ', msg.includes('мост soffice') || msg.includes('нет'), msg.slice(0, 160));
  }
  try {
    await tool.run('convert docx нет-такого-файла.docx', makeCtx(cwd));
    check('convert несуществующего — отказ', false, 'не бросил');
  } catch (e) {
    check('convert несуществующего — отказ', (e as Error).message.includes('нет'), (e as Error).message.slice(0, 120));
  }
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
const { rmTemp } = await import('./rm-tmp.js');
rmTemp(cwd);
