/**
 * Почта: несколько ящиков из ~/.dreamteam/mail.json — приём (IMAP) и отправка
 * (SMTP). Секреты живут в доме, не в карточках агентов: карточка тула ничего
 * не знает о паролях.
 *
 *   { "личное": { "preset": "yandex", "user": "…@yandex.ru", "password": "пароль приложения" },
 *     "работа": { "preset": "custom", "user": "…", "password": "…", "host": "imap.corp.ru", "smtpHost": "smtp.corp.ru" } }
 *
 * Пресеты: yandex (imap.yandex.ru/smtp.yandex.ru), gmail (imap.gmail.com/
 * smtp.gmail.com), mailru (imap.mail.ru/smtp.mail.ru); порты 993/465, у
 * custom можно переопределить полями port/smtpPort. Пароли — «пароли
 * приложений» почтовых провайдеров (обычный пароль от веб-почты не подойдёт).
 *
 * Если почтовик хостера отдаёт сертификат не на имя сервера (типично для
 * mail.на-хостинге.ru с панелью webhost1 и т.п.), соединение не проходит
 * проверку имени. Поле "tlsNoVerify": true отключает сверку имени — шифрование
 * остаётся, но подмену сервера это уже не ловит: включать осознанно.
 *
 * Чтение: последние N писем (конверты), поиск подстрокой по теме/отправителю
 * в последних 200, письмо целиком с сохранением вложений в рабочую папку.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dns from 'node:dns';
import { promisify } from 'node:util';
import { DT_HOME } from './paths.js';

export const MAIL_FILE = join(DT_HOME, 'mail.json');

const PRESETS: Record<string, { imap: string; smtp: string }> = {
  yandex: { imap: 'imap.yandex.ru', smtp: 'smtp.yandex.ru' },
  gmail: { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  mailru: { imap: 'imap.mail.ru', smtp: 'smtp.mail.ru' },
};

const ACCOUNT_FIELDS = ['preset', 'user', 'password', 'host', 'smtpHost', 'port', 'smtpPort', 'tlsNoVerify'];

export interface MailAccount {
  preset: string;
  user: string;
  password: string;
  host?: string;
  smtpHost?: string;
  port?: number;
  smtpPort?: number;
  /** Не сверять имя сервера с сертификатом (хостинги с чужим сертификатом). */
  tlsNoVerify?: boolean;
}

/** Конечные точки ящика: что давать IMAP/SMTP-клиентам. */
export interface MailEndpoints {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
}

/** Читает и валидирует ~/.dreamteam/mail.json; нет файла — отказ с примером. */
export function loadAccounts(file = MAIL_FILE): Record<string, MailAccount> {
  if (!existsSync(file)) {
    throw new Error(
      `нет файла ${file} — опишите ящики, например:\n` +
      '{ "личное": { "preset": "yandex", "user": "я@yandex.ru", "password": "пароль приложения" } }\n' +
      'пресеты: yandex, gmail, mailru; свой сервер — preset "custom" + "host" и "smtpHost"',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} — кривой JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} — ожидается объект {"имя ящика": {...}}`);
  }
  const accounts: Record<string, MailAccount> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${file}: ящик «${name}» — ожидается объект настроек`);
    }
    accounts[name] = readAccount(name, value as Record<string, unknown>, file);
  }
  return accounts;
}

function readAccount(name: string, raw: Record<string, unknown>, file: string): MailAccount {
  const extra = Object.keys(raw).filter((k) => !ACCOUNT_FIELDS.includes(k));
  if (extra.length > 0) {
    throw new Error(`${file}: ящик «${name}» — неизвестные поля ${extra.map((k) => `"${k}"`).join(', ')} (разрешены: ${ACCOUNT_FIELDS.join(', ')})`);
  }
  const preset = String(raw.preset ?? '').trim();
  if (!PRESETS[preset] && preset !== 'custom') {
    throw new Error(`${file}: ящик «${name}» — preset «${preset}» не знаю; есть: ${Object.keys(PRESETS).join(', ')}, custom`);
  }
  const user = String(raw.user ?? '').trim();
  const password = String(raw.password ?? '');
  if (!user || !password) throw new Error(`${file}: ящик «${name}» — нужны "user" и "password" (пароль приложения от провайдера почты)`);
  if (preset === 'custom' && (!String(raw.host ?? '').trim() || !String(raw.smtpHost ?? '').trim())) {
    throw new Error(`${file}: ящик «${name}» — для custom нужны "host" (IMAP) и "smtpHost"`);
  }
  for (const key of ['port', 'smtpPort'] as const) {
    if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || (raw[key] as number) < 1 || (raw[key] as number) > 65535)) {
      throw new Error(`${file}: ящик «${name}» — "${key}" должен быть целым числом 1…65535`);
    }
  }
  if (raw.tlsNoVerify !== undefined && typeof raw.tlsNoVerify !== 'boolean') {
    throw new Error(`${file}: ящик «${name}» — "tlsNoVerify" должен быть true или false`);
  }
  return { ...raw, preset, user, password } as MailAccount;
}

/** Адреса IMAP/SMTP: пресет или custom, порты с переопределением. */
export function resolveEndpoints(acc: MailAccount): MailEndpoints {
  if (acc.preset === 'custom') {
    return {
      imap: { host: acc.host!, port: acc.port ?? 993, secure: (acc.port ?? 993) === 993 },
      smtp: { host: acc.smtpHost!, port: acc.smtpPort ?? 465, secure: (acc.smtpPort ?? 465) === 465 },
    };
  }
  const p = PRESETS[acc.preset]!;
  return {
    imap: { host: p.imap, port: acc.port ?? 993, secure: true },
    smtp: { host: p.smtp, port: acc.smtpPort ?? 465, secure: true },
  };
}

/** «Имя» → аккаунт; без имени — если ящик один, он и есть. */
export function pickAccount(accounts: Record<string, MailAccount>, name?: string): { name: string; acc: MailAccount } {
  if (name) {
    const acc = accounts[name];
    if (!acc) throw new Error(`ящика «${name}» нет — есть: ${Object.keys(accounts).join(', ') || 'никаких'}`);
    return { name, acc };
  }
  const names = Object.keys(accounts);
  if (names.length === 1) return { name: names[0]!, acc: accounts[names[0]!]! };
  throw new Error(`укажите ящик — настроено несколько: ${names.join(', ')}`);
}

// ─── Соединения ──────────────────────────────────────────────────────────────

async function withImap<T>(acc: MailAccount, mailBox: string, fn: (client: import('imapflow').ImapFlow, exists: number) => Promise<T>): Promise<T> {
  const { ImapFlow } = await import('imapflow');
  const ep = resolveEndpoints(acc);
  const client = new ImapFlow({
    host: ep.imap.host,
    port: ep.imap.port,
    secure: ep.imap.secure,
    auth: { user: acc.user, pass: acc.password },
    tls: { rejectUnauthorized: !acc.tlsNoVerify },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`ящик ${acc.user} (${ep.imap.host}) недоступен: ${err instanceof Error ? err.message : err} — проверьте mail.json (нужен пароль приложения)`);
  }
  try {
    const box = await client.mailboxOpen(mailBox);
    return await fn(client, box.exists);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export interface MailHeader {
  uid: number;
  date: Date | undefined;
  from: string;
  subject: string;
}

/** Заголовок строки списка: #uid · дата · от · тема. */
export function formatHeader(m: MailHeader): string {
  const date = m.date ? m.date.toISOString().slice(0, 16).replace('T', ' ') : '???';
  return `#${m.uid} · ${date} · от: ${m.from || '?'} · ${m.subject || '(без темы)'}`;
}

function envelopeFrom(env: { from?: Array<{ name?: string; address?: string }> } | undefined): string {
  const first = env?.from?.[0];
  return first ? `${first.name ? `${first.name} ` : ''}<${first.address}>` : '';
}

/** То, что imapflow отдаёт как конверт и дату (строкой или Date — нормализуем). */
interface MsgLike {
  uid: number;
  internalDate?: string | Date;
  envelope?: { subject?: string; from?: Array<{ name?: string; address?: string }> };
}

function toHeaders(msgs: MsgLike[]): MailHeader[] {
  return msgs
    .filter((m) => m.uid)
    .map((m) => ({
      uid: m.uid,
      date: m.internalDate === undefined ? undefined : new Date(m.internalDate),
      from: envelopeFrom(m.envelope),
      subject: String(m.envelope?.subject ?? ''),
    }));
}

/** Последние n писем ящика (свежие сверху). */
export async function listMail(acc: MailAccount, n: number): Promise<MailHeader[]> {
  return withImap(acc, 'INBOX', async (client, exists) => {
    const from = Math.max(1, exists - n + 1);
    const msgs = await client.fetchAll(`${from}:*`, { uid: true, internalDate: true, envelope: true });
    return toHeaders(msgs).reverse();
  });
}

/** Поиск подстроки по теме/отправителю в последних 200 письмах. */
export async function findMail(acc: MailAccount, query: string, n: number): Promise<MailHeader[]> {
  const q = query.toLowerCase();
  const all = await withImap(acc, 'INBOX', async (client, exists) => {
    const from = Math.max(1, exists - 200 + 1);
    const msgs = await client.fetchAll(`${from}:*`, { uid: true, internalDate: true, envelope: true });
    return toHeaders(msgs);
  });
  return all
    .filter((m) => m.subject.toLowerCase().includes(q) || m.from.toLowerCase().includes(q))
    .reverse()
    .slice(0, n);
}

/** Размер в человекочитаемом виде. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export interface ReadMailResult {
  header: string;
  text: string;
  attachments: import('mailparser').Attachment[];
}

/** Письмо по uid целиком; вложения отдаём тулу — тот сохранит в рабочую папку. */
export async function readMail(acc: MailAccount, uid: string, maxSizeMb = 20): Promise<ReadMailResult> {
  return withImap(acc, 'INBOX', async (client) => {
    const msg = await client.fetchOne(uid as import('imapflow').SequenceString, { uid: true, internalDate: true, envelope: true, source: true }, { uid: true });
    if (msg === false || !msg.source) throw new Error(`письма #${uid} в ящике нет (или оно старше) — сверьтесь с «mail list»`);
    // mailparser экспортирует simpleParser с колбэк-перегрузками — ждём промис явно
    const mp = (await import('mailparser')) as unknown as { simpleParser: (input: Buffer) => Promise<import('mailparser').ParsedMail> };
    const parsed = await mp.simpleParser(msg.source);
    const headers = toHeaders([msg]);
    const text = (parsed.text ?? '').trim() || `(текстового тела нет — html-письмо, ${parsed.html ? humanSize(String(parsed.html).length) : 'и html пуст'})`;
    const attachments = (parsed.attachments ?? []).filter((a) => a.content && a.size <= maxSizeMb * 1024 * 1024);
    return { header: formatHeader(headers[0]!), text, attachments };
  });
}

export interface SendArgs {
  to: string;
  subject: string;
  text: string;
  files?: Array<{ path: string; name: string }>;
}

/** Отправка с ящика; файлы уже проверены тулом (внутри рабочей папки). */
export async function sendMail(acc: MailAccount, args: SendArgs): Promise<string> {
  const nodemailer = await import('nodemailer');
  const ep = resolveEndpoints(acc);
  // nodemailer резолвит хост прямыми DNS-запросами (resolve4/6), а они в части
  // сетей (VPN, корпоративные фильтры) не ходят, хотя системный резолвер
  // работает. Резолвим сами; не вышло — оставляем имя, пусть nodemailer
  // пробует сам. servername сохраняет имя сервера в TLS (SNI и сверка серта).
  let host = ep.smtp.host;
  try {
    host = (await promisify(dns.lookup)(ep.smtp.host)).address;
  } catch { /* оставляем имя хоста */ }
  const transport = nodemailer.createTransport({
    host,
    port: ep.smtp.port,
    secure: ep.smtp.secure,
    auth: { user: acc.user, pass: acc.password },
    tls: { rejectUnauthorized: !acc.tlsNoVerify, servername: ep.smtp.host },
  });
  try {
    const info = await transport.sendMail({
      from: acc.user,
      to: args.to,
      subject: args.subject,
      text: args.text,
      attachments: args.files?.map((f) => ({ path: f.path, filename: f.name })),
    });
    return `✓ отправлено с ${acc.user} на ${args.to} (id ${info.messageId})${args.files?.length ? `, вложений: ${args.files.length}` : ''}`;
  } catch (err) {
    throw new Error(`отправка с ${acc.user} через ${ep.smtp.host} не прошла: ${err instanceof Error ? err.message : err}`);
  }
}

/** Пример mail.json — для отказа без файла и документации. */
export function mailConfigHint(): string {
  return JSON.stringify(
    {
      личное: { preset: 'yandex', user: 'я@yandex.ru', password: 'пароль-приложения' },
      работа: { preset: 'custom', user: 'я@corp.ru', password: '…', host: 'imap.corp.ru', smtpHost: 'smtp.corp.ru' },
    },
    null,
    2,
  );
}

/** Сохраняет вложения письма в папку, возвращает пути. */
export function saveAttachments(dir: string, attachments: import('mailparser').Attachment[]): Array<{ path: string; name: string }> {
  mkdirSync(dir, { recursive: true });
  const out: Array<{ path: string; name: string }> = [];
  for (const att of attachments) {
    if (!att.content) continue;
    const safe = att.filename?.replace(/[\\/:*?"<>|]/g, '_') || `вложение-${out.length}`;
    const path = join(dir, safe);
    writeFileSync(path, att.content);
    out.push({ path, name: safe });
  }
  return out;
}
