/**
 * Тул «mail»: электронная почта по ящикам из ~/.dreamteam/mail.json
 * (```mail подкоманда).
 *
 *   boxes                   — настроенные ящики (без паролей);
 *   list [ящик] [N]         — последние N (10) писем; без ящика — если он один;
 *   find <ящик> <текст> [N] — поиск по теме/отправителю среди последних 200;
 *   read <ящик> <uid>       — письмо целиком; вложения сохраняются в mail/
 *                             рабочей папки (пути — в отчёте);
 *   send <ящик>             — отправка: в теле блока шапка «кому:/тема:/файлы:»,
 *                             после пустой строки — текст письма.
 *
 * Отправка — наружное действие, check() всегда спрашивает человека (y/n).
 * Файлы для вложений — только внутри рабочей папки, секреты (.env, ключи)
 * не отправляются никогда.
 */
import { basename, join } from 'node:path';
import { statSync } from 'node:fs';
import { safePath } from '../actions.js';
import { SENSITIVE, checkCardKeys, splitArgs, type Tool, type ToolConfig, type ToolRunContext, type ToolVerdict } from '../tools-api.js';
import {
  findMail,
  formatHeader,
  humanSize,
  listMail,
  loadAccounts,
  mailConfigHint,
  pickAccount,
  readMail,
  resolveEndpoints,
  saveAttachments,
  sendMail,
} from '../mail.js';

const SEND_HEAD = /^[ \t]*(кому|тема|файлы)[ \t]*:[ \t]*(.*)$/;

/** Разбор блока send: шапка key:value до пустой строки, дальше — текст письма. */
function parseSend(text: string): { to?: string; subject?: string; files?: string[]; body: string } {
  const lines = text.replace(/^\r?\n/, '').split(/\r?\n/);
  const meta: { to?: string; subject?: string; files?: string[] } = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      break;
    }
    const m = line.match(SEND_HEAD);
    if (!m) throw new Error(`строка шапки не понята: «${line.slice(0, 60)}» — ожидались кому:/тема:/файлы: (шапку от текста отделяйте пустой строкой)`);
    if (m[1] === 'кому') meta.to = m[2].trim();
    else if (m[1] === 'тема') meta.subject = m[2].trim();
    else meta.files = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return { ...meta, body: lines.slice(i).join('\n').trim() };
}

/** Путь внутри рабочей папки, не секретный; иначе — отказ. */
export function attachmentPath(cwd: string, rel: string): string {
  if (SENSITIVE.test(rel)) throw new Error(`«${rel}» похоже на секретный файл — отправлять его нельзя`);
  const abs = safePath(cwd, rel);
  if (!abs) throw new Error(`файл «${rel}» вне рабочей папки — вкладываю только свои файлы`);
  return abs;
}

export default (config: ToolConfig): Tool => {
  checkCardKeys(config, 'mail');

  return {
    desc:
      'Почта (ящики настроены в ~/.dreamteam/mail.json): ```mail boxes · list [ящик] [N] · find <ящик> <текст> · ' +
      'read <ящик> <uid> (вложения сохранятся в mail/) · send <ящик> (в теле шапка кому:/тема:/файлы:, ' +
      'потом пустая строка и текст письма).',
    check(body): ToolVerdict {
      const sub = body.split(/\s+/)[0] ?? '';
      if (['boxes', 'list', 'find', 'read'].includes(sub)) return 'allow';
      if (sub === 'send') return 'ask';
      return { deny: `подкоманды «${sub}» нет: boxes, list, find, read, send` };
    },
    async run(body: string, ctx: ToolRunContext) {
      const nl = body.indexOf('\n');
      const head = nl === -1 ? body : body.slice(0, nl);
      const text = nl === -1 ? '' : body.slice(nl + 1);
      const [sub = '', ...rest] = splitArgs(head);
      const accounts = loadAccounts();
      switch (sub) {
        case 'boxes': {
          return Object.entries(accounts)
            .map(([name, acc]) => {
              const ep = resolveEndpoints(acc);
              return `${name} — ${acc.user} (imap: ${ep.imap.host}, smtp: ${ep.smtp.host})`;
            })
            .join('\n') || `ящиков нет — заполните ~/.dreamteam/mail.json, например:\n${mailConfigHint()}`;
        }
        case 'list': {
          const n = Math.min(Math.max(Number(rest[1] ?? 10) || 10, 1), 50);
          const { name, acc } = pickAccount(accounts, rest[0]);
          const headers = await listMail(acc, n);
          if (headers.length === 0) return `ящик «${name}»: писем нет`;
          return `ящик «${name}» (${acc.user}), последние ${headers.length}:\n${headers.map(formatHeader).join('\n')}`;
        }
        case 'find': {
          const query = rest[1];
          if (!query) throw new Error('синтаксис: find <ящик> <текст> [сколько]');
          const n = Math.min(Math.max(Number(rest[2] ?? 10) || 10, 1), 50);
          const { name, acc } = pickAccount(accounts, rest[0]);
          const headers = await findMail(acc, query, n);
          if (headers.length === 0) return `ящик «${name}»: по «${query}» ничего`;
          return `ящик «${name}», найдено ${headers.length}:\n${headers.map(formatHeader).join('\n')}`;
        }
        case 'read': {
          const { name, acc } = pickAccount(accounts, rest[0]);
          const uid = rest[1];
          if (!uid) throw new Error('синтаксис: read <ящик> <uid из «mail list»>');
          const mail = await readMail(acc, uid);
          const dir = join(ctx.cwd, 'mail');
          const saved = saveAttachments(dir, mail.attachments);
          const attach = saved.length === 0
            ? 'вложений нет'
            : `вложения (${saved.length}):\n${saved.map((f) => `- ${f.name} (${humanSize(statSync(f.path).size)})`).join('\n')}`;
          return `${mail.header}\nящик: ${name}\n\n${mail.text}\n\n${attach}`;
        }
        case 'send': {
          const { name, acc } = pickAccount(accounts, rest[0]);
          const parsed = parseSend(text);
          if (!parsed.to) throw new Error('в шапке нет «кому: адрес@example.com»');
          if (!parsed.body) throw new Error('тело письма пустое — после шапки (и пустой строки) напишите текст');
          const files = (parsed.files ?? []).map((rel) => {
            const abs = attachmentPath(ctx.cwd, rel);
            return { path: abs, name: basename(abs) };
          });
          return await sendMail(acc, { to: parsed.to, subject: parsed.subject || '(без темы)', text: parsed.body, files });
        }
        default:
          throw new Error(`подкоманды «${sub}» нет: boxes, list, find, read, send`);
      }
    },
  };
};
