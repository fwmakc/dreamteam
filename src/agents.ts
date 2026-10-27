/**
 * Команда: полка agents/ в доме — по файлу на агента. id агента = имя файла
 * (латиница/цифры/./-/_), карточка внутри обязана иметь тот же id (сверка при
 * загрузке). Ростер — по алфавиту id: детерминированный порядок для
 * модератора и подсказок. Вызывается перед каждым раундом — правки карточек
 * подхватываются без перезапуска.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentId } from './ids.js';
import { normalizeAgentTools } from './tools-api.js';
import type { Agent, ModelRef, UserProfile } from './types.js';

/** Читает все карточки агентов из agents/ дома, сортирует по id. */
export function loadTeam(dir: string): Agent[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // папки нет — пустая команда (консьерж-старт)
  }
  const agents: Agent[] = [];
  for (const name of names.filter((f) => f.endsWith('.json')).sort()) {
    const id = name.replace(/\.json$/, '');
    const path = join(dir, name);
    if (!isAgentId(id)) {
      throw new Error(`${path}: «${id}» — id агента: строчные буквы/цифры/./-/_`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(
        `${path}: не удалось прочитать карточку агента (${err instanceof Error ? err.message : err})`,
      );
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${path}: ожидается объект-карточка агента`);
    }
    const a = raw as Partial<Agent>;
    if (!a.name || !a.prompt) {
      throw new Error(`${path}: обязательны поля name и prompt`);
    }
    if (a.id !== undefined && String(a.id) !== id) {
      throw new Error(`${path}: id в карточке «${a.id}» не совпадает с именем файла «${id}»`);
    }
    agents.push({
      id,
      name: String(a.name),
      emoji: String(a.emoji ?? '🤖'),
      role: String(a.role ?? 'участник'),
      description: a.description ? String(a.description) : undefined,
      color: String(a.color ?? 'white'),
      prompt: String(a.prompt),
      model: parseModelRef(`агент ${id}`, a.model),
      temperature: typeof a.temperature === 'number' ? a.temperature : undefined,
      tools: normalizeAgentTools(id, a.tools),
      projects: Array.isArray(a.projects) ? a.projects.map(String) : undefined,
      workspace: typeof a.workspace === 'string' && a.workspace.trim() ? a.workspace.trim() : undefined,
      vision: parseModelRef(`агент ${id}: vision`, a.vision),
      image: parseModelRef(`агент ${id}: image`, a.image),
    });
  }
  return agents;
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

/** Команда для показа (снимок состояния). Нет папки — пустая команда. */
export function loadTeamOrEmpty(dir: string): Agent[] {
  if (!existsSync(dir)) return [];
  return loadTeam(dir);
}

/** Читает одну карточку агента; нет файла — undefined. */
export function readAgentCard(dir: string, id: string): Agent | undefined {
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return undefined;
  return loadTeam(dir).find((a) => a.id === id);
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
