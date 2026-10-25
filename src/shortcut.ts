/**
 * Ярлык быстрого запуска: `dreamteam serve --open` — сервер + браузер.
 * По файлу на ОС, везде работает одинаково из коробки:
 *  - Windows: .lnk на рабочем столе (создаём PowerShell'ом, WScript.Shell) →
 *    запускает сценарий bin/dreamteam-serve.cmd в доме;
 *  - Linux: .desktop в ~/.local/share/applications (+ копия на ~/Desktop, если
 *    есть) → Exec на bin/dreamteam-serve.sh в доме, в терминале;
 *  - macOS: Dream Team.command на рабочем столе — двойной клик открывает
 *    Terminal и запускает сервер.
 *
 * Сценарий в доме — на всякий случай абсолютный: узел-интерпретатор
 * (process.execPath) + bin/dreamteam.js пакета (APP_ROOT). Никакой надежды на
 * PATH десктопной сессии (nvm, нестандартные префиксы npm).
 *
 * Всё — лучшее усилие: у ярлыка может не быть места (нет Desktop, экзотика) —
 * тогда ошибка уходит наверх, мастер превращает её в заметку, не падая.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT } from './paths.js';
import { tf } from './i18n.js';

export interface ShortcutOpts {
  /** Подмена путей для проб: рабочий стол */
  desktopDir?: string;
  /** Подмена путей для проб: папка меню приложений (linux) */
  appsDir?: string;
  /** Подмена для проб: интерпретатор (по умолчанию process.execPath) */
  nodePath?: string;
}

const BIN_DIR = 'bin';
const LAUNCHER_CMD = 'dreamteam-serve.cmd';
const LAUNCHER_SH = 'dreamteam-serve.sh';
const binJs = (): string => join(APP_ROOT, 'bin', 'dreamteam.js');

/** Сценарий запуска в доме: абсолютные node + bin/dreamteam.js, флаг --open. */
function writeLauncher(homeDir: string, nodePath: string): { file: string; sh: boolean } {
  const dir = join(homeDir, BIN_DIR);
  mkdirSync(dir, { recursive: true });
  const node = nodePath ?? process.execPath;
  if (process.platform === 'win32') {
    const file = join(dir, LAUNCHER_CMD);
    const body = [
      '@echo off',
      'title Dream Team',
      `"${node}" "${binJs()}" serve --open`,
      '',
    ].join('\r\n');
    writeFileSync(file, body);
    return { file, sh: false };
  }
  const file = join(dir, LAUNCHER_SH);
  writeFileSync(file, `#!/bin/sh\nexec "${node}" "${binJs()}" serve --open\n`);
  chmodSync(file, 0o755);
  return { file, sh: true };
}

/** Папка рабочего стола этой машины; нет — null (ярлык в меню всё равно будет). */
function detectDesktop(opts: ShortcutOpts): string | null {
  if (opts.desktopDir) return opts.desktopDir;
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8' },
    );
    const dir = (r.stdout ?? '').trim();
    return dir && existsSync(dir) ? dir : null;
  }
  const dir = join(homedir(), 'Desktop');
  return existsSync(dir) ? dir : null;
}

/** Windows: .lnk на рабочем столе → сценарий в доме (WScript.Shell через PowerShell). */
function shortcutWindows(launcher: string, homeDir: string, desktopDir: string): string {
  const link = join(desktopDir, 'Dream Team.lnk');
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut('${link.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${launcher.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${homeDir.replace(/'/g, "''")}'`,
    `$s.IconLocation = '${process.execPath.replace(/'/g, "''")}, 0'`,
    '$s.Save()',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`PowerShell не создал .lnk: ${(r.stderr ?? '').trim()}`);
  }
  return link;
}

/** Linux: .desktop в меню приложений (+ копия на рабочий стол, если он есть). */
function shortcutLinux(launcher: string, homeDir: string, opts: ShortcutOpts): string[] {
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Dream Team',
    `Comment=dreamteam serve + browser (${launcher})`,
    `Exec="${launcher}"`,
    'Terminal=true',
    'Categories=Network;',
    '',
  ].join('\n');
  const notes: string[] = [];
  const appsDir = opts.appsDir ?? join(homedir(), '.local', 'share', 'applications');
  mkdirSync(appsDir, { recursive: true });
  const entry = join(appsDir, 'dreamteam.desktop');
  writeFileSync(entry, desktopEntry);
  notes.push(tf('создал ярлык «Dream Team» → {file}', { file: entry }));
  const desktop = opts.desktopDir ?? detectDesktop({});
  if (desktop) {
    const onDesktop = join(desktop, 'dreamteam.desktop');
    writeFileSync(onDesktop, desktopEntry);
    chmodSync(onDesktop, 0o755);
    notes.push(tf('создал ярлык «Dream Team» → {file}', { file: onDesktop }));
  }
  void homeDir;
  return notes;
}

/** macOS: Dream Team.command на рабочем столе — двойной клик = терминал + сервер. */
function shortcutMac(launcher: string, desktopDir: string | null): string[] {
  const target = desktopDir ?? homedir();
  const file = join(target, 'Dream Team.command');
  writeFileSync(file, `#!/bin/sh\nexec "${launcher}"\n`);
  chmodSync(file, 0o755);
  return [tf('создал ярлык «Dream Team» → {file}', { file })];
}

/** Создать ярлык(и) для текущей ОС; возвращает заметки для мастера. */
export async function createShortcut(homeDir: string, opts: ShortcutOpts = {}): Promise<string[]> {
  const nodePath = opts.nodePath;
  const { file: launcher } = writeLauncher(homeDir, nodePath ?? process.execPath);
  const desktopDir = detectDesktop(opts);
  if (process.platform === 'win32') {
    if (!desktopDir) throw new Error('не нашёл папку рабочего стола (Desktop)');
    const link = shortcutWindows(launcher, homeDir, desktopDir);
    return [tf('создал ярлык «Dream Team» → {file}', { file: link })];
  }
  if (process.platform === 'darwin') {
    return shortcutMac(launcher, desktopDir);
  }
  return shortcutLinux(launcher, homeDir, opts);
}
