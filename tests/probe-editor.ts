/**
 * Проверка Editor: декодирование клавиш, курсор по кодпоинтам, история,
 * мягкий перенос, вставка, выделение Shift+стрелками/Home/End.
 * Запуск: npm run probe
 */
import { PassThrough } from 'node:stream';
import { Editor, type EditorHooks } from '../src/editor.js';
import { Screen } from '../src/screen.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeEditor(intercept: EditorHooks['interceptKey'] = () => null) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (m: boolean) => void }).setRawMode = () => {};
  const pt = new PassThrough();
  pt.resume();
  const events: {
    submit: [string, boolean][];
    ctrlC: boolean;
    eof: boolean;
    edits: [string, number][];
    scroll: ['up' | 'down' | 'top' | 'bottom', number][];
    mouse: ['down' | 'drag' | 'up', number, number][];
    select: ('left' | 'right' | 'up' | 'down' | 'home' | 'end')[];
  } = {
    submit: [],
    ctrlC: false,
    eof: false,
    edits: [],
    scroll: [],
    mouse: [],
    select: [],
  };
  const ed = new Editor(
    {
      interceptKey: intercept,
      onEdit: (b, c) => events.edits.push([b, c]),
      onSubmit: (l, s) => events.submit.push([l, s]),
      onScroll: (dir, lines) => events.scroll.push([dir, lines]),
      onMouse: (type, col, row) => events.mouse.push([type, col, row]),
      onSelectKey: (dir) => events.select.push(dir),
      onCtrlC: () => (events.ctrlC = true),
      onEof: () => (events.eof = true),
    },
    new Screen(pt as unknown as NodeJS.WriteStream, 40),
    stdin,
  );
  ed.start();
  const feed = async (s: string): Promise<void> => {
    stdin.write(s);
    await new Promise<void>((r) => setImmediate(r));
  };
  return { ed, feed, events, stdin, cleanup: () => ed.stop() };
}

const sleep = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

// --- ввод и Enter ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('привет');
  check('ввод: текст в буфере', ed.text === 'привет', ed.text);
  await feed('\r');
  check('ввод: Enter отправляет', events.submit?.[0]?.[0] === 'привет' && events.submit?.[0]?.[1] === false, JSON.stringify(events.submit));
  check('ввод: буфер очищен', ed.text === '');
  cleanup();
}

// --- курсор и правка ---
{
  const { ed, feed, cleanup } = makeEditor();
  await feed('аб');
  await feed('\x1b[D'); // ←
  await feed('в');
  check('курсор: ← и вставка', ed.text === 'авб', ed.text);
  await feed('\x1b[H'); // home
  await feed('!');
  check('курсор: home', ed.text === '!авб', ed.text);
  await feed('\x1b[F'); // end
  await feed('.');
  check('курсор: end', ed.text === '!авб.', ed.text);
  await feed('\x1b[D\x1b[D'); // ←←
  await feed('\x1b[3~'); // delete
  check('курсор: delete', ed.text === '!ав.', ed.text);
  await feed('\x7f'); // backspace
  check('курсор: backspace', ed.text === '!а.', ed.text);
  cleanup();
}

// --- эмодзи не режется ---
{
  const { ed, feed, cleanup } = makeEditor();
  await feed('а🎯б');
  await feed('\x1b[D'); // ← перепрыгивает суррогатную пару
  await feed('X');
  check('эмодзи: ← не режет пару', ed.text === 'а🎯Xб', JSON.stringify(ed.text));
  await feed('\x7f'); // удаляет X (курсор после X)
  check('эмодзи: backspace целиком', ed.text === 'а🎯б', JSON.stringify(ed.text));
  cleanup();
}

// --- слова и очистка ---
{
  const { ed, feed, cleanup } = makeEditor();
  await feed('раз два три');
  await feed('\x17'); // Ctrl+W
  check('слова: Ctrl+W', ed.text === 'раз два ', JSON.stringify(ed.text));
  await feed('\x15'); // Ctrl+U
  check('слова: Ctrl+U очищает', ed.text === '');
  cleanup();
}

// --- история ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('раз\r');
  await feed('два\r');
  await feed('\x1b[A'); // ↑ → «два»
  check('история: ↑ последняя', ed.text === 'два', ed.text);
  await feed('\x1b[A'); // ↑ → «раз»
  check('история: ↑ ещё', ed.text === 'раз', ed.text);
  await feed('\x1b[B'); // ↓ → «два»
  check('история: ↓', ed.text === 'два', ed.text);
  await feed('\x1b[B'); // ↓ → черновик (пусто)
  check('история: ↓ к черновику', ed.text === '', ed.text);
  await feed('черновик\r');
  check('история: черновик отправлен', events.submit?.at(-1)?.[0] === 'черновик');
  cleanup();
}

// --- мягкий перенос Alt+Enter и Ctrl+Enter (LF) ---
{
  const { feed, events, cleanup } = makeEditor();
  await feed('строка');
  await feed('\x1b\r'); // Alt+Enter
  await feed('два');
  await feed('\n'); // Ctrl+Enter
  await feed('три');
  await feed('\r');
  const subs = events.submit ?? [];
  check('soft: Alt+Enter', subs[0]?.[0] === 'строка' && subs[0]?.[1] === true, JSON.stringify(subs));
  check('soft: Ctrl+Enter', subs[1]?.[0] === 'два' && subs[1]?.[1] === true, JSON.stringify(subs));
  check('soft: финал обычный', subs[2]?.[0] === 'три' && subs[2]?.[1] === false, JSON.stringify(subs));
  cleanup();
}

// --- вставка из буфера: переносы становятся пробелами ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('\x1b[200~первая\nвторая\r\nтретья\x1b[201~');
  check('paste: без переводов строк', ed.text === 'первая вторая третья', JSON.stringify(ed.text));
  check('paste: Enter после вставки не отправил', (events.submit?.length ?? 0) === 0);
  cleanup();
}

// --- разрезанная escape-последовательность между чанками ---
{
  const { ed, feed, stdin, cleanup } = makeEditor();
  await feed('аб');
  stdin.write('\x1b[1'); // начало home
  await sleep();
  stdin.write('~');
  await sleep();
  check('esc: последовательность в два чанка', ed.text === 'аб'); // home — позиция, не текст; проверим курсор ниже
  // курсор теперь 0: допишем и проверим
  await feed('!');
  check('esc: home сработал', ed.text === '!аб', JSON.stringify(ed.text));
  cleanup();
}

// --- перехват клавиш хуком (всплывашка/Tab) ---
{
  let stolen = '';
  const { ed, feed, events, cleanup } = makeEditor((key) => {
    if (key.name === 'escape') {
      stolen = 'esc';
      return 'handled';
    }
    if (key.name === 'tab') return { text: '@Ника ', cursor: 6 };
    return null;
  });
  await feed('\x1b');
  await new Promise<void>((r) => setTimeout(r, 150)); // таймер Esc — 80 мс
  check('хук: Esc перехвачен', stolen === 'esc', stolen);
  await feed('\t');
  check('хук: Tab заменил строку', ed.text === '@Ника ', JSON.stringify(ed.text));
  await feed('\r');
  check('хук: отправка после Tab', events.submit?.[0]?.[0] === '@Ника ');
  cleanup();
}

// --- Ctrl+C / Ctrl+D ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('текст');
  await feed('\x1b[H\x04'); // home, затем Ctrl+D — delete-вперёд
  check('клавиши: Ctrl+D с текстом — delete', ed.text === 'екст', ed.text);
  await feed('\x15'); // очистить
  await feed('\x04');
  check('клавиши: Ctrl+D на пустой — eof', events.eof === true);
  await feed('\x03');
  check('клавиши: Ctrl+C → хук', events.ctrlC === true);
  cleanup();
}

// --- прокрутка: колесо мыши (SGR и X10), PgUp/PgDn ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('\x1b[<64;10;5M'); // колесо вверх (SGR)
  await feed('\x1b[<64;1;1M');
  await feed('\x1b[<65;3;3M'); // колесо вниз
  check('мышь: SGR колёсико → хук', JSON.stringify(events.scroll) === '[["up",3],["up",3],["down",3]]', JSON.stringify(events.scroll));
  await feed('а');
  check('мышь: клик не печатает текст', ed.text === 'а', JSON.stringify(ed.text));
  await feed('\x1b[<0;5;5M');
  await feed('\x1b[<0;5;5m'); // отпускание кнопки
  check('мышь: клики и m-события глотаются', ed.text === 'а' && events.scroll.length === 3, JSON.stringify({ t: ed.text, n: events.scroll.length }));
  await feed('\x1b[M`!!'); // X10: '`'=96 → кнопка 64 = колесо вверх, координаты 33;33
  check('мышь: X10 колёсико', JSON.stringify(events.scroll.at(-1)) === '["up",3]', JSON.stringify(events.scroll));
  check('мышь: X10 не печатает', ed.text === 'а', JSON.stringify(ed.text));
  await feed('\x1b[5~');
  await feed('\x1b[6~');
  check('клавиши: PgUp/PgDn', JSON.stringify(events.scroll.slice(-2)) === '[["up",20],["down",20]]', JSON.stringify(events.scroll.slice(-2)));
  await feed('\x1b[<6'); // разорванная мышиная последовательность
  await feed('4;1;1M');
  check('мышь: разрыв чанком — без текста', ed.text === 'а' && events.scroll.length === 7, JSON.stringify({ t: ed.text, n: events.scroll.length }));
  cleanup();
}

// --- Ctrl+PgUp / Ctrl+PgDn: в начало и к свежим ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('\x1b[5;5~'); // xterm: 5;5 = Ctrl+PgUp
  await feed('\x1b[6;5~'); // Ctrl+PgDn
  check('клавиши: Ctrl+PgUp/PgDn (xterm)', JSON.stringify(events.scroll) === '[["top",0],["bottom",0]]', JSON.stringify(events.scroll));
  await feed('\x1b[5^'); // rxvt-стиль
  await feed('\x1b[6^');
  check('клавиши: Ctrl+PgUp/PgDn (rxvt)', JSON.stringify(events.scroll.slice(-2)) === '[["top",0],["bottom",0]]', JSON.stringify(events.scroll.slice(-2)));
  check('клавиши: «^» не напечатался', ed.text === '', JSON.stringify(ed.text));
  await feed('\x1b[5;'); // разорванная последовательность
  await feed('5~');
  check('клавиши: разрыв чанком', events.scroll.length === 5 && events.scroll[4][0] === 'top', JSON.stringify(events.scroll));
  cleanup();
}

// --- мышь с координатами и Shift+стрелки (выделение) ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('\x1b[<0;5;7M'); // нажатие ЛКМ в (5,7)
  await feed('\x1b[<32;12;7M'); // протяжка
  await feed('\x1b[<0;12;7m'); // отпускание
  check('мышь: нажатие/протяжка/отпускание с координатами', JSON.stringify(events.mouse) === '[["down",5,7],["drag",12,7],["up",12,7]]', JSON.stringify(events.mouse));
  check('мышь: текст не печатается', ed.text === '', JSON.stringify(ed.text));
  await feed('\x1b[1;2D'); // Shift+влево (xterm)
  await feed('\x1b[1;2A'); // Shift+вверх
  await feed('\x1b[1;2C'); // Shift+вправо
  await feed('\x1b[d'); // Shift+влево (rxvt)
  check('клавиши: Shift+стрелки', JSON.stringify(events.select) === '["left","up","right","left"]', JSON.stringify(events.select));
  await feed('\x1b[1;2H'); // Shift+Home (xterm)
  await feed('\x1b[1;2F'); // Shift+End (xterm)
  await feed('\x1b[7$'); // Shift+Home (rxvt)
  await feed('\x1b[8$'); // Shift+End (rxvt)
  check('клавиши: Shift+Home/End', JSON.stringify(events.select.slice(4)) === '["home","end","home","end"]', JSON.stringify(events.select.slice(4)));
  check('клавиши: Shift+стрелки не двигают курсор ввода', ed.text === '', JSON.stringify(ed.text));
  cleanup();
}

// --- выделение в поле ввода (Shift+клавиши при непустом вводе) ---
{
  const { ed, feed, events, cleanup } = makeEditor();
  await feed('привет команда'); // 14 символов
  await feed('\x1b[1;2D'); // Shift+влево ×4
  await feed('\x1b[1;2D');
  await feed('\x1b[1;2D');
  await feed('\x1b[1;2D');
  check('ввод: shift+влево выделил «анда»', ed.selectionText() === 'анда', JSON.stringify(ed.selectionText()));
  await feed('\x1b[1;2H'); // Shift+Home — до начала строки
  check('ввод: shift+home — вся строка', ed.selectionText() === 'привет команда' && ed.hasSelection(), JSON.stringify(ed.selectionText()));
  await feed('\x1b[D'); // ← — схлопнуть к началу выделения
  check('ввод: ← схлопнул к началу', !ed.hasSelection() && ed.text === 'привет команда', JSON.stringify(ed.text));
  await feed('\x1b[C'); // → — курсор на 1 вперёд
  await feed('\x1b[1;2F'); // Shift+End — до конца
  check('ввод: shift+end — хвост строки', ed.selectionText() === 'ривет команда', JSON.stringify(ed.selectionText()));
  await feed('X'); // печать заменяет выделение
  check('ввод: печать заменила выделение', ed.text === 'пX', JSON.stringify(ed.text));
  await feed('\x1b[1;2D'); // Shift+влево — выделили X
  check('ввод: выделили X', ed.selectionText() === 'X', JSON.stringify(ed.selectionText()));
  await feed('\x7f'); // Backspace удаляет выделение
  check('ввод: backspace удалил выделение', ed.text === 'п' && !ed.hasSelection(), JSON.stringify(ed.text));
  await feed('тест'); // «птест»
  await feed('\x1b[1;2D'); // Shift+влево ×2 → «ст»
  await feed('\x1b[1;2D');
  await feed('\x1b'); // Esc снимает выделение, текст цел
  await new Promise<void>((r) => setTimeout(r, 150)); // одиночный Esc ждёт 80 мс
  check('ввод: esc снял выделение', !ed.hasSelection() && ed.text === 'птест', JSON.stringify(ed.text));
  await feed('\x1b[1;2D'); // снова выделили «т»
  await feed('\x1b[A'); // ↑ — снять выделение, в историю не прыгать
  check('ввод: ↑ снял выделение', !ed.hasSelection() && ed.text === 'птест', JSON.stringify(ed.text));
  await feed('\x15'); // Ctrl+U — очистить ввод
  await feed('\x1b[1;2D'); // Shift+влево при пустом вводе — в историю чата
  check('ввод: пустой ввод — клавиши ушли в историю', JSON.stringify(events.select) === '["left"]', JSON.stringify(events.select));
  cleanup();
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
