'use strict';

var DFLIX_BASE = 'https://dflix.live';
var TMDB_METADATA_BASE = 'https://dflix-tmdb-metadata.razin.workers.dev';
var MAX_CANDIDATES = 4;
var MAX_OUTPUT_STREAMS = 100;
var SEARCH_LIMIT = 20;
var MAX_REQUEST_LAUNCH_MS = 25000;


function extension(value) {
  var clean = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean || 'mp4';
}

function humanSize(value) {
  if (!Number.isSafeInteger(value) || value < 1) return null;
  var bytes = value;
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

function filesMatchTitle(files, titleId) {
  if (!Array.isArray(files)) return false;
  var foundExactOwner = false;
  for (var index = 0; index < files.length; index += 1) {
    var file = files[index];
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        !Number.isSafeInteger(file.titleId)) continue;
    if (file.titleId !== titleId) return false;
    foundExactOwner = true;
  }
  return foundExactOwner;
}

function parseDflixDetail(payload, titleId) {
  var flight = payload.indexOf('self.__next_f.push') >= 0 ? parseRscChunks(payload) : payload;
  var titles = extractJsonValuesAfterMarker(flight, '"title":').filter(function (value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  });
  var title = titles.find(function (value) { return value.id === titleId; });
  if (!title) throw new Error('No matching DFLIX title data found');

  var files = null;
  if (Array.isArray(title.files) && title.files.length > 0 && filesMatchTitle(title.files, titleId)) {
    files = title.files;
  }
  if (!files) {
    var fileLists = extractJsonValuesAfterMarker(flight, '"files":').filter(Array.isArray);
    files = fileLists.find(function (value) {
      return value.length > 0 && filesMatchTitle(value, titleId);
    });
  }
  if (!files && Array.isArray(title.files) && title.files.length === 0) files = [];
  if (!files) throw new Error('No matching DFLIX file data found');
  return { title: title, files: files };
}

async function getDflixDetail(titleId, deadlineAt) {
  var key = String(titleId);
  var detailUrl = DFLIX_BASE + '/title/' + encodeURIComponent(key);
  var rscError = null;
  try {
    var rscResponse = await fetch(detailUrl, {
      headers: { Accept: 'text/x-component', RSC: '1' }
    });
    if (!rscResponse.ok) throw new Error('DFLIX RSC title returned HTTP ' + rscResponse.status);
    return parseDflixDetail(await rscResponse.text(), titleId);
  } catch (error) {
    rscError = error;
  }

  if (Date.now() >= deadlineAt) throw rscError;
  var response = await fetch(detailUrl, {
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  if (!response.ok) throw new Error('DFLIX title returned HTTP ' + response.status);
  return parseDflixDetail(await response.text(), titleId);
}


function normalizedTitle(value) {
  var text = String(value || '').toLowerCase();
  if (typeof text.normalize === 'function') text = text.normalize('NFKD');
  return text.replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0080-\uFFFF]+/g, ' ').trim();
}

async function getTmdbMetadata(tmdbId, mediaType) {
  var wantedKind = mediaType === 'movie' ? 'movie' : 'tv';
  var requestedId = String(tmdbId).trim().toLowerCase();
  var isImdbId = /^tt\d{7,10}$/.test(requestedId);
  var metadata = await fetchJson(
    TMDB_METADATA_BASE + '/v1/metadata/' + wantedKind + '/' + encodeURIComponent(requestedId)
  );
  var title = String(metadata.title || '').trim();
  var originalTitle = String(metadata.originalTitle || title).trim();
  var canonicalTmdbId = Number(metadata.id);
  var identityMatches = isImdbId
    ? String(metadata.externalId || '').toLowerCase() === requestedId
    : canonicalTmdbId === Number(requestedId);
  if (!Number.isSafeInteger(canonicalTmdbId) || canonicalTmdbId < 1 ||
      !identityMatches || metadata.type !== wantedKind || !title) {
    throw new Error('TMDB metadata service returned invalid data for ' + tmdbId);
  }
  return {
    tmdbId: canonicalTmdbId,
    title: title,
    originalTitle: originalTitle || title,
    year: Number(metadata.year) || null
  };
}

function isDflixSearchCandidate(item, wantedKind) {
  return item && typeof item === 'object' && !Array.isArray(item) &&
    Number.isSafeInteger(item.id) && item.id > 0 && item.id <= 2147483647 &&
    item.kind === wantedKind && typeof item.title === 'string' &&
    item.title.trim().length > 0 && item.title.length <= 300 &&
    Number.isSafeInteger(item.year) && item.year >= 1800 && item.year <= 2200;
}

function rankCandidates(results, wantedKind, metadata, expectedTitles, seenIds) {
  return (Array.isArray(results) ? results : []).filter(function (item) {
    if (!isDflixSearchCandidate(item, wantedKind)) return false;
    var key = String(item.id);
    if (seenIds[key]) return false;
    seenIds[key] = true;
    return true;
  }).sort(function (left, right) {
    var leftScore = Number(expectedTitles.indexOf(normalizedTitle(left.title)) !== -1) * 2 +
      Number(metadata.year && Number(left.year) === metadata.year);
    var rightScore = Number(expectedTitles.indexOf(normalizedTitle(right.title)) !== -1) * 2 +
      Number(metadata.year && Number(right.year) === metadata.year);
    return rightScore - leftScore;
  });
}

async function resolveDflixTitle(tmdbId, mediaType, deadlineAt) {
  var wantedKind = mediaType === 'movie' ? 'movie' : 'tv';
  var metadata = await getTmdbMetadata(tmdbId, wantedKind);
  var canonicalTmdbId = metadata.tmdbId;
  var queries = [metadata.title];
  if (normalizedTitle(metadata.originalTitle) !== normalizedTitle(metadata.title)) {
    queries.push(metadata.originalTitle);
  }

  var expectedTitles = queries.map(normalizedTitle);
  var seenSearchIds = Object.create(null);
  var triedDetailIds = Object.create(null);
  var remainingCandidates = [];
  var detailAttempts = 0;
  var searchSucceeded = false;
  var lastSearchError = null;

  async function tryCandidate(candidate) {
    var key = String(candidate && candidate.id);
    if (!candidate || triedDetailIds[key] || detailAttempts >= MAX_CANDIDATES ||
        Date.now() >= deadlineAt) return null;
    triedDetailIds[key] = true;
    detailAttempts += 1;
    try {
      var detail = await getDflixDetail(candidate.id, deadlineAt);
      if (!Number.isSafeInteger(detail.title.tmdbId) || detail.title.tmdbId !== canonicalTmdbId) return null;
      if (detail.title.kind !== wantedKind) return null;
      return detail;
    } catch (_) {
      return null;
    }
  }

  for (var queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    if (Date.now() >= deadlineAt) break;
    var ranked = [];
    try {
      var search = await fetchJson(
        DFLIX_BASE + '/api/search?q=' + encodeURIComponent(queries[queryIndex]) + '&limit=' + SEARCH_LIMIT
      );
      searchSucceeded = true;
      ranked = rankCandidates(search.results, wantedKind, metadata, expectedTitles, seenSearchIds);
    } catch (error) {
      lastSearchError = error;
    }

    if (ranked.length) {
      var verified = await tryCandidate(ranked[0]);
      if (verified) return verified;
      remainingCandidates = remainingCandidates.concat(ranked.slice(1));
    }
  }

  if (!searchSucceeded && lastSearchError) throw lastSearchError;
  for (var candidateIndex = 0; candidateIndex < remainingCandidates.length; candidateIndex += 1) {
    var fallback = await tryCandidate(remainingCandidates[candidateIndex]);
    if (fallback) return fallback;
  }
  return null;
}

function displayText(value, maxLength) {
  if (typeof value !== 'string') return '';
  var text = value.trim();
  return text && text.length <= maxLength ? text : '';
}

function normalizedCodec(value) {
  var codec = displayText(value, 60);
  var key = codec.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key === 'x265' || key === 'h265' || key === 'hevc') return 'HEVC';
  if (key === 'x264' || key === 'h264' || key === 'avc') return 'H.264';
  if (key === 'av1') return 'AV1';
  return codec;
}

function qualityScore(value) {
  var quality = displayText(value, 60).toLowerCase();
  if (/\b(?:4k|uhd)\b/.test(quality)) return 2160;
  var match = quality.match(/(\d{3,4})\s*p/);
  return match ? Number(match[1]) : 0;
}

function safeFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
  if (!Number.isSafeInteger(file.id) || file.id < 1 || file.id > 2147483647) return false;
  if (!Number.isSafeInteger(file.titleId) || file.titleId < 1) return false;
  if (typeof file.container !== 'string' || file.container.length > 20) return false;
  var container = extension(file.container);
  if (['mp4', 'mkv', 'webm', 'avi', 'm4v', 'mov', 'ts'].indexOf(container) === -1) return false;
  if (file.season !== undefined && file.season !== null && !Number.isSafeInteger(file.season)) return false;
  if (file.episode !== undefined && file.episode !== null && !Number.isSafeInteger(file.episode)) return false;
  return true;
}

function makeResult(file) {
  var quality = displayText(file.quality, 60);
  var container = extension(file.container).toUpperCase();
  var codec = normalizedCodec(file.codec);
  var audioLanguage = displayText(file.audioLang, 100) || displayText(file.language, 100);
  var bits = [
    quality,
    container,
    codec,
    audioLanguage && 'Audio: ' + audioLanguage
  ].filter(function (value) { return Boolean(value); });
  var label = bits.join(' · ') || 'Direct';
  return {
    title: label,
    name: 'DFLIX',
    url: DFLIX_BASE + '/api/stream/' + encodeURIComponent(String(file.id)) + '.' + extension(file.container),
    quality: quality || null,
    size: humanSize(file.size),
    language: audioLanguage || null,
    provider: 'DFLIX',
    type: 'direct'
  };
}

function makeResults(files) {
  var seen = Object.create(null);
  return (Array.isArray(files) ? files : []).map(function (file, index) {
    return { file: file, index: index };
  }).filter(function (entry) {
    var file = entry.file;
    if (!safeFile(file)) return false;
    var key = String(file.id);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).sort(function (left, right) {
    return qualityScore(right.file.quality) - qualityScore(left.file.quality) || left.index - right.index;
  }).slice(0, MAX_OUTPUT_STREAMS).map(function (entry) {
    return makeResult(entry.file);
  });
}

function validateCaller(identifier, mediaType, season, episode) {
  if (mediaType !== 'movie' && mediaType !== 'tv') throw new Error('Invalid media type');
  if (typeof identifier !== 'string') throw new Error('Invalid identifier');
  var id = identifier.trim();
  var validTmdb = /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
  var validImdb = /^tt\d{7,10}$/.test(id);
  if (!validTmdb && !validImdb) throw new Error('Invalid identifier');
  if (mediaType === 'tv' && (!Number.isSafeInteger(season) || season < 0 ||
      !Number.isSafeInteger(episode) || episode < 1)) {
    throw new Error('Invalid season or episode');
  }
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    validateCaller(tmdbId, mediaType, season, episode);
    var deadlineAt = Date.now() + MAX_REQUEST_LAUNCH_MS;
    var normalizedType = mediaType;
    var detail = await resolveDflixTitle(tmdbId, normalizedType, deadlineAt);
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
