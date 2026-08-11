'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const project = __dirname;


test('repository manifest defines independently toggleable DFLIX and CircleFTP scrapers', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'DFLIX + CircleFTP Providers');
  assert.equal(manifest.version, '1.5.1');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.scrapers.length, 2);
  assert.deepEqual(manifest.scrapers.map((scraper) => scraper.version), ['1.4.3', '1.0.1']);
  assert.deepEqual(manifest.scrapers.map((scraper) => scraper.filename), ['dflix.js', 'circleftp.js']);
  assert.deepEqual(manifest.scrapers.map((scraper) => scraper.id), ['dflix-cloud', 'circleftp']);
  assert.deepEqual(manifest.scrapers.map((scraper) => scraper.supportedTypes), [
    ['movie', 'tv'],
    ['movie', 'tv']
  ]);
  assert.ok(manifest.scrapers.every((scraper) => scraper.enabled && scraper.hasSettings === false));
});

test('cloud plugin requires no client-side credentials or settings', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8'));
  const source = fs.readFileSync(path.join(project, 'dflix.js'), 'utf8');
  assert.equal(manifest.scrapers[0].hasSettings, false);
  assert.doesNotMatch(source, /tmdbReadAccessToken|TMDB_READ_ACCESS_TOKEN|api\.themoviedb\.org/);
  assert.doesNotMatch(source, /redactUrl|api_key/);
});

test('TMDB branch contains no embedded DFLIX title index', () => {
  const source = fs.readFileSync(path.join(project, 'dflix.js'), 'utf8');
  assert.doesNotMatch(source, /DFLIX_TITLE_INDEX|BEGIN GENERATED DFLIX INDEX/);
  assert.ok(Buffer.byteLength(source) < 20_000);
});

test('local plugin uses TMDB metadata to find an exact DFLIX movie', async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push(String(url));
    if (String(url) === 'https://dflix-tmdb-metadata.razin.workers.dev/v1/metadata/movie/603') {
      assert.equal(options.headers.Authorization, undefined);
      return { ok: true, json: async () => ({
        id: 603,
        type: 'movie',
        title: 'Matrix Localized',
        originalTitle: 'The Matrix',
        year: 1999
      }) };
    }
    if (String(url).startsWith('https://dflix.live/api/search?')) {
      const query = new URL(String(url)).searchParams.get('q');
      if (query === 'Matrix Localized') return { ok: true, json: async () => ({ results: [] }) };
      assert.equal(query, 'The Matrix');
      return { ok: true, json: async () => ({ results: [
        { id: 998, kind: 'movie', title: 'The Matrix', year: 1999 },
        { id: 999, kind: 'movie', title: 'The Matrix', year: 1999 },
        { id: 4592, kind: 'movie', title: 'The Matrix', year: 1999 }
      ] }) };
    }
    if (String(url) === 'https://dflix.live/title/998') {
      return { ok: false, status: 500 };
    }
    if (String(url) === 'https://dflix.live/title/999') {
      const payload = '0:{"title":{"id":999,"tmdbId":999},"files":[{"id":1,"titleId":999,"container":"mp4"}]}';
      const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
      return { ok: true, text: async () => html };
    }
    if (String(url) === 'https://dflix.live/title/4592') {
      const payload = '0:{"title":{"id":4592,"tmdbId":603},"files":[{"id":4599,"titleId":4592,"container":"mp4","quality":"1080p"}]}';
      const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
      return { ok: true, text: async () => html };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://dflix.live/api/stream/4599.mp4');
    assert.ok(seen.includes('https://dflix-tmdb-metadata.razin.workers.dev/v1/metadata/movie/603'));
    assert.ok(!seen.some((url) => url.includes('api.themoviedb.org')));
    assert.ok(seen.some((url) => url.includes('q=Matrix%20Localized')));
    assert.ok(seen.some((url) => url.includes('q=The%20Matrix')));
    assert.ok(seen.includes('https://dflix.live/title/998'));
    assert.ok(seen.includes('https://dflix.live/title/999'));
    assert.ok(seen.includes('https://dflix.live/title/4592'));
  } finally {
    global.fetch = realFetch;
  }
});

test('local plugin resolves an IMDb movie ID to canonical TMDB identity', async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (String(url) === 'https://dflix-tmdb-metadata.razin.workers.dev/v1/metadata/movie/tt10872600') {
      return { ok: true, json: async () => ({
        id: 634649,
        externalId: 'tt10872600',
        type: 'movie',
        title: 'Spider-Man: No Way Home',
        originalTitle: 'Spider-Man: No Way Home',
        year: 2021
      }) };
    }
    if (String(url).startsWith('https://dflix.live/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 25001, kind: 'movie', title: 'Spider-Man: No Way Home', year: 2021 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/25001') {
      const files = [{ id: 35001, titleId: 25001, container: 'mkv', quality: '1080p' }];
      const payload = `0:${JSON.stringify({ title: { id: 25001, kind: 'movie', tmdbId: 634649, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('tt10872600', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://dflix.live/api/stream/35001.mkv');
    assert.ok(seen.includes('https://dflix-tmdb-metadata.razin.workers.dev/v1/metadata/movie/tt10872600'));
  } finally {
    global.fetch = realFetch;
  }
});

test('local plugin resolves an IMDb series ID before selecting the episode', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/v1/metadata/tv/tt0386676')) {
      return { ok: true, json: async () => ({
        id: 2316,
        externalId: 'tt0386676',
        type: 'tv',
        title: 'The Office',
        originalTitle: 'The Office',
        year: 2005
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 14003, kind: 'tv', title: 'The Office', year: 2005 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/14003') {
      const files = [
        { id: 127480, titleId: 14003, container: 'mkv', season: 1, episode: 1 },
        { id: 127481, titleId: 14003, container: 'mkv', season: 1, episode: 2 }
      ];
      const payload = `0:${JSON.stringify({ title: { id: 14003, kind: 'tv', tmdbId: 2316, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('tt0386676', 'tv', 1, 1);
    assert.deepEqual(streams.map((stream) => stream.url), [
      'https://dflix.live/api/stream/127480.mkv'
    ]);
  } finally {
    global.fetch = realFetch;
  }
});

test('DFLIX detail parsing ignores unrelated Flight title and files objects', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 4592, kind: 'movie', title: 'The Matrix', year: 1999 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/4592') {
      const unrelated = '0:{"title":{"id":77,"tmdbId":77,"files":[{"id":770,"titleId":77,"container":"mp4"}]},"files":[{"id":770,"titleId":77,"container":"mp4"}]}';
      const wanted = '1:{"title":{"id":4592,"tmdbId":603,"files":[{"id":4599,"titleId":4592,"container":"mp4","quality":"1080p"}]},"files":[{"id":4599,"titleId":4592,"container":"mp4","quality":"1080p"}]}';
      const html = `<script>self.__next_f.push([1,${JSON.stringify(unrelated)}])</script>` +
        `<script>self.__next_f.push([1,${JSON.stringify(wanted)}])</script>`;
      return { ok: true, text: async () => html };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://dflix.live/api/stream/4599.mp4');
  } finally {
    global.fetch = realFetch;
  }
});

test('DFLIX detail parsing rejects a sole title with the wrong DFLIX ID', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 4592, kind: 'movie', title: 'The Matrix', year: 1999 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/4592') {
      const files = [{ id: 4599, titleId: 4592, container: 'mp4' }];
      const payload = `0:${JSON.stringify({ title: { id: 77, tmdbId: 603 }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    assert.deepEqual(await getStreams('603', 'movie', null, null), []);
  } finally {
    global.fetch = realFetch;
  }
});

test('DFLIX detail parsing rejects files without the requested title ID', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 4592, kind: 'movie', title: 'The Matrix', year: 1999 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/4592') {
      const payload = '0:{"title":{"id":4592,"tmdbId":603},"files":[{"id":4599,"container":"mp4"}]}';
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    assert.deepEqual(await getStreams('603', 'movie', null, null), []);
  } finally {
    global.fetch = realFetch;
  }
});

test('DFLIX detail parsing skips unrelated empty file arrays', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 4592, kind: 'movie', title: 'The Matrix', year: 1999 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/4592') {
      const unrelated = '0:{"files":[]}';
      const wanted = '1:{"title":{"id":4592,"tmdbId":603,"files":[]},"files":[{"id":4599,"titleId":4592,"container":"mp4"}]}';
      const html = `<script>self.__next_f.push([1,${JSON.stringify(unrelated)}])</script>` +
        `<script>self.__next_f.push([1,${JSON.stringify(wanted)}])</script>`;
      return { ok: true, text: async () => html };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams[0].url, 'https://dflix.live/api/stream/4599.mp4');
  } finally {
    global.fetch = realFetch;
  }
});

test('movie results include every DFLIX file option', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 4592, kind: 'movie', title: 'The Matrix', year: 1999 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/4592') {
      const files = [
        { id: 4599, titleId: 4592, container: 'mp4', quality: '1080p', size: 2000 },
        { id: 4600, titleId: 4592, container: 'mkv', quality: '720p', size: 1000, audioLang: 'eng' }
      ];
      const payload = `0:${JSON.stringify({ title: { id: 4592, tmdbId: 603, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.deepEqual(streams.map((stream) => stream.url), [
      'https://dflix.live/api/stream/4599.mp4',
      'https://dflix.live/api/stream/4600.mkv'
    ]);
  } finally {
    global.fetch = realFetch;
  }
});

test('local plugin uses TMDB metadata to resolve an exact series episode', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) === 'https://dflix-tmdb-metadata.razin.workers.dev/v1/metadata/tv/141') {
      return { ok: true, json: async () => ({
        id: 141,
        type: 'tv',
        title: 'Cheers',
        originalTitle: 'Cheers',
        year: 1982
      }) };
    }
    if (String(url).startsWith('https://dflix.live/api/search?')) {
      return { ok: true, json: async () => ({ results: [{ id: 30497, kind: 'tv', title: 'Cheers', year: 1982 }] }) };
    }
    if (String(url) === 'https://dflix.live/title/30497') {
      const payload = '0:{"title":{"id":30497,"tmdbId":141},"files":[{"id":286098,"titleId":30497,"container":"mkv","season":1,"episode":1,"audioLang":"eng"}]}';
      const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
      return { ok: true, text: async () => html };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('141', 'tv', 1, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://dflix.live/api/stream/286098.mkv');
    assert.equal(streams[0].language, 'eng');
    assert.match(streams[0].title, /Audio: eng/);
  } finally {
    global.fetch = realFetch;
  }
});

test('episode results include every matching DFLIX file option', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/tv/141')) {
      return { ok: true, json: async () => ({
        id: 141, type: 'tv', title: 'Cheers', originalTitle: 'Cheers', year: 1982
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 30497, kind: 'tv', title: 'Cheers', year: 1982 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/30497') {
      const files = [
        { id: 286098, titleId: 30497, container: 'mkv', quality: '720p', season: 1, episode: 1 },
        { id: 386098, titleId: 30497, container: 'mp4', quality: '1080p', season: 1, episode: 1 },
        { id: 286099, titleId: 30497, container: 'mkv', quality: '720p', season: 1, episode: 2 }
      ];
      const payload = `0:${JSON.stringify({ title: { id: 30497, tmdbId: 141, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('141', 'tv', 1, 1);
    assert.deepEqual(streams.map((stream) => stream.url), [
      'https://dflix.live/api/stream/286098.mkv',
      'https://dflix.live/api/stream/386098.mp4'
    ]);
  } finally {
    global.fetch = realFetch;
  }
});

test('an exact first candidate returns without loading lower-ranked detail pages', async () => {
  const realFetch = global.fetch;
  const requestedDetails = [];
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({ results: [4592, 4593, 4594, 4595].map((id) => ({
        id, kind: 'movie', title: id === 4592 ? 'The Matrix' : `Matrix ${id}`, year: id === 4592 ? 1999 : 2000
      })) }) };
    }
    const match = String(url).match(/\/title\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      requestedDetails.push(id);
      const tmdbId = id === 4592 ? 603 : id;
      const files = [{ id: 9000 + id, titleId: id, container: 'mp4' }];
      const payload = `0:${JSON.stringify({ title: { id, tmdbId, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams[0].url, 'https://dflix.live/api/stream/13592.mp4');
    assert.deepEqual(requestedDetails, [4592]);
  } finally {
    global.fetch = realFetch;
  }
});

test('candidate details are checked with bounded parallelism', async () => {
  const realFetch = global.fetch;
  let active = 0;
  let maxActive = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({ results: [1, 2, 3, 4].map((id) => ({
        id, kind: 'movie', title: 'The Matrix', year: 1999
      })) }) };
    }
    const match = String(url).match(/\/title\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      const tmdbId = id === 4 ? 603 : id;
      const files = [{ id: 4000 + id, titleId: id, container: 'mp4' }];
      const payload = `0:${JSON.stringify({ title: { id, tmdbId, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams[0].url, 'https://dflix.live/api/stream/4004.mp4');
    assert.ok(maxActive > 1, `expected parallel detail requests, saw ${maxActive}`);
    assert.ok(maxActive <= 4, `expected bounded concurrency, saw ${maxActive}`);
  } finally {
    global.fetch = realFetch;
  }
});

test('candidate detail work is capped to fit Nuvio execution limits', async () => {
  const realFetch = global.fetch;
  let detailRequests = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({ results: Array.from({ length: 20 }, (_, index) => ({
        id: index + 1, kind: 'movie', title: 'The Matrix', year: 1999
      })) }) };
    }
    const match = String(url).match(/\/title\/(\d+)$/);
    if (match) {
      detailRequests += 1;
      const id = Number(match[1]);
      const files = [{ id: 5000 + id, titleId: id, container: 'mp4' }];
      const payload = `0:${JSON.stringify({ title: { id, tmdbId: id, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.deepEqual(streams, []);
    assert.equal(detailRequests, 4);
  } finally {
    global.fetch = realFetch;
  }
});

test('title details are refreshed on each provider call', async () => {
  const realFetch = global.fetch;
  let detailFetches = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/metadata/movie/603')) {
      return { ok: true, json: async () => ({
        id: 603, type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', year: 1999
      }) };
    }
    if (String(url).includes('/api/search?')) {
      return { ok: true, json: async () => ({
        results: [{ id: 4592, kind: 'movie', title: 'The Matrix', year: 1999 }]
      }) };
    }
    if (String(url) === 'https://dflix.live/title/4592') {
      detailFetches += 1;
      const files = [{ id: 6000 + detailFetches, titleId: 4592, container: 'mp4' }];
      const payload = `0:${JSON.stringify({ title: { id: 4592, tmdbId: 603, files }, files })}`;
      return { ok: true, text: async () => `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const first = await getStreams('603', 'movie', null, null);
    const second = await getStreams('603', 'movie', null, null);
    assert.equal(first[0].url, 'https://dflix.live/api/stream/6001.mp4');
    assert.equal(second[0].url, 'https://dflix.live/api/stream/6002.mp4');
    assert.equal(detailFetches, 2);
  } finally {
    global.fetch = realFetch;
  }
});

test('Worker availability errors are returned as a visible diagnostic stream', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://dflix-tmdb-metadata.razin.workers.dev/v1/metadata/movie/603');
    assert.equal(options.headers.Authorization, undefined);
    return { ok: false, status: 503 };
  };
  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.match(streams[0].title, /HTTP 503/i);
  } finally {
    global.fetch = realFetch;
  }
});

test('client requests to the Worker never send an authorization credential', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://dflix-tmdb-metadata.razin.workers.dev/v1/metadata/movie/603');
    assert.equal(options.headers.Authorization, undefined);
    assert.doesNotMatch(JSON.stringify(options), /bearer|api[_-]?key/i);
    return { ok: false, status: 502 };
  };
  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.match(streams[0].title, /HTTP 502/i);
  } finally {
    global.fetch = realFetch;
  }
});

test('on-device runtime errors are returned as a visible diagnostic stream', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('simulated device DNS failure'); };
  try {
    delete require.cache[require.resolve('./dflix.js')];
    const { getStreams } = require('./dflix.js');
    const streams = await getStreams('603', 'movie', null, null);
    assert.equal(streams.length, 1);
    assert.match(streams[0].title, /DFLIX diagnostic/i);
    assert.match(streams[0].title, /simulated device DNS failure/i);
    assert.match(streams[0].name, /simulated device DNS failure/i);
    assert.match(streams[0].size, /simulated device DNS failure/i);
  } finally {
    global.fetch = realFetch;
  }
});
