#!/usr/bin/env node
// Глобальная команда dreamteam: регистрируем tsx-загрузчик и запускаем
// TypeScript-точку входа напрямую — отдельной сборки у приложения нет.
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
