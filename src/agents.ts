import { existsSync, readFileSync } from 'node:fs';
import { normalizeAgentTools } from './tools-api.js';
import type { Agent, ModelRef, UserProfile } from './types.js';

/**
 * Читает состав команды. Вызывается перед каждым раундом, поэтому правки
 * карточек агентов подхватываются без перезапуска приложения.
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
  // пустая команда — легитимный старт: чат начинается один на один с менеджером
  if (!Array.isArray(list)) {
    throw new Error(`в ${file} нет списка агентов (ожидался массив или поле "agents")`);
  }
  return list.map((item, i): Agent => {
    const a = item as Partial<Agent>;
    if (!a?.id || !a?.name || !a?.prompt) {
      throw new Error(`агент №${i + 1} в agents.json: обязательны поля id, name, prompt`);
    }
    return {
      id: String(a.id),
      name: String(a.name),
      emoji: String(a.emoji ?? '🤖'),
      role: String(a.role ?? 'участник'),
      description: a.description ? String(a.description) : undefined,
      color: String(a.color ?? 'white'),
      prompt: String(a.prompt),
      model: parseModelRef(`агент ${String(a.id)}`, a.model),
      temperature: typeof a.temperature === 'number' ? a.temperature : undefined,
      tools: normalizeAgentTools(String(a.id), a.tools),
      projects: Array.isArray(a.projects) ? a.projects.map(String) : undefined,
      workspace: typeof a.workspace === 'string' && a.workspace.trim() ? a.workspace.trim() : undefined,
      vision: parseModelRef(`агент ${String(a.id)}: vision`, a.vision),
      image: parseModelRef(`агент ${String(a.id)}: image`, a.image),
    };
  });
}

/** Ссылка на модель в карточке: id строкой или объект {id?, …}; форма — только такая. */
function parseModelRef(where: string, raw: unknown): ModelRef | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined;
    return { id: raw.trim() };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const ref = { ...(raw as ModelRef) };
    if (ref.id !== undefined && (typeof ref.id !== 'string' || !ref.id.trim())) {
      throw new Error(`${where}: "model.id" — непустая строка (id карточки из models/)`);
    }
    return ref;
  }
  throw new Error(`${where}: "model" — id строкой или объект {"id": "…", "temperature": …}`);
}

/**
 * Команда для показа (снимок состояния). Нет файла — пустая команда: это
 * легитимный консьерж-старт. А вот битый или невалидный файл — ошибка наружу:
 * команда не имеет права молча исчезать из оболочки.
 */
export function loadTeamOrEmpty(file: string): Agent[] {
  if (!existsSync(file)) return [];
  return loadTeam(file);
}

/**
 * Профиль пользователя (user.json в доме, меняется командой /profile set).
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

/**
 * Символы-триггеры упоминания: «@» — общепринятый, «!» — полный синоним
 * (Shift+1 на любой раскладке и в любом языке).
 */
export const MENTION_TRIGGERS = ['@', '!'] as const;

/** Находит упоминания участников: работает и по имени (@марина), и по id (@marina). */
export function findMentions(text: string, team: Agent[]): Agent[] {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const t = norm(text);
  const found: Agent[] = [];
  for (const agent of team) {
    const name = norm(agent.name);
    const id = norm(agent.id);
    if (MENTION_TRIGGERS.some((p) => t.includes(p + name) || t.includes(p + id))) {
      found.push(agent);
    }
  }
  return found;
}
