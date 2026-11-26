# SoundCloud (Myspoti / Orpheon extension)

Two things in one extension.

**1. SoundCloud as an audio source.** For each song the app plays, it looks the song up on
SoundCloud (title, artist, length, and the ISRC when SoundCloud has it) and streams the full, free
version of the best close match. When it finds none, the next source in your audio order is asked.

**2. Its own page (experimental)** for what only exists on SoundCloud (the extension API only opens
songs of the app's catalogs, so those cannot show up in the app's own search). Open it from
Extensions > SoundCloud > Open its page: search, tap a track, it plays in an audio element inside the
page, and goes on to the next one in the list.

- It plays **only while the page is open**: leave it and the sound stops. It depends on the phone's
  WebView letting the page play audio from SoundCloud's servers; if it does not, the page says so.
- First use: it looks up the client ID by itself (a moment). Results show only full, free tracks that
  have a plain MP3 stream.

Common rules: never previews or paid-only tracks (SoundCloud's `SNIP` and `BLOCK` policies); the audio
source skips remixes, covers, live, karaoke, sped up / slowed and similar uploads unless the song's own
title says so. Settings: how strict the match is (Strict / Normal / Loose), an optional client ID, and a
button to look it up again.

SoundCloud has no open API for new apps. The extension uses its public web API with a `client_id`
looked up from the site's own scripts (or the one you type in the settings). It can stop working when
SoundCloud changes its site, and using it may go against SoundCloud's terms: use it at your own risk.

Install: in Myspoti, Extensions > Store (topic `myspoti-extension`), or paste this repository's address
in "Install from an address". Then Settings > Playback: put SoundCloud where you want it in the audio order.

Actions it asks: `audio.source`, `network` (`*.soundcloud.com`, `*.sndcdn.com`), `webview.page`,
`storage`, `notify`, `settings.page`.
