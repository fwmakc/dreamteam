import type { ImageProvider, ImageRequest, ImageResult } from '../types.js';
import type { AdapterContract, ImageAdapterFactory, ProviderConfig } from './types.js';

/** Контракт карточки models/<id>.json для адаптера openai-images. */
export const contract: AdapterContract = {
  keys: {
    baseUrl: { type: 'string', required: true, desc: 'адрес images API вместе с /v1' },
    model: { type: 'string', required: true, desc: 'имя модели генерации' },
    apiKey: { type: 'string' },
  },
  ref: [],
};

/**
 * Адаптер "openai-images": наш facade в docker (по умолчанию) или любой
 * OpenAI-совместимый images API. Референсы переводят запрос на /images/edits.
 * Адаптер — только транспорт: байты картинок возвращаются приложению, файлы
 * на диск кладёт actions.ts в рабочую папку агента.
 */

const REQUEST_TIMEOUT_MS = 600_000; // генерация медленная, особенно на CPU

/** Опции генерации, которые стоит слать только если заданы (облачные API строгие) */
function optionalParams(req: ImageRequest): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (req.steps !== undefined) extra.steps = req.steps;
  if (req.guidance !== undefined) extra.guidance = req.guidance;
  if (req.seed !== undefined) extra.seed = req.seed;
  return extra;
}

interface ImagesApiResponse {
  data?: Array<{ b64_json?: unknown; url?: unknown }>;
  error?: { message?: unknown } | string;
  detail?: unknown;
}

/** Внешний сигнал отмены + таймаут генерации (ручной AbortSignal.any с опциональным signal). */
function reqSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function downloadAsBase64(url: string, signal?: AbortSignal): Promise<{ data: string; mediaType: string }> {
  const res = await fetch(url, { signal: reqSignal(signal, 120_000) });
  if (!res.ok) throw new Error(`не удалось скачать картинку (${res.status})`);
  const mediaType = res.headers.get('content-type') ?? 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString('base64'), mediaType };
}

/** Общий транспорт POST /images/generations и /images/edits (формат OpenAI). */
async function generateViaOpenAi(
  baseUrl: string,
  model: string,
  req: ImageRequest,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    n: req.n ?? 1,
    size: req.size ?? '512x512',
    ...optionalParams(req),
  };
  const path = req.refImages?.length ? '/images/edits' : '/images/generations';
  if (req.refImages?.length) body.image = req.refImages; // data: URL, формат нашего facade

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: reqSignal(signal, REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      images: [],
      error: `image-провайдер недоступен (${err instanceof Error ? err.message : err}) — поднимите контейнер: docker/README.md`,
    };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, images: [], error: `HTTP ${res.status}: ${detail.slice(0, 300)}` };
  }
  let parsed: ImagesApiResponse;
  try {
    parsed = (await res.json()) as ImagesApiResponse;
  } catch {
    return { ok: false, images: [], error: 'ответ image-провайдера — не JSON' };
  }
  const list = parsed.data ?? [];
  const images: ImageResult['images'] = [];
  for (const item of list) {
    if (typeof item.b64_json === 'string' && item.b64_json) {
      images.push({ data: item.b64_json, mediaType: 'image/png' });
    } else if (typeof item.url === 'string' && item.url) {
      try {
        images.push(await downloadAsBase64(item.url, signal));
      } catch (err) {
        return { ok: false, images, error: `не удалось забрать готовую картинку: ${err instanceof Error ? err.message : err}` };
      }
    }
  }
  if (images.length === 0) {
    return { ok: false, images: [], error: 'image-провайдер вернул пустой ответ' };
  }
  return { ok: true, images };
}

export const openAiImagesFactory: ImageAdapterFactory = (id, config: ProviderConfig): ImageProvider => {
  const baseUrl = String(config.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(`не задан baseUrl (image-провайдер «${id}»)`);
  }
  const model = String(config.model ?? '');
  if (!model) {
    throw new Error(`не задана модель (image-провайдер «${id}»)`);
  }
  const apiKey = config.apiKey ? String(config.apiKey) : undefined;
  return {
    id,
    kind: 'openai-images',
    model,
    generate: (req, signal) => generateViaOpenAi(baseUrl, model, req, apiKey, signal),
  };
};
