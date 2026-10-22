/**
 * Общий помощник проб: убрать временную папку в конце пробы.
 * Windows может держать файл мгновение после закрытия сервера/pty —
 * пара попыток с паузой; не убралось — предупреждение вместо падения пробы
 * (все проверки уже прошли, мусор остался только во временной папке ОС).
 */
import { rmSync } from 'node:fs';

export function rmTemp(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt >= 3) {
        console.log(`  (временная папка не убрана — Windows держит файлы: ${dir})`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}
