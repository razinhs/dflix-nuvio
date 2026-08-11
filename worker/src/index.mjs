const TMDB_API_BASE = 'https://api.themoviedb.org/3';

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extraHeaders
    }
  });
}

function validTmdbDate(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function validTmdbId(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
}

function validNormalizedMetadata(value, type, requestedId, isImdbId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!validTmdbId(value.id) || value.type !== type) return false;
  if (typeof value.title !== 'string' || !value.title.trim()) return false;
  if (typeof value.originalTitle !== 'string' || !value.originalTitle.trim()) return false;
  if (value.year !== null && (!Number.isInteger(value.year) || value.year < 1000 || value.year > 9999)) return false;
  return isImdbId
    ? value.externalId === requestedId
    : value.id === Number(requestedId);
}

function normalizeMetadata(metadata, type, requestedId) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (!validTmdbId(metadata.id) || metadata.id !== requestedId) return null;

  const rawTitle = type === 'movie' ? metadata.title : metadata.name;
  const rawOriginalTitle = type === 'movie' ? metadata.original_title : metadata.original_name;
  const date = type === 'movie' ? metadata.release_date : metadata.first_air_date;
  if (typeof rawTitle !== 'string' || !rawTitle.trim()) return null;
  if (rawOriginalTitle !== undefined && rawOriginalTitle !== null && typeof rawOriginalTitle !== 'string') return null;
  if (!validTmdbDate(date)) return null;

  const title = rawTitle.trim();
  const originalTitle = typeof rawOriginalTitle === 'string' && rawOriginalTitle.trim()
    ? rawOriginalTitle.trim()
    : title;
  return {
    id: requestedId,
    type,
    title,
    originalTitle,
    year: date ? Number(date.slice(0, 4)) : null
  };
}

export async function handleRequest(request, env, ctx, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  const cache = dependencies.cache || caches.default;
  const url = new URL(request.url);
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
  }
  if (url.search) return json({ error: 'Query parameters are not supported' }, 400);

  const match = /^\/v1\/metadata\/(movie|tv)\/(\d{1,10}|tt\d{7,10})$/.exec(url.pathname);
  if (!match) return json({ error: 'Not found' }, 404);

  const type = match[1];
  const requestedId = match[2].toLowerCase();
  const isImdbId = requestedId.startsWith('tt');
  const id = isImdbId ? null : Number(requestedId);
  if (!isImdbId && (!Number.isSafeInteger(id) || id < 1 || id > 2147483647)) {
    return json({ error: 'Invalid TMDB ID' }, 400);
  }

  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  let cached;
  try {
    cached = await cache.match(cacheKey);
  } catch (_) {
    return json({ error: 'Metadata service temporarily unavailable' }, 503);
  }
  if (cached) {
    try {
      const cachedMetadata = await cached.clone().json();
      if (validNormalizedMetadata(cachedMetadata, type, requestedId, isImdbId)) return cached;
    } catch (_) {
      /* Ignore malformed cache entries and refresh them from TMDB. */
    }
  }

  if (!env.TMDB_READ_ACCESS_TOKEN) {
    return json({ error: 'Metadata service is not configured' }, 503);
  }

  const clientKey = request.headers.get('cf-connecting-ip') || 'unknown';
  let rate;
  try {
    if (!env.TMDB_RATE_LIMITER) throw new Error('missing rate limiter');
    rate = await env.TMDB_RATE_LIMITER.limit({ key: clientKey });
  } catch (_) {
    return json({ error: 'Metadata service temporarily unavailable' }, 503);
  }
  if (!rate.success) {
    return json({ error: 'Rate limit exceeded' }, 429, { 'retry-after': '60' });
  }

  const upstreamUrl = isImdbId
    ? `${TMDB_API_BASE}/find/${requestedId}?external_source=imdb_id&language=en-US`
    : `${TMDB_API_BASE}/${type}/${id}?language=en-US`;
  const upstreamRequest = new Request(upstreamUrl, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${env.TMDB_READ_ACCESS_TOKEN}`
    }
  });
  let upstream;
  try {
    upstream = await fetchImpl(upstreamRequest);
  } catch (_) {
    return json({ error: 'Metadata provider request failed' }, 502);
  }
  if (!upstream.ok) {
    if (upstream.status === 404) return json({ error: 'Title not found' }, 404);
    return json({ error: 'Metadata provider request failed' }, 502);
  }
  let metadata;
  try {
    metadata = await upstream.json();
  } catch (_) {
    return json({ error: 'Metadata provider returned invalid data' }, 502);
  }
  let result;
  if (isImdbId) {
    const candidates = type === 'movie' ? metadata?.movie_results : metadata?.tv_results;
    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        const candidateId = candidate?.id;
        const normalized = normalizeMetadata(candidate, type, candidateId);
        if (normalized) {
          result = { ...normalized, externalId: requestedId };
          break;
        }
      }
    }
  } else {
    result = normalizeMetadata(metadata, type, id);
  }
  if (!result) return json({ error: 'Metadata provider returned invalid data' }, 502);
  const cacheControl = 'public, max-age=86400, s-maxage=2592000';
  const cachedResponse = json(result, 200, {
    'cache-control': cacheControl,
    'x-dflix-cache': 'HIT'
  });
  ctx.waitUntil(cache.put(cacheKey, cachedResponse));
  return json(result, 200, {
    'cache-control': cacheControl,
    'x-dflix-cache': 'MISS'
  });
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
