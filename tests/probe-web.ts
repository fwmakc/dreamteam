/**
 * Проба тула «web»: белый список доменов и чтение настоящего сайта
 * (example.com — стабильная страница без JS; редирект http→https проходится).
 * Карточка пробы: sites ["example.com"] — www-поддомен покрыт, чужой домен
 * нет; пустой список — отказ с подсказкой; кривая карточка — fail-fast.
 * Запуск: npx tsx tests/probe-web.ts  (нужен интернет)
 */
let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const { default: makeTool } = await import('../src/tools/web/web.js');
import http from 'node:http';
import { makeCtx } from './tool-ctx.js';

/** Локальный сайт: страница с двумя ссылками и редирект — для links и редиректов. */
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/final' });
    res.end();
    return;
  }
  const links = req.url === '/final'
    ? '<p>Финальная страница</p>'
    : '<h1>Оглавление</h1><a href="/раздел/правила">Правила</a><a href="/раздел/формы">Формы</a><a href="https://example.com/внешняя">Внешняя</a>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>${links}</body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const localPort = (server.address() as { port: number }).port;

// ─── карточка: валидация ─────────────────────────────────────────────────────
{
  let threw = '';
  try { makeTool({ sites: 'example.com' }); } catch (e) { threw = (e as Error).message; }
  check('карточка: sites-строка — отказ', threw.includes('массив непустых доменов'), threw);
  threw = '';
  try { makeTool({ bogus: 1 }); } catch (e) { threw = (e as Error).message; }
  check('карточка: лишнее поле — отказ', threw.includes('неизвестные поля'), threw);
}

const tool = makeTool({ sites: ['example.com', `127.0.0.1:${localPort}`] });
const checkV = (body: string) => {
  const v = tool.check(body);
  return typeof v === 'string' ? v : v.deny;
};

// ─── check: список доменов ───────────────────────────────────────────────────
{
  check('check: свой домен — allow', tool.check('read https://example.com/страница') === 'allow');
  check('check: поддомен покрыт', tool.check('read https://www.example.com/') === 'allow');
  check('check: чужой домен — deny со списком', checkV('read https://example.org/').includes('не в списке разрешённых'));
  check('check: ftp — deny протокол', checkV('read ftp://example.com/x').includes('http/https'));
  check('check: кривой адрес — deny', checkV('read ерунда').includes('не похоже на адрес'));
  check('check: неизвестная подкоманда — deny', checkV('crawl https://example.com/').includes('подкоманд'));
  check('check: без адреса — deny', checkV('read').includes('укажите адрес'));
  const empty = makeTool({});
  check('check: пустой список — отказ с подсказкой', (typeof empty.check('read https://example.com/') === 'object'
    ? (empty.check('read https://example.com/') as { deny: string }).deny
    : '').includes('список разрешённых сайтов пуст'));
}

// ─── run: чтение настоящего сайта ────────────────────────────────────────────
{
  const text = await tool.run('read https://example.com/', bareCtx());
  check('read: текст страницы', text.includes('Example Domain'), text.slice(0, 200));
  check('read: адрес в шапке отчёта', text.includes('https://example.com/'), text.slice(0, 80));

  const redirected = await tool.run('read http://example.com/', bareCtx());
  check('read: редирект http→https пройден', redirected.includes('Example Domain'), redirected.slice(0, 200));

  const links = await tool.run(`links http://127.0.0.1:${localPort}/`, bareCtx());
  check('links: ссылки страницы', links.includes('/раздел/правила') && links.includes('/раздел/формы') && links.includes('example.com'), links);
  check('links: тексты ссылок рядом с адресами', links.includes('Правила —') && links.includes('Формы —'), links);

  const filtered = await tool.run(`links http://127.0.0.1:${localPort}/ формы`, bareCtx());
  check('links: фильтр-подстрока', filtered.includes('/раздел/формы') && !filtered.includes('/раздел/правила'), filtered);
  const byTitle = await tool.run(`links http://127.0.0.1:${localPort}/ правила`, bareCtx());
  check('links: фильтр по названию ссылки', byTitle.includes('/раздел/правила') && !byTitle.includes('/раздел/формы'), byTitle);

  const final = await tool.run(`read http://127.0.0.1:${localPort}/final`, bareCtx());
  check('read: локальная страница', final.includes('Финальная страница'), final.slice(0, 120));
  const none = await tool.run('links https://example.com/ нет-такого-фрагмента', bareCtx());
  check('links: фильтр без совпадений', none.includes('ссылок не нашлось'), none);

  let threw = '';
  try { await tool.run('read https://example.org/', bareCtx()); } catch (e) { threw = (e as Error).message; }
  check('run: чужой домен — отказ и в run', threw.includes('не в списке разрешённых'), threw);
}

function bareCtx() {
  return makeCtx(process.cwd());
}

server.close();

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
