import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentTool } from './types.js';

/**
 * Инструменты агентов: текстовый протокол поверх обычного ответа модели.
 * Агент вставляет в ответ markdown-блоки ```file и ```run, приложение
 * парсит их после стрима, выполняет (с подтверждением пользователя)
 * и возвращает результаты следующим сообщением в истории.
 */

export interface ToolsConfig {
  /** Путь из конфига, как написано (для показа агенту) */
  workspace: string;
  /** Тот же путь, разрешённый относительно корня приложения */
  workspaceAbs: string;
  runTimeoutMs: number;
  maxOutputChars: number;
}

export type Action =
  | { kind: 'file'; path: string; content: string }
  | { kind: 'run'; command: string };

export interface ActionResult {
  ok: boolean;
  label: string;
  output: string;
}

/** Читает config/tools.json; нет файла или поля — берём значения по умолчанию. */
export function loadToolsConfig(root: string): ToolsConfig {
  let raw: Partial<ToolsConfig> = {};
  try {
    raw = JSON.parse(readFileSync(join(root, 'config', 'tools.json'), 'utf8'));
  } catch {
    // нет файла — работаем на дефолтах
  }
  const workspace =
    typeof raw.workspace === 'string' && raw.workspace.trim() ? raw.workspace.trim() : '.';
  const runTimeoutMs =
    typeof raw.runTimeoutMs === 'number' && raw.runTimeoutMs > 0 ? raw.runTimeoutMs : 180000;
  const maxOutputChars =
    typeof raw.maxOutputChars === 'number' && raw.maxOutputChars > 0 ? raw.maxOutputChars : 4000;
  return { workspace, workspaceAbs: resolve(root, workspace), runTimeoutMs, maxOutputChars };
}

/** Блоки ```file путь / ```run в ответе агента, в порядке появления. */
export function parseActions(text: string): Action[] {
  const re = /^```(file|run)[ \t]*([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  const actions: Action[] = [];
  for (const m of text.matchAll(re)) {
    if (m[1] === 'file') {
      const path = m[2].trim().replace(/^["']|["']$/g, '');
      if (path) actions.push({ kind: 'file', path, content: m[3].replace(/\n$/, '') });
    } else {
      const command = m[3].trim();
      if (command) actions.push({ kind: 'run', command });
    }
  }
  return actions;
}

/** Короткая строка для подтверждения и для отчёта об отказе. */
export function describeAction(a: Action): string {
  return a.kind === 'file'
    ? `файл ${a.path} (${a.content.length} символов)`
    : `команда: ${a.command.replace(/\s+/g, ' ').slice(0, 140)}`;
}

/**
 * Разрешает путь относительно рабочей папки и запрещает выходить за неё.
 * Возвращает абсолютный путь или null, если путь небезопасен.
 */
export function safePath(workspaceAbs: string, p: string): string | null {
  const target = resolve(workspaceAbs, p);
  const rel = relative(workspaceAbs, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

function killTree(child: ChildProcess): void {
  // shell:true порождает cmd.exe -> сама команда; убиваем всё дерево
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

export function executeFileAction(action: Action & { kind: 'file' }, cfg: ToolsConfig): ActionResult {
  const label = describeAction(action);
  const target = safePath(cfg.workspaceAbs, action.path);
  if (!target) {
    return { ok: false, label, output: `отказ: путь «${action.path}» вне рабочей папки ${cfg.workspaceAbs}` };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, action.content, 'utf8');
    const lines = action.content.split('\n').length;
    return { ok: true, label, output: `записан файл ${action.path} (${lines} строк, ${action.content.length} символов)` };
  } catch (err) {
    return { ok: false, label, output: `ошибка записи: ${err instanceof Error ? err.message : err}` };
  }
}

export function executeRunAction(
  action: Action & { kind: 'run' },
  cfg: ToolsConfig,
  signal?: AbortSignal,
): Promise<ActionResult> {
  return new Promise((done) => {
    const label = describeAction(action);
    let child: ChildProcess;
    try {
      child = spawn(action.command, { shell: true, cwd: cfg.workspaceAbs, signal });
    } catch (err) {
      done({ ok: false, label, output: `ошибка запуска: ${err instanceof Error ? err.message : err}` });
      return;
    }
    let out = '';
    const collect = (chunk: Buffer | string) => {
      out += chunk.toString();
      if (out.length > cfg.maxOutputChars * 4) {
        // защита от бесконечно сыплющего вывода: дальше не копим
        out = out.slice(0, cfg.maxOutputChars * 4);
        killTree(child);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let timedOut = false;
    const timer =
      cfg.runTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, cfg.runTimeoutMs)
        : undefined;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      done({ ok: false, label, output: `ошибка запуска: ${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const full = out.trim();
      const output =
        full.length > cfg.maxOutputChars
          ? full.slice(0, cfg.maxOutputChars) + `\n… (вывод обрезан, всего ${full.length} символов)`
          : full || '(команда не вывела ничего)';
      const status = timedOut
        ? `превышен таймаут ${Math.round(cfg.runTimeoutMs / 1000)} с — процесс прерван`
        : `код выхода: ${code ?? '—'}`;
      done({ ok: !timedOut && code === 0, label, output: `${status}\n${output}` });
    });
  });
}

export function executeAction(
  action: Action,
  cfg: ToolsConfig,
  signal?: AbortSignal,
): ActionResult | Promise<ActionResult> {
  return action.kind === 'file'
    ? executeFileAction(action, cfg)
    : executeRunAction(action, cfg, signal);
}

/** Блок в системный промпт: как агенту пользоваться инструментами. */
export function actionsHint(tools: AgentTool[], cfg: ToolsConfig): string | null {
  if (tools.length === 0) return null;
  const lines: string[] = [
    '## Инструменты',
    `Ты можешь не только обсуждать, но и реально действовать. Рабочая папка: ${cfg.workspaceAbs} (абсолютный путь). Все пути в блоках file — относительные, внутри рабочей папки.`,
    'Чтобы подействовать, вставь в свой ответ блок одного из видов:',
  ];
  if (tools.includes('files')) {
    lines.push(
      '```file относительный/путь/к/файлу.txt',
      '<полное содержимое файла>',
      '```',
    );
  }
  if (tools.includes('shell')) {
    lines.push('```run', '<одна команда оболочки, например docker ps>', '```');
  }
  lines.push(
    'Правила: файл записывается целиком (это перезапись, а не дифф); в одном блоке — одно действие или один файл; не описывай результат словами — результат придёт тебе отдельным сообщением от «⚙ инструменты», дождись его и продолжай; не используй блоки ``` внутри содержимого файла; не выдумывай вывод команд.',
  );
  return lines.join('\n');
}
