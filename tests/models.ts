import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Полка моделей для герметичных проб: models/<id>.json — карточка на модель,
 * settings.json получает model: {id: defaultId} (если указан).
 */
export function writeModels(
  home: string,
  cards: Record<string, Record<string, unknown>>,
  defaultId?: string,
): void {
  const dir = join(home, 'models');
  mkdirSync(dir, { recursive: true });
  for (const [id, card] of Object.entries(cards)) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(card, null, 2) + '\n');
  }
  if (defaultId !== undefined) {
    const sf = join(home, 'settings.json');
    let settings: Record<string, unknown> = {};
    if (existsSync(sf)) {
      try {
        settings = JSON.parse(readFileSync(sf, 'utf8')) as Record<string, unknown>;
      } catch {
        // перезапишем начисто — проба хозяин своего дома
      }
    }
    settings.model = { id: defaultId };
    writeFileSync(sf, JSON.stringify(settings, null, 2) + '\n');
  }
}
