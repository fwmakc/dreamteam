/**
 * Проба тула «ocr»: настоящий tesseract (rus+eng) на картинках, собранных тут же:
 *   png с текстом → text: слова читаются;
 *   png с таблицей (две колонки с широким зазором) → tables: markdown и csv;
 *   двухстраничный pdf → text: обе страницы, выборка «2» отдаёт только вторую;
 *   docx с вложенной картинкой → text: картинки из word/media распознаются;
 *   номера страниц у картинки — отказ; путь наружу, неизвестная подкоманда,
 *   неподдерживаемый формат — внятные отказы.
 * Первый запуск скачивает traineddata в ~/.dreamteam/cache/tesseract (нужен интернет).
 * Запуск: npx tsx tests/probe-ocr.ts
 */
import { createWriteStream, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './tool-ctx.js';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { Document as DocxDoc, ImageRun, Packer, Paragraph } from 'docx';
import PDFDocument from 'pdfkit';
import { pdfFontPath } from '../src/documents.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Нормализация для сравнения: нижний регистр + ё→е. */
const norm = (s: string): string => s.toLowerCase().replaceAll('ё', 'е');

const cwd = mkdtempSync(join(tmpdir(), 'dt-ocr-'));
const fontPath = pdfFontPath();
GlobalFonts.registerFromPath(fontPath, 'Arial');

/** Рисует png с текстом: строки [текст, x, y]. */
function pngWithText(lines: Array<[string, number, number]>, width = 900, height = 300): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = '40px Arial';
  for (const [text, x, y] of lines) ctx.fillText(text, x, y);
  return canvas.toBuffer('image/png');
}

writeFileSync(join(cwd, 'люди.png'), pngWithText([['Договор Ромашка', 60, 80], ['подписан вовремя', 60, 180]]));
// Таблица: две колонки, зазор 340px >> порога (0.7 высоты шрифта ≈ 28px)
writeFileSync(join(cwd, 'таблица.png'), pngWithText([
  ['Фамилия', 60, 80], ['Год', 400, 80],
  ['Иванов', 60, 160], ['1980', 400, 160],
  ['Петров', 60, 240], ['1990', 400, 240],
], 640, 340));

// Двухстраничный pdf с кириллицей
{
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  doc.pipe(createWriteStream(join(cwd, 'акт.pdf')));
  doc.font(fontPath).fontSize(36).text('Страница один: акт выполненных работ');
  doc.addPage();
  doc.fontSize(36).text('Страница два: счёт 4500');
  doc.end();
  await new Promise<void>((resolve) => doc.on('end', () => resolve()));
}

// docx с вложенной картинкой (скан, сохранённый в документ)
{
  const doc = new DocxDoc({
    sections: [{
      children: [new Paragraph({
        children: [new ImageRun({
          type: 'png',
          data: pngWithText([['Скан паспорта Ромашка', 60, 80]], 800, 200),
          transformation: { width: 400, height: 100 },
        })],
      })],
    }],
  });
  writeFileSync(join(cwd, 'сканы.docx'), await Packer.toBuffer(doc));
}

const tool = (await import('../src/tools/ocr/ocr.js')).default({});
const run = (body: string): Promise<string> => tool.run(body, makeCtx(cwd));

// ─── text: png ───────────────────────────────────────────────────────────────
{
  const text = await run('text люди.png');
  check('png: текст распознан', norm(text).includes('ромашка') && norm(text).includes('подписан'), text.slice(0, 200));
  check('png: в отчёте имя файла и уверенность', text.includes('люди.png') && /уверенность \d+%/.test(text), text.slice(0, 120));
}

// ─── tables: markdown и csv ──────────────────────────────────────────────────
{
  const md = await run('tables таблица.png');
  check('таблицы: markdown-колонки', md.includes('| --- | --- |'), md.slice(0, 300));
  check('таблицы: слова по ячейкам', md.includes('Иванов') && md.includes('1980') && md.includes('Петров'), md.slice(0, 300));
  const csv = await run('tables таблица.png csv');
  check('таблицы: csv-вариант', csv.includes('Иванов,1980') && csv.includes('Петров,1990'), csv.slice(0, 300));
}

// ─── text: pdf — обе страницы и выборка второй ───────────────────────────────
{
  const all = await run('text акт.pdf');
  check('pdf: обе страницы', norm(all).includes('акт') && norm(all).includes('выполненных') && norm(all).includes('счет'), all.slice(0, 300));
  const second = await run('text акт.pdf 2');
  check('pdf: выборка «2» — только вторая', norm(second).includes('4500') && !norm(second).includes('выполненных'), second.slice(0, 300));
  try { await run('text акт.pdf 5'); check('pdf: лишняя страница — отказ', false); }
  catch (e) { check('pdf: лишняя страница — отказ', String((e as Error).message).includes('страниц'), String((e as Error).message)); }
}

// ─── text: docx с картинками ─────────────────────────────────────────────────
{
  const text = await run('text сканы.docx');
  check('docx: картинка из word/media распознана', norm(text).includes('ромашка') || norm(text).includes('паспорта'), text.slice(0, 200));
}

// ─── отказы ──────────────────────────────────────────────────────────────────
{
  try { await run('text люди.png 2'); check('страницы у картинки — отказ', false); }
  catch (e) { check('страницы у картинки — отказ', String((e as Error).message).includes('только для pdf')); }
  try { await run('text ../наружу.png'); check('путь наружу — отказ', false); }
  catch (e) { check('путь наружу — отказ', String((e as Error).message).includes('выход за рабочую папку')); }
  try { await run('text нет-такого.png'); check('несуществующий файл — отказ', false); }
  catch (e) { check('несуществующий файл — отказ', /ENOENT|нет/.test(String((e as Error).message))); }
  try { await run('text пунктир.gif'); check('gif — отказ со списком форматов', false); }
  catch (e) { check('gif — отказ со списком форматов', String((e as Error).message).includes('поддерживаю')); }
  try { await run('frobnicate люди.png'); check('неизвестная подкоманда — синтаксис', false); }
  catch (e) { check('неизвестная подкоманда — синтаксис', String((e as Error).message).includes('подкоманды')); }
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
const { rmTemp } = await import('./rm-tmp.js');
rmTemp(cwd);
