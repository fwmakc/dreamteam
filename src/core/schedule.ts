/**
 * Расписание задач для агентов: schedule.json в проекте (.dreamteam) —
 * массив записей {id, message, intervalMinutes, enabled}. serve тикает
 * раз в минуту и запускает раунд, когда подошло время очередной задачи.
 *
 * Планировщик живёт в процессе serve: пока приложение запущено — задачи
 * исполняются, перезапуск сбрасывает таймеры (файл остаётся источником).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScheduleTask {
  id: string;
  /** Задание: уйдёт в чат как реплика руководителя */
  message: string;
  /** Раз в сколько минут исполнять */
  intervalMinutes: number;
  enabled: boolean;
}

export function scheduleFile(projectDir: string): string {
  return join(projectDir, 'schedule.json');
}

export function loadSchedule(projectDir: string): ScheduleTask[] {
  const file = scheduleFile(projectDir);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ScheduleTask[];
    if (!Array.isArray(raw)) return [];
    return raw.filter((t) => t && typeof t.id === 'string' && typeof t.message === 'string' && typeof t.intervalMinutes === 'number');
  } catch {
    return [];
  }
}

export function saveSchedule(projectDir: string, tasks: ScheduleTask[]): void {
  writeFileSync(scheduleFile(projectDir), JSON.stringify(tasks, null, 2) + '\n');
}
