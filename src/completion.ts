import pc from 'picocolors';
import { COMMANDS, type CommandSpec } from './core/commands.js';

// канонический список команд живёт в ядре (src/core/commands.ts) — отсюда им
// пользуются терминальные подсказки; /help и сервер отдают его же
export { COMMANDS };
export type { CommandSpec };

/** Живые данные для дополнения: список разговоров, команда, провайдеры. */
export interface CompletionContext {
  /** Разговоры в порядке /sessions (свежие сверху) — номер = индекс + 1 */
  sessions(): { title: string }[];
  teamNames(): string[];
  /** Участники текущего чата — их предлагает всплывашка @упоминаний */
  chatAgents(): { name: string; role?: string }[];
  providerIds(): string[];
  /** Имя менеджера переговорки (config/manager.json) — первый пункт всплывашки @ */
  managerName(): string;
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
    case '/grant':
      return ctx.teamNames();
    case '/agent':
      return ['add', 'set'];
    case '/project':
      return ['add', 'host'];
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
    const ses = /[@№]session[ \t]+(\S*)$/.exec(line);
    if (ses) {
      const fragment = ses[1];
      const hits = tabInsert(
        ctx.sessions().map((_, i) => String(i + 1)),
        fragment,
      );
      return hits.length > 0 ? [hits, line.slice(line.length - fragment.length)] : [[], line];
    }
    const at = /[@№](\S*)$/.exec(line);
    if (at) {
      const fragment = at[1];
      const hits = tabInsert(mentionOptions(ctx), fragment);
      return hits.length > 0 ? [hits, line.slice(line.length - fragment.length)] : [[], line];
    }
    return [[], line];
  };
}

/** Варианты упоминаний для Tab: менеджер, участники текущего чата и session. */
function mentionOptions(ctx: CompletionContext): string[] {
  return [ctx.managerName(), ...ctx.chatAgents().map((a) => a.name), 'session'].map((o) => o + ' ');
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
  const ses = /[@№]session[ \t]+(\S*)$/.exec(line);
  if (ses) return sessionRows(ctx, ses[1]);
  // @упоминания рисует MentionPicker (с выбором стрелками) — здесь молчим
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

/** Один вариант во всплывашке @упоминаний */
interface MentionItem {
  label: string;
  hint?: string;
}

/** @session — спец-упоминание: приложить конспект другого разговора */
const SESSION_ITEM: MentionItem = { label: 'session', hint: 'конспект другого разговора' };

const normName = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/** @фрагмент, за которым курсор: @ или № в начале строки или после пробела, без пробелов до курсора */
const MENTION_RE = /(?:^|\s)([@№])([^\s@№]*)$/;

/** Сколько вариантов видно в всплывашке без прокрутки */
const MENTION_VISIBLE = 8;

/** Ширина всплывашки, больше которой подсказка обрезается */
const MENTION_MAX_WIDTH = 52;

function mentionItems(ctx: CompletionContext): MentionItem[] {
  return [
    { label: ctx.managerName(), hint: 'менеджер переговорки' },
    ...ctx.chatAgents().map((a) => ({ label: a.name, hint: a.role })),
    SESSION_ITEM,
  ];
}

/**
 * Всплывающий выбор @упоминания под строкой ввода: рамка, выбранный вариант
 * подсвечен, при длинном списке — полоса прокрутки. Стрелки двигают выбор,
 * Tab/Enter вставляют, Esc закрывает, оставляя набранный @фрагмент как есть.
 * Живёт на протяжении ввода: фильтрация не сбивает выбор, Esc действует до
 * изменения фрагмента.
 */
export class MentionPicker {
  private items: MentionItem[] = [];
  private sel = 0;
  /** Индекс триггера (@ или №) во вставленном варианте и срез строки на последний пересчёт */
  private at = 0;
  /** Какой триггер набрал пользователь — его же и вставляем */
  private trigger = '@';
  private line = '';
  private cursor = 0;
  /** Фрагмент, для которого Esc уже закрыл панель (наберёшь другой — откроется) */
  private dismissed: string | null = null;

  get active(): boolean {
    return this.items.length > 0;
  }

  /**
   * Пересчёт по строке и позиции курсора: совпал @фрагмент перед курсором —
   * возвращает строки панели, иначе null (панель скрыта).
   */
  update(line: string, cursor: number, ctx: CompletionContext): string[] | null {
    this.line = line;
    this.cursor = cursor;
    const before = line.slice(0, cursor);
    const m = MENTION_RE.exec(before);
    if (!m) {
      this.items = [];
      return null;
    }
    const fragment = normName(m[2]);
    if (this.dismissed !== null && fragment !== this.dismissed) this.dismissed = null;
    if (fragment === this.dismissed) {
      this.items = [];
      return null;
    }
    const items = mentionItems(ctx).filter((it) => normName(it.label).startsWith(fragment));
    if (items.length === 0) {
      this.items = [];
      return null;
    }
    const prev = this.items[this.sel]?.label;
    this.at = before.length - 1 - m[2].length;
    this.trigger = m[1];
    this.items = items;
    const keep = prev ? items.findIndex((it) => it.label === prev) : -1;
    this.sel = keep >= 0 ? keep : 0;
    return this.rows();
  }

  /**
   * Клавиша при открытой панели. 'handled' — клавиша съедена (стрелки, Esc);
   * {line, cursor} — вставить выбранный вариант (Tab/Enter); null — панели это
   * не касается, клавиша уходит в readline.
   */
  key(name: string): 'handled' | { line: string; cursor: number } | null {
    if (!this.active) return null;
    const n = this.items.length;
    switch (name) {
      case 'up':
        this.sel = (this.sel - 1 + n) % n;
        return 'handled';
      case 'down':
        this.sel = (this.sel + 1) % n;
        return 'handled';
      case 'escape':
        this.dismissed = normName(this.line.slice(this.at + 1, this.cursor));
        this.items = [];
        return 'handled';
      case 'tab':
      case 'return':
      case 'enter': {
        const item = this.items[this.sel];
        this.items = [];
        const inserted = item.label + ' ';
        return {
          line: this.line.slice(0, this.at) + this.trigger + inserted + this.line.slice(this.cursor),
          cursor: this.at + 1 + inserted.length,
        };
      }
      default:
        return null;
    }
  }

  /** Строки панели: рамка, подсветка выбранного, полоса прокрутки. */
  rows(): string[] {
    if (!this.active) return [];
    const n = this.items.length;
    const visible = Math.min(n, MENTION_VISIBLE);
    let off = this.sel - Math.floor((visible - 1) / 2);
    off = Math.max(0, Math.min(off, n - visible));
    const scroll = n > visible;
    const thumbSize = Math.max(1, Math.round((visible * visible) / n));
    const thumbAt = Math.round((this.sel / (n - 1)) * (visible - thumbSize));

    const plain: string[] = [];
    const colored: string[] = [];
    for (let i = off; i < off + visible; i++) {
      const it = this.items[i];
      let hint = it.hint ? ' — ' + it.hint : '';
      let label = this.trigger + it.label;
      if (label.length + hint.length > MENTION_MAX_WIDTH) {
        hint = hint.slice(0, Math.max(0, MENTION_MAX_WIDTH - label.length - 1)) + '…';
      }
      if (label.length + hint.length > MENTION_MAX_WIDTH) {
        label = label.slice(0, MENTION_MAX_WIDTH - 1) + '…';
        hint = '';
      }
      plain.push(label + hint);
      colored.push(label + (hint ? pc.dim(hint) : ''));
    }
    const width = Math.max(...plain.map((p) => p.length));
    const edge = '─'.repeat(width + 4 + (scroll ? 1 : 0));
    const rows = ['┌' + edge + '┐'];
    for (let r = 0; r < visible; r++) {
      const pad = ' '.repeat(width - plain[r].length);
      let cell = colored[r] + pad + '  ';
      if (scroll) {
        cell += off + r >= thumbAt && off + r < thumbAt + thumbSize ? '▓' : '░';
      }
      rows.push('│ ' + (off + r === this.sel ? pc.inverse(cell) : cell) + ' │');
    }
    rows.push('└' + edge + '┘');
    return rows;
  }
}
