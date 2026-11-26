// SoundCloud as an audio source for Myspoti / Orpheon.
// For each song the app wants to play, it looks the song up on SoundCloud (title, artist, length,
// ISRC when SoundCloud has it) and returns the full, free stream of the best close match. Previews
// and paid-only tracks (policy SNIP / BLOCK) are never used. No match: null, so the next source in
// the user's order is asked.
// SoundCloud has no open API for new apps: this uses its public web API with a "client_id" that
// is looked up from the site's own scripts (or typed in the settings). It can break when they change.
var API = 'https://api-v2.soundcloud.com';
var HOME = 'https://soundcloud.com';
var CID_TTL_MS = 3 * 24 * 3600 * 1000;
var TOLERANCE = { Strict: 4000, Normal: 8000, Loose: 20000 };
var RECALL = { Strict: 1, Normal: 0.85, Loose: 0.7 };
// Versions that are not the song asked for, unless its own title says so.
var VERSION_WORDS = ['remix', 'cover', 'live', 'karaoke', 'nightcore', 'sped up', 'slowed', 'reverb',
  'instrumental', '8d', 'mashup', 'bootleg', 'acoustic', 'tribute', 'type beat'];

var TEXT = {
  en: { reset: 'SoundCloud client ID cleared: it will be looked up again.', noid: 'Could not get a SoundCloud client ID.' },
  es: { reset: 'Client ID de SoundCloud borrado: se buscará de nuevo.', noid: 'No se pudo obtener un client ID de SoundCloud.' }
};
function tr(key) {
  var l = String(myspoti.locale || 'en').split('-')[0];
  return (TEXT[l] || TEXT.en)[key];
}

function hasFeature(name) {
  return !!(myspoti.features && myspoti.features.indexOf(name) >= 0);
}

// Why there is nothing, when this Myspoti understands outcomes; plain null otherwise.
function none(outcome, extra) {
  if (!hasFeature('results')) return null;
  var r = { outcome: outcome };
  if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
  return r;
}

function req(url, timeout) {
  try {
    return myspoti.http.get(url, { timeout: timeout || 8000 });
  } catch (e) {
    return { ok: false, status: 0, error: String(e), body: '' };
  }
}

// The bodies of [urls], 4 at a time when this Myspoti can ('' for one that failed).
function fetchBodies(urls) {
  if (hasFeature('http.all') && urls.length > 1) {
    try {
      var rs = myspoti.http.all(urls.map(function (u) { return { url: u, timeout: 8000 }; }));
      return rs.map(function (r) { return r.error || !r.ok ? '' : String(r.body || ''); });
    } catch (e) { /* falls back below */ }
  }
  return urls.map(function (u) { var r = req(u, 8000); return r.ok ? String(r.body || '') : ''; });
}

// ── The client ID ──

// Reads it from the scripts SoundCloud's own home page loads (its last ones hold it).
function discover() {
  var home = req(HOME, 8000);
  if (!home.ok) return null;
  var urls = [];
  var re = /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
  var m;
  while ((m = re.exec(String(home.body))) !== null) urls.push(m[1]);
  urls.reverse();
  var idRe = /client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/;
  for (var i = 0; i < urls.length && i < 8; i += 4) {
    var bodies = fetchBodies(urls.slice(i, i + 4));
    for (var k = 0; k < bodies.length; k++) {
      var f = idRe.exec(bodies[k]);
      if (f) return f[1];
    }
  }
  return null;
}

function clientId(force) {
  var manual = String(myspoti.settings.get('client_id') || '').replace(/\s+/g, '');
  if (manual) return manual;
  var saved = myspoti.storage.get('cid');
  var at = Number(myspoti.storage.get('cidAt') || 0);
  if (!force && saved && Date.now() - at < CID_TTL_MS) return saved;
  var found = discover();
  if (found) {
    myspoti.storage.set('cid', found);
    myspoti.storage.set('cidAt', Date.now());
    return found;
  }
  return force ? null : (saved || null);
}

// ── Matching a song to an upload ──

function plain(s) {
  s = String(s || '').toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
  return ' ' + s.replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

// A title without its (brackets) and its "feat." tail.
function core(s) {
  s = String(s || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  s = s.replace(/\b(feat|ft|featuring)\b\.?.*$/i, ' ');
  return plain(s);
}

function tokens(p) { return p.trim().split(' ').filter(function (t) { return t.length > 0; }); }

// The share of the wanted title's words that the upload's title has.
function recall(wantedCore, candPlain) {
  var ts = tokens(wantedCore);
  if (!ts.length) return 0;
  var hit = 0;
  ts.forEach(function (t) { if (candPlain.indexOf(' ' + t + ' ') >= 0) hit++; });
  return hit / ts.length;
}

// How many version words the upload has that the wanted song's title does not.
function penalty(wantedPlain, candPlain) {
  var n = 0;
  VERSION_WORDS.forEach(function (w) {
    var p = ' ' + w + ' ';
    if (candPlain.indexOf(p) >= 0 && wantedPlain.indexOf(p) < 0) n++;
  });
  return n;
}

function artistNames(track) {
  var list = [track.artist];
  (track.artists || []).forEach(function (a) { list.push(typeof a === 'string' ? a : (a && a.name) || ''); });
  var seen = {};
  var out = [];
  list.forEach(function (a) {
    var p = plain(a).trim();
    if (p.length >= 2 && !seen[p]) { seen[p] = 1; out.push(p); }
  });
  return out;
}

// An artist of the song is in the upload's title, its uploader's name or its publisher metadata.
function artistOk(names, c) {
  var hay = plain(c.title) + plain(c.user && c.user.username) + plain(c.publisher_metadata && c.publisher_metadata.artist);
  return names.some(function (n) { return hay.indexOf(' ' + n + ' ') >= 0; });
}

function mode() {
  var v = String(myspoti.settings.get('match') || 'Normal');
  return TOLERANCE[v] ? v : 'Normal';
}

// The best upload for [track] among [list], or null.
function pick(track, list) {
  var m = mode();
  var tol = TOLERANCE[m];
  var need = RECALL[m];
  var wantedCore = core(track.title);
  var wantedPlain = plain(track.title);
  var names = artistNames(track);
  var isrc = String(track.isrc || '').toUpperCase();
  var best = null;
  list.forEach(function (c) {
    if (!c || c.streamable === false) return;
    if (c.policy && c.policy !== 'ALLOW' && c.policy !== 'MONETIZE') return;   // not previews, not paid-only
    if (!c.media || !c.media.transcodings || !c.media.transcodings.length) return;
    var diff = track.durationMs > 0 && c.duration > 0 ? Math.abs(c.duration - track.durationMs) : 0;
    var cisrc = String((c.publisher_metadata && c.publisher_metadata.isrc) || '').toUpperCase();
    var byIsrc = isrc.length > 0 && cisrc === isrc;
    var candPlain = plain(c.title);
    var rec = recall(wantedCore, candPlain);
    var pen = penalty(wantedPlain, candPlain);
    var art = artistOk(names, c);
    var ok;
    if (byIsrc) ok = diff <= tol * 2;
    else ok = rec >= need && diff <= tol && pen === 0 && (art || (m === 'Loose' && diff <= 3000));
    if (!ok) return;
    var score = (byIsrc ? 100 : 0) + rec * 40 + (art ? 30 : 0) + (1 - Math.min(diff / tol, 1)) * 20 - pen * 40;
    if (!best || score > best.score) best = { c: c, score: score };
  });
  return best ? best.c : null;
}

// The stream to ask for: a plain MP3 when there is one, else HLS.
function chooseTranscoding(c) {
  var t = (c.media && c.media.transcodings) || [];
  function find(protocol, re) {
    for (var i = 0; i < t.length; i++) {
      var f = t[i].format || {};
      if (f.protocol === protocol && re.test(String(f.mime_type || '') + ' ' + String(t[i].preset || ''))) return t[i];
    }
    return null;
  }
  var p = find('progressive', /mpeg|mp3/i);
  if (p) return { t: p, mime: 'audio/mpeg', label: 'SoundCloud · MP3' };
  var a = find('hls', /mp4a|aac/i);
  if (a) return { t: a, mime: 'application/x-mpegURL', label: 'SoundCloud · AAC (HLS)' };
  var h = find('hls', /mpeg|mp3/i);
  if (h) return { t: h, mime: 'application/x-mpegURL', label: 'SoundCloud · MP3 (HLS)' };
  return null;
}

// One try with [cid]: the answer, or { retry: true } when SoundCloud refused the client ID.
function attempt(track, cid) {
  var q = ((artistNames(track)[0] || '') + ' ' + core(track.title)).replace(/\s+/g, ' ').trim();
  if (!q) return none('not-found');
  var r = req(API + '/search/tracks?' + myspoti.query({
    q: q, client_id: cid, limit: 20, offset: 0, linked_partitioning: 1
  }), 8000);
  if (r.error) return none('network', { detail: 'SoundCloud did not answer' });
  if (r.status === 401 || r.status === 403) return { retry: true };
  if (r.status === 429) return none('rate-limited', { retryAfterMs: 60000 });
  if (r.status >= 500) return none('server-down', { retryAfterMs: 120000 });
  if (!r.ok) return none('not-found');
  var data;
  try { data = r.json(); } catch (e) { return none('error', { detail: 'Unexpected answer from SoundCloud' }); }
  var c = pick(track, (data && data.collection) || []);
  if (!c) return none('not-found');
  var ch = chooseTranscoding(c);
  if (!ch || !ch.t.url) return none('not-found');

  var url = ch.t.url + (ch.t.url.indexOf('?') >= 0 ? '&' : '?') +
    myspoti.query({ client_id: cid, track_authorization: c.track_authorization });
  var s = req(url, 8000);
  if (s.error) return none('network', { detail: 'SoundCloud did not answer' });
  if (s.status === 401 || s.status === 403) return { retry: true };
  if (s.status === 429) return none('rate-limited', { retryAfterMs: 60000 });
  if (!s.ok) return none('not-found');
  var u = null;
  try { u = s.json().url; } catch (e) {}
  if (!u) return none('not-found');
  return { url: u, mimeType: ch.mime, durationMs: c.duration, expiresInMs: 240000, source: ch.label };
}

myspoti.provide('audio-source', function (track) {
  var cid = clientId(false);
  if (!cid) return none('error', { detail: tr('noid') });
  var out = attempt(track, cid);
  if (out && out.retry) {
    // The saved client ID went stale: look it up again once (a typed one is the user's to fix).
    cid = clientId(true);
    if (!cid) return none('error', { detail: tr('noid') });
    out = attempt(track, cid);
  }
  if (out && out.retry) return none('error', { detail: 'SoundCloud refused the client ID' });
  return out;
});

myspoti.on('setting', function (e) {
  if (e.key === 'reset' && e.pressed) {
    myspoti.storage.remove('cid');
    myspoti.storage.remove('cidAt');
    myspoti.notify(tr('reset'));
  }
});
