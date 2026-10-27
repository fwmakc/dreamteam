/**
 * Проба бинаря: -v/--version и -h/--help отвечают без загрузки приложения
 * (дом не создаётся и не трогается), кривая форма проекта — fail-fast с кодом 1.
 * e2e: `dreamteam <путь>` (TUI) и `dreamteam serve <путь>` открывают проект
 * незнакомой папки — регистрируют его в доме. Запуск: npm run probe:bin
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp } from './rm-tmp.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'dreamteam.js');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

// DT_HOME — во временную папку: проба обязана работать без ~/.dreamteam
const home = mkdtempSync(join(tmpdir(), 'dt-bin-'));

let fails = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : `: ${detail}`}`);
  if (!cond) fails++;
}

const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, DT_HOME: home } });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const v1 = run(['-v']);
check('-v печатает версию пакета', v1.status === 0 && v1.stdout.includes(version), `stdout=${JSON.stringify(v1.stdout)} stderr=${JSON.stringify(v1.stderr)}`);

const v2 = run(['--version']);
check('--version — синоним -v', v2.status === 0 && v2.stdout.includes(version));

const h1 = run(['-h']);
check('-h показывает справку (TUI, путь, serve, -v)', h1.status === 0 && h1.stdout.includes('serve') && h1.stdout.includes('<путь>') && h1.stdout.includes('-v'), `stdout=${JSON.stringify(h1.stdout)}`);

const h2 = run(['--help']);
check('--help — синоним -h', h2.status === 0 && h2.stdout.includes('serve'));

// fail-fast до загрузки приложения: опечатка не должна запускать TUI и мастер
const bad = run(['serv']);
check('голое имя вместо пути — отказ с подсказкой /project open (TUI не стартует)', bad.status === 1 && bad.stderr.includes('serv') && bad.stderr.includes('/project open serv'), `status=${bad.status} stderr=${JSON.stringify(bad.stderr)}`);
const flag = run(['--open']);
check('--open без serve — отказ', flag.status === 1 && flag.stderr.includes('--open есть только у serve'), `status=${flag.status} stderr=${JSON.stringify(flag.stderr)}`);
const openSub = run(['open', 'myproj']);
check('подкоманда open убрана — отказ «лишний аргумент»', openSub.status === 1 && openSub.stderr.includes('Лишний аргумент'), `status=${openSub.status} stderr=${JSON.stringify(openSub.stderr)}`);
const newSub = run(['new']);
check('подкоманда new убрана — отказ как не-путь', newSub.status === 1 && newSub.stderr.includes('не похоже на путь') && newSub.stderr.includes('/project open new'), `status=${newSub.status} stderr=${JSON.stringify(newSub.stderr)}`);
const twoPaths = run(['.', 'лишний']);
check('два пути — отказ «лишний аргумент»', twoPaths.status === 1 && twoPaths.stderr.includes('Лишний аргумент'), `status=${twoPaths.status} stderr=${JSON.stringify(twoPaths.stderr)}`);

check('отказы и флаги не создали дом', existsSync(home) && readdirSync(home).length === 0, readdirSync(home).join(', '));

/** Преднастроенный дом: mock-модель + русский интерфейс (мастер не стартует). */
const makeMockHome = (base: string): string => {
  const h = join(base, 'home');
  mkdirSync(join(h, 'models'), { recursive: true });
  writeFileSync(join(h, 'models', 'mock.json'), JSON.stringify({ provider: 'mock' }, null, 2) + '\n');
  writeFileSync(join(h, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');
  return h;
};

// e2e: `dreamteam .` (TUI) — проект текущей папки регистрируется и открывается
{
  const dir = mkdtempSync(join(tmpdir(), 'dt-open-'));
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const mockHome = makeMockHome(dir);
  const child = spawn(process.execPath, [BIN, '.'], { cwd: work, env: { ...process.env, DT_HOME: mockHome } });
  let out = '';
  const opened = await Promise.race([
    new Promise<boolean>((res) => {
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('Проект:')) res(true);
      });
      child.on('exit', () => res(false));
    }),
    new Promise<boolean>((res) => setTimeout(() => res(false), 60_000)),
  ]);
  child.kill();
  check('`dreamteam .`: проект открыт — строка в шапке', opened, `stdout=${JSON.stringify(out.slice(0, 300))}`);
  const pj = join(mockHome, 'projects', 'work', 'project.json');
  check('`dreamteam .`: папка незнакомая — зарегистрирована в доме', existsSync(pj), pj);
  if (existsSync(pj)) {
    const cfg = JSON.parse(readFileSync(pj, 'utf8')) as { id?: string; path?: string };
    check(
      '`dreamteam .`: project.json указывает на рабочую папку',
      cfg.id === 'work' && cfg.path !== undefined && resolve(cfg.path) === resolve(work),
      JSON.stringify(cfg),
    );
  }
  rmTemp(dir);
}

// e2e: `dreamteam serve <путь>` — веб-оболочка сразу с проектом
{
  const dir = mkdtempSync(join(tmpdir(), 'dt-serve-open-'));
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const mockHome = makeMockHome(dir);
  const child = spawn(process.execPath, [BIN, 'serve', work], {
    env: {
      ...process.env,
      DT_HOME: mockHome,
      // PORT=0 serve трактует как «не задан» — берём случайный свободный
      PORT: String(20000 + Math.floor(Math.random() * 20000)),
    },
  });
  let out = '';
  const lifted = await Promise.race([
    new Promise<boolean>((res) => {
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('API поднято') && out.includes('Проект:')) res(true);
      });
      child.on('exit', () => res(false));
    }),
    new Promise<boolean>((res) => setTimeout(() => res(false), 30_000)),
  ]);
  child.kill();
  check('`serve <путь>`: API поднято и проект открыт', lifted, `stdout=${JSON.stringify(out.slice(0, 300))}`);
  check('`serve <путь>`: проект зарегистрирован в доме', existsSync(join(mockHome, 'projects', 'work', 'project.json')));
  rmTemp(dir);
}

console.log(fails === 0 ? '\nВсе проверки прошли.' : `\nПровалено проверок: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
