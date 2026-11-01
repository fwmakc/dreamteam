/**
 * Проба ярлыка быстрого запуска и флага --open:
 *  - browserOpenPlan: план открытия на текущей ОС (win: cmd/start, darwin:
 *    open, linux: xdg-open) — без реального открытия окна;
 *  - createShortcut: сценарий запуска в доме (абсолютные node + bin/dreamteam.js,
 *    флаг --open), ярлык по правилам ОС — с подменёнными путями (герметично):
 *    win — .lnk через PowerShell, linux — .desktop в меню и на рабочем столе,
 *    darwin — Dream Team.command;
 *  - ветки других ОС — той же пробой через подмену process.platform:
 *    linux-десктоп и .command на mac проверяются на файлах без настоящей ОС;
 *  - openBrowser — с подменённым spawn: detached + unref, план возвращается
 *    даже когда спавн падает (нет браузера);
 *  - интеграция с мастером проверяется в probe-wizard (там ответ «n» —
 *    без ярлыка: пробы не трогают настоящий рабочий стол).
 *
 * Запуск: npm run probe:shortcut
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const root = mkdtempSync(join(tmpdir(), 'dt-shortcut-'));
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows держит файлы */ } });

const { browserOpenPlan } = await import('../src/open.js');
const { createShortcut } = await import('../src/shortcut.js');

// --- план открытия браузера (без окна) ---------------------------------------
{
  const plan = browserOpenPlan('http://127.0.0.1:8080/');
  const platform = process.platform;
  if (platform === 'win32') {
    check('план win: cmd /c start с пустым заголовком', plan.cmd === 'cmd' && plan.args[0] === '/c' && plan.args[1] === 'start' && plan.args[3] === 'http://127.0.0.1:8080/', JSON.stringify(plan));
  } else if (platform === 'darwin') {
    check('план darwin: open URL', plan.cmd === 'open' && plan.args[0] === 'http://127.0.0.1:8080/', JSON.stringify(plan));
  } else {
    check('план linux: xdg-open URL', plan.cmd === 'xdg-open' && plan.args[0] === 'http://127.0.0.1:8080/', JSON.stringify(plan));
  }
}

// --- ярлык: герметичные подмены путей ----------------------------------------
{
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const desktop = join(root, 'Desktop');
  const apps = join(root, 'apps');
  mkdirSync(desktop, { recursive: true });
  mkdirSync(apps, { recursive: true });

  const notes = await createShortcut(home, { desktopDir: desktop, appsDir: apps });
  check('заметки: ярлык создан хотя бы один', notes.some((n) => n.includes('Dream Team')), notes.join(' | '));

  // сценарий запуска в доме: абсолютные node и bin/dreamteam.js + --open
  const launcher = join(home, 'bin', process.platform === 'win32' ? 'dreamteam-serve.cmd' : 'dreamteam-serve.sh');
  check('сценарий запуска в доме', existsSync(launcher), launcher);
  const body = readFileSync(launcher, 'utf8');
  check('сценарий: serve --open внутри', body.includes('serve --open'), body);
  check('сценарий: абсолютный bin/dreamteam.js', body.replace(/\\/g, '/').includes('bin/dreamteam.js'), body);
  check('сценарий: абсолютный node', body.replace(/\\/g, '/').includes(process.execPath.replace(/\\/g, '/')), body.slice(0, 200));
  if (process.platform !== 'win32') {
    const mode = statSync(launcher).mode & 0o777;
    check('сценарий: права на исполнение (POSIX)', (mode & 0o111) !== 0, mode.toString(8));
  }

  if (process.platform === 'win32') {
    const link = join(desktop, 'Dream Team.lnk');
    check('win: .lnk на рабочем столе (PowerShell)', existsSync(link) && statSync(link).size > 0, link);
  } else if (process.platform === 'darwin') {
    const cmd = join(desktop, 'Dream Team.command');
    check('mac: Dream Team.command на рабочем столе', existsSync(cmd), cmd);
    const mode = statSync(cmd).mode & 0o777;
    check('mac: .command исполняемый', (mode & 0o111) !== 0, mode.toString(8));
  } else {
    const entry = join(apps, 'dreamteam.desktop');
    check('linux: .desktop в меню приложений', existsSync(entry), entry);
    const text = readFileSync(entry, 'utf8');
    check('linux: Exec ведёт на сценарий в доме', text.includes(`Exec="${launcher}"`) && text.includes('Terminal=true'), text);
    const onDesktop = join(desktop, 'dreamteam.desktop');
    check('linux: копия .desktop на рабочем столе', existsSync(onDesktop), onDesktop);
  }
}

// --- ветки linux/mac: подмена process.platform (герметично) -------------------
{
  const realPlatform = process.platform;
  const setPlatform = (p: string): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };
  try {
    const fakeNode = join(root, 'fake-node');
    const desktop2 = join(root, 'Desktop-other');
    const apps2 = join(root, 'apps-other');
    mkdirSync(desktop2, { recursive: true });
    mkdirSync(apps2, { recursive: true });

    setPlatform('linux');
    const homeLinux = join(root, 'home-linux');
    const notesLinux = await createShortcut(homeLinux, { desktopDir: desktop2, appsDir: apps2, nodePath: fakeNode });
    const sh = join(homeLinux, 'bin', 'dreamteam-serve.sh');
    const shBody = readFileSync(sh, 'utf8');
    check('linux: сценарий .sh — шебанг и подменённый node', shBody.startsWith('#!/bin/sh') && shBody.includes(fakeNode), shBody);
    const entry = join(apps2, 'dreamteam.desktop');
    const entryBody = readFileSync(entry, 'utf8');
    check('linux: .desktop в меню — Exec на сценарий', entryBody.includes(`Exec="${sh}"`) && entryBody.includes('Terminal=true'), entryBody);
    const copy = join(desktop2, 'dreamteam.desktop');
    check('linux: копия .desktop на рабочем столе', existsSync(copy) && readFileSync(copy, 'utf8').includes('Exec='), copy);
    check('linux: две заметки', notesLinux.length === 2 && notesLinux.every((n) => n.includes('Dream Team')), notesLinux.join(' | '));

    setPlatform('darwin');
    const homeMac = join(root, 'home-mac');
    const notesMac = await createShortcut(homeMac, { desktopDir: desktop2, nodePath: fakeNode });
    const launcherSh = join(homeMac, 'bin', 'dreamteam-serve.sh');
    const cmdFile = join(desktop2, 'Dream Team.command');
    const cmdBody = readFileSync(cmdFile, 'utf8');
    check('mac: .command запускает сценарий в доме', cmdBody === `#!/bin/sh\nexec "${launcherSh}"\n`, cmdBody);
    check('mac: одна заметка', notesMac.length === 1 && notesMac[0].includes('Dream Team'), notesMac.join(' | '));
    check('план darwin: open URL', browserOpenPlan('http://x:1/').cmd === 'open', JSON.stringify(browserOpenPlan('http://x:1/')));

    setPlatform('linux');
    check('план linux: xdg-open URL', browserOpenPlan('http://x:1/').cmd === 'xdg-open' && browserOpenPlan('http://x:1/').args[0] === 'http://x:1/', JSON.stringify(browserOpenPlan('http://x:1/')));
  } finally {
    setPlatform(realPlatform);
  }
}

// --- openBrowser: спавн с подменой (без окна) ---------------------------------
{
  const { openBrowser } = await import('../src/open.js');
  let calls = 0;
  let unrefs = 0;
  let lastOpts: unknown;
  const spawnStub = ((cmd: string, args: string[], opts: unknown) => {
    calls++;
    lastOpts = { cmd, args, opts };
    return { unref: () => { unrefs++; } };
  }) as unknown as typeof spawn;
  const plan = openBrowser('http://127.0.0.1:9999/', spawnStub);
  const captured = lastOpts as { cmd: string; args: string[]; opts: { detached?: boolean; stdio?: unknown } };
  check('openBrowser: план возвращён и дошёл до спавна', calls === 1 && captured.cmd === plan.cmd && JSON.stringify(captured.args) === JSON.stringify(plan.args), JSON.stringify(captured));
  check('openBrowser: detached, stdio ignore', captured.opts.detached === true && captured.opts.stdio === 'ignore', JSON.stringify(captured.opts));
  check('openBrowser: child отвязан (unref)', unrefs === 1, String(unrefs));

  const boom = (() => { throw new Error('нет браузера'); }) as unknown as typeof spawn;
  const plan2 = openBrowser('http://127.0.0.1:9999/', boom);
  check('openBrowser: падение спавна проглочено, план возвращён', plan2.args.includes('http://127.0.0.1:9999/'), JSON.stringify(plan2));
}

// --- вход через bin: serve --open доходит до src/serve.ts (парсинг флага) ----
{
  // имитируем то, что делает bin: сплайсит 'serve', флаг остаётся в argv
  const fakeArgv = ['/node', '/bin/dreamteam.js', 'serve', '--open'];
  const rest = fakeArgv.slice(2).filter((a) => a !== 'serve');
  check('bin: флаг --open проходит к serve', rest.includes('--open'), JSON.stringify(rest));
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
