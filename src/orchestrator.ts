import type { Agent, ChatMessage, LLMProvider } from './types.js';

export interface Turn {
  agent: Agent;
  /** На чём сфокусироваться — задаёт модератор, чтобы ответы не повторялись */
  focus?: string;
}

export interface PlanResult {
  turns: Turn[];
  /** Пометка пользователю: план собрать не удалось, сработал запасной вариант */
  note?: string;
}

export interface PlanInput {
  text: string;
  team: Agent[];
  history: ChatMessage[];
  /** Провайдер, через который думает модератор */
  moderator: LLMProvider;
  /** Участники, упомянутые через @имя */
  mentioned: Agent[];
  /** Отмена раунда (Esc): план не нужен, отвечать никто не будет */
  signal?: AbortSignal;
  /** Имя собеседника для подписей в истории (профиль /me) */
  userName?: string;
  /** Максимальное число отвечающих (0 — без ограничения); по умолчанию 3 */
  maxTurns?: number;
}

const MAX_TURNS = 3;
const HISTORY_LIMIT = 12;

const moderatorPrompt = (maxTurns: number) => `Ты — модератор совещания команды. По сообщению пользователя решаешь, кто из участников должен ответить.

Правила:
- Выбирай от 1 до ${maxTurns} самых релевантных теме участников, не всех подряд.
- На светское или короткое сообщение хватает одного-двух.
- Первый в списке — основной ответчик; остальные развивают или возражают.
- Адвоката дьявола бери, когда полезна критическая оценка идеи, а не в бытовых разговорах.
- В поле focus — одна фраза, которая разводит участников по разным аспектам, чтобы ответы не повторялись.
- Ответ — строго JSON-массив, без какого-либо текста до или после. Формат:
[{"id":"ид_участника","focus":"фокус одной фразой"}]`;

/**
 * Решает, кто отвечает на сообщение пользователя и в каком порядке.
 * Приоритет: @упоминания → модератор (LLM) → запасной вариант.
 * Ничего не печатает: вывод делает вызывающий код (чтобы не мешать спиннеру).
 */
export async function planTurns(input: PlanInput): Promise<PlanResult> {
  const cap = input.maxTurns === 0 ? input.team.length : (input.maxTurns ?? MAX_TURNS);
  if (input.mentioned.length > 0) return { turns: input.mentioned.slice(0, cap || input.team.length).map((agent) => ({ agent })) };
  // mock-модератор не умеет планировать — работаем по эвристике
  if (input.moderator.kind === 'mock') return { turns: mockPlan(input, cap) };
  try {
    return { turns: await llmPlan(input) };
  } catch (err) {
    if (input.signal?.aborted) return { turns: [] }; // прервано (Esc) — не подменяем abort запасным планом
    return {
      turns: input.team.length ? [{ agent: input.team[0] }] : [],
      note: `модератор не смог выбрать участников (${err instanceof Error ? err.message : err}), отвечает ${input.team[0]?.name ?? '—'}`,
    };
  }
}

/** Эвристика для mock-режима: первые двое, на вопрос добавляется критик. */
function mockPlan(input: PlanInput, cap = 2): Turn[] {
  const turns = input.team.slice(0, Math.min(2, cap || 2)).map((agent) => ({ agent }));
  if (/\?\s*$/.test(input.text) && input.team.length > turns.length && turns.length < cap) {
    turns.push({ agent: input.team[input.team.length - 1] });
  }
  return turns;
}

async function llmPlan(input: PlanInput): Promise<Turn[]> {
  const roster = input.team
    .map((a) => `- ${a.id} — ${a.name}, ${a.role}${a.description ? `: ${a.description}` : ''}`)
    .join('\n');
  const recent = input.history
    .slice(-HISTORY_LIMIT)
    .map((m) => `${m.authorId === 'user' ? input.userName ?? 'Пользователь' : m.authorName}: ${m.text}`)
    .join('\n');
  const user =
    `Состав команды:\n${roster}\n\n` +
    (recent ? `Последние сообщения:\n${recent}\n\n` : '') +
    `Новое сообщение от ${input.userName ?? 'пользователя'}:\n«${input.text}»\n\n` +
    `Кто должен ответить и на чём каждому сфокусироваться? Ответь строго JSON-массивом по формату.`;

  let out = '';
  const cap = input.maxTurns === 0 ? 99 : (input.maxTurns ?? 3);
  for await (const chunk of input.moderator.stream({
    system: moderatorPrompt(cap),
    messages: [{ role: 'user', content: user }],
    temperature: 0.2,
    signal: input.signal,
  })) {
    out += chunk;
  }

  const raw = extractJsonArray(out);
  const byId = new Map(input.team.map((a) => [a.id, a]));
  const turns: Turn[] = [];
  for (const item of raw) {
    const agent = byId.get(String((item as { id?: unknown })?.id));
    if (!agent || turns.some((t) => t.agent.id === agent.id)) continue;
    const focus = (item as { focus?: unknown })?.focus;
    turns.push({
      agent,
      focus: typeof focus === 'string' && focus.trim() ? focus.trim() : undefined,
    });
    if (turns.length >= (input.maxTurns === 0 ? Infinity : (input.maxTurns ?? MAX_TURNS))) break;
  }
  if (turns.length === 0) throw new Error('пустой или нераспознанный план');
  return turns;
}

function extractJsonArray(text: string): Array<Record<string, unknown>> {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('в ответе модератора нет JSON-массива');
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('модератор вернул не массив');
  return parsed as Array<Record<string, unknown>>;
}
