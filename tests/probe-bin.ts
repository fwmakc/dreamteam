/**
 * Проба бинаря: -v/--version и -h/--help отвечают без загрузки приложения
 * (дом не создаётся и не трогается), незнакомый аргумент — fail-fast с кодом 1.
 * Запуск: npm run probe:bin
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
check('-h показывает справку (TUI, serve, -v)', h1.status === 0 && h1.stdout.includes('serve') && h1.stdout.includes('-v'), `stdout=${JSON.stringify(h1.stdout)}`);

const h2 = run(['--help']);
check('--help — синоним -h', h2.status === 0 && h2.stdout.includes('serve'));

const bad = run(['serv']);
check('незнакомый аргумент — отказ с кодом 1 (TUI не стартует)', bad.status === 1 && bad.stderr.includes('serv') && bad.stderr.includes('serve'), `status=${bad.status} stderr=${JSON.stringify(bad.stderr)}`);

check('флаги не создали дом', existsSync(home) && readdirSync(home).length === 0, readdirSync(home).join(', '));

// serve-ветка бинаря: на преднастроенном доме (mock) сервер поднимается и печатает адрес
{
  const serveDir = mkdtempSync(join(tmpdir(), 'dt-serve-'));
  mkdirSync(join(serveDir, 'home'), { recursive: true });
  writeFileSync(
    join(serveDir, 'home', 'providers.json'),
    JSON.stringify({ default: 'mock', providers: { mock: { adapter: 'mock' } } }, null, 2) + '\n',
  );
  const child = spawn(process.execPath, [BIN, 'serve'], {
    env: {
      ...process.env,
      DT_HOME: join(serveDir, 'home'),
      DT_PROJECT: join(serveDir, 'proj'),
      // PORT=0 serve трактует как «не задан» — берём случайный свободный
      PORT: String(20000 + Math.floor(Math.random() * 20000)),
    },
  });
  let out = '';
  const lifted = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('API поднято')) resolve(true);
      });
      child.on('exit', () => resolve(false));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  child.kill();
  check('serve: бинарь поднимает API и печатает адрес', lifted, `stdout=${JSON.stringify(out.slice(0, 200))}`);
  rmTemp(serveDir);
}

console.log(fails === 0 ? '\nВсе проверки прошли.' : `\nПровалено проверок: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
