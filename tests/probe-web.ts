/**
 * Проба тула «web» — полностью герметичная: свой http-сервер на случайном
 * порту вместо настоящих сайтов.
 *  - hostAllowed: суффикс-покрытие поддоменов, порт, кривые записи;
 *  - fetchPage: редиректы вручную (цепочка, цикл >5, редирект без адреса),
 *    HTTP-ошибки, чужой content-type, молчание сервера;
 *  - extractArticle: статья readability, запасной разбор блоков, пустая страница;
 *  - extractLinks: абсолютность, dedupe (в т.ч. #хэш), фильтр протоколов, кириллица;
 *  - тул: карточка (sites, пустой список), check/run на локальных страницах,
 *    редирект на чужой домен — отказ (в сети не ходим).
 *
 * Запуск: npm run probe:web
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostAllowed, fetchPage, extractArticle, extractLinks } from '../src/web.js';
import { makeCtx } from './tool-ctx.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Страница-статья (readability) и страница без статьи (запасной разбор). */
const ARTICLE_HTML = `<!doctype html><html><head><title>ГК РФ Статья 8</title></head><body>
<nav>меню</nav><article><h1>Основания возникновения прав</h1>
<p>Права возникают из договоров и иных сделок.</p><p>Из актов государственных органов.</p>
<blockquote>Цитата из закона.</blockquote></article><footer>подвал</footer></body></html>`;
const PLAIN_HTML = `<!doctype html><html><head><title>Правила проекта</title></head><body>
<script>alert('мусор');</script><h1>Правила</h1><ul><li>первый пункт</li><li>второй пункт</li></ul></body></html>`;
const LINKS_HTML = `<!doctype html><html><body>
<a href="/раздел/правила">Правила</a>
<a href="/раздел/формы">Формы</a>
<a href="/раздел/правила#глава">Правила (дубль с хэшем)</a>
<a href="/раздел/правила">Дубль точный</a>
<a href="mailto:x@y.z">письмо</a><a href="ftp://files.local/x">файлопомойка</a>
<a href="https://внешний.пример.орг/страница">Внешний документ</a>
<a href="раздел/относительная">Относительная</a>
<a href="#якорь">Якорь этой же страницы</a>
</body></html>`;

/** Локальный сайт: маршруты для read/links/редиректов/ошибок. */
const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const html = (body: string, code = 200, type = 'text/html; charset=utf-8'): void => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  const redirect = (loc: string, code = 302): void => {
    res.writeHead(code, { location: loc });
    res.end();
  };
  switch (req.url) {
    case '/article': return html(ARTICLE_HTML);
    case '/plain': return html(PLAIN_HTML);
    case '/links': return html(LINKS_HTML);
    case '/empty': return html('<!doctype html><html><body></body></html>');
    case '/r1': return redirect('/r2');
    case '/r2': return redirect('/final');
    case '/final': return html('<p>Финальная страница</p>');
    case '/foreign': return redirect('https://example.org/swapped');
    case '/no-loc': return redirect('');
    case '/loop': return redirect('/loop');
    case '/api.json': return html('{"nope":true}', 200, 'application/json');
    default: return html('нет такой', 404, 'text/plain');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const localPort = (server.address() as { port: number }).port;
const local = `http://127.0.0.1:${localPort}`;

// ─── hostAllowed: суффиксы, порт, мусор ──────────────────────────────────────
{
  check('домены: точное совпадение', hostAllowed('wikipedia.org', ['wikipedia.org']));
  check('домены: поддомен покрыт', hostAllowed('ru.wikipedia.org', ['wikipedia.org']) && hostAllowed('a.b.wikipedia.org', ['wikipedia.org']));
  check('домены: суффикс-подделка не проходит', !hostAllowed('evil-wikipedia.org', ['wikipedia.org']) && !hostAllowed('wikipedia.org.evil.ru', ['wikipedia.org']));
  check('домены: регистр и хвостовая точка', hostAllowed('RU.Wikipedia.Org.', ['wikipedia.org']));
  check('домены: запись с https:// и путём — чистится', hostAllowed('github.com', ['https://github.com/sub/']) && hostAllowed('www.github.com', ['https://github.com']));
  check('домены: порт в хосте требует порт в записи', !hostAllowed('example.com:8080', ['example.com']) && hostAllowed('example.com:8080', ['example.com:8080']));
}

// ─── fetchPage: редиректы и ошибки ───────────────────────────────────────────
{
  const noGuard = (): void => {};
  const chain = await fetchPage(new URL(`${local}/r1`), noGuard);
  check('редиректы: цепочка из двух пройдена', chain.url.href === `${local}/final` && chain.html.includes('Финальная страница'), chain.url.href);

  let loopErr = '';
  try { await fetchPage(new URL(`${local}/loop`), noGuard); } catch (e) { loopErr = (e as Error).message; }
  check('редиректы: цикл — «больше 5» ', loopErr.includes('больше 5 редиректов'), loopErr);

  let noLoc = '';
  try { await fetchPage(new URL(`${local}/no-loc`), noGuard); } catch (e) { noLoc = (e as Error).message; }
  check('редиректы: без location — внятная ошибка', noLoc.includes('без адреса'), noLoc);

  const hops: URL[] = [];
  await fetchPage(new URL(`${local}/r1`), (u) => hops.push(u));
  check('редиректы: каждый хоп идёт через guard', hops.length === 3 && hops[hops.length - 1]!.pathname === '/final', JSON.stringify(hops.map(String)));

  let notFound = '';
  try { await fetchPage(new URL(`${local}/missing`), noGuard); } catch (e) { notFound = (e as Error).message; }
  check('ошибки: HTTP 404 наружу', notFound.includes('HTTP 404'), notFound);

  let badType = '';
  try { await fetchPage(new URL(`${local}/api.json`), noGuard); } catch (e) { badType = (e as Error).message; }
  check('ошибки: json-ответ отклонён', badType.includes('только html/текст'), badType);

  let silent = '';
  try { await fetchPage(new URL('http://127.0.0.1:1/'), noGuard); } catch (e) { silent = (e as Error).message; }
  check('ошибки: молчание сервера — «не отвечает»', silent.includes('не отвечает'), silent);
}

// ─── extractArticle / extractLinks ──────────────────────────────────────────
{
  const article = extractArticle(ARTICLE_HTML, `${local}/article`);
  check('статья: заголовок и текст, мусор вырезан', article.startsWith('ГК РФ Статья 8') && article.includes('Права возникают из договоров') && article.includes('Цитата из закона') && !article.includes('меню') && !article.includes('подвал'), article.slice(0, 120));

  const plain = extractArticle(PLAIN_HTML, `${local}/plain`);
  check('статья: простая страница читается, скрипт вырезан', plain.includes('первый пункт') && plain.includes('Правила') && !plain.includes('alert'), plain.slice(0, 160));
  let unreadable = '';
  try { extractArticle('<html><head><title>Пустые параграфы</title></head><body><p>   </p><p></p></body></html>', `${local}/пустые-абзацы`); } catch (e) { unreadable = (e as Error).message; }
  check('статья: без читаемого текста — честная ошибка про JS', unreadable.includes('без читаемого текста') && unreadable.includes('JavaScript'), unreadable);

  let empty = '';
  try { extractArticle('<!doctype html><html><body></body></html>', `${local}/empty`); } catch (e) { empty = (e as Error).message; }
  check('статья: пустая страница — честная ошибка', empty.includes('без читаемого текста'), empty);

  const links = extractLinks(LINKS_HTML, `${local}/links`);
  const urls = links.map((l) => l.url);
  check('ссылки: относительные стали абсолютными', urls.some((u) => u === `${local}/раздел/правила`));
  check('ссылки: кириллица расшифрована', urls.some((u) => u.includes('/раздел/формы')), JSON.stringify(urls));
  check('ссылки: dedupe по адресу (хэш отбрасывается)', urls.filter((u) => u === `${local}/раздел/правила`).length === 1, JSON.stringify(urls));
  check('ссылки: mailto/ftp и якоря отфильтрованы', !urls.some((u) => u.startsWith('mailto:') || u.startsWith('ftp:')) && !urls.includes(`${local}/ссылки#якорь`));
  check('ссылки: внешние остаются (IDNA-хост)', urls.some((u) => u.startsWith(`https://${new URL('https://внешний.пример.орг/').host}/`)));
  check('ссылки: тексты рядом с адресами', links.find((l) => l.url.endsWith('/раздел/формы'))?.text === 'Формы');

  const many = extractLinks(`<html><body>${Array.from({ length: 250 }, (_, i) => `<a href="/стр/${i}">ссылка ${i}</a>`).join('')}</body></html>`, `${local}/links`);
  check('ссылки: потолок 200', many.length === 200, String(many.length));
}

// ─── тул: карточка, check, run ──────────────────────────────────────────────
{
  const { default: makeTool } = await import('../src/tools/web/web.js');

  let threw = '';
  try { makeTool({ sites: 'example.com' }); } catch (e) { threw = (e as Error).message; }
  check('карточка: sites-строка — отказ', threw.includes('массив непустых доменов'), threw);
  threw = '';
  try { makeTool({ bogus: 1 }); } catch (e) { threw = (e as Error).message; }
  check('карточка: лишнее поле — отказ', threw.includes('неизвестные поля'), threw);

  const tool = makeTool({ sites: [`127.0.0.1:${localPort}`] });
  const deny = (body: string): string => {
    const v = tool.check(body);
    return typeof v === 'string' ? '' : v.deny;
  };

  check('check: локальный адрес из списка — allow', tool.check(`read ${local}/article`) === 'allow');
  check('check: чужой домен — deny со списком', deny('read https://example.org/').includes('не в списке разрешённых'));
  check('check: ftp — deny протокол', deny('read ftp://127.0.0.1/x').includes('http/https'));
  check('check: кривой адрес — deny', deny('read ерунда').includes('не похоже на адрес'));
  check('check: неизвестная подкоманда — deny', deny('crawl https://127.0.0.1/').includes('подкоманд'));
  check('check: без адреса — deny', deny('read').includes('укажите адрес'));

  const emptyTool = makeTool({});
  const emptyDeny = emptyTool.check(`read ${local}/`);
  check('check: пустой список — отказ с подсказкой', typeof emptyDeny === 'object' && emptyDeny.deny.includes('список разрешённых сайтов пуст'), typeof emptyDeny === 'object' ? emptyDeny.deny : 'allow');

  const ctx = makeCtx(process.cwd());
  const article = await tool.run(`read ${local}/article`, ctx);
  check('run read: адрес в шапке, статья текстом', article.startsWith(`${local}/article`) && article.includes('Права возникают из договоров'), article.slice(0, 120));

  const plain = await tool.run(`read ${local}/plain`, ctx);
  check('run read: простая страница — текст без скрипта', plain.includes('первый пункт') && !plain.includes('alert'), plain.slice(0, 160));

  const chain = await tool.run(`read ${local}/r1`, ctx);
  check('run read: редиректы пройдены', chain.includes('Финальная страница'), chain.slice(0, 120));

  const links = await tool.run(`links ${local}/links`, ctx);
  check('run links: список с текстами', links.includes(`${local}/раздел/правила — Правила`) || (links.includes('/раздел/правила') && links.includes('Правила')), links.slice(0, 200));

  const filtered = await tool.run(`links ${local}/links формы`, ctx);
  check('run links: фильтр по подстроке адреса', filtered.includes('/раздел/формы') && !filtered.includes('/раздел/правила'), filtered.slice(0, 120));
  const byTitle = await tool.run(`links ${local}/links правила`, ctx);
  check('run links: фильтр по названию', byTitle.includes('/раздел/правила') && !byTitle.includes('/раздел/формы'), byTitle.slice(0, 120));
  const none = await tool.run(`links ${local}/links нет-такого-фрагмента`, ctx);
  check('run links: пустой фильтр — честное сообщение', none.includes('ссылок не нашлось'), none);

  let foreign = '';
  try { await tool.run(`read ${local}/foreign`, ctx); } catch (e) { foreign = (e as Error).message; }
  check('run: редирект на чужой домен — отказ до запроса', foreign.includes('редирект увёл') && foreign.includes('example.org'), foreign);

  let denied = '';
  try { await tool.run('read https://example.org/', ctx); } catch (e) { denied = (e as Error).message; }
  check('run: чужой домен — отказ и в run', denied.includes('не в списке разрешённых'), denied);

  let failed = '';
  try { await tool.run(`read ${local}/missing`, ctx); } catch (e) { failed = (e as Error).message; }
  check('run: 404 внутри тула — ошибка с кодом', failed.includes('HTTP 404'), failed);
}

server.close();
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
