import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSessionId } from './ids.js';
import type { Session, SessionMeta } from './types.js';

/** Хранилище разговоров: один JSON-файл на разговор в sessions/ проекта + человекочитаемый лог в transcripts/. */
export class SessionStore {
  private readonly transcriptsDir: string;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.transcriptsDir = join(dirname(dir), 'transcripts');
    mkdirSync(this.transcriptsDir, { recursive: true });
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Новый разговор: без id — автоштамп; с id — проверка маски и занятости (кидают ошибку). */
  create(id?: string): Session {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    let final: string;
    if (id !== undefined) {
      if (!isSessionId(id)) {
        throw new Error(
          `id «${id}» не по маске: строчная латиница и цифры, внутри — точка, дефис, подчёркивание`,
        );
      }
      if (existsSync(this.file(id))) throw new Error(`Разговор с id «${id}» уже есть — см. /sessions`);
      final = id;
    } else {
      const base =
        `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
        `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
      final = base;
      let n = 2;
      while (existsSync(this.file(final))) final = `${base}-${n++}`;
    }
    const session: Session = {
      id: final,
      title: 'Новый разговор',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.save(session);
    return session;
  }

  /** touch: false — не освежать дату правки (влив разговора из архива). */
  save(session: Session, opts: { touch?: boolean } = {}): void {
    if (opts.touch !== false) session.updatedAt = Date.now();
    writeFileSync(this.file(session.id), JSON.stringify(session, null, 2), 'utf8');
    this.writeTranscript(session);
  }

  /** Человекочитаемый лог разговора — удобно открыть в редакторе и перечитать. */
  private writeTranscript(s: Session): void {
    const time = (ts: number) => new Date(ts).toLocaleTimeString('ru-RU');
    const lines: string[] = [
      `# ${s.title}`,
      '',
      `Разговор \`${s.id}\` · создан ${new Date(s.createdAt).toLocaleString('ru-RU')} · обновлён ${new Date(s.updatedAt).toLocaleString('ru-RU')}`,
      '',
      '---',
      '',
    ];
    for (const m of s.messages) {
      const who = m.authorId === 'user'
        ? '**Вы**'
        : m.authorId === 'session-ref'
          ? `*📎 Приложение — конспект разговора «${m.authorName}»*`
          : `**${m.authorName}** (${m.authorRole ?? 'участник'})`;
      lines.push(`${who} · ${time(m.ts)}`, '');
      lines.push(m.text.replace(/\r/g, ''), '');
      lines.push('---', '');
    }
    writeFileSync(join(this.transcriptsDir, `${s.id}.md`), lines.join('\n'), 'utf8');
  }

  load(id: string): Session | null {
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8')) as Session;
    } catch {
      return null;
    }
  }

  /** Удаляет разговор и его транскрипт. */
  delete(id: string): void {
    try {
      unlinkSync(this.file(id));
    } catch {
      // нет файла — не страшно
    }
    try {
      unlinkSync(join(this.transcriptsDir, `${id}.md`));
    } catch {
      // аналогично
    }
  }

  /** Все разговоры, свежие сверху. */
  list(): SessionMeta[] {
    const out: SessionMeta[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Session;
        out.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          count: s.messages.length,
        });
      } catch {
        // битый файл не должен ронять список
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
