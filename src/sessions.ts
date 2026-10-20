import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Session, SessionMeta } from './types.js';

/** Хранилище разговоров: один JSON-файл на разговор в data/sessions/ + человекочитаемый лог в data/transcripts/. */
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

  create(): Session {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const base =
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
      `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    let id = base;
    let n = 2;
    while (existsSync(this.file(id))) id = `${base}-${n++}`;
    const session: Session = {
      id,
      title: 'Новый разговор',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.save(session);
    return session;
  }

  save(session: Session): void {
    session.updatedAt = Date.now();
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
