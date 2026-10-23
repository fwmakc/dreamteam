/**
 * Тул «max»: бот мессенджера MAX, токен — в messengers.json проекта (папка
 * .dreamteam, ```max подкоманда). API: platform-api2.max.ru, заголовок Authorization.
 *
 *   me             — кто я (имя и user_id бота);
 *   chats          — чаты бота (chat_id + название);
 *   in [N]         — последние N (10) входящих сообщений (GET /updates);
 *   send <цель>    — цель: chat_id (из «chats») или user:<user_id>; в теле
 *                    текст, строки «файлы: п1, п2» в начале — вложения
 *                    (загрузка через /uploads → POST файла → token).
 *
 * Отправка — наружное действие, check() всегда спрашивает человека (y/n).
 * Файлы — только из рабочей папки, секреты (.env, ключи) не отправляются.
 * «Избранное» — диалог бота с хозяином: его chat_id смотрите в «chats».
 */
import { basename } from 'node:path';
import { checkCardKeys, resolveCard, splitArgs, type Tool, type ToolConfig, type ToolRunContext, type ToolVerdict } from '../../tools-api.js';
import { apiGet, apiPost, loadMessengers, maxUploadToken, MAX_API, parseSendText, pickMessenger } from '../../messengers.js';
import { attachmentPath } from '../mail/mail.js';

interface MaxChat {
  chat_id?: number | string;
  type?: string;
  title?: string;
}
interface MaxUpdate {
  update_type?: string;
  message?: {
    sender?: { user_id?: number; name?: string };
    recipient?: { chat_id?: number | string };
    body?: { text?: string };
  };
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g)$/i.test(name);
}

export default (config: ToolConfig): Tool => {
  checkCardKeys(resolveCard('max', config), 'max');

  return {
    desc:
      'Бот MAX (токен в messengers.json проекта, папка .dreamteam): ```max me · chats · in [N] · ' +
      'send <chat_id|user:user_id> (в теле текст, строка «файлы: путь1, путь2» в начале — вложения). ' +
      'chat_id берите из «chats».',
    check(body): ToolVerdict {
      const sub = body.split(/\s+/)[0] ?? '';
      if (['me', 'chats', 'in'].includes(sub)) return 'allow';
      if (sub === 'send') return 'ask';
      return { deny: `подкоманды «${sub}» нет: me, chats, in, send` };
    },
    async run(body: string, ctx: ToolRunContext) {
      const nl = body.indexOf('\n');
      const head = nl === -1 ? body : body.slice(0, nl);
      const text = nl === -1 ? '' : body.slice(nl + 1);
      const [sub = '', ...rest] = splitArgs(head);
      const { token, api } = pickMessenger(loadMessengers(), 'max', MAX_API);
      switch (sub) {
        case 'me': {
          const me = (await apiGet(api, '/me', { header: token })) as { name?: string; user_id?: number | string };
          return `бот «${me.name ?? '?'}» (user_id ${me.user_id ?? '?'})`;
        }
        case 'chats': {
          const chats = ((await apiGet(api, '/chats', { header: token })) as { chats?: MaxChat[] } | undefined)?.chats ?? [];
          if (chats.length === 0) return 'чатов у бота пока нет — напишите ему в MAX и повторите «chats»';
          return `чаты бота:\n${chats
            .map((c) => `- ${c.chat_id ?? '?'} — ${c.title ?? '(без названия)'} (${c.type ?? 'chat'})`)
            .join('\n')}`;
        }
        case 'in': {
          const n = Math.min(Math.max(Number(rest[0] ?? 10) || 10, 1), 100);
          const updates = ((await apiGet(api, '/updates', { header: token })) as { updates?: MaxUpdate[] } | undefined)?.updates ?? [];
          const msgs = updates
            .filter((u) => u.update_type === 'message_created' && u.message)
            .map((u) => ({
              chatId: u.message?.recipient?.chat_id ?? '?',
              from: u.message?.sender?.name ?? String(u.message?.sender?.user_id ?? '?'),
              text: u.message?.body?.text ?? '(без текста)',
            }))
            .slice(-n);
          if (msgs.length === 0) return 'входящих у бота пока нет — напишите ему в MAX и повторите «in»';
          return `последние ${msgs.length} входящих:\n${msgs.map((m) => `- ${m.chatId} · от ${m.from} · ${m.text}`).join('\n')}`;
        }
        case 'send': {
          const target = rest[0] ?? '';
          const userId = target.startsWith('user:') ? target.slice(5) : undefined;
          if (!userId && !/^-?\d+$/.test(target)) {
            throw new Error('синтаксис: send <chat_id> (из «max chats») или send user:<user_id>');
          }
          const parsed = parseSendText(text);
          if (!parsed.body && parsed.files.length === 0) {
            throw new Error('тело пустое — напишите текст сообщения (строка «файлы: путь» в начале приложит файл)');
          }
          const attachments = [];
          for (const rel of parsed.files) {
            const abs = attachmentPath(ctx.cwd, rel);
            attachments.push(await maxUploadToken(api, token, isImage(abs) ? 'image' : 'file', abs));
          }
          const query = userId ? `user_id=${encodeURIComponent(userId)}` : `chat_id=${encodeURIComponent(target)}`;
          await apiPost(api, `/messages?${query}`, { text: parsed.body || undefined, attachments }, { header: token });
          return `✓ отправлено в MAX (${userId ? `пользователь ${userId}` : `чат ${target}`})${attachments.length > 0 ? `, вложений: ${attachments.length}` : ''}`;
        }
        default:
          throw new Error(`подкоманды «${sub}» нет: me, chats, in, send`);
      }
    },
  };
};
