'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const METADATA_BASE = 'https://dflix-tmdb-metadata.razin.workers.dev';
const CIRCLE_API = 'http://new.circleftp.net:5000/api';

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function rangeResponse(status, headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized[String(name).toLowerCase()] || null }
  };
}

async function withFetch(mock, run) {
  const realFetch = global.fetch;
  global.fetch = mock;
  try {
    delete require.cache[require.resolve('./circleftp.js')];
    return await run(require('./circleftp.js'));
  } finally {
    global.fetch = realFetch;
  }
}

test('CircleFTP resolves every exact movie variant by canonical title, year, and media type', async () => {
  const seen = [];
  const posts = [
    { id: 71940, name: 'The Matrix', year: '1999', type: 'singleVideo', quality: '1080p' },
    { id: 71943, name: 'The Matrix', year: '1999', type: 'singleVideo', quality: '1080p Dual Audio' },
    { id: 71939, name: 'The Matrix Revolutions', year: '2003', type: 'singleVideo' },
    { id: 69637, name: 'The Matrix', year: null, type: 'singleFile' }
  ];
  const details = {
    71940: {
      id: 71940,
      name: 'The Matrix',
      year: '1999',
      type: 'singleVideo',
      quality: '1080p BluRay English',
      title: 'The Matrix (1999) REMASTERED 1080p BluRay',
      content: 'http://index.circleftp.net/FILE/English%20Movies/1999/The%20Matrix.mp4'
    },
    71943: {
      id: 71943,
      name: 'The Matrix',
      year: '1999',
      type: 'singleVideo',
      quality: '1080p BluRay Hin+Eng',
      title: 'The Matrix (1999) Dual Audio',
      content: 'http://index.circleftp.net/FILE/English%20Movies/1999/The%20Matrix.mkv'
    }
  };

  await withFetch(async (url) => {
    const value = String(url);
    seen.push(value);
    if (value === `${METADATA_BASE}/v1/metadata/movie/603`) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value === `${CIRCLE_API}/posts?searchTerm=The%20Matrix&order=desc`) {
      return jsonResponse({ posts });
    }
    const detail = value.match(new RegExp(`^${CIRCLE_API}/posts/(\\d+)$`));
    if (detail && details[detail[1]]) return jsonResponse(details[detail[1]]);
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.deepEqual(streams.map((stream) => stream.url), [
      details[71940].content,
      details[71943].content
    ]);
    assert.deepEqual(streams.map((stream) => stream.provider), ['CircleFTP', 'CircleFTP']);
    assert.match(streams[1].title, /Hin\+Eng/);
  });

  assert.ok(seen.includes(`${CIRCLE_API}/posts/71940`));
  assert.ok(seen.includes(`${CIRCLE_API}/posts/71943`));
  assert.ok(!seen.includes(`${CIRCLE_API}/posts/71939`));
  assert.ok(!seen.includes(`${CIRCLE_API}/posts/69637`));
});

test('CircleFTP enriches at most two unique streams from one-byte range metadata', async () => {
  const links = [
    'http://ftp1.circleftp.net/FILE/Movies/One.mkv',
    'http://ftp2.circleftp.net/FILE/Movies/Two.mp4',
    'http://ftp3.circleftp.net/FILE/Movies/Three.mkv'
  ];
  const rangeCalls = [];
  await withFetch(async (url, options = {}) => {
    const value = String(url);
    if (value === `${METADATA_BASE}/v1/metadata/movie/603`) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 8000, name: 'The Matrix', year: '1999', type: 'multiVideo' }] });
    }
    if (value === `${CIRCLE_API}/posts/8000`) {
      return jsonResponse({
        id: 8000,
        name: 'The Matrix',
        year: '1999',
        type: 'multiVideo',
        content: links.map((link, index) => ({ title: `Variant ${index + 1}`, link }))
      });
    }
    if (links.includes(value)) {
      rangeCalls.push({ value, options });
      const total = value.endsWith('One.mkv') ? '2147483648' : '3758096384';
      return rangeResponse(206, { 'Content-Range': `bytes 0-0/${total}` });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.deepEqual(streams.map((stream) => stream.size), ['2.00 GB', '3.50 GB', null]);
  });
  assert.equal(rangeCalls.length, 2);
  assert.deepEqual(rangeCalls.map((call) => call.value), links.slice(0, 2));
  assert.ok(rangeCalls.every((call) => call.options.headers.Range === 'bytes=0-0'));
});

test('CircleFTP size enrichment is best-effort and never drops playable streams', async () => {
  const links = [
    'http://ftp1.circleftp.net/FILE/Movies/One.mkv',
    'http://ftp2.circleftp.net/FILE/Movies/Two.mkv'
  ];
  await withFetch(async (url) => {
    const value = String(url);
    if (value === `${METADATA_BASE}/v1/metadata/movie/603`) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 8001, name: 'The Matrix', year: '1999', type: 'multiVideo' }] });
    }
    if (value === `${CIRCLE_API}/posts/8001`) {
      return jsonResponse({
        id: 8001,
        name: 'The Matrix',
        year: '1999',
        type: 'multiVideo',
        content: links.map((link) => ({ link }))
      });
    }
    if (value === links[0]) return rangeResponse(200, { 'Content-Length': '999999999' });
    if (value === links[1]) throw new Error('range probe failed');
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.deepEqual(streams.map((stream) => stream.url), links);
    assert.deepEqual(streams.map((stream) => stream.size), [null, null]);
  });
});

test('CircleFTP skips size probes after the short enrichment launch window', async () => {
  const link = 'http://ftp1.circleftp.net/FILE/Movies/One.mkv';
  let now = 0;
  let rangeCalls = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await withFetch(async (url) => {
      const value = String(url);
      if (value === `${METADATA_BASE}/v1/metadata/movie/603`) {
        return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
      }
      if (value.includes('/posts?searchTerm=')) {
        return jsonResponse({ posts: [{ id: 8002, name: 'The Matrix', year: '1999', type: 'singleVideo' }] });
      }
      if (value === `${CIRCLE_API}/posts/8002`) {
        now = 5000;
        return jsonResponse({ id: 8002, name: 'The Matrix', year: '1999', type: 'singleVideo', content: link });
      }
      if (value === link) {
        rangeCalls += 1;
        return rangeResponse(206, { 'Content-Range': 'bytes 0-0/2147483648' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }, async ({ getStreams }) => {
      const streams = await getStreams('603', 'movie', null, null);
      assert.equal(streams.length, 1);
      assert.equal(streams[0].size, null);
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(rangeCalls, 0);
});

test('CircleFTP selects the requested episode from an exact series and season', async () => {
  const detail = {
    id: 89891,
    name: 'Breaking Bad',
    year: '2008',
    type: 'series',
    quality: '1080p TV Series',
    title: 'Breaking Bad (TV Series 2008-2013)',
    content: [
      {
        seasonName: 'Season 1',
        episodes: [
          {
            title: 'Breaking Bad.S1.Episode:1',
            link: 'http://ftp9.circleftp.net/FILE/TV/Breaking.Bad.S01E01.mkv'
          },
          {
            title: 'Breaking Bad.S1.Episode:2',
            link: 'http://ftp9.circleftp.net/FILE/TV/Breaking.Bad.S01E02.mkv'
          },
          {
            title: 'Breaking Bad.S2.Episode:2',
            link: 'http://ftp9.circleftp.net/FILE/TV/Wrong-Season-S02E02.mkv'
          },
          {
            title: 'EP 3',
            link: 'http://ftp9.circleftp.net/FILE/TV/Breaking.Bad.S01E03.mkv'
          }
        ]
      },
      {
        seasonName: 'Season 2',
        episodes: [{
          title: 'Breaking Bad S02 E01',
          link: 'http://ftp9.circleftp.net/FILE/TV/Breaking.Bad.S02E01.mkv'
        }]
      }
    ]
  };

  await withFetch(async (url) => {
    const value = String(url);
    if (value === `${METADATA_BASE}/v1/metadata/tv/1396`) {
      return jsonResponse({ id: 1396, type: 'tv', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008 });
    }
    if (value === `${CIRCLE_API}/posts?searchTerm=Breaking%20Bad&order=desc`) {
      return jsonResponse({ posts: [
        { id: 89891, name: 'Breaking Bad', year: '2008', type: 'series' },
        { id: 51384, name: 'El Camino A Breaking Bad Movie', year: '2019', type: 'singleVideo' }
      ] });
    }
    if (value === `${CIRCLE_API}/posts/89891`) return jsonResponse(detail);
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('1396', 'tv', 1, 2);
    assert.deepEqual(streams.map((stream) => stream.url), [
      'http://ftp9.circleftp.net/FILE/TV/Breaking.Bad.S01E02.mkv'
    ]);
    assert.match(streams[0].title, /Episode:2/);

    const seasonTwo = await getStreams('1396', 'tv', 2, 1);
    assert.deepEqual(seasonTwo.map((stream) => stream.url), [
      'http://ftp9.circleftp.net/FILE/TV/Breaking.Bad.S02E01.mkv'
    ]);

    const shortEpisode = await getStreams('1396', 'tv', 1, 3);
    assert.deepEqual(shortEpisode.map((stream) => stream.url), [
      'http://ftp9.circleftp.net/FILE/TV/Breaking.Bad.S01E03.mkv'
    ]);
  });
});

test('CircleFTP caps Nuvio-compatible sequential detail requests while preserving exact variants', async () => {
  let active = 0;
  let maxActive = 0;
  const posts = Array.from({ length: 8 }, (_, index) => ({
    id: 8000 + index,
    name: 'The Matrix',
    year: '1999',
    type: 'singleVideo'
  }));

  await withFetch(async (url) => {
    const value = String(url);
    if (value === `${METADATA_BASE}/v1/metadata/movie/603`) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value === `${CIRCLE_API}/posts?searchTerm=The%20Matrix&order=desc`) return jsonResponse({ posts });
    const match = value.match(new RegExp(`^${CIRCLE_API}/posts/(\\d+)$`));
    if (match) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse({
        id: Number(match[1]),
        name: 'The Matrix',
        year: '1999',
        type: 'singleVideo',
        content: `http://index.circleftp.net/FILE/English/Matrix-${match[1]}.mkv`
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 4);
  });

  assert.equal(maxActive, 1, `expected Nuvio-compatible sequential detail work, saw ${maxActive}`);
});

test('CircleFTP supports IMDb input when localized search fails and original title succeeds', async () => {
  const seen = [];
  await withFetch(async (url) => {
    const value = String(url);
    seen.push(value);
    if (value === `${METADATA_BASE}/v1/metadata/movie/tt0133093`) {
      return jsonResponse({
        id: 603,
        externalId: 'tt0133093',
        type: 'movie',
        title: 'Matrix Localized',
        originalTitle: 'The Matrix',
        year: 1999
      });
    }
    if (value === `${CIRCLE_API}/posts?searchTerm=Matrix%20Localized&order=desc`) {
      return jsonResponse({ message: 'temporary failure' }, 503);
    }
    if (value === `${CIRCLE_API}/posts?searchTerm=The%20Matrix&order=desc`) {
      return jsonResponse({ posts: [{ id: 71940, name: 'The Matrix', year: '1999', type: 'singleVideo' }] });
    }
    if (value === `${CIRCLE_API}/posts/71940`) {
      return jsonResponse({
        id: 71940,
        name: 'The Matrix',
        year: '1999',
        type: 'singleVideo',
        content: 'http://index.circleftp.net/FILE/English/Matrix.mkv'
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('tt0133093', 'movie', null, null);
    assert.equal(streams.length, 1);
  });
  assert.ok(seen.includes(`${CIRCLE_API}/posts?searchTerm=Matrix%20Localized&order=desc`));
  assert.ok(seen.includes(`${CIRCLE_API}/posts?searchTerm=The%20Matrix&order=desc`));
});

test('CircleFTP stops after an exact localized-title search instead of launching the fallback', async () => {
  const searches = [];
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/603')) {
      return jsonResponse({ id: 603, type: 'movie', title: 'Matrix Localized', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) {
      searches.push(value);
      return jsonResponse({ posts: value.includes('Matrix%20Localized')
        ? [{ id: 9050, name: 'Matrix Localized', year: '1999', type: 'singleVideo' }]
        : [] });
    }
    if (value.endsWith('/posts/9050')) {
      return jsonResponse({
        id: 9050,
        name: 'Matrix Localized',
        year: '1999',
        type: 'singleVideo',
        content: 'http://index.circleftp.net/FILE/Movies/Matrix.mkv'
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    assert.equal((await getStreams('603', 'movie', null, null)).length, 1);
  });
  assert.deepEqual(searches, [`${CIRCLE_API}/posts?searchTerm=Matrix%20Localized&order=desc`]);
});

test('CircleFTP does not launch a fallback search after its request-launch budget is exhausted', async () => {
  const realNow = Date.now;
  let now = 0;
  const seen = [];
  Date.now = () => now;
  try {
    await withFetch(async (url) => {
      const value = String(url);
      seen.push(value);
      if (value.endsWith('/v1/metadata/movie/603')) {
        return jsonResponse({ id: 603, type: 'movie', title: 'Matrix Localized', originalTitle: 'The Matrix', year: 1999 });
      }
      if (value.includes('searchTerm=Matrix%20Localized')) {
        now = 26000;
        return jsonResponse({ posts: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }, async ({ getStreams }) => {
      assert.deepEqual(await getStreams('603', 'movie', null, null), []);
    });
  } finally {
    Date.now = realNow;
  }
  assert.ok(seen.some((url) => url.includes('searchTerm=Matrix%20Localized')));
  assert.ok(!seen.some((url) => url.includes('searchTerm=The%20Matrix')));
});

test('CircleFTP rejects non-CircleFTP, credentialed, non-FILE, and non-video links', async () => {
  const links = [
    'http://index.circleftp.net/FILE/Movies/valid.mkv',
    'http://index.circleftp.net.evil.example/FILE/Movies/bad.mkv',
    'http://index.circleftp.net@evil.example/FILE/Movies/bad.mkv',
    'http://index.circleftp.net/private/bad.mkv',
    'http://index.circleftp.net/FILE/Movies/bad.exe',
    'https://index.circleftp.net/FILE/Movies/bad.mkv',
    'http://index.circleftp.net/FILE/../private/traversal.mkv',
    'http://index.circleftp.net/FILE/%2e%2e/private/encoded-traversal.mkv',
    'http://index.circleftp.net/FILE/%25252e%25252e/private/triple-encoded-traversal.mkv',
    'http://index.circleftp.net/FILE/%25255csecret/encoded-backslash.mkv',
    'http://index.circleftp.net/FILE/..\\private/backslash-traversal.mkv'
  ];
  const posts = [{
    id: 9000,
    name: 'The Matrix',
    year: '1999',
    type: 'multiVideo'
  }];

  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/603')) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) return jsonResponse({ posts });
    if (value === `${CIRCLE_API}/posts/9000`) {
      return jsonResponse({
        ...posts[0],
        content: links.map((link, index) => ({ title: `variant-${index}`, link }))
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.deepEqual(streams.map((stream) => stream.url), [links[0]]);
  });
});

test('CircleFTP revalidates title identity on detail responses', async () => {
  const posts = [
    { id: 9101, name: 'The Matrix', year: '1999', type: 'singleVideo' },
    { id: 9102, name: 'The Matrix', year: '1999', type: 'singleVideo' },
    { id: 9103, name: 'The Matrix', year: '1999', type: 'singleVideo' },
    { id: 9104, name: 'The Matrix', year: '1999', type: 'singleVideo' }
  ];
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/603')) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) return jsonResponse({ posts });
    if (value.endsWith('/posts/9101')) {
      return jsonResponse({ ...posts[0], content: 'http://index.circleftp.net/FILE/Movies/good.mkv' });
    }
    if (value.endsWith('/posts/9102')) {
      return jsonResponse({ ...posts[1], name: 'The Matrix Reloaded', content: 'http://index.circleftp.net/FILE/Movies/wrong.mkv' });
    }
    if (value.endsWith('/posts/9103')) {
      return jsonResponse({ ...posts[2], year: '2003', content: 'http://index.circleftp.net/FILE/Movies/wrong-year.mkv' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.deepEqual(streams.map((stream) => stream.url), [
      'http://index.circleftp.net/FILE/Movies/good.mkv'
    ]);
  });
});

test('CircleFTP returns no stream when only same-name wrong-year titles exist', async () => {
  let detailRequests = 0;
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/tv/2316')) {
      return jsonResponse({ id: 2316, type: 'tv', title: 'The Office', originalTitle: 'The Office', year: 2005 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 58451, name: 'The Office', year: '2019', type: 'series' }] });
    }
    detailRequests += 1;
    throw new Error(`Unexpected detail URL: ${url}`);
  }, async ({ getStreams }) => {
    assert.deepEqual(await getStreams('2316', 'tv', 1, 1), []);
  });
  assert.equal(detailRequests, 0);
});

test('CircleFTP surfaces a bounded diagnostic when its search API is unavailable', async () => {
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/603')) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) return jsonResponse({ message: 'unavailable' }, 503);
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].provider, 'CircleFTP');
    assert.equal(streams[0].url, 'http://new.circleftp.net/');
    assert.match(streams[0].name, /CircleFTP error: HTTP 503/);
  });
});

test('CircleFTP rejects a mismatched IMDb identity before contacting CircleFTP', async () => {
  const seen = [];
  await withFetch(async (url) => {
    const value = String(url);
    seen.push(value);
    if (value.endsWith('/v1/metadata/movie/tt0133093')) {
      return jsonResponse({
        id: 603,
        externalId: 'tt9999999',
        type: 'movie',
        title: 'The Matrix',
        originalTitle: 'The Matrix',
        year: 1999
      });
    }
    throw new Error(`CircleFTP must not be contacted: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('tt0133093', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.match(streams[0].name, /Metadata service returned invalid data/);
  });
  assert.ok(!seen.some((url) => url.startsWith(CIRCLE_API)));
});

test('CircleFTP rejects invalid caller identifiers and media types before network I/O', async () => {
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    throw new Error('network must not be used');
  }, async ({ getStreams }) => {
    for (const args of [
      ['6.03e2', 'movie', null, null],
      ['0603', 'movie', null, null],
      ['TT0133093', 'movie', null, null],
      ['tt123', 'movie', null, null],
      ['603', 'series', null, null],
      ['603', '', null, null],
      ['1396', 'tv', [1], [1]],
      ['1396', 'tv', true, true],
      ['1396', 'tv', { valueOf: () => 1 }, { valueOf: () => 1 }],
      ['1396', 'tv', '1', '1'],
      ['1396', 'tv', 1.5, 1],
      ['1396', 'tv', -1, 1],
      ['1396', 'tv', 1, 0],
      ['1396', 'tv', null, null]
    ]) {
      const streams = await getStreams(...args);
      assert.equal(streams.length, 1);
      assert.match(streams[0].name, /CircleFTP error: Invalid/);
    }
  });
  assert.equal(fetches, 0);
});

test('CircleFTP ignores non-canonical post identifiers before detail requests', async () => {
  const details = [];
  const posts = [
    { id: 9300, name: 'The Matrix', year: '1999', type: 'singleVideo' },
    { id: '1e2', name: 'The Matrix', year: '1999', type: 'singleVideo' },
    { id: '001', name: 'The Matrix', year: '1999', type: 'singleVideo' },
    { id: true, name: 'The Matrix', year: '1999', type: 'singleVideo' }
  ];
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/603')) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) return jsonResponse({ posts });
    const match = value.match(/\/posts\/(.+)$/);
    if (match) {
      details.push(match[1]);
      if (match[1] === '9300') {
        return jsonResponse({
          ...posts[0],
          content: 'http://index.circleftp.net/FILE/Movies/Matrix.mkv'
        });
      }
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
  });
  assert.deepEqual(details, ['9300']);
});

test('CircleFTP rejects malformed year fields before detail requests', async () => {
  const details = [];
  const posts = [
    { id: 9350, name: 'The Matrix', year: '1999', type: 'singleVideo' },
    { id: 9351, name: 'The Matrix', year: '1999.5', type: 'singleVideo' },
    { id: 9352, name: 'The Matrix', year: 'x1999', type: 'singleVideo' },
    { id: 9353, name: 'The Matrix', year: 1999.5, type: 'singleVideo' },
    { id: 9354, name: 'The Matrix', year: { value: 1999 }, type: 'singleVideo' }
  ];
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/603')) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) return jsonResponse({ posts });
    const match = value.match(/\/posts\/(\d+)$/);
    if (match) {
      details.push(match[1]);
      return jsonResponse({
        ...posts[Number(match[1]) - 9350],
        content: `http://index.circleftp.net/FILE/Movies/${match[1]}.mkv`
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
  });
  assert.deepEqual(details, ['9350']);
});

test('CircleFTP never treats different non-Latin titles as an empty-title match', async () => {
  let detailRequests = 0;
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/777')) {
      return jsonResponse({ id: 777, type: 'movie', title: 'পথের পাঁচালী', originalTitle: 'পথের পাঁচালী', year: 1955 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 9400, name: '기생충', year: '1955', type: 'singleVideo' }] });
    }
    detailRequests += 1;
    return jsonResponse({
      id: 9400,
      name: '기생충',
      year: '1955',
      type: 'singleVideo',
      content: 'http://index.circleftp.net/FILE/Movies/Wrong.mkv'
    });
  }, async ({ getStreams }) => {
    assert.deepEqual(await getStreams('777', 'movie', null, null), []);
  });
  assert.equal(detailRequests, 0);
});

test('CircleFTP preserves mixed-script title identity instead of matching only ASCII fragments', async () => {
  let detailRequests = 0;
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/777')) {
      return jsonResponse({ id: 777, type: 'movie', title: '愛 Love', originalTitle: '愛 Love', year: 2020 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 9450, name: 'كره Love', year: '2020', type: 'singleVideo' }] });
    }
    detailRequests += 1;
    return jsonResponse({
      id: 9450,
      name: 'كره Love',
      year: '2020',
      type: 'singleVideo',
      content: 'http://index.circleftp.net/FILE/Movies/Wrong.mkv'
    });
  }, async ({ getStreams }) => {
    assert.deepEqual(await getStreams('777', 'movie', null, null), []);
  });
  assert.equal(detailRequests, 0);
});

test('CircleFTP discards malformed optional display fields from otherwise valid streams', async () => {
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/603')) {
      return jsonResponse({ id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 9500, name: 'The Matrix', year: '1999', type: 'singleVideo' }] });
    }
    if (value.endsWith('/posts/9500')) {
      return jsonResponse({
        id: 9500,
        name: 'The Matrix',
        year: '1999',
        type: 'singleVideo',
        quality: { bad: true },
        title: ['bad'],
        content: 'http://index.circleftp.net/FILE/Movies/Matrix.mkv'
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].title, 'MKV');
    assert.equal(streams[0].quality, null);
    assert.equal(typeof streams[0].title, 'string');
  });
});

test('CircleFTP enforces one cumulative 100-result cap across nested TV payloads', async () => {
  const seasons = Array.from({ length: 100 }, (_, seasonIndex) => ({
    seasonName: 'Season 1',
    episodes: Array.from({ length: 100 }, (_, episodeIndex) => ({
      title: 'S01E01',
      link: `http://ftp9.circleftp.net/FILE/TV/s${seasonIndex}-e${episodeIndex}.mkv`
    }))
  }));
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/tv/1396')) {
      return jsonResponse({ id: 1396, type: 'tv', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 9550, name: 'Breaking Bad', year: '2008', type: 'series' }] });
    }
    if (value.endsWith('/posts/9550')) {
      return jsonResponse({
        id: 9550,
        name: 'Breaking Bad',
        year: '2008',
        type: 'series',
        content: seasons
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('1396', 'tv', 1, 1);
    assert.equal(streams.length, 100);
    assert.equal(new Set(streams.map((stream) => stream.url)).size, 100);
  });
});

test('CircleFTP accepts multi-video posts and deduplicates repeated direct links', async () => {
  const direct = 'http://ftp5.circleftp.net/FILE/Movies/Anthology-Part-1.mp4';
  await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/v1/metadata/movie/123')) {
      return jsonResponse({ id: 123, type: 'movie', title: 'Anthology', originalTitle: 'Anthology', year: 2020 });
    }
    if (value.includes('/posts?searchTerm=')) {
      return jsonResponse({ posts: [{ id: 9200, name: 'Anthology', year: '2020', type: 'multiVideo' }] });
    }
    if (value.endsWith('/posts/9200')) {
      return jsonResponse({
        id: 9200,
        name: 'Anthology',
        year: '2020',
        type: 'multiVideo',
        quality: '1080p',
        content: [
          { title: 'Part 1', link: direct },
          { title: 'Part 1 duplicate', link: direct }
        ]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async ({ getStreams }) => {
    const streams = await getStreams('123', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, direct);
    assert.match(streams[0].title, /Part 1/);
  });
});
