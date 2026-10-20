/**
 * Проверка однократного переноса старой схемы (config/ + data/ в корне пакета)
 * на слои: src/paths.ts → migrateLegacy(). Вызывается напрямую с временным
 * корнем; слои (DT_HOME/DT_PROJECT) задаются до импорта модуля — пути
 * замораживаются в tmp, а сам перенос проверяем по файлам. Реальные данные
 * не трогаются. Запуск: tsx tests/probe-migrate.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  }
}

// слои замораживаем во временные папки ДО импорта paths.ts
const layers = mkdtempSync(join(tmpdir(), 'dt-mig-layers-'));
const home = join(layers, 'home');
const proj = join(layers, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = proj;
const { migrateLegacy } = await import('../src/paths.js');
// путь-защита переноса смотрит на env в момент вызова — снимаем его,
// чтобы перенос сработал, а пункты назначения остались tmp-ными
delete process.env.DT_HOME;
delete process.env.DT_PROJECT;

process.on('exit', () => rmSync(layers, { recursive: true, force: true }));

// --- старая схема: config/ + data/ в «корне пакета» ---
const root = mkdtempSync(join(tmpdir(), 'dt-mig-root-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'config'), { recursive: true });
mkdirSync(join(root, 'data', 'sessions'), { recursive: true });
mkdirSync(join(root, 'data', 'transcripts'), { recursive: true });
const cf = (name: string, body: string): void => writeFileSync(join(root, 'config', name), body);
cf('providers.json', '{"default":"mock"}');
cf('settings.json', '{"width":100}');
cf('user.json', '{"name":"Босс"}');
cf('agents.json', '[{"id":"gleb","name":"Глеб","prompt":"п"}]');
cf('manager.json', '{"provider":"mock"}');
cf('projects.json', '{}');
writeFileSync(join(root, 'data', 'sessions', '20260101-000000.json'), '{"id":"s1"}');
writeFileSync(join(root, 'data', 'transcripts', '20260101-000000.md'), '# разговор');
writeFileSync(join(root, 'data', 'memory.json'), '{"shared":[]}');

// --- перенос: всё на местах, источники переехали (rename), каталоги-архивы целы ---
const notes = migrateLegacy(root);
check('перенос: заметки о каждом файле', notes.length >= 8, notes.join(' | '));
check('дом: providers.json', readFileSync(join(home, 'providers.json'), 'utf8').includes('mock'));
check('дом: settings.json и user.json', existsSync(join(home, 'settings.json')) && existsSync(join(home, 'user.json')));
check('проект: agents.json', readFileSync(join(proj, 'agents.json'), 'utf8').includes('Глеб'));
check('проект: manager.json и projects.json', existsSync(join(proj, 'manager.json')) && existsSync(join(proj, 'projects.json')));
check('дом: sessions/ получил разговор', readFileSync(join(home, 'sessions', '20260101-000000.json'), 'utf8').includes('s1'));
check('дом: transcripts/ получил лог', readFileSync(join(home, 'transcripts', '20260101-000000.md'), 'utf8').includes('разговор'));
check('проект: memory.json', readFileSync(join(proj, 'memory.json'), 'utf8').includes('shared'));
check('источники переехали (rename)', !existsSync(join(root, 'config', 'agents.json')) && !existsSync(join(root, 'data', 'memory.json')));
check('старые каталоги остались как архив', existsSync(join(root, 'config')) && existsSync(join(root, 'data', 'sessions')));
check('заметка про архив в конце', notes.at(-1)?.includes('архив') === true, notes.at(-1));

// --- повторный вызов: существующие назначения не перезаписываются ---
writeFileSync(join(root, 'config', 'agents.json'), '[{"id":"другой","name":"Другой","prompt":"п"}]');
const notes2 = migrateLegacy(root);
check('повтор: agents.json не перезаписан', readFileSync(join(proj, 'agents.json'), 'utf8').includes('Глеб'));
check('повтор: старый файл остался на месте (назначение занято)', readFileSync(join(root, 'config', 'agents.json'), 'utf8').includes('Другой'));
check('повтор: заметок нет — переносить нечего', notes2.length === 0, notes2.join(' | '));

// --- защиты: нет старых каталогов и задан env — перенос молчит ---
check('нет старых каталогов — пусто', migrateLegacy(mkdtempSync(join(tmpdir(), 'dt-mig-empty-'))).length === 0);
process.env.DT_HOME = home;
check('DT_HOME задан — перенос не запускается', migrateLegacy(root).length === 0);
delete process.env.DT_HOME;
process.env.DT_PROJECT = proj;
check('DT_PROJECT задан — перенос не запускается', migrateLegacy(root).length === 0);
delete process.env.DT_PROJECT;

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
