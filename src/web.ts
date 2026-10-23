/**
 * Чтение веб-страниц: только сайты из белого списка в карточке тула
 * ("sites": ["wikipedia.org", "github.com"]), без JS-рендера — то, что отдал
 * сервер, то и разбираем.
 *
 *   read  — статья текстом: @mozilla/readability (статьи) или блоки через
 *           cheerio (страницы без «тела статьи»: заголовок + абзацы/списки);
 *   links — абсолютные ссылки страницы (для навигации по разделам);
 *
 * Домены сверяются по суффиксу: "wikipedia.org" покрывает и ru.wikipedia.org.
 * Редиректы проходятся вручную (до 5) — каждый хост сверяется со списком,
 * поэтому подменой редиректом из списка не выбраться. Локальные адреса
 * (localhost, 127.0.0.1) разрешены, только если сами попали в список.
 */
import { load } from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const UA = 'DreamTeam-web-tool/0.3 (+local; allow-listed fetcher)';
const MAX_HTML = 2 * 1024 * 1024; // страниц больше 2 МБ не читаем
const MAX_TEXT = 50_000; // лимит текста статьи в отчёте
const MAX_LINKS = 200;

/** Хост (нижний регистр, без порта) покрывается записью списка: равен или поддомен. */
export function hostAllowed(host: string, sites: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return sites.some((raw) => {
    const s = raw.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return h === s || h.endsWith(`.${s}`);
  });
}

/** GET с ручными редиректами: до 5 переходов, каждый хост — через checkUrl. */
export async function fetchPage(url: URL, checkUrl: (u: URL) => void): Promise<{ url: URL; html: string }> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    checkUrl(current);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' },
      });
    } catch (err) {
      throw new Error(`сайт ${current.host} не отвечает (${err instanceof Error ? err.message : err})`);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`сайт ${current.host} отдал редирект без адреса (HTTP ${res.status})`);
      current = new URL(loc, current);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} от ${current.host}`);
    const type = res.headers.get('content-type') ?? '';
    if (type && !/text\/html|text\/plain|application\/xhtml|xml/.test(type)) {
      throw new Error(`${current.host} отдал «${type}» — читаю только html/текст`);
    }
    const html = await res.text();
    return { url: current, html: html.slice(0, MAX_HTML) };
  }
  throw new Error(`больше 5 редиректов подряд от ${url.host} — прекратил`);
}

/** HTML → текст: заголовки, абзацы, пункты списков, цитаты, ячейки таблиц. */
function htmlToText(html: string): string {
  const $ = load(html);
  $('script, style, nav, header, footer, aside, form, noscript').remove();
  const parts: string[] = [];
  $('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th, figcaption, dt, dd').each((_, el) => {
    // li и td внутри уже вынутых блоков дублировали бы текст — берём только листовые
    const $el = $(el);
    if ($el.find('p, li, blockquote, pre, td, h1, h2, h3, h4, h5, h6').length > 0) return;
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
    if (/^h[1-6]$/.test(tag)) parts.push(`\n${text}\n`);
    else if (tag === 'li') parts.push(`- ${text}`);
    else parts.push(text);
  });
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Статья текстом: сначала readability, без статьи — cheerio-блоки. */
export function extractArticle(html: string, baseUrl: string): string {
  const dom = new JSDOM(html, { url: baseUrl });
  const article = new Readability(dom.window.document).parse();
  if (article?.textContent?.trim()) {
    const title = article.title ? `${article.title}\n\n` : '';
    return (title + article.textContent.replace(/\n{3,}/g, '\n\n').trim()).slice(0, MAX_TEXT);
  }
  const text = htmlToText(html);
  if (!text) throw new Error('страница без читаемого текста (возможно, она рисуется JavaScript-ом — тул web JS не исполняет)');
  const title = load(html)('title').first().text().trim();
  const head = title ? `${title}\n\n(страница без явной статьи — текст целиком)\n` : '(страница без явной статьи — текст целиком)\n';
  return (head + text).slice(0, MAX_TEXT);
}

/** Абсолютные http(s)-ссылки страницы в порядке появления, без повторов. */
/** Ссылка страницы: адрес + текст (названия разделов/статей видны без чтения страницы). */
export interface LinkRef {
  url: string;
  text: string;
}

export function extractLinks(html: string, baseUrl: string): LinkRef[] {
  const $ = load(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: LinkRef[] = [];
  for (const el of $('a[href]').toArray()) {
    const href = $(el).attr('href') ?? '';
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    abs.hash = '';
    const key = abs.href;
    if (seen.has(key)) continue;
    seen.add(key);
    let shown = key;
    try {
      shown = decodeURI(key); // %D0... от кириллицы в путях — человеку и агенту читать нечем
    } catch {
      /* кривые проценты — отдаём как есть */
    }
    const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push({ url: shown, text });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}
