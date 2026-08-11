import test from 'node:test';
import assert from 'node:assert/strict';

const TOKEN = 'test-token-never-deploy';

function context() {
  return { waitUntil() {} };
}

test('returns normalized movie metadata without exposing the TMDB token', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  let upstreamRequest;
  const dependencies = {
    fetch: async (request) => {
      upstreamRequest = request;
      return new Response(JSON.stringify({
        id: 603,
        title: 'The Matrix',
        original_title: 'The Matrix',
        release_date: '1999-03-30'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    cache: { match: async () => null, put: async () => {} }
  };
  const env = {
    TMDB_READ_ACCESS_TOKEN: TOKEN,
    TMDB_RATE_LIMITER: { limit: async () => ({ success: true }) }
  };

  const response = await handleRequest(
    new Request('https://worker.example/v1/metadata/movie/603'),
    env,
    context(),
    dependencies
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    id: 603,
    type: 'movie',
    title: 'The Matrix',
    originalTitle: 'The Matrix',
    year: 1999
  });
  assert.equal(upstreamRequest.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.doesNotMatch(upstreamRequest.url, new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(body), new RegExp(TOKEN));
});

test('rejects unsupported methods, paths, query strings, and invalid IDs before calling upstream', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  let calls = 0;
  const dependencies = {
    fetch: async () => { calls += 1; throw new Error('must not fetch'); },
    cache: { match: async () => null, put: async () => {} }
  };
  const env = { TMDB_READ_ACCESS_TOKEN: TOKEN };
  const cases = [
    new Request('https://worker.example/v1/metadata/movie/603', { method: 'POST' }),
    new Request('https://worker.example/v1/metadata/person/603'),
    new Request('https://worker.example/v1/metadata/movie/not-a-number'),
    new Request('https://worker.example/v1/metadata/movie/0'),
    new Request('https://worker.example/v1/metadata/movie/603?path=authentication')
  ];

  for (const request of cases) {
    const response = await handleRequest(request, env, context(), dependencies);
    assert.ok([400, 404, 405].includes(response.status), `${request.method} ${request.url}`);
  }
  assert.equal(calls, 0);
});

test('serves cached metadata without calling TMDB or consuming the rate limit', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  let fetchCalls = 0;
  let rateLimitCalls = 0;
  const cached = new Response(JSON.stringify({ id: 603, type: 'movie', title: 'The Matrix', year: 1999 }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-dflix-cache': 'HIT' }
  });
  const dependencies = {
    fetch: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    cache: { match: async () => cached, put: async () => {} }
  };
  const env = {
    TMDB_READ_ACCESS_TOKEN: TOKEN,
    TMDB_RATE_LIMITER: { limit: async () => { rateLimitCalls += 1; return { success: true }; } }
  };

  const response = await handleRequest(
    new Request('https://worker.example/v1/metadata/movie/603'),
    env,
    context(),
    dependencies
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-dflix-cache'), 'HIT');
  assert.equal(fetchCalls, 0);
  assert.equal(rateLimitCalls, 0);
});

test('rate limits uncached clients before contacting TMDB', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  let fetchCalls = 0;
  let rateLimitKey;
  const dependencies = {
    fetch: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    cache: { match: async () => null, put: async () => {} }
  };
  const env = {
    TMDB_READ_ACCESS_TOKEN: TOKEN,
    TMDB_RATE_LIMITER: {
      limit: async ({ key }) => { rateLimitKey = key; return { success: false }; }
    }
  };
  const request = new Request('https://worker.example/v1/metadata/movie/603', {
    headers: { 'cf-connecting-ip': '203.0.113.10' }
  });

  const response = await handleRequest(request, env, context(), dependencies);

  assert.equal(response.status, 429);
  assert.equal(rateLimitKey, '203.0.113.10');
  assert.equal(fetchCalls, 0);
});

test('fails closed without contacting TMDB when the Worker secret is missing', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  let fetchCalls = 0;
  const dependencies = {
    fetch: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    cache: { match: async () => null, put: async () => {} }
  };
  const env = {
    TMDB_RATE_LIMITER: { limit: async () => ({ success: true }) }
  };

  const response = await handleRequest(
    new Request('https://worker.example/v1/metadata/movie/603'),
    env,
    context(),
    dependencies
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, 'Metadata service is not configured');
  assert.equal(fetchCalls, 0);
});

test('stores successful normalized metadata in the Cloudflare cache', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  let storedKey;
  let storedResponse;
  let backgroundTask;
  const dependencies = {
    fetch: async () => new Response(JSON.stringify({
      id: 141,
      name: 'Cheers',
      original_name: 'Cheers',
      first_air_date: '1982-09-30'
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    cache: {
      match: async () => null,
      put: async (key, response) => { storedKey = key; storedResponse = response; }
    }
  };
  const env = {
    TMDB_READ_ACCESS_TOKEN: TOKEN,
    TMDB_RATE_LIMITER: { limit: async () => ({ success: true }) }
  };
  const ctx = { waitUntil(task) { backgroundTask = task; } };

  const response = await handleRequest(
    new Request('https://worker.example/v1/metadata/tv/141'),
    env,
    ctx,
    dependencies
  );
  await backgroundTask;

  assert.equal(response.headers.get('x-dflix-cache'), 'MISS');
  assert.match(response.headers.get('cache-control'), /s-maxage=2592000/);
  assert.equal(storedKey.url, 'https://worker.example/v1/metadata/tv/141');
  assert.equal(storedResponse.headers.get('x-dflix-cache'), 'HIT');
  assert.deepEqual(await storedResponse.json(), {
    id: 141,
    type: 'tv',
    title: 'Cheers',
    originalTitle: 'Cheers',
    year: 1982
  });
});

test('returns a generic error without exposing TMDB upstream details or the token', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  const dependencies = {
    fetch: async () => new Response(JSON.stringify({
      status_message: `Invalid token ${TOKEN}`
    }), { status: 401, headers: { 'content-type': 'application/json' } }),
    cache: { match: async () => null, put: async () => { throw new Error('must not cache'); } }
  };
  const env = {
    TMDB_READ_ACCESS_TOKEN: TOKEN,
    TMDB_RATE_LIMITER: { limit: async () => ({ success: true }) }
  };

  const response = await handleRequest(
    new Request('https://worker.example/v1/metadata/movie/603'),
    env,
    context(),
    dependencies
  );
  const text = await response.text();

  assert.equal(response.status, 502);
  assert.match(text, /metadata provider request failed/i);
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.doesNotMatch(text, /status_message/i);
});

test('sanitizes thrown network errors that contain secret material', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  const dependencies = {
    fetch: async () => { throw new Error(`network failure with ${TOKEN}`); },
    cache: { match: async () => null, put: async () => {} }
  };
  const env = {
    TMDB_READ_ACCESS_TOKEN: TOKEN,
    TMDB_RATE_LIMITER: { limit: async () => ({ success: true }) }
  };

  const response = await handleRequest(
    new Request('https://worker.example/v1/metadata/movie/603'),
    env,
    context(),
    dependencies
  );
  const text = await response.text();

  assert.equal(response.status, 502);
  assert.match(text, /metadata provider request failed/i);
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.doesNotMatch(text, /network failure/i);
});

test('does not expose a public health or secret-configuration endpoint', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  const dependencies = {
    fetch: async () => { throw new Error('must not fetch'); },
    cache: { match: async () => { throw new Error('must not cache'); }, put: async () => {} }
  };

  const response = await handleRequest(
    new Request('https://worker.example/health'),
    {},
    context(),
    dependencies
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not found' });
});

test('rejects malformed or mismatched TMDB payloads before caching them', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  const malformed = [
    null,
    {},
    [],
    { id: 999, title: 'Wrong ID', release_date: '1999-03-30' },
    { id: 603, title: '', release_date: '1999-03-30' },
    { id: 603, title: 42, release_date: '1999-03-30' },
    { id: 603, title: 'The Matrix', original_title: 42, release_date: '1999-03-30' },
    { id: 603, title: 'The Matrix', release_date: 'not-a-date' },
    { id: 603, title: 'The Matrix', release_date: '1999-02-31' }
  ];

  for (const payload of malformed) {
    let cacheWrites = 0;
    const dependencies = {
      fetch: async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }),
      cache: {
        match: async () => null,
        put: async () => { cacheWrites += 1; }
      }
    };
    const env = {
      TMDB_READ_ACCESS_TOKEN: TOKEN,
      TMDB_RATE_LIMITER: { limit: async () => ({ success: true }) }
    };

    const response = await handleRequest(
      new Request('https://worker.example/v1/metadata/movie/603'),
      env,
      context(),
      dependencies
    );
    assert.equal(response.status, 502, JSON.stringify(payload));
    assert.deepEqual(await response.json(), { error: 'Metadata provider returned invalid data' });
    assert.equal(cacheWrites, 0);
  }
});

test('fails closed when Cloudflare cache or rate-limit bindings are unavailable', async () => {
  const { handleRequest } = await import('./src/index.mjs');
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; throw new Error('must not fetch'); };
  const request = new Request('https://worker.example/v1/metadata/movie/603');

  const cacheFailure = await handleRequest(
    request,
    {
      TMDB_READ_ACCESS_TOKEN: TOKEN,
      TMDB_RATE_LIMITER: { limit: async () => ({ success: true }) }
    },
    context(),
    {
      fetch: fetchImpl,
      cache: { match: async () => { throw new Error('cache unavailable'); }, put: async () => {} }
    }
  );
  assert.equal(cacheFailure.status, 503);
  assert.deepEqual(await cacheFailure.json(), { error: 'Metadata service temporarily unavailable' });

  const limiterFailure = await handleRequest(
    request,
    {
      TMDB_READ_ACCESS_TOKEN: TOKEN,
      TMDB_RATE_LIMITER: { limit: async () => { throw new Error('limiter unavailable'); } }
    },
    context(),
    {
      fetch: fetchImpl,
      cache: { match: async () => null, put: async () => {} }
    }
  );
  assert.equal(limiterFailure.status, 503);
  assert.deepEqual(await limiterFailure.json(), { error: 'Metadata service temporarily unavailable' });
  assert.equal(fetchCalls, 0);
});
