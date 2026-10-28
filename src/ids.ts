/**
 * Маски id сущностей (агенты, тулы, модели, адаптеры): строчная латиница и
 * цифры, внутри — дефис, подчёркивание и точка. Точка не по краям и не
 * двойная: «qwen2.5-vl-7b», «pdf.export» — можно, «.a», «a.», «a..b» — нет:
 * id попадает в имена файлов, а точка на краю имени запрещена на Windows.
 */

/** С цифры или буквы, от 1 символа. */
const ID_ALNUM = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;

/** С буквы, от 1 символа. */
const ID_LETTER = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;

/** Агент: agents/<id>.json, @упоминания. */
export const isAgentId = (id: string): boolean => ID_ALNUM.test(id);

/** Тул: встроенный, tools/<id>.ts, вызов блоком ```<id>. */
export const isToolId = (id: string): boolean => ID_LETTER.test(id) && id.length >= 2;

/** Модель и кастомный адаптер: models/<id>.json, providers/<id>.ts. */
export const isModelId = (id: string): boolean => ID_LETTER.test(id) && id.length >= 2;

/** Разговор: sessions/<id>.json; автогенерация — штамп «20261027-143052». */
export const isSessionId = (id: string): boolean => ID_ALNUM.test(id);

/** Запись секрета проекта (ящик, сервер, бот): ключ в project.json. */
export const isRecordId = (id: string): boolean => ID_ALNUM.test(id);
