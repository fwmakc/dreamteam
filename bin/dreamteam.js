#!/usr/bin/env node
// Глобальная команда dreamteam. Флаги разбираем до tsx-загрузчика: -v и -h
// отвечают мгновенно и не создают дом. Точки входа две: без аргументов —
// терминальная оболочка (src/index.ts), `dreamteam serve` — API+GUI (src/serve.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const usage = (toStderr) => {
  const text = [
    'dreamteam — чат с командой ИИ-агентов',
    '',
    '  dreamteam            терминальная оболочка (TUI)',
    '  dreamteam serve      веб-оболочка: API+GUI (адрес — HOST/PORT, по умолчанию 127.0.0.1:8080)',
    '  dreamteam serve --open  то же + открыть http://адрес в браузере (так работает ярлык быстрого запуска)',
    '  dreamteam -v         версия пакета',
    '  dreamteam -h         эта справка',
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
if (arg !== undefined && arg !== 'serve') {
  // fail-fast: опечатка («dreamteam serv») не должна молча запускать мастер настройки
  console.error(`Не знаю, что делать с аргументом «${arg}».`);
  usage(true);
  process.exit(1);
}

const { register } = await import('tsx/esm/api');
register();
if (arg === 'serve') {
  process.argv.splice(2, 1);
  process.env.DT_SERVE = '1';
  await import('../src/serve.ts');
} else {
  await import('../src/index.ts');
}
