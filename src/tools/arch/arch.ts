/**
 * Тул «arch»: архивы zip / tar / tar.gz без внешних программ — чистый Node
 * (adm-zip для zip, tar для tar-семейства), одинаково на Windows и Linux.
 *
 * Тело блока — подкоманда первым словом:
 *  - pack archive.zip путь…      — запаковать файлы и папки (рекурсивно);
 *  - unpack archive.zip [папка]  — распаковать (по умолчанию — текущая);
 *  - list archive.zip            — содержимое: имена и размеры.
 *
 * Безопасность (в том же стиле, что files/shell):
 *  - zip-slip и выход за рабочую папку: каждый путь записи проверяется
 *    safePath — отказ с обоснованием;
 *  - симлинки внутри архива — отказ (классическая атака);
 *  - секреты (.env, *.pem, id_rsa…) и служебная .dreamteam — не пакуются
 *    и не распаковываются (тот же SENSITIVE/protectedPath, что у files);
 *  - маски карточки ("masks") — дополнительные запреты при упаковке;
 *  - архивы-бомбы: лимиты карточки maxEntries/maxTotalBytes — проверяются
 *    ДО распаковки.
 *
 * rar/7z не поддерживаются: проприетарные форматы без чистой JS-библиотеки.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import {
  checkCardKeys,
  maskDeny,
  parseMasks,
  protectedPath,
  SENSITIVE,
  splitArgs,
  toolDefaults,
  type BuiltinDeps,
  type Tool,
  type ToolConfig,
  type ToolRunContext,
} from '../../tools-api.js';
import { safePath } from '../../actions.js';

/** Заводские лимиты архивов-бомб — из default.json рядом с кодом. */
const DEF = toolDefaults('arch');
checkCardKeys(DEF, 'arch default.json', 'maxEntries', 'maxTotalBytes');
const DEFAULT_MAX_ENTRIES = DEF.maxEntries as number;
const DEFAULT_MAX_TOTAL_BYTES = DEF.maxTotalBytes as number;
if (!Number.isInteger(DEFAULT_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES <= 0 || !Number.isInteger(DEFAULT_MAX_TOTAL_BYTES) || DEFAULT_MAX_TOTAL_BYTES <= 0) {
  throw new Error('src/tools/arch/default.json: "maxEntries" и "maxTotalBytes" — положительные целые числа');
}

/** Расширение → формат; неизвестное — ошибка (rar/7z сознательно не поддержаны). */
function formatOf(file: string): 'zip' | 'tar' | 'tgz' {
  const low = file.toLowerCase();
  if (low.endsWith('.zip')) return 'zip';
  if (low.endsWith('.tgz') || low.endsWith('.tar.gz')) return 'tgz';
  if (low.endsWith('.tar')) return 'tar';
  throw new Error(`формат «${file}» не поддерживается: zip, tar, tar.gz/tgz (rar/7z — проприетарные, распаковывайте вручную)`);
}

/** Причина отказа для файла (секреты, служебная папка, маски карточки) или null. */
function denyReason(rel: string, masks: string[] | undefined): string | null {
  const prot = protectedPath(rel);
  if (prot) return prot;
  if (SENSITIVE.test(rel)) return `«${rel}» — похож на секрет (ключи и пароли не пакуются)`;
  return maskDeny(masks, rel);
}

/** Рекурсивный обход папки → относительные пути файлов (вперёд-слэши). */
function walkFiles(absDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(abs);
    }
  };
  walk(absDir);
  return out;
}

/** Собирает список файлов для упаковки: источники рекурсивно, сам архив — мимо. */
function collectForPack(cwd: string, archiveAbs: string, sources: string[], masks: string[] | undefined): { relFiles: string[]; denied: string[] } {
  const picked = new Set<string>();
  const denied: string[] = [];
  for (const src of sources) {
    const srcAbs = safePath(cwd, src);
    if (!srcAbs) throw new Error(`«${src}» — выход за рабочую папку`);
    if (!existsSync(srcAbs)) throw new Error(`«${src}» — файла или папки нет`);
    const files = statSync(srcAbs).isDirectory() ? walkFiles(srcAbs) : [srcAbs];
    for (const abs of files) {
      if (abs === archiveAbs) continue; // сам архив не пакуем
      const rel = relative(cwd, abs).replaceAll('\\', '/');
      const reason = denyReason(rel, masks);
      if (reason) {
        denied.push(reason);
        continue;
      }
      picked.add(abs);
    }
  }
  return { relFiles: [...picked].map((abs) => relative(cwd, abs).replaceAll('\\', '/')), denied };
}

function packZip(archiveAbs: string, cwd: string, relFiles: string[]): string {
  const zip = new AdmZip();
  for (const rel of relFiles) zip.addFile(rel, readFileSync(join(cwd, rel)));
  writeFileSync(archiveAbs, zip.toBuffer());
  return `✅ упаковано файлов: ${relFiles.length} → ${archiveAbs}`;
}

async function packTar(archiveAbs: string, cwd: string, relFiles: string[], gzip: boolean): Promise<string> {
  // v7 tar: список файлов — второй позиционный аргумент; без колбэка — промис,
  // дождаться обязательно, иначе архив не дописан к моменту распаковки
  await tar.c(
    { file: archiveAbs, cwd, gzip, portable: true },
    relFiles,
  );
  return `✅ упаковано файлов: ${relFiles.length} → ${archiveAbs}`;
}

type TarEntryInfo = { path: string; size: number; type?: string };

/** Читает оглавление tar-архива (вторая строка — честное распакованное имя). */
async function tarEntries(archiveAbs: string): Promise<TarEntryInfo[]> {
  const out: TarEntryInfo[] = [];
  await tar.t({
    file: archiveAbs,
    onReadEntry: (e: { path: string; size?: number; type?: string }) =>
      out.push({ path: e.path, size: e.size ?? 0, type: e.type }),
  });
  return out;
}

export default (config: ToolConfig, _deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'arch', 'maxEntries', 'maxTotalBytes', 'masks');
  const masks = parseMasks(config, 'arch');
  const maxEntries =
    config.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : Number(config.maxEntries);
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('карточка тула arch: "maxEntries" — положительное целое число файлов');
  }
  const maxTotalBytes =
    config.maxTotalBytes === undefined ? DEFAULT_MAX_TOTAL_BYTES : Number(config.maxTotalBytes);
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error('карточка тула arch: "maxTotalBytes" — положительное целое число байт');
  }

  const desc =
    'Архивы zip / tar / tar.gz без внешних программ (```arch подкоманда …). ' +
    'pack archive.zip файлы… — запаковать; unpack archive.zip [папка] — распаковать; ' +
    'list archive.zip — содержимое. Симлинки, секреты (.env, *.pem, id_rsa…), ' +
    'служебная .dreamteam и выход за рабочую папку — отказ; rar/7z не поддерживаются.';

  /** Разбор и проверка тела; возвращает нормализованные пути (безопасные, внутри cwd). */
  function parseBody(body: string, ctx: { cwd?: string }): {
    sub: string; format: 'zip' | 'tar' | 'tgz'; archiveAbs: string; archiveRel: string; sources: string[]; targetAbs: string;
  } {
    const [sub = '', ...rest] = splitArgs(body);
    if (!['pack', 'unpack', 'list'].includes(sub)) {
      throw new Error('подкоманды: pack archive.zip пути… · unpack archive.zip [папка] · list archive.zip');
    }
    const cwd = ctx.cwd ?? process.cwd();
    const archiveRel = rest[0] ?? '';
    if (!archiveRel) throw new Error('укажите файл архива');
    const format = formatOf(archiveRel);
    const archiveAbs = safePath(cwd, archiveRel);
    if (!archiveAbs) throw new Error(`«${archiveRel}» — выход за рабочую папку`);
    const reason = protectedPath(archiveRel);
    if (reason) throw new Error(reason);
    if (sub === 'pack' && rest.length < 2) {
      throw new Error('укажите, что паковать: pack archive.zip путь…');
    }
    const sources = sub === 'pack' ? rest.slice(1) : [];
    const targetRel = sub === 'unpack' ? (rest[1] ?? '.') : '.';
    const targetAbs = safePath(cwd, targetRel);
    if (!targetAbs) throw new Error(`папка «${targetRel}» — выход за рабочую папку`);
    return { sub, format, archiveAbs, archiveRel, sources, targetAbs };
  }

  /** Общие проверки записей архива: slip, секреты, лимиты. Бросает при нарушении. */
  function vetEntries(entries: { path: string; size?: number; isDir: boolean; isLink: boolean }[], targetAbs: string): void {
    if (entries.length > maxEntries) {
      throw new Error(`в архиве ${entries.length} записей — лимит ${maxEntries} (карточка "maxEntries"); архив-бомба?`);
    }
    let total = 0;
    for (const e of entries) {
      const rel = e.path.replace(/^\.?\//, '').replace(/\\/g, '/');
      const dest = safePath(targetAbs, rel);
      if (!dest) throw new Error(`запись «${e.path}» выпадает за папку распаковки (zip-slip) — отказ`);
      const reason = denyReason(rel, masks) ?? protectedPath(rel);
      if (reason) throw new Error(`запись «${e.path}»: ${reason}`);
      if (e.isLink) throw new Error(`запись «${e.path}» — симлинк, симлинки в архивах запрещены`);
      if (!e.isDir) total += e.size ?? 0;
    }
    if (total > maxTotalBytes) {
      throw new Error(`распакованный объём ${total} Б — лимит ${maxTotalBytes} (карточка "maxTotalBytes"); архив-бомба?`);
    }
  }

  return {
    desc,
    check: (body, ctx) => {
      try {
        parseBody(body, ctx!);
        return 'allow';
      } catch (err) {
        return { deny: err instanceof Error ? err.message : String(err) };
      }
    },
    async run(body, ctx) {
      const { sub, format, archiveAbs, archiveRel, sources, targetAbs } = parseBody(body, ctx);

      if (sub === 'pack') {
        const { relFiles, denied } = collectForPack(ctx.cwd, archiveAbs, sources, masks);
        if (denied.length > 0) {
          throw new Error(`отказ — в списке на упаковку запрещённые файлы:\n${denied.slice(0, 8).map((d) => `⛔ ${d}`).join('\n')}${denied.length > 8 ? `\n…и ещё ${denied.length - 8}` : ''}`);
        }
        if (relFiles.length === 0) throw new Error('по указанным путям нет файлов');
        return format === 'zip' ? packZip(archiveAbs, ctx.cwd, relFiles) : await packTar(archiveAbs, ctx.cwd, relFiles, format === 'tgz');
      }

      if (!existsSync(archiveAbs)) throw new Error(`архива «${archiveRel}» нет`);

      if (format === 'zip') {
        const zip = new AdmZip(archiveAbs);
        const entries = zip.getEntries().map((e) => ({
          path: e.entryName,
          size: e.header.size,
          isDir: e.isDirectory,
          isLink: ((e.attr >>> 16) & 0o170000) === 0o120000,
        }));
        if (sub === 'list') {
          return entries.map((e) => `${e.isDir ? 'папка' : `${e.size} Б`}  ${e.path}`).join('\n');
        }
        vetEntries(entries, targetAbs);
        mkdirSync(targetAbs, { recursive: true });
        let count = 0;
        for (const e of zip.getEntries()) {
          if (e.isDirectory) continue;
          const rel = e.entryName.replace(/^\.?\//, '');
          const dest = safePath(targetAbs, rel)!;
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, e.getData());
          count++;
        }
        return `✅ распаковано файлов: ${count} → ${targetAbs}`;
      }

      // tar / tgz: сперва оглавление с проверками, потом распаковка
      const entries: { path: string; size: number; isDir: boolean; isLink: boolean }[] = [];
      for (const e of await tarEntries(archiveAbs)) {
        entries.push({ path: e.path, size: e.size, isDir: e.type === 'Directory', isLink: e.type === 'SymbolicLink' || e.type === 'Link' });
      }
      if (sub === 'list') {
        return entries.map((e) => `${e.isDir ? 'папка' : `${e.size} Б`}  ${e.path}`).join('\n');
      }
      vetEntries(entries, targetAbs);
      mkdirSync(targetAbs, { recursive: true });
      await tar.x({ file: archiveAbs, cwd: targetAbs });
      const count = entries.filter((e) => !e.isDir).length;
      return `✅ распаковано файлов: ${count} → ${targetAbs}`;
    },
  };
};
