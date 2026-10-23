/**
 * Тул «web»: чтение разрешённых сайтов (```web подкоманда, адрес — в заголовке).
 *
 *   read <url>            — страница текстом (статья через readability,
 *                           иначе заголовок + блоки текста);
 *   links <url> [фильтр]  — абсолютные ссылки страницы; фильтр — подстрока
 *                           в адресе (навигация по разделам сайта).
 *
 * Белый список — карточка "sites": ["wikipedia.org", "github.com"]; домен
 * покрывает свои поддомены. Пустой список = читать некуда: check() отказывает
 * с подсказкой, куда сайт добавить. JS на страницах не исполняется — то, что
 * отдал сервер, то и разбираем. Каждый редирект сверяется со списком.
 */
import { checkCardKeys, resolveCard, splitArgs, type Tool, type ToolConfig, type ToolVerdict } from '../../tools-api.js';
import { extractArticle, extractLinks, fetchPage, hostAllowed } from '../../web.js';

/** Разбор заголовка блока: подкоманда + аргументы. */
function parseHead(body: string): { sub: string; rest: string[] } {
  const head = body.indexOf('\n') === -1 ? body : body.slice(0, body.indexOf('\n'));
  return { sub: head.split(/\s+/)[0] ?? '', rest: splitArgs(head).slice(1) };
}

function syntax(): string {
  return 'подкоманды: read <адрес> · links <адрес> [фильтр-подстрока]';
}

export default (config: ToolConfig): Tool => {
  const card = resolveCard('web', config);
  checkCardKeys(card, 'web', 'sites');
  if (card.sites !== undefined && (!Array.isArray(card.sites) || (card.sites as unknown[]).some((s) => typeof s !== 'string' || !s.trim()))) {
    throw new Error('карточка тула web: "sites" — массив непустых доменов ["wikipedia.org", "github.com"]');
  }
  const sites =  ((card.sites as string[] | undefined) ?? []).map((s) => s.trim());

  /** Адрес валиден и разрешён? Для check() и run() — одна и та же причина отказа. */
  const guard = (urlText: string): { url: URL } | { deny: string } => {
    if (sites.length === 0) {
      return { deny: 'список разрешённых сайтов пуст — добавьте домены в карточку тула web ("sites" в agents.json)' };
    }
    let url: URL;
    try {
      url = new URL(urlText.trim());
    } catch {
      return { deny: `«${urlText}» — не похоже на адрес страницы (нужен https://…)` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { deny: `протокол «${url.protocol}» не читаю — только http/https` };
    }
    if (!hostAllowed(url.host, sites)) {
      return { deny: `сайт «${url.host}» не в списке разрешённых тула web (${sites.join(', ')}) — попросите хозяина добавить его в карточку "sites"` };
    }
    return { url };
  };

  return {
    desc:
      'Чтение разрешённых сайтов: ```web read https://… (страница текстом) · web links https://… [фильтр] (ссылки страницы). ' +
      'Список доменов задаёт хозяин в карточке "sites"; JS не исполняется, динамические страницы могут отдавать пустоту.',
    check(body): ToolVerdict {
      const { sub, rest } = parseHead(body);
      if (sub !== 'read' && sub !== 'links') return { deny: `подкоманды «${sub}» нет. ${syntax()}` };
      if (!rest[0]) return { deny: 'укажите адрес страницы' };
      const g = guard(rest[0]);
      return 'deny' in g ? g : 'allow';
    },
    async run(body) {
      const { sub, rest } = parseHead(body);
      if (sub !== 'read' && sub !== 'links') throw new Error(syntax());
      const g = guard(rest[0] ?? '');
      if ('deny' in g) throw new Error(g.deny);
      // редиректы fetchPage ходит сам, но каждый промежуточный хост — через этот хук
      const checkRedirect = (u: URL): void => {
        if (!hostAllowed(u.host, sites)) throw new Error(`редирект увёл на «${u.host}» — этого сайта нет в списке разрешённых`);
      };
      const { html } = await fetchPage(g.url, checkRedirect);
      if (sub === 'read') return `${g.url.href}\n\n${extractArticle(html, g.url.href)}`;
      let links = extractLinks(html, g.url.href);
      const filter = rest[1];
      if (filter) links = links.filter((l) => l.includes(filter));
      if (links.length === 0) return 'ссылок не нашлось' + (filter ? ` с «${filter}»` : '');
      return links.map((l) => `- ${l}`).join('\n');
    },
  };
};
