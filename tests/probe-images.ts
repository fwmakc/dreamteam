/**
 * Проба генерации картинок: mock-images (1×1 PNG без GPU), openai-images
 * против локального http-стаба (тело запроса, b64/url-ответ, референсы →
 * /images/edits), разбор параметров блока ```image и живой прогон
 * executeImageAction с сохранением файлов в дом.
 *
 * Герметично: временный DT_HOME, сеть — 127.0.0.1:0 (случайный порт).
 * Запуск: npm run probe:images
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, ImageProvider, ImageRequest, ImageResult } from '../src/types.js';
import type { ToolContext, ToolsConfig } from '../src/actions.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const root = mkdtempSync(join(tmpdir(), 'dt-images-'));
process.env.DT_HOME = root; // прикладное проекта (images/) падает в дом

/** 1×1 PNG из mock-images — валидные байты для проверок. */
const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkKPn/HwAEfgJ/qN5MzAAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(MOCK_PNG_BASE64, 'base64');

interface Captured { url?: string; body?: Record<string, unknown>; auth?: string; contentType?: string }

/** Локальный стаб images API: по url решает, чем ответить; всё запоминает. */
async function startStub(): Promise<{ server: Server; port: number; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const cap: Captured = { url: req.url, auth: req.headers.authorization as string | undefined, contentType: req.headers['content-type'] as string | undefined };
      try { cap.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* не json — и ладно */ }
      captured.push(cap);
      if (req.url === '/img.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_BYTES);
        return;
      }
      // спец-маршруты — до общих: их суффиксы тоже заканчиваются на /images/generations
      if (req.url?.includes('/http-500/')) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('упс, сервер болеет');
        return;
      }
      if (req.url?.includes('/not-json/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html>не json</html>');
        return;
      }
      if (req.url?.includes('/empty/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.url?.endsWith('/images/edits')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: MOCK_PNG_BASE64 }] }));
        return;
      }
      if (req.url?.endsWith('/images/generations')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: MOCK_PNG_BASE64 }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const port = await new Promise<number>((done) => { server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)); });
  return { server, port, captured };
}

// ── 1. mock-images: фабрика и зажим количества ──────────────────────────────
{
  const { mockImagesFactory } = await import('../src/providers/mock-images.js');
  const one = mockImagesFactory('pic', { provider: 'mock-images' });
  check('mock: kind и модель по умолчанию', one.kind === 'mock-images' && one.model === 'mock');
  const r1 = await one.generate({ prompt: 'тест' });
  check('mock: одна картинка, настоящий PNG', r1.ok && r1.images.length === 1 && Buffer.from(r1.images[0]!.data, 'base64').equals(PNG_BYTES));
  const r0 = await one.generate({ prompt: 'x', n: 0 });
  const r99 = await one.generate({ prompt: 'x', n: 99 });
  const r3 = await one.generate({ prompt: 'x', n: 3 });
  check('mock: n зажимается 1..6', r0.images.length === 1 && r99.images.length === 6 && r3.images.length === 3, `${r0.images.length}/${r99.images.length}/${r3.images.length}`);
}

// ── 2. openai-images: фабрика и транспорт на стабе ──────────────────────────
{
  const { openAiImagesFactory } = await import('../src/providers/openai-images.js');
  let threw = '';
  try { openAiImagesFactory('bad', { provider: 'openai-images',  model: 'm' }); } catch (e) { threw = String(e); }
  check('фабрика: без baseUrl — внятная ошибка', threw.includes('не задан baseUrl'), threw);
  try { openAiImagesFactory('bad', { provider: 'openai-images',  baseUrl: 'http://x/v1' }); } catch (e) { threw = String(e); }
  check('фабрика: без модели — внятная ошибка', threw.includes('не задана модель'), threw);

  const { server, port, captured } = await startStub();
  const base = `http://127.0.0.1:${port}/v1`;
  const provider = openAiImagesFactory('pic', { provider: 'openai-images',  baseUrl: `${base}/`, model: 'diffusor', apiKey: 'test-key-1' }); // слэш в конце — срежется
  check('фабрика: kind и модель', provider.kind === 'openai-images' && provider.model === 'diffusor');

  const ok: ImageResult = await provider.generate({ prompt: 'кот в шляпе' });
  const gen = captured.find((c) => c.url?.endsWith('/images/generations'));
  check('транспорт: POST на /v1/images/generations', Boolean(gen), JSON.stringify(captured.map((c) => c.url)));
  check('транспорт: тело — модель, промпт, дефолты n/size', Boolean(gen?.body) && gen?.body?.model === 'diffusor' && gen.body.prompt === 'кот в шляпе' && gen.body.n === 1 && gen.body.size === '512x512', JSON.stringify(gen?.body));
  check('транспорт: опций без задания нет', gen?.body !== undefined && !('steps' in gen.body) && !('seed' in gen.body), JSON.stringify(gen?.body));
  check('транспорт: Bearer из карточки', gen?.auth === 'Bearer test-key-1', gen?.auth);
  check('транспорт: ответ b64 → PNG с типом', ok.ok && ok.images.length === 1 && ok.images[0]!.mediaType === 'image/png' && Buffer.from(ok.images[0]!.data, 'base64').equals(PNG_BYTES));

  await provider.generate({ prompt: 'x', n: 2, size: '1024x1024', steps: 20, guidance: 7.5, seed: -5 });
  const opt = captured[captured.length - 1];
  check('транспорт: заданные опции уходят', opt?.body?.n === 2 && opt.body.steps === 20 && opt.body.guidance === 7.5 && opt.body.seed === -5, JSON.stringify(opt?.body));

  const ref = `data:image/png;base64,${MOCK_PNG_BASE64}`;
  await provider.generate({ prompt: 'x', refImages: [ref] });
  const edit = captured[captured.length - 1];
  check('транспорт: референсы → /images/edits с image[]', edit.url?.endsWith('/images/edits') === true && Array.isArray(edit.body?.image) && (edit.body?.image as string[])[0] === ref, JSON.stringify({ url: edit.url, body: edit.body }));

  const failRes = await openAiImagesFactory('pic3', { provider: 'openai-images',  baseUrl: `${base}/http-500`, model: 'm' }).generate({ prompt: 'x' });
  check('транспорт: HTTP 500 — текст ошибки с кодом и деталью', !failRes.ok && failRes.error?.includes('HTTP 500') === true && failRes.error?.includes('болеет') === true, failRes.error);

  const notJson = await openAiImagesFactory('pic4', { provider: 'openai-images',  baseUrl: `${base}/not-json`, model: 'm' }).generate({ prompt: 'x' });
  check('транспорт: не JSON — честный отказ', !notJson.ok && notJson.error?.includes('не JSON') === true, notJson.error);

  const empty = await openAiImagesFactory('pic5', { provider: 'openai-images',  baseUrl: `${base}/empty`, model: 'm' }).generate({ prompt: 'x' });
  check('транспорт: пустой data — честный отказ', !empty.ok && empty.error?.includes('пустой') === true, empty.error);

  const refused = await openAiImagesFactory('pic6', { provider: 'openai-images',  baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }).generate({ prompt: 'x' });
  check('транспорт: сервер не отвечает — подсказка про контейнер', !refused.ok && refused.error?.includes('недоступен') === true && refused.error?.includes('docker') === true, refused.error);

  await new Promise<void>((done) => server.close(() => done()));
}

// ── 2b. openai-images: url-ответ докачивается в b64 ─────────────────────────
{
  const { openAiImagesFactory } = await import('../src/providers/openai-images.js');
  const server2 = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.includes('/img.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${(server2.address() as { port: number }).port}/img.png` }] }));
  });
  const port2 = await new Promise<number>((done) => { server2.listen(0, '127.0.0.1', () => done((server2.address() as { port: number }).port)); });
  const urlProvider = openAiImagesFactory('pic', { provider: 'openai-images',  baseUrl: `http://127.0.0.1:${port2}/v1`, model: 'm' });
  const r = await urlProvider.generate({ prompt: 'x' });
  check('транспорт: url-ответ докачан в b64 с content-type', r.ok && r.images.length === 1 && r.images[0]!.mediaType === 'image/png' && Buffer.from(r.images[0]!.data, 'base64').equals(PNG_BYTES), JSON.stringify(r).slice(0, 120));
  await new Promise<void>((done) => server2.close(() => done()));
}

// ── 3. parseImageParams: строки «ключ: значение» + свободные строки ─────────
{
  const { parseImageParams } = await import('../src/actions.js');
  const p1 = parseImageParams('prompt: кот в шляпе\nsize: 1024x1024\nn: 3');
  check('параметры: базовые ключи', p1.prompt === 'кот в шляпе' && p1.size === '1024x1024' && p1.n === 3, JSON.stringify(p1));
  const p2 = parseImageParams('PROMPT: вечер\nSteps: 150\nguidance: 7.5\nseed: -5\nn: 99\nn: 0\nn: abc');
  check('параметры: регистр не важен, зажимы и отбраковка', p2.prompt === 'вечер' && p2.steps === 100 && p2.guidance === 7.5 && p2.seed === -5 && p2.n === 8, JSON.stringify(p2));
  const p3 = parseImageParams('refs: a.png; b.png,c.png');
  check('параметры: референсы режутся по запятой и точке с запятой', JSON.stringify(p3.refs) === '["a.png","b.png","c.png"]', JSON.stringify(p3.refs));
  const p4 = parseImageParams('prompt: первая\nprompt: вторая\nсвободная строка\nfoo: бар\nещё строка');
  check('параметры: несколько prompt и свободные строки — в промпт', p4.prompt === 'первая\nвторая\nсвободная строка\nfoo: бар\nещё строка', JSON.stringify(p4.prompt));
  check('параметры: пустое тело — пустой промпт', parseImageParams('').prompt === '');
}

// ── 4. executeImageAction: живой прогон с сохранением в дом ─────────────────
{
  const { executeImageAction } = await import('../src/actions.js');
  const { mockImagesFactory } = await import('../src/providers/mock-images.js');

  const cfg: ToolsConfig = { workspaceAbs: root, runTimeoutMs: 15000, maxOutputChars: 4000, projects: new Map() };
  let lastRequest: ImageRequest | undefined;
  const captureProvider: ImageProvider = {
    id: 'capture',
    kind: 'mock-images',
    model: 'capture',
    async generate(req: ImageRequest): Promise<ImageResult> {
      lastRequest = req;
      return { ok: true, images: [{ data: MOCK_PNG_BASE64, mediaType: 'image/png' }] };
    },
  };
  const tctx: ToolContext = {
    getVisionProvider: () => ({ error: 'в пробнике нет' }),
    getImageProvider: () => ({ provider: captureProvider }),
    model: () => ({ error: 'в пробнике нет' }),
  };
  const noImage: ToolContext = { ...tctx, getImageProvider: () => ({ error: 'агенту не назначена image-модель' }) };

  const noPrompt = await executeImageAction({ kind: 'image', params: { prompt: '  ' } }, cfg, undefined, tctx);
  check('действие: без промпта — отказ', !noPrompt.ok && noPrompt.output.includes('нет промпта'), noPrompt.output);
  const noProvider = await executeImageAction({ kind: 'image', params: { prompt: 'кот' } }, cfg, undefined, noImage);
  check('действие: без image-модели — отказ с причиной', !noProvider.ok && noProvider.output.includes('не назначена'), noProvider.output);

  writeFileSync(join(root, 'ref.png'), PNG_BYTES);
  const done = await executeImageAction(
    { kind: 'image', params: { prompt: 'кот в шляпе', n: 1, refs: ['ref.png'] } },
    cfg, undefined, tctx,
  );
  check('действие: успех с перечнем файлов', done.ok && done.output.includes('сгенерировано 1'), done.output);
  const refReq = lastRequest;
  check('действие: референс ушёл data:URL-ом', Boolean(refReq?.refImages?.[0]?.startsWith('data:image/png;base64,')), refReq?.refImages?.[0]?.slice(0, 40));

  const dir = join(root, 'images');
  check('действие: файл в доме (images/), байты — PNG', existsSync(dir) && readdirSync(dir).length === 1 && readdirSync(dir)[0]!.endsWith('.png') && readFileSync(join(dir, readdirSync(dir)[0]!)).equals(PNG_BYTES), JSON.stringify(readdirSync(dir)));

  const badRef = await executeImageAction(
    { kind: 'image', params: { prompt: 'кот', refs: ['../../../etc/passwd'] } },
    cfg, undefined, tctx,
  );
  check('действие: референс вне папки — отказ', !badRef.ok && badRef.output.includes('вне рабочей папки'), badRef.output);
  const notPic = await executeImageAction({ kind: 'image', params: { prompt: 'кот', refs: ['note.txt'] } }, cfg, undefined, tctx);
  check('действие: референс не картинка — отказ', !notPic.ok && notPic.output.includes('не картинка'), notPic.output);
  const ghostRef = await executeImageAction({ kind: 'image', params: { prompt: 'кот', refs: ['ghost.png'] } }, cfg, undefined, tctx);
  check('действие: референс не найден — отказ', !ghostRef.ok && ghostRef.output.includes('не удалось прочитать'), ghostRef.output);

  const failProvider: ToolContext = {
    ...tctx,
    getImageProvider: () => ({ provider: { ...captureProvider, async generate() { return { ok: false, images: [], error: 'бах' }; } } }),
  };
  const genFail = await executeImageAction({ kind: 'image', params: { prompt: 'кот' } }, cfg, undefined, failProvider);
  check('действие: провайдер упал — ошибка наружу', !genFail.ok && genFail.output === 'бах', genFail.output);

  // ── тул image: фабрика и run через конвейер deps (как его зовёт движок) ────
  {
    const { default: imageFactory } = await import('../src/tools/image/image.js');
    const { makeCtx } = await import('./tool-ctx.js');
    const artist: Agent = { id: 'hudozhnik', name: 'Художник', emoji: '🎨', color: 'magenta', prompt: 'рисуй', role: 'тест' };
    const runCtx = makeCtx(root, root);
    const tool = imageFactory({}, { cfg, agent: artist, tctx });
    check('тул: check всегда allow — пишет только в images/', tool.check('') === 'allow', String(tool.check('')));
    const drawn = await tool.run('prompt: закат над морем\nn: 1', runCtx);
    check('тул: run рисует через deps', drawn.includes('сгенерировано 1'), drawn);
    const noDeps = await imageFactory({}).run('prompt: кот', runCtx).catch((e: Error) => e.message);
    check('тул: без конвейера — внутренняя ошибка', noDeps.includes('без конвейера'), noDeps);
    const blocked = await imageFactory({}, { cfg, agent: artist, tctx: noImage }).run('prompt: кот', runCtx).catch((e: Error) => e.message);
    check('тул: нет image-модели — throw с причиной', blocked.includes('не назначена'), blocked);
  }
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
