import pc from 'picocolors';
import { OPERATIONS, findOperation, operationCommand, operationArgs, type OpSpec } from './core/operations.js';
import { t, tf } from './i18n.js';

// канонический список операций живёт в ядре (src/core/operations.ts) — отсюда
// им пользуются терминальные подсказки; /help и сервер отдают тот же список
export { operationHints as commandHints } from './core/operations.js';

/** Живые данные для дополнения: список разговоров, команда, провайдеры. */
export interface CompletionContext {
  /** Разговоры в порядке /sessions (свежие сверху) */
  sessions(): { id: string; title: string }[];
  /** id агентов команды — адресация в командах только по id */
  agentIds(): string[];
  /** Участники текущего чата — их предлагает всплывашка @упоминаний */
  chatAgents(): { id: string; name: string; role?: string }[];
  /** Модели из models/ дома — для /model update|delete и model.id=. */
  modelIds(): string[];
  /** Имя менеджера переговорки (~/.dreamteam/manager.json) — первый пункт всплывашки @ */
  managerName(): string;
  /** Имена проектов дома (папки в projects/) — для /project open|delete.
   *  Опционально: старые вызовы и пробы без дома подсказывать не обязаны. */
  projectNames?(): string[];
}

function commonPrefix(items: string[]): string {
  let prefix = items[0] ?? '';
  while (prefix.length > 0 && !items.every((s) => s.startsWith(prefix))) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * Что Tab вставит: единственный вариант или общий префикс — и только если он
 * удлиняет ввод. При неоднозначности возвращаем пусто: варианты и так видны
 * в панели подсказок, а readline не печатает свои списки (не ломая панель).
 * skipExactPlusSpace — «то, что набрано, плюс пробел» не считается попаданием.
 */
function tabInsert(options: string[], fragment: string, skipExactPlusSpace = false): string[] {
  // регистр и «ё» не важны; вставляем вариант в его исходном виде
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

/** Кандидаты первого слова: полные канонические команды операций. */
function commandOptions(fragment: string): string[] {
  const want = ('/' + fragment).toLowerCase();
  return tabInsert(
    OPERATIONS.map((o) => operationCommand(o) + ' ').filter((o) => o.toLowerCase().startsWith(want)),
    want,
    true,
  );
}

const lastToken = (rest: string): string => (/(\S*)$/.exec(rest))![1];

const verbsOf = (group: string): string[] =>
  [...new Set(OPERATIONS.filter((o) => o.name.startsWith(group + '.') && !o.implicit).map((o) => o.name.split('.')[1]))];

/** Значения аргумента по подсказке манифеста; [] — подсказывать нечего, null — операция неизвестна. */
function argValues(op: OpSpec, argPos: number, ctx: CompletionContext): string[] | null {
  const arg = op.args?.[Math.min(argPos, (op.args?.length ?? 1) - 1)];
  if (!arg) return [];
  switch (arg.hint) {
    case 'sessions':
      return ctx.sessions().map((s) => s.id);
    case 'agents':
      return ctx.agentIds();
    case 'chat':
      return ctx.chatAgents().map((a) => a.id);
    case 'models':
      return ctx.modelIds();
    case 'projects':
      return ctx.projectNames?.() ?? [];
    default:
      return [];
  }
}

/** Варианты для Tab после первого слова; null — группа неизвестна. */
function argOptions(body: string, ctx: CompletionContext): string[] | null {
  const parts = body.trim().split(/\s+/).filter(Boolean);
  const trailing = /\s$/.test(body);
  const group = (parts[0] ?? '').toLowerCase();
  const verbs = verbsOf(group);
  const implicitOp = OPERATIONS.find((o) => o.name.startsWith(group + '.') && o.implicit);

  // '/group ' — глаголы явных операций; у обзорных групп сразу их аргумент
  if (parts.length === 1 && trailing) {
    if (implicitOp && verbs.length === 0) return argValues(implicitOp, 0, ctx) ?? [];
    return verbs.map((v) => v + ' ');
  }
  // '/group ве' — завершаем глагол
  if (parts.length === 2 && !trailing) {
    return tabInsert(verbs.map((v) => v + ' '), parts[1].toLowerCase());
  }

  const explicit = parts[1] ? findOperation(`${group}.${parts[1].toLowerCase()}`) : undefined;
  const op = explicit ?? implicitOp;
  if (!op) return null;
  const hasVerb = Boolean(explicit);
  const typed = parts.length - (hasVerb ? 2 : 1) + (trailing ? 1 : 0);
  return argValues(op, Math.max(0, typed), ctx);
}

/** Completer для readline: операции, их аргументы, @упоминания, номера разговоров. */
export function makeCompleter(ctx: CompletionContext) {
  return (line: string): [string[], string] => {
    if (line.startsWith('/')) {
      const body = line.slice(1);
      const parts = body.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 1 && !/\s$/.test(body)) return [commandOptions(body), line];
      const options = argOptions(body, ctx);
      if (!options || options.length === 0) return [[], line];
      const fragment = /\s$/.test(body) ? '' : lastToken(body);
      const hits = tabInsert(options, fragment);
      return hits.length > 0 ? [hits, line.slice(line.length - fragment.length)] : [[], line];
    }
    const ses = /[@!]session[ \t]+(\S*)$/.exec(line);
    if (ses) {
      const fragment = ses[1];
      const hits = tabInsert(
        ctx.sessions().map((s) => s.id),
        fragment,
      );
      return hits.length > 0 ? [hits, line.slice(line.length - fragment.length)] : [[], line];
    }
    const at = /[@!](\S*)$/.exec(line);
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

/** Строки «id — название» для панели: /session open и @session <id>. */
function sessionRows(ctx: CompletionContext, fragment: string): string[] {
  const hits = ctx
    .sessions()
    .filter((s) => s.id.startsWith(fragment))
    .map((s) => ({ id: s.id, title: s.title }));
  if (hits.length === 0) {
    return [pc.dim(tf('  нет разговора с id «{id}» — см. /sessions', { id: fragment || '…' }))];
  }
  return hits
    .slice(0, 8)
    .map((x) => `  ${x.id} ${pc.dim('—')} ${truncate(x.title, 46)}`);
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
  const ses = /[@!]session[ \t]+(\S*)$/.exec(line);
  if (ses) return sessionRows(ctx, ses[1]);
  // @упоминания рисует MentionPicker (с выбором стрелками) — здесь молчим
  return null;
}

function usageRow(op: OpSpec): string {
  const args = operationArgs(op);
  return `  ${operationCommand(op)}${args ? ' ' + pc.dim(args) : ''}  ${pc.dim('— ' + t(op.help))}`;
}

function hintRowsForCommand(line: string, ctx: CompletionContext): string[] | null {
  if (!line.startsWith('/')) return null;
  const body = line.slice(1);
  const parts = body.trim().split(/\s+/).filter(Boolean);
  const trailing = /\s$/.test(body);

  // первая лексема: показываем подходящие операции целиком
  if (parts.length === 1 && !trailing) {
    const prefix = body.toLowerCase();
    const matches = OPERATIONS.filter((o) => operationCommand(o).slice(1).startsWith(prefix));
    if (matches.length === 0) return [pc.dim(t('  нет такой команды — см. /help'))];
    const rows = matches.slice(0, PANEL_MAX).map(usageRow);
    if (matches.length > PANEL_MAX) rows.push(pc.dim(tf('  … ещё {n} — уточните ввод', { n: matches.length - PANEL_MAX })));
    return rows;
  }

  const group = (parts[0] ?? '').toLowerCase();
  const groupExists = OPERATIONS.some((o) => o.name.startsWith(group + '.'));
  if (!groupExists) return [pc.dim(t('  нет такой группы — см. /help'))];
  const verbs = verbsOf(group);
  const implicitOp = OPERATIONS.find((o) => o.name.startsWith(group + '.') && o.implicit);

  // после группы: глаголы или аргументы обзорной операции
  if (parts.length === 1 && trailing) {
    if (implicitOp && verbs.length === 0) return [usageRow(implicitOp), ...valueRows(implicitOp, 0, ctx)];
    return [
      pc.dim(tf('  /{group} <{verb}>:', { group, verb: t('глагол') })),
      pc.dim('    ' + verbs.slice(0, PANEL_MAX).join('   ')),
    ];
  }
  // завершаем глагол
  if (parts.length === 2 && !trailing) {
    const hits = verbs.filter((v) => v.startsWith(parts[1].toLowerCase()) && v !== parts[1].toLowerCase());
    if (hits.length === 0) return [pc.dim(t('  нет такого глагола — см. /help'))];
    return [
      pc.dim(tf('  /{group} <{verb}>:', { group, verb: t('глагол') })),
      pc.dim('    ' + hits.slice(0, PANEL_MAX).join('   ')),
    ];
  }

  const explicit = parts[1] ? findOperation(`${group}.${parts[1].toLowerCase()}`) : undefined;
  const op = explicit ?? implicitOp;
  if (!op) return [pc.dim(t('  нет такой команды — см. /help'))];
  const hasVerb = Boolean(explicit);
  const argPos = Math.max(0, parts.length - (hasVerb ? 2 : 1) + (trailing ? 1 : 0) - 1);
  return [usageRow(op), ...valueRows(op, argPos, ctx)];
}

/** Живые значения аргумента (номера, имена, id) — для панели. */
function valueRows(op: OpSpec, argPos: number, ctx: CompletionContext): string[] {
  const arg = op.args?.[Math.min(argPos, (op.args?.length ?? 1) - 1)];
  if (!arg) return [];
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  if (arg.hint === 'sessions') return sessionRows(ctx, '');
  let values: string[] | null = null;
  if (arg.hint === 'agents') values = ctx.agentIds();
  else if (arg.hint === 'chat') values = ctx.chatAgents().map((a) => a.id);
  else if (arg.hint === 'models') values = ctx.modelIds();
  else if (arg.hint === 'projects') values = ctx.projectNames?.() ?? [];
  if (values === null) return [];
  return [
    `  ${operationCommand(op)} ${pc.dim(operationArgs(op))}:`,
    pc.dim('    ' + values.slice(0, PANEL_MAX).join('   ')),
  ];
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
const SESSION_ITEM: MentionItem = { label: 'session' };

const normName = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/** @фрагмент, за которым курсор: @ или ! в начале строки или после пробела, без пробелов до курсора */
const MENTION_RE = /(?:^|\s)([@!])([^\s@!]*)$/;

/** Сколько вариантов видно в всплывашке без прокрутки */
const MENTION_VISIBLE = 8;

/** Ширина всплывашки, больше которой подсказка обрезается */
const MENTION_MAX_WIDTH = 52;

function mentionItems(ctx: CompletionContext): MentionItem[] {
  return [
    { label: ctx.managerName(), hint: t('менеджер переговорки') },
    ...ctx.chatAgents().map((a) => ({ label: a.name, hint: a.role })),
    { label: SESSION_ITEM.label, hint: t('конспект другого разговора') },
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
  /** Индекс триггера (@ или !) во вставленном варианте и срез строки на последний пересчёт */
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
        this.sel = (this.sel + 1 + n) % n;
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
    const thumbAt = Math.round((this.sel / Math.max(1, n - 1)) * (visible - thumbSize));

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
