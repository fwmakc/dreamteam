/**
 * Проверка экрана: wrapAnsi/wrapPlain/loadSettings и математика зон
 * Screen на фейковом потоке (без реального терминала): перенос живого
 * стрима на несколько нижних строк, выделение мышью и Shift+клавишами,
 * прокрутка, margin, всплывашка. Запуск: npm run probe
 */
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapAnsi, visibleWidth, Screen } from '../src/screen.js';
import { loadSettings } from '../src/settings.js';
import { wrapPlain } from '../src/editor.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- wrapAnsi: перенос по словам ---
{
  const lines = wrapAnsi('привет прекрасный мир', 12);
  check('wrap: слова не рвутся', lines.join('|') === 'привет|прекрасный|мир', JSON.stringify(lines));
}
{
  // ширина зажимается минимум до 8 колонок, поэтому слово длиной 10 на ширине 8
  const lines = wrapAnsi('abcdefghij', 8);
  check('wrap: длинное слово режется', lines.join('|') === 'abcdefgh|ij', JSON.stringify(lines));
}
{
  // одно слово во всю ширину — не зацикливается
  const lines = wrapAnsi('abcde', 5);
  check('wrap: слово ровно в ширину', lines.length === 1 && lines[0] === 'abcde', JSON.stringify(lines));
}
{
  // ANSI-цвет переносится на следующую строку и закрывается
  const lines = wrapAnsi('красный \x1b[31mпомидор очень спелый\x1b[0m', 9);
  check('wrap: 4 строки', lines.length === 4, JSON.stringify(lines));
  check(
    'wrap: цвет перенесён и закрыт',
    lines.slice(1).every((l) => l.startsWith('\x1b[31m') && l.endsWith('\x1b[0m')),
    JSON.stringify(lines),
  );
  check('wrap: видимые ширины в лимите', lines.every((l) => visibleWidth(l) <= 9), lines.map(visibleWidth).join(','));
}
{
  // пустая строка
  check('wrap: пустая строка → одна пустая', wrapAnsi('', 40).length === 1);
}

// --- wrapPlain: сегменты и оффсеты ---
{
  const segs = wrapPlain('привет прекрасный мир', 12);
  check('wrapPlain: 3 сегмента', segs.length === 3, JSON.stringify(segs));
  check('wrapPlain: оффсеты', segs[1].start === 7 && segs[2].start === 18, JSON.stringify(segs));
}
{
  const segs = wrapPlain('аб', 1); // firstWidth=1 → лимит min 4
  check('wrapPlain: минимум 4 колонки', segs.length === 1, JSON.stringify(segs));
}

// --- visibleWidth ---
check('width: ANSI не считается', visibleWidth('\x1b[31mок\x1b[0m') === 2);
check('width: CJK = 2', visibleWidth('中文') === 4);
check('width: эмодзи = 2', visibleWidth('🎯') === 2);

// --- loadSettings: строгая валидация (на своих файлах во временной папке) ---
{
  const tmp = mkdtempSync(join(tmpdir(), 'dt-screen-'));
  const f = join(tmp, 'settings.json');
  writeFileSync(f, JSON.stringify({ width: 100, margin: 2, screen: true, runTimeoutMs: 180000, maxOutputChars: 4000 }));
  const cfg = loadSettings(f, 120);
  check(
    'settings: читается',
    cfg.width === 100 && cfg.screen === true && cfg.margin === 2 && cfg.runTimeoutMs === 180000 && cfg.maxOutputChars === 4000,
    JSON.stringify(cfg),
  );
  const clamped = loadSettings(f, 80);
  check('settings: обрезка по терминалу', clamped.width === 80, JSON.stringify(clamped));
  const bad = (json: unknown, part: string, what: string) => {
    writeFileSync(f, JSON.stringify(json));
    let threw = '';
    try {
      loadSettings(f, 100);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(`settings: ${what} → ошибка`, threw.includes(part), threw);
  };
  bad({ width: 10 }, 'width', 'width=10');
  bad({ width: 80, margin: 11 }, 'margin', 'margin=11');
  bad({ width: 80, runTimeoutMs: -1 }, 'runTimeoutMs', 'runTimeoutMs=-1');
  bad({ width: 80, workspace: 'ws' }, 'workspace', 'workspace удалён');
  let missing = '';
  try {
    loadSettings(join(tmp, 'settings.nope.json'), 100);
  } catch (e) {
    missing = e instanceof Error ? e.message : String(e);
  }
  check('settings: файла нет → ошибка', missing.includes('settings.nope'), missing);
  rmSync(tmp, { recursive: true, force: true });
}

// --- Screen: зоны на фейковом выходе ---
{
  const pt = new PassThrough();
  pt.setEncoding('utf8');
  let buf = '';
  pt.on('data', (d: string) => (buf += d));
  const scr = new Screen(pt as unknown as NodeJS.WriteStream, 40);
  (scr as unknown as { height: number }).height = 24;
  buf = '';
  scr.start();
  // мышиный режим: кнопки + SGR-расширение (в e2e не проверить — ConPTY их глотает)
  check('screen: мышь включена при старте', buf.includes('\x1b[?1000h') && buf.includes('\x1b[?1006h'), JSON.stringify(buf.slice(0, 120)));
  // 2 строки ввода → relayout: inputTop=24-2-2+1=21, hintsTop=16, chatBot=15
  buf = '';
  scr.setInput(['Ты > ', 'продолжение'], 0, 5);
  const st = scr as unknown as { chatBot: number; hintsTop: number; inputTop: number; paneRow: number; chat: string[] };
  check('screen: chatBot=15', st.chatBot === 15, String(st.chatBot));
  check('screen: hintsTop=16', st.hintsTop === 16, String(st.hintsTop));
  check('screen: inputTop=21', st.inputTop === 21, String(st.inputTop));
  check('screen: scroll region', buf.includes('\x1b[1;15r'), JSON.stringify(buf.slice(0, 80)));
  // стрим: живая строка копится и рисуется в последней строке панели (K=1, панель 1..16)
  buf = '';
  scr.setInput(['Ты > '], 0, 5); // обратно 1 строка → relayout, paneH=16
  buf = '';
  scr.push('При');
  scr.push('вет');
  check('screen: живая строка копится', /\x1b\[16;1H\x1b\[2KПривет/.test(buf), JSON.stringify(buf.slice(-60)));
  buf = '';
  scr.push(' и ещё длинный хвост, который точно шире сорока колонок экрана\n');
  const chunks = buf.split('\x1b[');
  const noOver = !chunks.some((c) => {
    const m = /^[0-9]+;1H\x1b\[2K([^\x1b]*)/.exec(c);
    return m && visibleWidth(m[1]) > 40;
  });
  check('screen: строки стрима не шире панели', noOver);
  check('screen: перенос завершённой строки', st.chat.length === 2, JSON.stringify(st.chat));
  check('screen: хвост строки не потерян', st.chat.join(' ').includes('колонок экрана'), JSON.stringify(st.chat));
  // --- живой стрим длинной строки: хвост переносится на несколько нижних строк ---
  buf = '';
  scr.push('слово '.repeat(30)); // ~180 символов → 5 строк по ширине 40
  const livePainted = [...buf.matchAll(/\x1b\[(\d+);1H\x1b\[2K([^\x1b][^\x1b]*)/g)]
    .map((m) => ({ row: Number(m[1]), text: m[2] }))
    .filter((x) => x.text.trim() !== '' && x.row >= 1 && x.row <= 16);
  check('stream: длинная строка — не меньше 5 нижних строк', livePainted.length >= 5, JSON.stringify(livePainted.map((x) => x.row)));
  check(
    'stream: живой блок прижат к низу панели',
    livePainted[livePainted.length - 1]?.row === 16 && livePainted.slice(-5).map((x) => x.row).join(',') === '12,13,14,15,16',
    JSON.stringify(livePainted.map((x) => x.row)),
  );
  // --- выделение по живым строкам стрима ---
  scr.selMouseDown(3, 16); // низ живого блока (строки 12..16)
  scr.selMouseDrag(30, 12); // протянули через весь блок
  const liveSel = scr.selectedText();
  check('stream: выделение по живым строкам', liveSel.trim().length > 0 && liveSel.includes('\n'), JSON.stringify(liveSel));
  check('stream: живое выделение — 5 строк', liveSel.split('\n').length === 5, String(liveSel.split('\n').length));
  scr.clearSelection();
  scr.selMouseDown(3, 15);
  scr.selMouseDrag(30, 11);
  check('stream: живое выделение есть', scr.hasSelection(), '');
  scr.push('хвост\n'); // стрим завершился — виртуальные строки ушли в chat[]
  check('stream: коммит снял живое выделение', !scr.hasSelection() && scr.selectedText() === '', JSON.stringify(scr.selectedText()));
  check('stream: строки стрима в истории', st.chat.length > 2 && st.chat.join(' ').includes('хвост'), String(st.chat.length));
  // hints и статус
  buf = '';
  scr.setHints(['подсказка']);
  check('screen: подсказки в своей зоне', buf.includes('\x1b[17;1H'), JSON.stringify(buf.slice(0, 40)));
  buf = '';
  scr.setStatus('⋯ думаю');
  check('screen: статус в нижней строке зоны', buf.includes('\x1b[21;1H'), JSON.stringify(buf.slice(0, 40)));
  // всплывашка накрывает строки чата; при закрытии чат перерисовывается из состояния
  scr.push('строка в чате один\n');
  scr.push('строка в чате два\n');
  buf = '';
  scr.setOverlay(['@Катя', '@Ника', '@Сергей', '@Виктор', '@Марина', '@Дмитрий']); // 6 строк → top=16
  check('screen: всплывашка заходит на чат', buf.includes('\x1b[16;1H\x1b[2K@Катя'), JSON.stringify(buf.slice(0, 120)));
  buf = '';
  scr.setOverlay(null);
  check('screen: закрытие перерисовало чат', buf.includes('строка в чате два'), JSON.stringify(buf.slice(0, 200)));
  // статус поверх открытой всплывашки не рисуется
  scr.setOverlay(['@Катя', '@Ника', '@Сергей', '@Виктор', '@Марина', '@Дмитрий']);
  buf = '';
  scr.setStatus('⋯ думаю');
  check('screen: статус не затирает всплывашку', !buf.includes('\x1b[21;1H'), JSON.stringify(buf.slice(0, 120)));
  scr.setOverlay(null);
  buf = '';
  scr.stop();
  check('screen: мышь выключена при выходе', buf.includes('\x1b[?1000l') && buf.includes('\x1b[?1006l'), JSON.stringify(buf));
}

// --- Screen с отступами (margin=2): колонки и верх сдвинуты ---
{
  const pt = new PassThrough();
  pt.setEncoding('utf8');
  let buf = '';
  pt.on('data', (d: string) => (buf += d));
  const scr = new Screen(pt as unknown as NodeJS.WriteStream, 40, 2);
  (scr as unknown as { height: number }).height = 24;
  check('margin: внутренняя ширина 36', scr.inner === 36, String(scr.inner));
  scr.start();
  check('margin: scroll region 3..16', buf.includes('\x1b[3;16r'), JSON.stringify(buf.slice(0, 80)));
  buf = '';
  scr.setInput(['Ты > '], 0, 5);
  const st = scr as unknown as {
    chatTop: number;
    chatBot: number;
    hintsTop: number;
    inputTop: number;
    paneRow: number;
    chat: string[];
  };
  // 24 строки, margin 2 сверху: чат в строках 3..16, подсказки 17..21, ввод 22
  check('margin: chatTop=3', st.chatTop === 3, String(st.chatTop));
  check('margin: chatBot=16', st.chatBot === 16, String(st.chatBot));
  check('margin: inputTop=22', st.inputTop === 22, String(st.inputTop));
  check('margin: ввод с колонки 3', buf.includes('\x1b[22;3H'), JSON.stringify(buf.slice(0, 120)));
  check('margin: курсор с учётом отступа', buf.includes('\x1b[22;8H'), JSON.stringify(buf.slice(-80)));
  // стрим пишется с колонки 3 и переносится по внутренней ширине
  buf = '';
  scr.push('При');
  scr.push('вет');
  // живая строка рисуется у низа панели (строка 16), а не под верхней строкой чата
  check('margin: живая строка в последней строке панели', /\x1b\[16;3H\x1b\[2KПривет/.test(buf), JSON.stringify(buf.slice(-60)));
  buf = '';
  scr.push(' и длинный хвост, который заведомо шире внутренней ширины в тридцать шесть\n');
  const first = st.chat[0] ?? '';
  check('margin: строки чата ≤ 36 колонок', visibleWidth(first) <= 36, `${String(visibleWidth(first))} «${first}»`);
  check('margin: завершённая строка с колонки 3', buf.includes('\x1b[3;3H'), JSON.stringify(buf.slice(0, 60)));
  buf = '';
  scr.setHints(['подсказка']);
  check('margin: подсказки с колонки 3', buf.includes('\x1b[17;3H'), JSON.stringify(buf.slice(0, 40)));
  scr.stop();
}

// --- Прокрутка истории: viewOffset, закреплённый вид, индикатор ---
{
  const pt = new PassThrough();
  pt.setEncoding('utf8');
  let buf = '';
  pt.on('data', (d: string) => (buf += d));
  const scr = new Screen(pt as unknown as NodeJS.WriteStream, 40);
  (scr as unknown as { height: number }).height = 24;
  scr.start();
  scr.setInput(['Ты > '], 0, 5); // чат 1..16 (paneH=16), подсказки 17..21
  const st = scr as unknown as { viewOffset: number; chat: string[]; chatTop: number; chatBot: number };
  for (let i = 1; i <= 20; i++) scr.push(`строка ${i}\n`);
  check('scroll: 20 строк в истории', st.chat.length === 20, String(st.chat.length));
  buf = '';
  scr.scrollUp(3);
  // окно chat[1..16]: сверху «строка 2», снизу «строка 17»
  check('scroll: вверх — старое сверху', /\x1b\[1;1H\x1b\[2Kстрока 2/.test(buf), JSON.stringify(buf.slice(0, 60)));
  check('scroll: низ окна — строка 17', buf.includes('\x1b[16;1H\x1b[2Kстрока 17'), JSON.stringify(buf.slice(-160)));
  check('scroll: индикатор «выше ещё на 3»', buf.includes('\x1b[21;1H') && buf.includes('выше ещё на 3'), JSON.stringify(buf.slice(-120)));
  // новая реплика при прокрутке: вид закреплён, счётчик растёт
  buf = '';
  scr.push('ещё одна\n');
  check('scroll: закреп — панель не перерисована', !buf.includes('\x1b[1;1H'), JSON.stringify(buf.slice(0, 80)));
  check('scroll: закреп — счётчик вырос', buf.includes('выше ещё на 4'), JSON.stringify(buf.slice(-120)));
  check('scroll: закреп — viewOffset=4', st.viewOffset === 4, String(st.viewOffset));
  // при прокрутке живая строка стрима не пишется
  buf = '';
  scr.push('живой кусок');
  check('scroll: живая строка скрыта', !buf.includes('живой кусок'), JSON.stringify(buf.slice(0, 120)));
  scr.push('\n');
  // потолок прокрутки (22 строки в истории: 20 + «ещё одна» + «живой кусок»)
  buf = '';
  scr.scrollUp(1000);
  check('scroll: потолок — самая первая строка', /\x1b\[1;1H\x1b\[2Kстрока 1/.test(buf) && st.viewOffset === 6, String(st.viewOffset));
  buf = '';
  scr.scrollDown(2);
  check('scroll: частично вниз — строка 3 сверху', /\x1b\[1;1H\x1b\[2Kстрока 3/.test(buf), JSON.stringify(buf.slice(0, 60)));
  check('scroll: индикатор «на 4»', buf.includes('выше ещё на 4'), JSON.stringify(buf.slice(-120)));
  buf = '';
  scr.scrollDown(100);
  check('scroll: вниз до конца — хвост в панели', buf.includes('\x1b[15;1H\x1b[2Kещё одна') && buf.includes('\x1b[16;1H\x1b[2Kживой кусок'), JSON.stringify(buf.slice(-160)));
  check('scroll: вниз до конца — индикатор исчез', !buf.includes('история'), JSON.stringify(buf.slice(-200)));
  check('scroll: вниз до конца — viewOffset=0', st.viewOffset === 0, String(st.viewOffset));
  buf = '';
  scr.scrollDown(3);
  check('scroll: вниз на живом виде — пусто', buf === '', JSON.stringify(buf.slice(0, 80)));
  // Ctrl+PgUp / Ctrl+PgDn: прыжок в начало и обратно к свежим
  buf = '';
  scr.scrollToStart();
  check('scroll: в начало — первая строка сверху', /\x1b\[1;1H\x1b\[2Kстрока 1/.test(buf) && st.viewOffset === 6, String(st.viewOffset));
  buf = '';
  scr.scrollToStart();
  check('scroll: в начало на начале — пусто', buf === '', JSON.stringify(buf.slice(0, 80)));
  buf = '';
  scr.scrollToEnd();
  check('scroll: к свежим — хвост в панели', st.viewOffset === 0 && buf.includes('\x1b[16;1H\x1b[2Kживой кусок'), JSON.stringify(buf.slice(-160)));
  buf = '';
  scr.scrollToEnd();
  check('scroll: к свежим на свежих — пусто', buf === '', JSON.stringify(buf.slice(0, 80)));
  // --- выделение мышью: нажать, протянуть, отпустить ---
  // панель 1..16, margin 0; строка 5 экрана = chat[idx]: end=22, idx=22-16+(5-1)=10 → «строка 11»
  buf = '';
  scr.selMouseDown(3, 5); // колонка 3 экрана = колонка 2 строки
  check('sel: нажатие рисует панель без реверса', !buf.includes('\x1b[7m'), JSON.stringify(buf.slice(0, 80)));
  buf = '';
  scr.selMouseDrag(8, 5);
  // подсвеченные ячейки переиздаются по одной, «строка 11» уже не подстрока
  check('sel: протяжка подсвечивает реверсом', buf.includes('\x1b[7m') && buf.includes('\x1b[27m'), JSON.stringify(buf.slice(0, 120)));
  buf = '';
  scr.selMouseDrag(15, 6); // захват следующих строк
  const text = scr.selectedText();
  check('sel: текст через строки', text.startsWith('рока 11') && text.includes('\n') && text.includes('строка 12'), JSON.stringify(text));
  check('sel: hasSelection', scr.hasSelection() === true, '');
  scr.clearSelection();
  check('sel: сброс', !scr.hasSelection() && scr.selectedText() === '', '');
  buf = '';
  scr.selMouseDown(3, 5);
  scr.selMouseUp();
  check('sel: клик без протяжки — выделения нет', !scr.hasSelection(), '');
  // клик вне панели снимает выделение
  scr.selMouseDown(3, 5);
  scr.selMouseDrag(8, 5);
  scr.selMouseDown(1, 20); // строка подсказок
  check('sel: клик вне панели снял выделение', !scr.hasSelection(), '');
  // --- Shift+стрелки: свежий старт — якорь на последней видимой строке (21,0) ---
  scr.selMoveKeyboard('up');
  const up1 = scr.selectedText(); // голова (20,0) «ещё одна»
  check('sel: Shift+вверх захватил строку выше', up1 === 'ещё одна\n', JSON.stringify(up1));
  scr.selMoveKeyboard('up');
  const up2 = scr.selectedText(); // голова (19,0) «строка 20»
  check('sel: ещё вверх — две строки', up2 === 'строка 20\nещё одна\n', JSON.stringify(up2));
  scr.selMoveKeyboard('right');
  const right1 = scr.selectedText(); // голова (19,1): строка 19 без первой буквы
  check('sel: Shift+вправо сдвинул голову', right1 === 'трока 20\nещё одна\n' && scr.hasSelection(), JSON.stringify(right1));
  scr.selMoveKeyboard('down');
  check('sel: Shift+вниз на строку ниже', scr.selectedText() === 'щё одна\n' && scr.hasSelection(), JSON.stringify(scr.selectedText()));
  scr.selMoveKeyboard('left');
  check('sel: Shift+влево — начало строки', scr.hasSelection() && scr.selectedText() === 'ещё одна\n', JSON.stringify(scr.selectedText()));
  // Shift+End/Home — хвост/начало строки под головой
  scr.selMoveKeyboard('up'); // голова (19,0) «строка 20»
  check('sel: вверх перед End — две строки', scr.selectedText() === 'строка 20\nещё одна\n', JSON.stringify(scr.selectedText()));
  scr.selMoveKeyboard('end'); // голова (19,9): хвост «строка 20» пуст
  check('sel: Shift+End — хвост строки', scr.selectedText() === '\nещё одна\n', JSON.stringify(scr.selectedText()));
  scr.selMoveKeyboard('home'); // голова (19,0) — обратно
  check('sel: Shift+Home — начало строки', scr.selectedText() === 'строка 20\nещё одна\n', JSON.stringify(scr.selectedText()));
  scr.clearSelection();
  scr.selMoveKeyboard('end'); // свежий старт: вся нижняя строка
  check('sel: Shift+End с нуля — вся нижняя строка', scr.selectedText() === 'живой кусок', JSON.stringify(scr.selectedText()));
  scr.selMoveKeyboard('home'); // голова в якорь — схлопнулось
  check('sel: Shift+Home в якорь — схлопнулось', !scr.hasSelection() && scr.selectedText() === '', JSON.stringify(scr.selectedText()));
  scr.clearSelection();
  // пережатие окна: viewOffset не превышает максимум
  scr.scrollUp(5);
  (scr as unknown as { height: number }).height = 40;
  (scr as unknown as { relayout(): void }).relayout();
  check('scroll: resize поджал viewOffset до 0', st.viewOffset === 0, String(st.viewOffset));
  scr.stop();
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
