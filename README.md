# SoundCloud (Myspoti / Orpheon extension)

Uses **SoundCloud as the audio source**: for each song the app plays, it looks the song up on
SoundCloud (title, artist, length, and the ISRC when SoundCloud has it) and streams the full, free
version of the best close match. When it finds none, the next source in your audio order is asked.

- It does **not browse SoundCloud**: the extension API only opens songs of the app's catalogs
  (Deezer, iTunes, ...), so you search and play as usual and SoundCloud supplies the sound.
  Tracks that exist only on SoundCloud (a catalog does not list them) cannot be reached this way.
- Never uses previews or paid-only tracks (SoundCloud's `SNIP` and `BLOCK` policies).
- Skips remixes, covers, live, karaoke, sped up / slowed and similar uploads unless the song's own
  title says so.
- Settings: how strict the match is (Strict / Normal / Loose), an optional client ID, and a button to
  look the client ID up again.

SoundCloud has no open API for new apps. The extension uses its public web API with a `client_id`
looked up from the site's own scripts (or the one you type in the settings). It can stop working when
SoundCloud changes its site, and using it may go against SoundCloud's terms: use it at your own risk.

Install: in Myspoti, Extensions > Store (topic `myspoti-extension`), or paste this repository's address
in "Install from an address". Then Settings > Playback: put SoundCloud where you want it in the audio order.

Actions it asks: `audio.source`, `network` (`*.soundcloud.com`, `*.sndcdn.com`), `storage`, `notify`,
`settings.page`.
