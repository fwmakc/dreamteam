import type { ImageProvider, ImageRequest, ImageResult } from '../types.js';
import type { ImageAdapterFactory, ProviderConfig } from './types.js';

/**
 * Адаптер "mock-images": работает без docker и GPU — отдает 1×1 PNG.
 * Нужен, чтобы проверять весь цикл «сгенерировал → сохранил → посмотрел»
 * на любой машине.
 */

/** Крошечный валидный PNG (1×1 синий пиксель) — чтобы mock-режим рисовал настоящие файлы. */
const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkKPn/HwAEfgJ/qN5MzAAAAABJRU5ErkJggg==';

export const mockImagesFactory: ImageAdapterFactory = (id, config: ProviderConfig): ImageProvider => {
  const model = typeof config.model === 'string' ? config.model : 'mock';
  return {
    id,
    kind: 'mock-images',
    model,
    async generate(req: ImageRequest): Promise<ImageResult> {
      const n = Math.min(Math.max(req.n ?? 1, 1), 6);
      const images = Array.from({ length: n }, () => ({ data: MOCK_PNG_BASE64, mediaType: 'image/png' }));
      return { ok: true, images };
    },
  };
};
