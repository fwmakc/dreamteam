/**
 * Каркасы контекстов тулов для офлайн-проб: вместо литералов в каждом файле.
 * Мостики run/http/confirm — заглушки; workspaceFile/projectFile бросают,
 * пока проба их не переопределит.
 */
import type { ToolCheckContext, ToolRunContext } from '../src/tools-api.js';

export function makeCtx(cwd: string, projectHome: string | null = null): ToolRunContext {
  return {
    cwd,
    projectHome,
    run: async () => ({ ok: true, output: '' }),
    http: async () => ({ ok: true, output: '' }),
    confirm: async () => false,
    workspaceFile: (rel) => {
      throw new Error(`makeCtx: workspaceFile('${rel}') не настроен в пробе`);
    },
    projectFile: (rel) => {
      throw new Error(`makeCtx: projectFile('${rel}') не настроен в пробе`);
    },
  };
}

export function makeCheckCtx(cwd: string, projectHome: string | null = null): ToolCheckContext {
  return { cwd, projectHome };
}
