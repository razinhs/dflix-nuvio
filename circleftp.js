'use strict';

var CIRCLE_API = 'http://new.circleftp.net:5000/api';
var TMDB_METADATA_BASE = 'https://dflix-tmdb-metadata.razin.workers.dev';
var MAX_CANDIDATES = 4;
var MAX_LINKS_PER_POST = 100;
var MAX_REQUEST_LAUNCH_MS = 25000;

async function fetchJson(url) {
  var response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  var data = await response.json();
  if (data === null) throw new Error('Invalid JSON from ' + url);
  return data;
}

function normalizedTitle(value) {
  var text = String(value || '').toLowerCase();
  if (typeof text.normalize === 'function') text = text.normalize('NFKD');
  return text.replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0080-\uFFFF]+/g, ' ').trim();
}

function startYear(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1000 && value <= 9999 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d{4}(?:-\d{4})?$/.test(value)) return null;
  var first = Number(value.slice(0, 4));
  if (first < 1000) return null;
  if (value.length > 4 && Number(value.slice(5)) < first) return null;
  return first;
}

function validPostId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

function movieType(value) {
  return value === 'singleVideo' || value === 'multiVideo';
}

function wantedPost(item, metadata, mediaType) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !validPostId(item.id) ||
      typeof item.name !== 'string' || typeof item.type !== 'string' ||
      (typeof item.year !== 'string' && typeof item.year !== 'number')) return false;
  var expectedTitles = [normalizedTitle(metadata.title), normalizedTitle(metadata.originalTitle)].filter(Boolean);
  var candidateTitle = normalizedTitle(item.name);
  var typeMatches = mediaType === 'movie' ? movieType(item.type) : item.type === 'series';
  return Boolean(candidateTitle) && typeMatches && expectedTitles.indexOf(candidateTitle) !== -1 &&
    metadata.year && startYear(item.year) === metadata.year;
}

function safeCirclePath(pathname) {
  var current = pathname;
  for (var i = 0; i < 5; i += 1) {
    if (current.indexOf('\\') !== -1 || /[\u0000-\u001f\u007f]/.test(current) ||
        current.slice(0, 6) !== '/FILE/') return false;
    var segments = current.split('/');
    if (segments.some(function (segment) { return segment === '.' || segment === '..'; })) return false;
    if (current.indexOf('%') === -1) {
      return /\.(?:mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(current);
    }
    try {
      current = decodeURIComponent(current);
    } catch (_) {
      return false;
    }
  }
  return false;
}

function validVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.indexOf('\\') !== -1 ||
      /[\u0000-\u001f\u007f]/.test(value)) return false;
  var match = value.match(/^http:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.circleftp\.net)(?::80)?(\/[^?#]*)(?:\?[^#]*)?$/i);
  return Boolean(match) && safeCirclePath(match[2]);
}

function containerFromUrl(value) {
  var match = String(value || '').match(/\.([a-z0-9]+)(?:\?[^#]*)?$/i);
  return match ? match[1].toUpperCase() : null;
}

async function getMetadata(identifier, mediaType) {
  var kind = mediaType === 'movie' ? 'movie' : 'tv';
  var requestedId = String(identifier);
  var isImdbId = /^tt\d{7,10}$/.test(requestedId);
  var metadata = await fetchJson(
    TMDB_METADATA_BASE + '/v1/metadata/' + kind + '/' + encodeURIComponent(requestedId)
  );
  var canonicalId = metadata && metadata.id;
  var title = metadata && typeof metadata.title === 'string' ? metadata.title.trim() : '';
  var originalTitle = metadata && typeof metadata.originalTitle === 'string' ? metadata.originalTitle.trim() : title;
  var identityMatches = isImdbId
    ? metadata && metadata.externalId === requestedId
    : canonicalId === Number(requestedId);
  if (!Number.isSafeInteger(canonicalId) || canonicalId < 1 || canonicalId > 2147483647 ||
      !identityMatches || metadata.type !== kind || !title ||
      !Number.isSafeInteger(metadata.year) || metadata.year < 1000 || metadata.year > 9999) {
    throw new Error('Metadata service returned invalid data for ' + identifier);
  }
  return {
    title: title,
    originalTitle: originalTitle || title,
    year: metadata.year
  };
}

async function searchPosts(metadata, mediaType, deadlineAt) {
  var queries = [metadata.title];
  if (normalizedTitle(metadata.originalTitle) !== normalizedTitle(metadata.title)) queries.push(metadata.originalTitle);
  var posts = [];
  var searchWorked = false;
  var lastError = null;
  for (var i = 0; i < queries.length; i += 1) {
    if (Date.now() >= deadlineAt) break;
    try {
      var response = await fetchJson(
        CIRCLE_API + '/posts?searchTerm=' + encodeURIComponent(queries[i]) + '&order=desc'
      );
      searchWorked = true;
      var batch = response && Array.isArray(response.posts) ? response.posts : [];
      posts = posts.concat(batch);
      if (batch.some(function (item) { return wantedPost(item, metadata, mediaType); })) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!searchWorked && lastError) throw lastError;

  var seen = Object.create(null);
  return posts.filter(function (item) {
    var key = item && String(item.id);
    if (!wantedPost(item, metadata, mediaType) || seen[key]) return false;
    seen[key] = true;
    return true;
  }).slice(0, MAX_CANDIDATES);
}

function movieLinks(detail) {
  if (detail.type === 'singleVideo' && typeof detail.content === 'string') {
    return [{ link: detail.content, title: typeof detail.title === 'string' ? detail.title : '' }];
  }
  if (detail.type === 'multiVideo' && Array.isArray(detail.content)) {
    return detail.content.slice(0, MAX_LINKS_PER_POST).filter(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item) &&
        typeof item.link === 'string' && (item.title == null || typeof item.title === 'string');
    });
  }
  return [];
}

function seasonNumber(value) {
  var match = String(value || '').match(/\bseason[\s.:_-]*0*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function episodeNumber(value, expectedSeason) {
  var title = String(value || '');
  var full = title.match(/\bs(?:eason)?[\s.:_-]*0*(\d+)[\s.:_-]*e(?:pisode)?[\s.:_-]*0*(\d+)\b/i);
  if (full) return Number(full[1]) === Number(expectedSeason) ? Number(full[2]) : null;
  var withinSeason = title.match(/\b(?:e|ep|episode)[\s.:_-]*0*(\d+)\b/i);
  return withinSeason ? Number(withinSeason[1]) : null;
}

function episodeLinks(detail, season, episode) {
  if (!Array.isArray(detail.content)) return [];
  var results = [];
  var seasons = detail.content.slice(0, MAX_LINKS_PER_POST);
  for (var i = 0; i < seasons.length && results.length < MAX_LINKS_PER_POST; i += 1) {
    var seasonItem = seasons[i];
    if (!seasonItem || typeof seasonItem !== 'object' || Array.isArray(seasonItem) ||
        typeof seasonItem.seasonName !== 'string' || seasonNumber(seasonItem.seasonName) !== Number(season) ||
        !Array.isArray(seasonItem.episodes)) continue;
    var episodes = seasonItem.episodes.slice(0, MAX_LINKS_PER_POST);
    for (var j = 0; j < episodes.length && results.length < MAX_LINKS_PER_POST; j += 1) {
      var candidate = episodes[j];
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
          typeof candidate.title === 'string' && typeof candidate.link === 'string' &&
          episodeNumber(candidate.title, season) === Number(episode)) results.push(candidate);
    }
  }
  return results;
}

function safeText(value, maximumLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maximumLength);
}

function makeResult(detail, item) {
  var url = item && typeof item.link === 'string' ? item.link :
    (item && typeof item.content === 'string' ? item.content : '');
  if (!validVideoUrl(url)) return null;
  var quality = safeText(detail.quality, 120);
  var itemTitle = safeText(item && item.title, 240);
  var bits = [quality, containerFromUrl(url), itemTitle].filter(function (value) {
    return Boolean(value);
  });
  return {
    title: bits.join(' · ') || 'Direct',
    name: 'CircleFTP',
    url: url,
    quality: quality || null,
    size: null,
    language: null,
    provider: 'CircleFTP',
    type: 'direct'
  };
}

async function loadDetails(candidates, metadata, mediaType, deadlineAt) {
  var details = [];
  for (var i = 0; i < candidates.length; i += 1) {
    if (Date.now() >= deadlineAt) break;
    var candidate = candidates[i];
    try {
      var detail = await fetchJson(CIRCLE_API + '/posts/' + encodeURIComponent(String(candidate.id)));
      if (detail && detail.id === candidate.id && wantedPost(detail, metadata, mediaType)) details.push(detail);
    } catch (_) {}
  }
  return details;
}

async function getStreams(identifier, mediaType, season, episode) {
  try {
    var deadlineAt = Date.now() + MAX_REQUEST_LAUNCH_MS;
    if (mediaType !== 'movie' && mediaType !== 'tv') throw new Error('Invalid media type');
    if (mediaType === 'tv' && (!Number.isSafeInteger(season) || season < 0 ||
        !Number.isSafeInteger(episode) || episode < 1)) {
      throw new Error('Invalid season or episode');
    }
    var requestedId;
    if (typeof identifier === 'number' && Number.isSafeInteger(identifier)) requestedId = String(identifier);
    else if (typeof identifier === 'string') requestedId = identifier;
    else throw new Error('Invalid identifier');
    var isTmdbId = /^[1-9]\d{0,9}$/.test(requestedId) && Number(requestedId) <= 2147483647;
    var isImdbId = /^tt\d{7,10}$/.test(requestedId);
    if (!isTmdbId && !isImdbId) throw new Error('Invalid identifier');
    var metadata = await getMetadata(requestedId, mediaType);
    if (Date.now() >= deadlineAt) throw new Error('CircleFTP request budget exhausted after metadata');
    var candidates = await searchPosts(metadata, mediaType, deadlineAt);
    if (!candidates.length) return [];
    if (Date.now() >= deadlineAt) return [];
    var details = await loadDetails(candidates, metadata, mediaType, deadlineAt);
    var results = [];
    var seenUrls = Object.create(null);
    for (var i = 0; i < details.length && results.length < MAX_LINKS_PER_POST; i += 1) {
      var detail = details[i];
      if (!detail) continue;
      var links = mediaType === 'movie' ? movieLinks(detail) : episodeLinks(detail, season, episode);
      for (var j = 0; j < links.length && results.length < MAX_LINKS_PER_POST; j += 1) {
        var item = links[j];
        var result = makeResult(detail, item);
        if (result && !seenUrls[result.url]) {
          seenUrls[result.url] = true;
          results.push(result);
        }
      }
    }
    return results;
  } catch (error) {
    var message = error && error.message ? error.message : String(error);
    console.error('CircleFTP scraper:', message);
    return [{
      title: 'CircleFTP diagnostic: ' + message,
      name: 'CircleFTP error: ' + message,
      url: 'http://new.circleftp.net/',
      size: message,
      provider: 'CircleFTP',
      type: 'direct'
    }];
  }
}

if (typeof module !== 'undefined') module.exports = { getStreams: getStreams };
if (typeof globalThis !== 'undefined') globalThis.getStreams = getStreams;
