#!/usr/bin/env node
// Глобальная команда dreamteam. Флаги и форму проекта разбираем до tsx-
// загрузчика: -v и -h отвечают мгновенно, кривая форма — мгновенный отказ,
// и только потом грузится приложение. Точки входа: без формы проекта —
// терминальная оболочка (src/index.ts), `serve` — API+GUI (src/serve.ts);
// хвост argv (какой проект открыть) передаём через DT_PROJECT_ARGS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const usage = (toStderr) => {
  const text = [
    'dreamteam — чат с командой ИИ-агентов',
    '',
    '  dreamteam                   терминальная оболочка (TUI); проект открывается командами /project',
    '  dreamteam <путь>            то же + открыть проект этой рабочей папки (незнакомую зарегистрирует)',
    '  dreamteam open <имя|путь>   открыть проект по имени (список — /project) или по пути к папке',
    '  dreamteam new <имя> [папка] создать проект (и рабочую папку, если задана) и открыть',
    '  dreamteam serve             веб-оболочка: API+GUI (адрес — HOST/PORT, по умолчанию 127.0.0.1:8080)',
    '  dreamteam serve <форма проекта>  веб-оболочка сразу с проектом (те же <путь> / open / new)',
    '  dreamteam serve --open      то же + открыть http://адрес в браузере (так работает ярлык быстрого запуска)',
    '  dreamteam -v                версия пакета',
    '  dreamteam -h                эта справка',
    '',
  ].join('\n');
  (toStderr ? console.error : console.log)(text);
};

const arg = process.argv[2];
if (arg === '-v' || arg === '--version') {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  console.log(`dreamteam v${pkg.version}`);
  process.exit(0);
}
if (arg === '-h' || arg === '--help') {
  usage(false);
  process.exit(0);
}

const fail = (message) => {
  // fail-fast: опечатка не должна молча запускать приложение и мастер настройки
  console.error(message);
  usage(true);
  process.exit(1);
};

let argv = process.argv.slice(2);
let serve = false;
if (argv[0] === 'serve') {
  serve = true;
  argv = argv.slice(1);
}
// --open — флаг serve: в argv он остаётся (его читает src/serve.ts), а в форму
// проекта для приложения не входит
const rest = serve ? argv.filter((a) => a !== '--open') : argv;
if (rest.length > 0) {
  const [head, second, third] = rest;
  if (head.startsWith('-')) fail(`Не знаю, что делать с флагом «${head}»${serve ? '' : ' — --open есть только у serve'}.`);
  if (head === 'open') {
    if (!second || third) fail('Форма: dreamteam open <имя|путь> — имя из /project или путь к папке.');
  } else if (head === 'new') {
    if (!second || rest.length > 3) fail('Форма: dreamteam new <имя> [папка] — папка создаётся, если её нет.');
  } else if (second) {
    fail(`Лишний аргумент «${second}» — укажите один путь: dreamteam <путь>.`);
  } else if (head !== '.' && head !== '..' && !head.includes('/') && !head.includes('\\')) {
    fail(`«${head}» не похоже на путь — папку пишите как ./имя или полным путём; для имени проекта: dreamteam open ${head}.`);
  }
}
process.env.DT_PROJECT_ARGS = JSON.stringify(rest);

const { register } = await import('tsx/esm/api');
register();
if (serve) {
  process.argv.splice(2, 1);
  process.env.DT_SERVE = '1';
  await import('../src/serve.ts');
} else {
  await import('../src/index.ts');
}
