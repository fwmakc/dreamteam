#!/usr/bin/env node
// Глобальная команда dreamteam: регистрируем tsx-загрузчик и запускаем
// TypeScript-точку входа напрямую — отдельной сборки у приложения нет.
// `dreamteam serve` поднимает локальный API+GUI (src/serve.ts).
import { register } from 'tsx/esm/api';

register();
const serve = process.argv[2] === 'serve';
if (serve) {
  process.argv.splice(2, 1);
  process.env.DT_SERVE = '1';
}
await import(serve ? '../src/serve.ts' : '../src/index.ts');
