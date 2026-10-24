import type { Session } from '../types.js';

/** Кто говорит: агент команды или менеджер переговорки (для заголовка реплики). */
export interface SpeakerRef {
  id: string;
  name: string;
  role?: string;
  emoji?: string;
  color?: string;
}

/**
 * Приёмник стримящейся реплики. Индикатор занятости висит до первого куска,
 * снимается сам (в delta или в done, если текст так и не пошёл).
 */
export interface TurnSink {
  /** Очередной кусок текста. */
  delta(text: string): void;
  /** Стрим кончился (в том числе ошибкой/отменой): снять индикатор занятости. */
  done(): void;
}

/** Вопрос человеку перед действием (y/n); false — отказ. */
export interface ConfirmRequest {
  /** Короткое имя действия: «Команда», «Запись файла», «Тул «x»»… */
  label: string;
  /** Что именно собираются сделать. */
  desc: string;
  /** Кто спрашивает. */
  who: SpeakerRef;
}

/**
 * Единственный канал ядро → оболочка. Ядро ничего не знает о терминале и
 * консоли: всё, что видит человек, оболочка получает через эти методы.
 * Терминальная реализация — CliPresenter в index.ts; поверх неё — GUI.
 */
export interface Presenter {
  /** Служебная заметка о происходящем (тусклая строка). */
  notice(text: string): void;
  /** Событие чата (позвали/вывели участника): ядро уже записал его в хронику
   *  разговора репликой менеджера — оболочка просто показывает строку живьём.
   *  Необязателен: сетевой оболочке достаточно state с записанной репликой. */
  service?(text: string): void;
  /** Ошибка (не падение раунда, а сообщённая проблема). */
  error(text: string): void;
  /** Заголовок реплики агента перед стримом/репликой. */
  turnHeader(agent: SpeakerRef): void;
  /** Занятость без стрима («разбирается…», «осмысливает…»). stop() — снять. */
  busy(label: string): { stop(): void };
  /** Стримящаяся реплика агента. */
  stream(busyLabel: string): TurnSink;
  /** Конец реплики: full — весь текст (оболочка решает, как завершить показ). */
  turnEnd(full: string): void;
  /** Готовая реплика целиком (менеджер отвечает буферизованно). */
  say(text: string): void;
  /** Блок результатов инструментов (⚙ …). */
  toolLines(results: string[]): void;
  /** Приложенный конспект другого разговора (@session). */
  attachment(title: string, digest: string): void;
  /** Живой вопрос человеку; false — отказ. */
  confirm(req: ConfirmRequest): Promise<boolean>;
  /** Выбор разговора для @session: индекс в items или null (отказ). */
  chooseSession(items: { title: string; count: number }[]): Promise<number | null>;
  /** Текущий разговор сменился — показать, где мы оказались. */
  sessionOpened(session: Session): void;
}
