import type { ChatMessage, LLMProvider, Session } from './types.js';

/** Столько последних сообщений всегда остаются в контексте как есть */
const KEEP_RECENT = 16;
/** Сжимаем пачками: когда накопилось столько сообщений сверх KEEP_RECENT */
const COMPRESS_BATCH = 8;

const SYSTEM = `Ты — модератор совещания. Сожми историю обсуждения в краткий конспект, чтобы команда могла продолжать разговор без потери сути.
Сохрани: тему и цели; ключевые аргументы и возражения с именами; принятые решения и договорённости; открытые вопросы и следующие шаги; важные цифры, названия и ограничения.
Пиши сжато, до 150–200 слов, без воды. Это рабочий конспект, а не пересказ.`;

/** Сообщения, которые ещё отправляются в LLM целиком (после границы сжатия). */
export function contextSlice(session: Session): ChatMessage[] {
  return session.messages.slice(session.compressedUpTo ?? 0);
}

/**
 * Периодическое сжатие контекста: когда старых сообщений накопилось много,
 * сворачивает их в конспект (LLM-вызов через провайдера модератора) и
 * запоминает границу. Полную историю при этом никто не удаляет — она остаётся
 * в session.messages и в транскрипте, уменьшается только то, что уходит в LLM.
 * Возвращает true, если разговор был сжат.
 */
export async function compressIfNeeded(
  session: Session,
  provider: LLMProvider,
  signal?: AbortSignal,
  userName = 'Пользователь',
): Promise<boolean> {
  const keepFrom = session.messages.length - KEEP_RECENT;
  const from = session.compressedUpTo ?? 0;
  const skipped = session.messages.slice(from, keepFrom);
  if (skipped.length < COMPRESS_BATCH) return false;

  const dialog = skipped
    .map((m) => {
      const who = m.authorId === 'user'
        ? userName
        : m.authorId === 'session-ref'
          ? `Конспект разговора «${m.authorName}»`
          : `${m.authorName} (${m.authorRole ?? 'участник'})`;
      return `${who}: ${m.text}`;
    })
    .join('\n');
  const user =
    (session.summary ? `Предыдущий конспект:\n${session.summary}\n\n` : '') +
    `Сообщения, которые нужно добавить в конспект:\n${dialog}`;

  let summary: string;
  if (provider.kind === 'mock') {
    // без LLM конспектом становится просто список свёрнутых сообщений
    summary = [
      session.summary,
      ...skipped.map((m) => `${m.authorName}: ${m.text.slice(0, 80)}${m.text.length > 80 ? '…' : ''}`),
    ].filter(Boolean).join('\n');
  } else {
    let out = '';
    for await (const chunk of provider.stream({
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      signal,
    })) {
      out += chunk;
    }
    summary = out.trim();
    if (!summary) return false; // пустой ответ — лучше продолжить без сжатия
  }

  session.summary = summary;
  session.compressedUpTo = keepFrom;
  return true;
}
