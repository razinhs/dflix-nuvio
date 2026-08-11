'use strict';

var DFLIX_BASE = 'https://dflix.live';
var TMDB_METADATA_BASE = 'https://dflix-tmdb-metadata.razin.workers.dev';


function extension(value) {
  var clean = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean || 'mp4';
}

function humanSize(value) {
  var bytes = Number(value || 0);
  if (!bytes) return null;
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return (index === 0 ? Math.round(bytes) : bytes.toFixed(2)) + ' ' + units[index];
}

async function fetchJson(url, additionalHeaders) {
  var headers = { Accept: 'application/json' };
  Object.keys(additionalHeaders || {}).forEach(function (name) {
    headers[name] = additionalHeaders[name];
  });
  var response = await fetch(url, { headers: headers });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  var data = await response.json();
  if (data === null) throw new Error('Invalid JSON from ' + url);
  return data;
}

function parseRscChunks(html) {
  var chunks = [];
  var regex = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  var match;
  while ((match = regex.exec(html)) !== null) {
    try { chunks.push(JSON.parse(match[1])); } catch (error) { /* Ignore malformed chunks. */ }
  }
  if (!chunks.length) throw new Error('No DFLIX Flight data found');
  return chunks.join('');
}

function extractJsonValuesAfterMarker(payload, marker) {
  var values = [];
  var from = 0;
  while (from < payload.length) {
    var index = payload.indexOf(marker, from);
    if (index < 0) break;
    var start = index + marker.length;
    from = start + 1;
    var opening = payload[start];
    if (opening !== '{' && opening !== '[') continue;
    var closing = opening === '{' ? '}' : ']';
    var depth = 0;
    var inString = false;
    var escaped = false;

    for (var i = start; i < payload.length; i += 1) {
      var char = payload[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === opening) depth += 1;
      else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          try { values.push(JSON.parse(payload.slice(start, i + 1))); } catch (_) { /* Try later markers. */ }
          break;
        }
      }
    }
  }
  return values;
}

function filesMatchTitle(files, titleId, requireTitleId) {
  if (!Array.isArray(files)) return false;
  return files.every(function (file) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
    if (file.titleId === null || file.titleId === undefined) return !requireTitleId;
    return Number(file.titleId) === Number(titleId);
  });
}

async function getDflixDetail(titleId) {
  var key = String(titleId);
  var response = await fetch(DFLIX_BASE + '/title/' + encodeURIComponent(key), {
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  if (!response.ok) throw new Error('DFLIX title returned HTTP ' + response.status);
  var html = await response.text();
  var flight = parseRscChunks(html);
  var titles = extractJsonValuesAfterMarker(flight, '"title":').filter(function (value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  });
  var title = titles.find(function (value) { return Number(value.id) === Number(titleId); });
  if (!title) throw new Error('No matching DFLIX title data found');

  var files = null;
  if (Array.isArray(title.files) && title.files.length > 0 && filesMatchTitle(title.files, titleId, true)) {
    files = title.files;
  }
  if (!files) {
    var fileLists = extractJsonValuesAfterMarker(flight, '"files":').filter(Array.isArray);
    files = fileLists.find(function (value) {
      return value.length > 0 && filesMatchTitle(value, titleId, true);
    });
  }
  if (!files && Array.isArray(title.files) && title.files.length === 0) files = [];
  if (!files) throw new Error('No matching DFLIX file data found');
  return { title: title, files: files };
}


function normalizedTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function getTmdbMetadata(tmdbId, mediaType) {
  var wantedKind = mediaType === 'movie' ? 'movie' : 'tv';
  var metadata = await fetchJson(
    TMDB_METADATA_BASE + '/v1/metadata/' + wantedKind + '/' + encodeURIComponent(String(tmdbId))
  );
  var title = String(metadata.title || '').trim();
  var originalTitle = String(metadata.originalTitle || title).trim();
  if (Number(metadata.id) !== Number(tmdbId) || metadata.type !== wantedKind || !title) {
    throw new Error('TMDB metadata service returned invalid data for ' + tmdbId);
  }
  return {
    title: title,
    originalTitle: originalTitle || title,
    year: Number(metadata.year) || null
  };
}

async function resolveDflixTitle(tmdbId, mediaType) {
  var wantedKind = mediaType === 'movie' ? 'movie' : 'tv';
  var metadata = await getTmdbMetadata(tmdbId, wantedKind);
  var queries = [metadata.title];
  if (normalizedTitle(metadata.originalTitle) !== normalizedTitle(metadata.title)) {
    queries.push(metadata.originalTitle);
  }

  var results = [];
  var searchSucceeded = false;
  var lastSearchError = null;
  for (var queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    try {
      var search = await fetchJson(
        DFLIX_BASE + '/api/search?q=' + encodeURIComponent(queries[queryIndex]) + '&limit=60'
      );
      searchSucceeded = true;
      results = results.concat(search.results || []);
    } catch (error) {
      lastSearchError = error;
    }
  }
  if (!searchSucceeded && lastSearchError) throw lastSearchError;

  var expectedTitles = queries.map(normalizedTitle);
  var seenIds = Object.create(null);
  var candidates = results.filter(function (item) {
    var key = String(item.id);
    if (item.kind !== wantedKind || seenIds[key]) return false;
    seenIds[key] = true;
    return true;
  }).sort(function (left, right) {
    var leftScore = Number(Number(left.tmdbId) === Number(tmdbId)) * 4 +
      Number(expectedTitles.indexOf(normalizedTitle(left.title)) !== -1) +
      Number(metadata.year && Number(left.year) === metadata.year);
    var rightScore = Number(Number(right.tmdbId) === Number(tmdbId)) * 4 +
      Number(expectedTitles.indexOf(normalizedTitle(right.title)) !== -1) +
      Number(metadata.year && Number(right.year) === metadata.year);
    return rightScore - leftScore;
  }).slice(0, 4);

  if (!candidates.length) return null;

  try {
    var firstDetail = await getDflixDetail(candidates[0].id);
    if (Number(firstDetail.title.tmdbId) === Number(tmdbId)) return firstDetail;
  } catch (_) {
    /* Continue with lower-ranked candidates. */
  }

  var fallbackDetails = await Promise.all(candidates.slice(1).map(async function (candidate) {
    try {
      return await getDflixDetail(candidate.id);
    } catch (_) {
      return null;
    }
  }));
  for (var detailIndex = 0; detailIndex < fallbackDetails.length; detailIndex += 1) {
    if (fallbackDetails[detailIndex] && Number(fallbackDetails[detailIndex].title.tmdbId) === Number(tmdbId)) {
      return fallbackDetails[detailIndex];
    }
  }
  return null;
}

function makeResult(file) {
  if (!file) return null;
  var audioLanguage = String(file.audioLang || file.language || '').trim();
  var bits = [
    file.quality,
    file.container && String(file.container).toUpperCase(),
    file.codec,
    audioLanguage && 'Audio: ' + audioLanguage
  ].filter(function (value) { return Boolean(value); });
  var label = bits.join(' · ') || 'Direct';
  return {
    title: label,
    name: 'DFLIX',
    url: DFLIX_BASE + '/api/stream/' + encodeURIComponent(String(file.id)) + '.' + extension(file.container),
    quality: file.quality || null,
    size: humanSize(file.size),
    language: audioLanguage || null,
    provider: 'DFLIX',
    type: 'direct'
  };
}

function makeResults(files) {
  var seen = Object.create(null);
  return (files || []).filter(function (file) {
    var key = file && String(file.id);
    if (!file || !file.id || seen[key]) return false;
    seen[key] = true;
    return true;
  }).map(makeResult).filter(Boolean);
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var normalizedType = mediaType === 'movie' ? 'movie' : 'tv';
    var detail = await resolveDflixTitle(tmdbId, normalizedType);
    if (!detail) return [];
    var files;
    if (normalizedType === 'movie') {
      files = detail.files;
    } else {
      files = detail.files.filter(function (candidate) {
        return Number(candidate.season) === Number(season) &&
          Number(candidate.episode) === Number(episode);
      });
    }
    return makeResults(files);
  } catch (error) {
    var message = error && error.message ? error.message : String(error);
    console.error('DFLIX scraper:', message);
    return [{
      title: 'DFLIX diagnostic: ' + message,
      name: 'DFLIX error: ' + message,
      url: DFLIX_BASE,
      size: message,
      provider: 'DFLIX',
      type: 'direct'
    }];
  }
}

if (typeof module !== 'undefined') module.exports = { getStreams: getStreams };
if (typeof globalThis !== 'undefined') globalThis.getStreams = getStreams;
