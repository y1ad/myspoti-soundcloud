// SoundCloud for Myspoti / Orpheon.
// 1) An audio source: for each song the app wants to play, it looks the song up on SoundCloud
//    (title, artist, length, ISRC when SoundCloud has it) and returns the full, free stream of the
//    best close match. Previews and paid-only tracks (policy SNIP / BLOCK) are never used. No match:
//    null, so the next source in the user's order is asked.
// 2) Its own page (experimental): a SoundCloud search with its own player, for what only exists on
//    SoundCloud. The extension API only opens songs of the app's catalogs, so this plays inside the
//    page, and only while the page is open.
// SoundCloud has no open API for new apps: this uses its public web API with a "client_id" that
// is looked up from the site's own scripts (or typed in the settings). It can break when they change.
var API = 'https://api-v2.soundcloud.com';
var HOME = 'https://soundcloud.com';
var CID_TTL_MS = 3 * 24 * 3600 * 1000;
var PAGE_SIZE = 20;
var TOLERANCE = { Strict: 4000, Normal: 8000, Loose: 20000 };
var RECALL = { Strict: 1, Normal: 0.85, Loose: 0.7 };
// Versions that are not the song asked for, unless its own title says so.
var VERSION_WORDS = ['remix', 'cover', 'live', 'karaoke', 'nightcore', 'sped up', 'slowed', 'reverb',
  'instrumental', '8d', 'mashup', 'bootleg', 'acoustic', 'tribute', 'type beat'];

var TEXT = {
  en: {
    reset: 'SoundCloud client ID cleared: it will be looked up again.',
    noid: 'Could not get a SoundCloud client ID.',
    page: {
      title: 'SoundCloud',
      exp: 'Experimental: the audio plays only while this page is open.',
      placeholder: 'Search SoundCloud',
      search: 'Search',
      more: 'More',
      loading: 'Loading...',
      wait: 'Setting things up, one moment...',
      ready: 'Ready.',
      noid: 'Could not get a SoundCloud client ID.',
      empty: 'No full, free tracks found.',
      error: 'Something went wrong',
      fail: 'Could not open that track.',
      noplay: 'This phone could not play the audio in this page.',
      nobridge: 'This page must be opened from the extension.'
    }
  },
  es: {
    reset: 'Client ID de SoundCloud borrado: se buscará de nuevo.',
    noid: 'No se pudo obtener un client ID de SoundCloud.',
    page: {
      title: 'SoundCloud',
      exp: 'Experimental: el audio suena solo mientras esta página está abierta.',
      placeholder: 'Buscar en SoundCloud',
      search: 'Buscar',
      more: 'Más',
      loading: 'Cargando...',
      wait: 'Preparando todo, un momento...',
      ready: 'Listo.',
      noid: 'No se pudo obtener un client ID de SoundCloud.',
      empty: 'No hay pistas completas y gratis.',
      error: 'Algo salió mal',
      fail: 'No se pudo abrir esa pista.',
      noplay: 'El cel no pudo reproducir el audio en esta página.',
      nobridge: 'Esta página se abre desde la extensión.'
    }
  }
};
function lang() {
  return String(myspoti.locale || 'en').split('-')[0] === 'es' ? 'es' : 'en';
}
function tr(key) { return TEXT[lang()][key]; }

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

function typedId() {
  return String(myspoti.settings.get('client_id') || '').replace(/\s+/g, '');
}

function clientId(force) {
  var manual = typedId();
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

// The client ID already known, never looked up (the page's hooks have 3 s).
function cachedId() {
  return typedId() || myspoti.storage.get('cid') || null;
}

function forgetId() {
  myspoti.storage.remove('cid');
  myspoti.storage.remove('cidAt');
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

// The progressive MP3 transcoding of an upload (the only one a plain audio element plays), or null.
function progressive(c) {
  var t = (c.media && c.media.transcodings) || [];
  for (var i = 0; i < t.length; i++) {
    var f = t[i].format || {};
    if (f.protocol === 'progressive' && /mpeg|mp3/i.test(String(f.mime_type || '') + ' ' + String(t[i].preset || ''))) return t[i];
  }
  return null;
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
  var p = progressive(c);
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

// ── Its own page ──

// What the page asks (its message hook has 3 s: only requests already known, never a look-up).
function pageSearch(q, offset) {
  q = q.replace(/\s+/g, ' ').trim();
  if (!q) return { type: 'results', items: [], more: false };
  var cid = cachedId();
  if (!cid) { myspoti.work.whenOnline(); return { type: 'wait' }; }
  var r = req(API + '/search/tracks?' + myspoti.query({
    q: q, client_id: cid, limit: PAGE_SIZE, offset: offset, linked_partitioning: 1
  }), 2500);
  if (r.error) return { type: 'error', code: 'network' };
  if (r.status === 401 || r.status === 403) { forgetId(); myspoti.work.whenOnline(); return { type: 'wait' }; }
  if (!r.ok) return { type: 'error', code: 'http ' + r.status };
  var data;
  try { data = r.json(); } catch (e) { return { type: 'error', code: 'answer' }; }
  var items = [];
  ((data && data.collection) || []).forEach(function (c) {
    if (!c || c.streamable === false) return;
    if (c.policy && c.policy !== 'ALLOW' && c.policy !== 'MONETIZE') return;
    var t = progressive(c);
    if (!t || !t.url) return;
    items.push({
      id: c.id,
      title: String(c.title || ''),
      user: String((c.user && c.user.username) || ''),
      dur: c.duration || 0,
      art: String(c.artwork_url || (c.user && c.user.avatar_url) || '').replace('-large.', '-t200x200.'),
      t: t.url,
      auth: c.track_authorization || ''
    });
  });
  return { type: 'results', items: items, more: !!(data && data.next_href) };
}

function pageStream(t, auth) {
  if (t.indexOf('https://api-v2.soundcloud.com/media/') !== 0) return { type: 'error', code: 'bad' };
  var cid = cachedId();
  if (!cid) { myspoti.work.whenOnline(); return { type: 'wait' }; }
  var s = req(t + (t.indexOf('?') >= 0 ? '&' : '?') + myspoti.query({ client_id: cid, track_authorization: auth }), 2500);
  if (s.error) return { type: 'error', code: 'network' };
  if (s.status === 401 || s.status === 403) { forgetId(); myspoti.work.whenOnline(); return { type: 'wait' }; }
  if (!s.ok) return { type: 'error', code: 'http ' + s.status };
  var u = null;
  try { u = s.json().url; } catch (e) {}
  return u ? { type: 'stream', url: u } : { type: 'error', code: 'nourl' };
}

myspoti.provide('message', function (m) {
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { return null; } }
  if (!m || !m.type) return null;
  var out = null;
  var type = String(m.type);
  if (type === 'init') {
    var has = !!cachedId();
    if (!has) myspoti.work.whenOnline();
    out = { type: 'init', ok: has };
  } else if (type === 'search') {
    out = pageSearch(String(m.q || ''), Number(m.offset) || 0);
  } else if (type === 'stream') {
    out = pageStream(String(m.t || ''), String(m.auth || ''));
  }
  if (out) out.rid = m.rid;
  return out;
});

// The client ID is looked up here (30 s), when the page asked for it and the phone has a network.
myspoti.on('online', function () {
  var cid = null;
  try { cid = clientId(true); } catch (e) {}
  try { myspoti.page.post({ type: 'ready', ok: !!cid }); } catch (e) {}
});

function pageHtml() {
  var S = TEXT[lang()].page;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>',
    'body{margin:0;background:#0b0b0f;color:#fff;font:15px system-ui,sans-serif}',
    '#top{position:sticky;top:0;background:#0b0b0f;padding:14px 16px 10px;border-bottom:1px solid #26262e;z-index:2}',
    'h1{font-size:22px;margin:0 0 4px}',
    '#exp{color:#8c8c9a;font-size:12px;margin:0 0 10px}',
    '#row{display:flex;gap:8px}',
    '#q{flex:1;min-width:0;padding:10px 14px;border-radius:20px;border:1px solid #33333d;background:#16161c;color:#fff;font-size:15px}',
    'button{background:#ff5500;color:#fff;border:0;border-radius:20px;padding:10px 16px;font-size:15px;font-weight:600}',
    '#now{margin-top:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    'audio{width:100%;margin-top:6px}',
    '#st{color:#b8b8c4;padding:10px 16px;min-height:18px}',
    '.it{display:flex;gap:12px;align-items:center;padding:10px 16px}',
    '.it.on{background:#1b1b22}',
    '.it img{width:52px;height:52px;border-radius:6px;background:#26262e;object-fit:cover}',
    '.it .t{flex:1;min-width:0}.it .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.it .s{color:#8c8c9a;font-size:13px}',
    '#more{display:block;margin:12px auto 24px;background:#26262e}',
    '</style></head><body>',
    '<div id="top"><h1 id="h"></h1><p id="exp"></p><div id="row"><input id="q"><button id="go"></button></div>',
    '<div id="now"></div><audio id="a" controls></audio></div>',
    '<div id="st"></div><div id="list"></div><button id="more" style="display:none"></button>',
    '<script>(function(){',
    'var S=' + JSON.stringify(S) + ';',
    'var $=function(i){return document.getElementById(i);};',
    'var items=[],idx=-1,q="",offset=0,rid=0,pending={},lastSearch=null,retried=false;',
    '$("h").textContent=S.title;$("exp").textContent=S.exp;$("q").placeholder=S.placeholder;$("go").textContent=S.search;$("more").textContent=S.more;',
    'function status(t){$("st").textContent=t||"";}',
    'function send(msg,cb){if(typeof MyspotiPage==="undefined"){status(S.nobridge);return;}rid++;msg.rid=rid;pending[rid]=cb;MyspotiPage.postMessage(JSON.stringify(msg));}',
    'function fmt(ms){var s=Math.round(ms/1000);return Math.floor(s/60)+":"+("0"+(s%60)).slice(-2);}',
    'function render(){var l=$("list");l.innerHTML="";items.forEach(function(it,i){var d=document.createElement("div");d.className="it"+(i===idx?" on":"");var im=document.createElement("img");if(it.art)im.src=it.art;var t=document.createElement("div");t.className="t";var n=document.createElement("div");n.className="n";n.textContent=it.title;var s=document.createElement("div");s.className="s";s.textContent=it.user+" · "+fmt(it.dur);t.appendChild(n);t.appendChild(s);d.appendChild(im);d.appendChild(t);d.onclick=function(){play(i);};l.appendChild(d);});}',
    'function doSearch(query,off,keep){q=query;offset=off;lastSearch={q:query,o:off,k:keep};status(S.loading);send({type:"search",q:query,offset:off},function(r){',
    'if(r.type==="wait"){status(S.wait);return;}',
    'if(r.type==="results"){if(keep){items=items.concat(r.items);}else{items=r.items;idx=-1;}render();status(items.length?"":S.empty);$("more").style.display=r.more?"block":"none";return;}',
    'status(S.error+" ("+(r.code||"?")+")");});}',
    '$("go").onclick=function(){var v=$("q").value.trim();if(v){retried=false;doSearch(v,0,false);}};',
    '$("q").onkeydown=function(e){if(e.key==="Enter")$("go").onclick();};',
    '$("more").onclick=function(){doSearch(q,offset+' + PAGE_SIZE + ',true);};',
    'function play(i){idx=i;var it=items[i];render();$("now").textContent=it.title+" — "+it.user;status(S.loading);send({type:"stream",t:it.t,auth:it.auth},function(r){',
    'if(r.type==="wait"){status(S.wait);return;}',
    'if(r.type==="stream"&&r.url){status("");var a=$("a");a.src=r.url;var p=a.play();if(p&&p.catch)p.catch(function(){status(S.noplay);});return;}',
    'status(S.fail);});}',
    '$("a").onended=function(){if(idx+1<items.length)play(idx+1);};',
    '$("a").onerror=function(){var c=$("a").error?$("a").error.code:0;status(S.noplay+" ("+c+")");};',
    'window.addEventListener("message",function(e){var m=e.data;if(typeof m==="string"){try{m=JSON.parse(m);}catch(x){return;}}if(!m)return;',
    'if(m.type==="ready"){status(m.ok?S.ready:S.noid);if(m.ok&&lastSearch&&!retried){retried=true;doSearch(lastSearch.q,lastSearch.o,lastSearch.k);}return;}',
    'var cb=m.rid&&pending[m.rid];if(cb){delete pending[m.rid];cb(m);}});',
    'send({type:"init"},function(r){if(!r.ok)status(S.wait);});',
    '})();</script></body></html>'
  ].join('\n');
}

myspoti.provide('page', function () { return { title: TEXT[lang()].page.title, html: pageHtml() }; });

myspoti.on('setting', function (e) {
  if (e.key === 'reset' && e.pressed) {
    forgetId();
    myspoti.notify(tr('reset'));
  }
});
