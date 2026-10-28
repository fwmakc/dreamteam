/**
 * Проба тула «docs» и модуля documents: полный цикл на временной рабочей папке —
 *   write xlsx (markdown-таблица) → read/tables: ячейки на месте;
 *   чужой xlsx (zip+xml руками): sharedStrings, inlineStr, кэш формулы,
 *         булев, дата по стилю — то, что Excel пишет за нас;
 *   write docx из markdown (# заголовок) → read; append с markdown-блоками → XML;
 *   md: юнит-проверки parseMd (цитаты, код-блоки, линия, экранирование,
 *         вложенные списки, таблицы с \| и выравниванием, картинки в notes);
 *   md → docx богатый: XML (заголовки, начертания, код, гиперссылка, нумерация)
 *         + золотой круг md → docx → md — структура блоков совпадает;
 *   экранирование \* и \. — литеральные звёздочка и точка;
 *   md → xlsx: листы из «# имя», жирная шапка; roundtrip xlsx → md → xlsx;
 *   md → pdf (заголовки/списки/цитата/код-блок/таблица) → read;
 *   таблица в docx (собрана пакетом docx) → tables: CSV совпадает;
 *   write pdf → pdfText: кириллица читается обратно;
 *   odt/ods — фикстуры-архивы с content.xml → текст и таблицы;
 *   csv — как есть; пути наружу рабочей папки — отказ;
 *   мост soffice недоступен — внятный отказ с подсказкой (не падение);
 *   convert docx→pdf без моста — нативный фолбэк через markdown.
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

// ─── docx: markdown → write → read; append с markdown-блоками ───────────────
{
  await run('write договор.docx\n# Договор поставки\n\nРаздел 1. Предмет договора\nПоставка кофе, 10 кг.');
  const text = await run('read договор.docx');
  check('docx: read — абзацы на месте', text.includes('Договор поставки') && text.includes('Поставка кофе, 10 кг.'), text);
  check('docx: read — пустые строки схлопнуты', !text.includes('\n\n\n'), JSON.stringify(text.slice(0, 80)));

  const report = await run('append договор.docx\n3.5. Риски и ответственность сторон\n3.6. Порядок споров');
  check('docx: append — отчёт со счётчиком строк', report.includes('2') && report.includes('договор.docx'), report);
  const after = await run('read договор.docx');
  check('docx: append — новое присутствует', after.includes('3.5. Риски и ответственность сторон') && after.includes('3.6. Порядок споров'), after.slice(-160));
  check('docx: append — старое не тронуто', after.includes('Договор поставки') && after.includes('Раздел 1. Предмет договора'), after.slice(0, 120));
  const zip0 = new AdmZip(join(cwd, 'договор.docx'));
  const xml0 = zip0.getEntry('word/document.xml')!.getData().toString('utf8');
  check('docx: write — заголовок стилем Heading1', xml0.includes('w:val="Heading1"'), xml0.slice(0, 300));
  check('docx: append — «3.5.» сохранено буквально', xml0.includes('3.5. Риски'), xml0.slice(-300));
  check('docx: append — вставка перед sectPr', !xml0.includes('<w:sectPr') || xml0.lastIndexOf('<w:p>') < xml0.lastIndexOf('<w:sectPr'));
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

// ─── md: юнит-проверки парсера ──────────────────────────────────────────────
{
  const { parseMd } = await import('../src/md.js');
  const q = parseMd('> Раз строки\n> ещё строка\n>\n> второй').blocks[0];
  check(
    'md: цитата — строки подряд, пустая > — разрыв',
    q.kind === 'quote' && q.paragraphs.length === 3 && (q.paragraphs[0][0]?.text ?? '') === 'Раз строки' && (q.paragraphs[2][0]?.text ?? '') === 'второй',
    JSON.stringify(q),
  );
  const fence = parseMd('```\nкод <>&\n```').blocks[0];
  check('md: код-блок целиком, без разбора тегов', fence.kind === 'code' && fence.text === 'код <>&', JSON.stringify(fence));
  const kinds = parseMd('текст\n\n---\n\nещё').blocks.map((b) => b.kind);
  check('md: --- — линия', kinds.includes('hr'), JSON.stringify(kinds));
  const esc = parseMd('\\*не жирный\\* и 1\\. не список').blocks[0];
  const escLines = esc.kind === 'p' ? esc.lines : [];
  check(
    'md: экранирование \\* и \\.',
    esc.kind === 'p' && escLines[0].length === 1 && escLines[0][0].text === '*не жирный* и 1. не список',
    JSON.stringify(escLines),
  );
  const nest = parseMd('- верх\n  - низ\n1. раз\n2. два').blocks;
  check(
    'md: вложенность списков и исходный маркер',
    nest[0].kind === 'ul' && !!nest[0].items[0].sub && nest[1].kind === 'ol' && nest[1].items[1].marker === '2.',
    JSON.stringify(nest),
  );
  const tbl = parseMd('| a \\| б | в |\n| :--- | ---: |\n| 1 | 2 |').blocks[0];
  check(
    'md: таблица — \\| в ячейке, выравнивание из разделителя',
    tbl.kind === 'table' && tbl.aligns[0] === 'left' && tbl.aligns[1] === 'right' && tbl.header[0][0].text === 'a | б',
    JSON.stringify(tbl),
  );
  const img = parseMd('![подпись](фото.png)').notes.join(' | ');
  check('md: картинка — в notes, не в блоках', img.includes('подпись') && img.includes('фото.png'), img);
}

// ─── md → docx богатый: XML-проверки + золотой круг md → docx → md ──────────
{
  const golden = [
    '# Заголовок первый',
    '',
    'Абзац с **жирным**, *курсивом*, ***обоими*** и `инлайн-кодом`.',
    '',
    '## Заголовок второй',
    '',
    '- пункт первый',
    '- пункт второй',
    '  - вложенный пункт',
    '',
    '1. шаг раз',
    '2. шаг два',
    '',
    'Ссылка: [сайт](https://example.com) в тексте.',
    '',
    '| **Имя** | **Роль** |',
    '| --- | --- |',
    '| Катя | дизайнер |',
  ].join('\n');
  const report = await run(`write богатый.docx\n${golden}`);
  check('md→docx: write — отчёт', report.includes('богатый.docx'), report);
  const zip = new AdmZip(join(cwd, 'богатый.docx'));
  const xml = zip.getEntry('word/document.xml')!.getData().toString('utf8');
  check('md→docx: заголовки Heading1/Heading2', xml.includes('w:val="Heading1"') && xml.includes('w:val="Heading2"'));
  check('md→docx: жирный и курсив', xml.includes('<w:b/>') && xml.includes('<w:i/>'));
  check('md→docx: инлайн-код — Consolas и стиль Code', xml.includes('Consolas') && xml.includes('w:val="Code"'));
  check('md→docx: гиперссылка в тексте', xml.includes('<w:hyperlink'));
  check('md→docx: списки — numPr', xml.includes('<w:numPr>'));
  const rels = zip.getEntry('word/_rels/document.xml.rels')?.getData().toString('utf8') ?? '';
  check('md→docx: адрес ссылки в rels', rels.includes('https://example.com'));
  const back = await run('md богатый.docx');
  const { parseMd } = await import('../src/md.js');
  const strip = (md: string): string => JSON.stringify(parseMd(md).blocks, (k, v) => (k === 'marker' ? undefined : v));
  check('md→docx→md: золотой круг — структура совпала', strip(golden) === strip(back), `A=${strip(golden).slice(0, 250)}\nB=${strip(back).slice(0, 250)}`);
}

// ─── экранирование и код-блок: \* литеральный, плашка у fenced-кода ─────────
{
  await run('write экранирование.docx\n\\*не жирный\\* и 1\\. не список');
  const xml = new AdmZip(join(cwd, 'экранирование.docx')).getEntry('word/document.xml')!.getData().toString('utf8');
  check('md→docx: \\* без w:b, звёздочка литеральная', !xml.includes('<w:b/>') && xml.includes('*не жирный* и 1. не список'));
  const text = await run('read экранирование.docx');
  check('md→docx: экранированный текст читается', text.includes('*не жирный* и 1. не список'), text);
  await run('write код-блок.docx\n```\nкод <>&\n```');
  const xmlc = new AdmZip(join(cwd, 'код-блок.docx')).getEntry('word/document.xml')!.getData().toString('utf8');
  check('md→docx: код-блок — плашка F2F2F2 и Consolas', xmlc.includes('F2F2F2') && xmlc.includes('Consolas'));
  const codetext = await run('read код-блок.docx');
  check('md→docx: код-блок читается', codetext.includes('код <>&'), codetext);
}

// ─── md → xlsx: листы из «# имя», жирная шапка; roundtrip xlsx → md → xlsx ──
{
  const md = ['# Смета', '', '| Пункт | Цена |', '| --- | --- |', '| Кофе | 1200 |', '', '# Итоги', '', '| Показатель | Значение |', '| --- | --- |', '| Всего | 1200 |'].join('\n');
  const report = await run(`write смета-богатая.xlsx\n${md}`);
  check('md→xlsx: write — отчёт с именами листов', report.includes('Смета') && report.includes('Итоги'), report);
  const csv = await run('tables смета-богатая.xlsx');
  check('md→xlsx: два листа с именами', csv.includes('# лист: Смета') && csv.includes('# лист: Итоги'), csv.slice(0, 200));
  check('md→xlsx: ячейки на месте', csv.includes('Кофе,1200') && csv.includes('Всего,1200'), csv);
  const styles = new AdmZip(join(cwd, 'смета-богатая.xlsx')).getEntry('xl/styles.xml')?.getData().toString('utf8') ?? '';
  check('md→xlsx: жирная шапка в стилях', styles.includes('<b/>'), styles.slice(0, 200));
  const back = await run('md смета-богатая.xlsx');
  check('xlsx→md: «# имя» и md-таблицы', back.startsWith('# Смета') && back.includes('| Пункт | Цена |') && back.includes('| --- | --- |'), back.slice(0, 200));
  await run(`write смета-снова.xlsx\n${back}`);
  const csv2 = await run('tables смета-снова.xlsx');
  check('xlsx→md→xlsx: roundtrip — таблицы совпали', csv2 === csv, `1: ${csv.slice(0, 120)}\n2: ${csv2.slice(0, 120)}`);
}

// ─── md → pdf: богатый рендер (заголовки, списки, цитата, код, таблица) ─────
{
  const md = [
    '# Формат документа',
    '',
    'Абзац с **жирным** и *курсивом*, намеренно длинный, чтобы было видно',
    'перенос строк и интерлиньяж рендера.',
    '',
    '- пункт первый',
    '- пункт второй',
    '',
    '1. нумерованный шаг',
    '',
    '> Цитата с курсивом',
    '',
    '```',
    'код-блок с пробелами',
    '```',
    '',
    '| Колонка А | Колонка Б |',
    '| --- | --- |',
    '| один | два |',
    '',
    '---',
  ].join('\n');
  const report = await run(`write формат-проба.pdf\n${md}`);
  check('md→pdf: write — отчёт', report.includes('формат-проба.pdf'), report);
  const text = await run('read формат-проба.pdf');
  check(
    'md→pdf: заголовок, список, цитата, таблица — в текстовом слое',
    text.includes('Формат документа') && text.includes('пункт первый') && text.includes('нумерованный шаг') &&
      text.includes('Цитата с курсивом') && text.includes('Колонка А') && text.includes('один'),
    text.slice(0, 300),
  );
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
  // docx→pdf без моста — нативный фолбэк: docx → md → наш pdf-рендер
  const fb = await tool.run('convert pdf договор.docx', makeCtx(cwd));
  check('convert docx→pdf без моста — фолбэк в отчёте', fb.includes('фолбэк') && fb.includes('договор.pdf'), fb);
  const pdftext = await run('read договор.pdf');
  check('фолбэк pdf: текст и заголовок на месте', pdftext.includes('Договор поставки') && pdftext.includes('Поставка кофе'), pdftext.slice(0, 200));
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
const { rmTemp } = await import('./rm-tmp.js');
rmTemp(cwd);
