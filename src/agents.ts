import { readFileSync } from 'node:fs';
import type { Agent, AgentTool, UserProfile } from './types.js';

/**
 * Читает состав команды. Вызывается перед каждым раундом, поэтому правки
 * config/team.json подхватываются без перезапуска приложения.
 */
export function loadTeam(file: string): Agent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `не удалось прочитать ${file}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown })?.agents;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`в ${file} нет списка агентов (ожидался массив или поле "agents")`);
  }
  return list.map((item, i): Agent => {
    const a = item as Partial<Agent>;
    if (!a?.id || !a?.name || !a?.prompt) {
      throw new Error(`агент №${i + 1} в team.json: обязательны поля id, name, prompt`);
    }
    return {
      id: String(a.id),
      name: String(a.name),
      emoji: String(a.emoji ?? '🤖'),
      role: String(a.role ?? 'участник'),
      description: a.description ? String(a.description) : undefined,
      color: String(a.color ?? 'white'),
      prompt: String(a.prompt),
      provider: a.provider ? String(a.provider) : undefined,
      temperature: typeof a.temperature === 'number' ? a.temperature : undefined,
      tools: Array.isArray(a.tools)
        ? a.tools.filter(
            (t): t is AgentTool =>
              t === 'files' || t === 'shell' || t === 'ssh' || t === 'look' || t === 'image',
          )
        : undefined,
      projects: Array.isArray(a.projects) ? a.projects.map(String) : undefined,
      hosts: Array.isArray(a.hosts) ? a.hosts.map(String) : undefined,
      workspace: typeof a.workspace === 'string' && a.workspace.trim() ? a.workspace.trim() : undefined,
      vision: typeof a.vision === 'string' && a.vision.trim() ? a.vision.trim() : undefined,
      image: typeof a.image === 'string' && a.image.trim() ? a.image.trim() : undefined,
    };
  });
}

/**
 * Профиль пользователя (config/user.json, меняется командой /me).
 * Файл необязателен: нет файла — участники видят просто «Пользователь».
 */
export function loadUserProfile(file: string): UserProfile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<UserProfile>;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Пользователь';
    const role = typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : undefined;
    const about = typeof raw.about === 'string' && raw.about.trim() ? raw.about.trim() : undefined;
    return { name, role, about };
  } catch {
    return { name: 'Пользователь' };
  }
}

/** Находит @упоминания участников: работает и по имени (@марина), и по id (@marina). */
export function findMentions(text: string, team: Agent[]): Agent[] {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const t = norm(text);
  const found: Agent[] = [];
  for (const agent of team) {
    if (t.includes('@' + norm(agent.name)) || t.includes('@' + norm(agent.id))) {
      found.push(agent);
    }
  }
  return found;
}
