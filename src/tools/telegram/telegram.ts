/**
 * Тул «telegram»: бот Telegram, токен — в messengers.json проекта (папка
 * .dreamteam, ```telegram подкоманда).
 *
 *   list            — чаты, откуда боту писали (chat_id + имя), из getUpdates;
 *   in [N]          — последние N (10) входящих сообщений;
 *   send <chat_id>  — отправка: в теле текст, строки «файлы: п1, п2» в начале
 *                     уходят вложениями (sendDocument).
 *
 * Отправка — наружное действие, check() всегда спрашивает человека (y/n).
 * Файлы — только из рабочей папки, секреты (.env, ключи) не отправляются.
 * «Избранное» для бота — диалог с хозяином: его chat_id смотрите в «list».
 */
import { basename } from 'node:path';
import { checkCardKeys, resolveCard, splitArgs, type Tool, type ToolConfig, type ToolRunContext, type ToolVerdict } from '../../tools-api.js';
import { parseSendText, pickMessenger, loadMessengers, TELEGRAM_API, telegramCall, telegramSendFile } from '../../messengers.js';
import { attachmentPath } from '../mail/mail.js';

interface TgChat {
  id: number | string;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgMessage {
  date?: number;
  chat?: TgChat;
  from?: { first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
}
interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

function chatTitle(chat: TgChat | undefined): string {
  if (!chat) return '?';
  const name = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username);
  return `${name} (${chat.type ?? 'chat'})`;
}

function senderName(m: TgMessage | undefined): string {
  const name = [m?.from?.first_name, m?.from?.last_name].filter(Boolean).join(' ') || m?.from?.username;
  return name || '?';
}

/** Входящие из getUpdates: message и channel_post, по порядку обновлений. */
async function fetchIncoming(api: string, token: string): Promise<Array<{ chatId: string | number; text: string; from: string }>> {
  const updates = (await telegramCall(api, token, 'getUpdates', { body: {} })) as TgUpdate[] | undefined;
  const out: Array<{ chatId: string | number; text: string; from: string }> = [];
  for (const u of updates ?? []) {
    const m = u.message ?? u.channel_post;
    if (!m) continue;
    out.push({ chatId: m.chat?.id ?? '?', text: m.text ?? m.caption ?? '(без текста)', from: senderName(m) });
  }
  return out;
}

export default (config: ToolConfig): Tool => {
  checkCardKeys(resolveCard('telegram', config), 'telegram');

  return {
    desc:
      'Telegram-бот (токен в messengers.json проекта, папка .dreamteam): ```telegram list · in [N] · ' +
      'send <chat_id> (в теле текст, строка «файлы: путь1, путь2» в начале — вложения). ' +
      'chat_id берите из «list».',
    check(body): ToolVerdict {
      const sub = body.split(/\s+/)[0] ?? '';
      if (['list', 'in'].includes(sub)) return 'allow';
      if (sub === 'send') return 'ask';
      return { deny: `подкоманды «${sub}» нет: list, in, send` };
    },
    async run(body: string, ctx: ToolRunContext) {
      const nl = body.indexOf('\n');
      const head = nl === -1 ? body : body.slice(0, nl);
      const text = nl === -1 ? '' : body.slice(nl + 1);
      const [sub = '', ...rest] = splitArgs(head);
      const { token, api } = pickMessenger(loadMessengers(), 'telegram', TELEGRAM_API);
      switch (sub) {
        case 'list': {
          const seen = new Map<string, string>();
          for (const u of ((await telegramCall(api, token, 'getUpdates', { body: {} })) as TgUpdate[] | undefined) ?? []) {
            const m = u.message ?? u.channel_post;
            if (m?.chat) seen.set(String(m.chat.id), chatTitle(m.chat));
          }
          if (seen.size === 0) return 'чатов пока нет — напишите боту в Telegram (или добавьте в группу) и повторите «list»';
          return `чаты бота:\n${[...seen.entries()].map(([id, title]) => `- ${id} — ${title}`).join('\n')}`;
        }
        case 'in': {
          const n = Math.min(Math.max(Number(rest[0] ?? 10) || 10, 1), 100);
          const msgs = (await fetchIncoming(api, token)).slice(-n);
          if (msgs.length === 0) return 'входящих у бота пока нет — напишите ему в Telegram и повторите «in»';
          return `последние ${msgs.length} входящих:\n${msgs.map((m) => `- ${m.chatId} · от ${m.from} · ${m.text}`).join('\n')}`;
        }
        case 'send': {
          const chatId = rest[0];
          if (!chatId) throw new Error('синтаксис: send <chat_id> — id из «telegram list» (канал можно @имя)');
          const parsed = parseSendText(text);
          if (!parsed.body && parsed.files.length === 0) {
            throw new Error('тело пустое — напишите текст сообщения (строка «файлы: путь» в начале приложит файл)');
          }
          if (parsed.files.length === 0) {
            await telegramCall(api, token, 'sendMessage', { body: { chat_id: chatId, text: parsed.body } });
            return `✓ отправлено в чат ${chatId}`;
          }
          for (const rel of parsed.files) {
            const abs = attachmentPath(ctx.cwd, rel);
            await telegramSendFile(api, token, chatId, abs, parsed.body || undefined);
          }
          return `✓ отправлено в чат ${chatId}: файл(ы) ${parsed.files.map((f) => basename(f)).join(', ')}${parsed.body ? ` + подпись` : ''}`;
        }
        default:
          throw new Error(`подкоманды «${sub}» нет: list, in, send`);
      }
    },
  };
};
