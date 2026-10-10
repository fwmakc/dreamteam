import { readFileSync, writeFileSync } from 'node:fs';
import type {
  Agent,
  AgentChatMemory,
  ChatMessage,
  LLMProvider,
  Session,
  TeamMemory,
} from './types.js';

/** Рефлексия не чаще, чем раз в столько сообщений разговора */
export const REFLECT_THRESHOLD = 12;
/** Сколько последних сообщений скармливается рефлексии */
export const REFLECT_WINDOW = 14;
/** Лимиты в словах — жёсткие бюджеты, чтобы память никогда не разрасталась */
const BUDGET_TASK = 30;
const BUDGET_USER = 30;
const BUDGET_TIE = 20;
const BUDGET_OTHER = 60;
const BUDGET_SHARED = 80;
/** Столько итогов разговоров храним в общем логе */
export const LOG_LIMIT = 8;

export function emptyTeamMemory(): TeamMemory {
  return { log: [], logVersion: 0, agents: {} };
}

export function loadTeamMemory(file: string): TeamMemory {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TeamMemory>;
    return {
      log: Array.isArray(raw.log) ? raw.log.filter((e) => e && typeof e.digest === 'string') : [],
      logVersion: typeof raw.logVersion === 'number' ? raw.logVersion : 0,
      shared: typeof raw.shared === 'string' ? raw.shared : undefined,
      agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {},
    };
  } catch {
    return emptyTeamMemory();
  }
}

export function saveTeamMemory(file: string, memory: TeamMemory): void {
  writeFileSync(file, JSON.stringify(memory, null, 2) + '\n');
}

export function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return words.slice(0, max).join(' ') + '…';
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function label(m: ChatMessage, userName: string): string {
  const who = m.authorId === 'user'
    ? userName
    : m.authorId === 'session-ref'
      ? `Конспект разговора «${m.authorName}»`
      : `${m.authorName} (${m.authorRole ?? 'участник'})`;
  return `${who}: ${m.text}`;
}

/**
 * Блок личной памяти для системного промпта агента. Пустая память → ''.
 */
export function memoryBlock(
  agent: Agent,
  session: Session,
  team: Agent[],
  teamMemory: TeamMemory,
  userName: string,
): string {
  const mine = session.memories?.[agent.id];
  const glob = teamMemory.agents[agent.id];
  const byId = new Map(team.map((a) => [a.id, a.name]));
  const lines: string[] = [];
  if (mine?.task) lines.push(`- Задача в этом разговоре: ${mine.task}`);
  if (mine?.towardUser) lines.push(`- Отношение к ${userName}: ${mine.towardUser}`);
  if (mine?.ties) {
    const parts = Object.entries(mine.ties)
      .filter(([, v]) => v)
      .map(([id, v]) => `${byId.get(id) ?? id} — ${v}`);
    if (parts.length > 0) lines.push(`- Коллеги: ${parts.join('; ')}`);
  }
  if (glob?.otherChats) lines.push(`- Из других разговоров: ${glob.otherChats}`);
  if (teamMemory.shared) lines.push(`- Общее у команды: ${teamMemory.shared}`);
  return lines.join('\n');
}

/** Пора ли агенту осмыслить накопившееся (ленивая рефлексия по порогу). */
export function needsReflection(session: Session, agentId: string): boolean {
  const from = session.memories?.[agentId]?.updatedAtMsg ?? 0;
  return session.messages.length - from >= REFLECT_THRESHOLD;
}

const REFLECT_SYSTEM = `Ты участник командного чата. Обнови свою личную память — то, что ты сам помнишь и чувствуешь после новых сообщений разговора.
Правила:
- меняй только то, что изменилось; ничего не выдумывай;
- task — твоя личная задача/цель в этом конкретном разговоре;
- towardUser — твоё личное отношение к руководителю (собеседнику), с именем можно на «ты»;
- ties — строка на каждого коллегу, с которым было взаимодействие (ключ — его id из списка);
- пиши от первого лица, по-человечески, с отношением, а не протоколом;
- сжато: task и towardUser до 30 слов, каждая связь до 20 слов;
- ответ — строго JSON без пояснений: {"task":"...","towardUser":"...","ties":{"ид":"..."}}`;

/**
 * Ленивая рефлексия: переписывает память агента с учётом новых сообщений.
 * Одно маленькое LLM-обращение; при сбое возвращаем ошибку — память останется прежней.
 */
export async function reflectSessionMemory(
  agent: Agent,
  current: AgentChatMemory | undefined,
  dialog: ChatMessage[],
  userName: string,
  team: Agent[],
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<Pick<AgentChatMemory, 'task' | 'towardUser' | 'ties'>> {
  const base: AgentChatMemory = current ?? { updatedAtMsg: 0 };
  if (provider.kind === 'mock') {
    return { task: base.task, towardUser: base.towardUser, ties: base.ties };
  }
  const roster = team.map((a) => `- ${a.id} — ${a.name}, ${a.role}`).join('\n');
  const currentJson = JSON.stringify(
    { task: base.task ?? '', towardUser: base.towardUser ?? '', ties: base.ties ?? {} },
    null, 1,
  );
  const user =
    `Участники команды:\n${roster}\n\n` +
    `Твоя текущая память:\n${currentJson}\n\n` +
    `Новые сообщения разговора:\n${dialog.map((m) => label(m, userName)).join('\n')}\n\n` +
    `Обнови свою память по формату.`;

  let out = '';
  for await (const chunk of provider.stream({
    system: REFLECT_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.4,
    signal,
  })) {
    out += chunk;
  }
  const json = extractJson(out);
  if (!json) throw new Error('в ответе рефлексии нет JSON');

  const ties: Record<string, string> = { ...(base.ties ?? {}) };
  if (json.ties && typeof json.ties === 'object') {
    for (const [id, v] of Object.entries(json.ties as Record<string, unknown>)) {
      const t = asText(v);
      if (t) ties[id] = clampWords(t, BUDGET_TIE);
    }
  }
  const task = asText(json.task);
  const towardUser = asText(json.towardUser);
  return {
    task: task ? clampWords(task, BUDGET_TASK) : base.task,
    towardUser: towardUser ? clampWords(towardUser, BUDGET_USER) : base.towardUser,
    ties,
  };
}

const MERGE_OTHER_SYSTEM = `Ты участник командного чата. Обнови свою память о других разговорах команды: влей новые итоги в уже имеющиеся воспоминания.
От первого лица, только главное и личное для тебя, до 60 слов, ничего не выдумывай.
Ответ — строго JSON: {"otherChats":"..."}`;

/** Вливает итоги чужих разговоров в память агента (лениво, ≤1 агента за раунд). */
export async function mergeOtherChats(
  current: string | undefined,
  entries: string[],
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<string> {
  if (provider.kind === 'mock') {
    return clampWords([current ?? '', ...entries].filter(Boolean).join(' '), BUDGET_OTHER);
  }
  const user =
    (current ? `Текущие воспоминания:\n${current}\n\n` : '') +
    `Итоги разговоров команды:\n${entries.map((e) => `- ${e}`).join('\n')}\n\n` +
    `Обнови свои воспоминания по формату.`;
  let out = '';
  for await (const chunk of provider.stream({
    system: MERGE_OTHER_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    signal,
  })) {
    out += chunk;
  }
  const json = extractJson(out);
  const text = json ? asText(json.otherChats) : undefined;
  if (!text) throw new Error('в ответе слияния памяти нет JSON');
  return clampWords(text, BUDGET_OTHER);
}

const MERGE_SHARED_SYSTEM = `Сведи общую память команды: влей итоги очередного разговора в уже накопленное. Храни договорённости, решения, названия, цифры и незакрытые вопросы. До 80 слов, без воды.
Ответ — строго JSON: {"shared":"..."}`;

/** Общий документ команды, обновляется при закрытии разговора (≤1 вызова). */
export async function mergeShared(
  current: string | undefined,
  title: string,
  digest: string,
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<string> {
  const entry = `«${title}»: ${digest}`;
  if (provider.kind === 'mock') {
    return clampWords([current ?? '', entry].filter(Boolean).join(' '), BUDGET_SHARED);
  }
  const user =
    (current ? `Текущая общая память:\n${current}\n\n` : '') +
    `Итог разговора:\n${entry}\n\nОбнови общую память по формату.`;
  let out = '';
  for await (const chunk of provider.stream({
    system: MERGE_SHARED_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    signal,
  })) {
    out += chunk;
  }
  const json = extractJson(out);
  const text = json ? asText(json.shared) : undefined;
  if (!text) throw new Error('в ответе слияния общей памяти нет JSON');
  return clampWords(text, BUDGET_SHARED);
}

/** Итог разговора — в общий лог команды (без LLM, просто append с обрезкой). */
export function appendChatToLog(memory: TeamMemory, title: string, digest: string): void {
  memory.log.push({ title: clampWords(title, 12), digest: clampWords(digest, 100) });
  while (memory.log.length > LOG_LIMIT) memory.log.shift();
  memory.logVersion += 1;
}

/** Агент ещё не видел свежие итоги чужих разговоров. */
export function needsGlobalMerge(memory: TeamMemory, agentId: string): boolean {
  const seen = memory.agents[agentId]?.seenVersion ?? 0;
  return memory.log.length > 0 && memory.logVersion - seen >= 1;
}
