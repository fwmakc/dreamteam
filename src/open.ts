/**
 * Открыть адрес в браузере пользователя — лучшее усилие, без гарантий:
 * головной сервер (SSH без дисплея, CI) не обязан иметь браузер. План
 * запуска (команда + аргументы) вынесен отдельно — пробы проверяют его
 * без реального открытия окна.
 */
import { spawn } from 'node:child_process';

export interface OpenPlan {
  cmd: string;
  args: string[];
}

/** Чем открывать адрес в этой ОС: win — start, macOS — open, linux — xdg-open. */
export function browserOpenPlan(url: string): OpenPlan {
  if (process.platform === 'win32') {
    // «start» — встроенная команда cmd: пустой первый аргумент — заголовок окна
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (process.platform === 'darwin') {
    return { cmd: 'open', args: [url] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

/** Открыть адрес в браузере: detached-процесс, ошибки игнорируем (best effort). */
export function openBrowser(
  url: string,
  spawnFn: typeof spawn = spawn,
): OpenPlan {
  const plan = browserOpenPlan(url);
  try {
    const child = spawnFn(plan.cmd, plan.args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // нет браузера/команды — не беда: адрес и так напечатан в консоли
  }
  return plan;
}
