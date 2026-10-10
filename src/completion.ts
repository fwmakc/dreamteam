import pc from 'picocolors';

/**
 * Единый список команд: из него собираются /help, Tab-автодополнение
 * и живая панель подсказок под строкой ввода.
 */
export interface CommandSpec {
  cmd: string;
  /** Ожидаемые аргументы — для справки и панели; пусто, если аргументов нет */
  args?: string;
  help: string;
}

export const COMMANDS: CommandSpec[] = [
  { cmd: '/new', help: 'новый разговор (выбор участников, Enter — вся команда)' },
  { cmd: '/sessions', help: 'список сохранённых разговоров' },
  { cmd: '/session', args: '<номер>', help: 'открыть разговор из списка' },
  { cmd: '/delete', args: '<номер>', help: 'удалить разговор из списка' },
  { cmd: '/history', args: '[N]', help: 'история текущего разговора (или последние N)' },
  { cmd: '/team', help: 'состав команды (· не в этом чате)' },
  { cmd: '/add', args: '<имя|номер>', help: 'позвать участника в текущий чат' },
  { cmd: '/out', args: '<имя|номер>', help: 'вывести участника из текущего чата' },
  { cmd: '/providers', help: 'провайдеры и их статус' },
  { cmd: '/provider', args: '<id>', help: 'сменить основного провайдера' },
  { cmd: '/me', args: '[Имя; роль; о себе]', help: 'как вас видит команда' },
  { cmd: '/memory', args: '[имя|shared]', help: 'что помнит участник; shared — общая память' },
  { cmd: '/help', help: 'эта справка' },
  { cmd: '/exit', help: 'выход' },
];

/** Живые данные для дополнения: список разговоров, команда, провайдеры. */
export interface CompletionContext {
  /** Разговоры в порядке /sessions (свежие сверху) — номер = индекс + 1 */
  sessions(): { title: string }[];
  teamNames(): string[];
  providerIds(): string[];
}

function commonPrefix(items: string[]): string {
  let prefix = items[0] ?? '';
  for (const s of items) {
    while (prefix.length > 0 && !s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * Что Tab вставит: единственный вариант или общий префикс — и только если он
 * удлиняет ввод. При неоднозначности возвращаем пусто: варианты и так видны
 * в панели подсказок, а readline не печатает свои списки (не ломая панель).
 * skipExactPlusSpace — для цепочки слэш-команд (/session → Tab → /sessions ):
 * вариант «то, что набрано, плюс пробел» не считается попаданием.
 */
function tabInsert(options: string[], fragment: string, skipExactPlusSpace = false): string[] {
  // как в findMentions: регистр и «ё» не важны; вставляем вариант в его исходном виде
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const nf = norm(fragment);
  const hits = options.filter((o) => {
    const no = norm(o);
    return no.startsWith(nf) && no !== nf && (!skipExactPlusSpace || o !== fragment + ' ');
  });
  if (hits.length === 0) return [];
  if (hits.length === 1) return hits;
  const prefix = commonPrefix(hits);
  return norm(prefix).length > nf.length ? [prefix] : [];
}

function commandOptions(fragment: string): string[] {
  // фрагмент без слэша, варианты — со слэшем: сравниваем в одном виде
  const want = ('/' + fragment).toLowerCase();
  return tabInsert(
    COMMANDS.map((c) => c.cmd + ' ').filter((o) => o.toLowerCase().startsWith(want)),
    want,
    true,
  );
}

const lastToken = (rest: string): string => (/(\S*)$/.exec(rest))![1];

/** Варианты аргументов для Tab; null — команда неизвестна. */
function argOptions(cmd: string, ctx: CompletionContext): string[] | null {
  switch (cmd) {
    case '/session':
    case '/delete':
      return ctx.sessions().map((_, i) => String(i + 1));
    case '/add':
    case '/out':
      return [...ctx.teamNames().map((_, i) => String(i + 1)), ...ctx.teamNames()];
    case '/memory':
      return [...ctx.teamNames(), 'shared'];
    case '/provider':
      return ctx.providerIds();
    case '/new':
    case '/sessions':
    case '/history':
    case '/me':
    case '/help':
    case '/exit':
      return [];
    default:
      return null;
  }
}

/** Completer для readline: команды, @упоминания, номера разговоров. */
export function makeCompleter(ctx: CompletionContext) {
  return (line: string): [string[], string] => {
    if (line.startsWith('/')) {
      const body = line.slice(1);
      const sp = body.indexOf(' ');
      if (sp === -1) return [commandOptions(body), line];
      const rest = body.slice(sp + 1);
      const fragment = lastToken(rest);
      const options = argOptions('/' + body.slice(0, sp).toLowerCase(), ctx);
      const hits = options ? tabInsert(options, fragment) : [];
      return hits.length > 0 ? [hits, line.slice(line.length - fragment.length)] : [[], line];
    }
    const ses = /@session[ \t]+(\S*)$/.exec(line);
    if (ses) {
      const fragment = ses[1];
      const hits = tabInsert(
        ctx.sessions().map((_, i) => String(i + 1)),
        fragment,
      );
      return hits.length > 0 ? [hits, line.slice(line.length - fragment.length)] : [[], line];
    }
    const at = /@(\S*)$/.exec(line);
    if (at) {
      const fragment = at[1];
      const hits = tabInsert(mentionOptions(ctx), fragment);
      return hits.length > 0 ? [hits, line.slice(line.length - fragment.length)] : [[], line];
    }
    return [[], line];
  };
}

/** Варианты упоминаний: имена участников (их и понимает findMentions) и session. */
function mentionOptions(ctx: CompletionContext): string[] {
  return [...ctx.teamNames(), 'session'].map((o) => o + ' ');
}

const PANEL_MAX = 12;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Строки «номер — название» для панели: /session, /delete и @session N. */
function sessionRows(ctx: CompletionContext, fragment: string): string[] {
  const hits = ctx
    .sessions()
    .map((s, i) => ({ n: String(i + 1), title: s.title }))
    .filter((x) => x.n.startsWith(fragment));
  if (hits.length === 0) {
    return [pc.dim(`  нет разговора №${fragment || '…'} — см. /sessions`)];
  }
  return hits
    .slice(0, 8)
    .map((x) => `  ${x.n} ${pc.dim('—')} ${truncate(x.title, 46)}`);
}

/**
 * Строки панели подсказок под вводом (уже раскрашенные); null — панель скрыть.
 * Не совпадает один в один с Tab: панель показывает и то, что вставить нельзя
 * (неоднозначные варианты, формат аргументов).
 */
export function hintRowsFor(line: string, ctx: CompletionContext): string[] | null {
  if (line.startsWith('/')) {
    return hintRowsForCommand(line, ctx);
  }
  const ses = /@session[ \t]+(\S*)$/.exec(line);
  if (ses) return sessionRows(ctx, ses[1]);
  const at = /@(\S*)$/.exec(line);
  if (at) {
    const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
    const fragment = norm(at[1]);
    const names = ctx.teamNames().filter((v) => norm(v).startsWith(fragment));
    const opts = [...names];
    if ('session'.startsWith(fragment)) opts.push('session');
    if (opts.length === 0) return null; // не похоже на упоминание — молчим
    return [`  @${pc.dim('<имя | session>')}:`, pc.dim('    ' + opts.slice(0, PANEL_MAX).join('   '))];
  }
  return null;
}

function hintRowsForCommand(line: string, ctx: CompletionContext): string[] | null {
  if (!line.startsWith('/')) return null;
  const body = line.slice(1);
  const sp = body.indexOf(' ');

  if (sp === -1) {
    const prefix = body.toLowerCase();
    const matches = COMMANDS.filter((c) => c.cmd.slice(1).startsWith(prefix));
    if (matches.length === 0) return [pc.dim('  нет такой команды — см. /help')];
    const rows = matches
      .slice(0, PANEL_MAX)
      .map((c) => `  ${c.cmd}${c.args ? ' ' + pc.dim(c.args) : ''}  ${pc.dim('— ' + c.help)}`);
    if (matches.length > PANEL_MAX) {
      rows.push(pc.dim(`  … ещё ${matches.length - PANEL_MAX} — уточните ввод`));
    }
    return rows;
  }

  const name = '/' + body.slice(0, sp).toLowerCase();
  const rest = body.slice(sp + 1);
  const spec = COMMANDS.find((c) => c.cmd === name);
  const usageRow = spec
    ? [`  ${spec.cmd}${spec.args ? ' ' + pc.dim(spec.args) : ''}  ${pc.dim('— ' + spec.help)}`]
    : null;
  // после полного аргумента и пробела панель значений больше не нужна
  if (rest !== '' && rest.endsWith(' ')) return usageRow;
  const fragment = lastToken(rest);
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

  if (name === '/session' || name === '/delete') {
    return sessionRows(ctx, fragment);
  }

  if (name === '/add' || name === '/out' || name === '/memory' || name === '/provider') {
    const values =
      name === '/provider'
        ? ctx.providerIds()
        : name === '/memory'
          ? [...ctx.teamNames(), 'shared']
          : ctx.teamNames();
    const hits = values.filter((v) => norm(v).startsWith(norm(fragment)) && norm(v) !== norm(fragment));
    if (hits.length > 0) {
      return [
        `  ${name} ${pc.dim(spec?.args ?? '')}:`,
        pc.dim('    ' + hits.slice(0, PANEL_MAX).join('   ')),
      ];
    }
    return usageRow;
  }

  return usageRow;
}

/**
 * Панель подсказок под строкой ввода. Рисуется относительными перемещениями
 * курсора от позиции readline, поэтому не зависит от ширины промпта и цвета;
 * перед каждым выводом и по Enter блок стирается. Вне TTY — тихий no-op.
 */
export class HintPanel {
  private rows = 0;
  private content: string | null = null;

  constructor(private out: NodeJS.WriteStream) {}

  render(rows: string[] | null): void {
    const next = rows !== null && this.out.isTTY && this.out.columns >= 10 ? rows.join('\n') : null;
    if (next === this.content) return;
    let seq = '';
    const erase = () => {
      seq += '\x1b[s';
      for (let i = 0; i < this.rows; i++) seq += '\x1b[1B\r\x1b[2K';
      seq += '\x1b[u';
    };
    if (this.rows > 0) erase();
    if (next !== null) {
      const parts = next.split('\n');
      seq += '\x1b[s';
      for (const p of parts) seq += '\x1b[1B\r\x1b[2K' + p;
      seq += '\x1b[u';
      this.rows = parts.length;
    } else {
      this.rows = 0;
    }
    if (seq !== '') this.out.write(seq);
    this.content = next;
  }

  clear(): void {
    this.render(null);
  }
}
