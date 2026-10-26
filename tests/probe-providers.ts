/**
 * Проба кастомных адаптеров провайдеров: файл providers/<id>.ts в доме —
 * export default фабрика (id, config) => LLMProvider, карточка в providers.json
 * ссылается полем "adapter".
 *  - happy path: адаптер «echo» отвечает на раунд, статус ok, провайдер виден
 *    rpc-слою (addProviderConfig принимает его адаптер, неизвестный — отказ
 *    со списком, где «echo» есть);
 *  - коллизия providers/mock.ts со встроенным адаптером — громкая ошибка;
 *  - битый файл providers/broken.ts — громкая ошибка с путём.
 *
 * Герметично: временные DT_HOME/DT_PROJECT.
 * Запуск: npm run probe:providers
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmTemp } from './rm-tmp.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const root = mkdtempSync(join(tmpdir(), 'dt-providers-'));
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows держит файлы */ } });

/** Дом с карточкой models/echo.json на адаптере «echo» и самим адаптером на полке. */
function makeHome(name: string, extra: void): string {
  void extra;
  const home = join(root, name);
  const proj = join(root, `${name}-proj`);
  mkdirSync(join(home, 'providers'), { recursive: true });
  mkdirSync(join(home, 'models'), { recursive: true });
  process.env.DT_HOME = home;
  process.env.DT_PROJECT = proj;
  writeFileSync(
    join(home, 'models', 'echo.json'),
    JSON.stringify({ adapter: 'echo', model: 'mirror' }, null, 2) + '\n',
  );
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'echo' } }, null, 2) + '\n');
  return home;
}

// --- 1. happy path: кастомный адаптер отвечает; rpc-слой его видит -----------
{
  const home = makeHome('h1');
  writeFileSync(join(home, 'providers', 'echo.ts'), `
export default (id, config) => ({
  id,
  kind: 'echo',
  model: String(config.model ?? 'echo'),
  async *stream(req) {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    yield 'ЭХО: ' + (last ? last.content : '');
  },
});
`);

  const { bootstrapApp } = await import('../src/core/bootstrap.js');
  const { app } = await bootstrapApp();
  const status = app.models.get('echo');
  check('кастомный адаптер: статус ok', Boolean(status?.ok) && status?.provider.kind === 'echo', JSON.stringify({ ok: status?.ok, kind: status?.provider.kind, note: status?.note }));

  const chunks: string[] = [];
  for await (const c of status!.provider.stream({ messages: [{ role: 'user', content: 'привет' }] })) chunks.push(c);
  check('кастомный адаптер: раунд отвечает', chunks.join('').includes('ЭХО: привет'), chunks.join(''));

  const { addModelConfig, loadUserAdapters } = await import('../src/providers/registry.js');
  const report = addModelConfig(join(home, 'models'), 'two', { adapter: 'echo', model: 'y' });
  check('rpc: карточка с кастомным адаптером добавляется', report.includes('добавлена'), report);

  let threw = '';
  try { addModelConfig(join(home, 'models'), 'three', { adapter: 'nope' }); } catch (e) { threw = (e as Error).message; }
  check('rpc: неизвестный адаптер — отказ, в списке есть кастомный', threw.includes('nope') && threw.includes('echo'), threw);

  const card = JSON.parse(readFileSync(join(home, 'models', 'two.json'), 'utf8'));
  check('rpc: карточка реально записана', card.adapter === 'echo', JSON.stringify(card));

  // --- 2. коллизия со встроенным адаптером — громкая ошибка --------------------
  const home2 = join(root, 'h2');
  mkdirSync(join(home2, 'providers'), { recursive: true });
  writeFileSync(join(home2, 'providers', 'mock.ts'), 'export default (id) => ({ id, kind: "x", model: "x", async *stream() {} });');
  threw = '';
  try { await loadUserAdapters(join(home2, 'providers')); } catch (e) { threw = (e as Error).message; }
  check('коллизия providers/mock.ts — отказ', threw.includes('mock.ts') && threw.includes('занято'), threw);

  // --- 3. битый файл — громкая ошибка с путём ----------------------------------
  const home3 = join(root, 'h3');
  mkdirSync(join(home3, 'providers'), { recursive: true });
  writeFileSync(join(home3, 'providers', 'broken.ts'), '{ битый');
  threw = '';
  try { await loadUserAdapters(join(home3, 'providers')); } catch (e) { threw = (e as Error).message; }
  check('битый providers/broken.ts — отказ с путём', threw.includes('broken.ts'), threw);
}

rmTemp(root);
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
