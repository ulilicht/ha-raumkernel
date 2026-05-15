## 1.2.108

- Fix (stopping TischlerEi also stops Kueche when they share a zone):
  Once a room joins another room's zone via `connectRoomToZone`, calling `stop()` on
  the joining room resolved to the shared zone renderer and stopped the entire zone,
  silencing all rooms in it.

  Fix: `stop()` now checks whether the room belongs to a multi-room zone
  (`getRoomCountForZoneUDN > 1`).  If so, it calls `zoneManager.dropRoomFromZone()`
  instead of `renderer.stop()` — this ejects just the stopped room from the zone
  while the other room(s) continue playing.  Falls back to zone stop on error.

- Note: the `ECONNREFUSED` / `UNSUBSCRIBE_ALL` errors seen during zone-join startup
  are harmless: they occur when the old standalone zone port is closed by the kernel
  immediately after the room is moved into the shared zone.  The subscription was
  already torn down on the kernel side; the error is a cleanup artifact only.

## 1.2.107

- Fix (zone-join missing from `play()` STOPPED→native path):
  When a room was in STOPPED state with a `dlna-playsingle://` URI already loaded
  (e.g. after a stream drop or HA restart), pressing Play in HA called `play()` which
  took the `STOPPED→native` branch and called `renderer.play()` directly — bypassing
  the zone-join logic entirely.  Both rooms then ran independent TuneIn sessions for
  the same station, which is what the zone-join fix was meant to prevent.

  Fix: the `STOPPED→native` branch in `play()` now performs the same zone-join check
  as `loadSingle()`: if another room is already PLAYING the same station (matched via
  `room._lastStationId`, which is now set from running kernel metadata), the room joins
  the existing zone via `zoneManager.connectRoomToZone()` instead of calling
  `renderer.play()`.  Falls back to native `Play()` on any error.

## 1.2.106

- Fix (zone-join never triggered because stationId lookup relied solely on stale browse cache):
  `loadSingle()` determined the TuneIn station ID via `_getItemRefIdFromCache()`, which returns
  null when the item was added to favourites after the last fresh browse (e.g. favourite removed
  and re-added, getting a new numeric ID).  With `stationId = null` the zone-join block was
  silently skipped and each room started an independent TuneIn session.

  Fix 1 – `_extractNowPlaying`: when a live-stream is detected, extract the station ID directly
  from the raw `refID` attribute in the kernel's live metadata (e.g. `refID="0/RadioTime/Search/s-s8007"`)
  and store it on `room._lastStationId`.  This is independent of the browse cache and runs on
  every subscription update while the station is playing.

  Fix 2 – `loadSingle()` stationId fallback: if the browse-cache lookup returns null, scan other
  rooms for one that (a) previously loaded the same `itemId` and (b) has a known `_lastStationId`
  from running metadata.  This lets TischlerEi correctly identify that it wants to join Kueche's
  s8007 zone even when the item ID is not in the local browse cache.

  Fix 3 – `_lastStationId` is now reset to `undefined` alongside `_isLiveStream` when a new
  media source URI is detected (prevents stale station IDs from matching the wrong zones).

- Fix ("already active but none was playing" error when starting a station that is already loaded
  but STOPPED):
  When the kernel already has `dlna-playsingle://…?iid=<itemId>` as its `AVTransportURI` and the
  room is in STOPPED state, calling `SetAVTransportURI` with the identical URI causes the kernel
  to respond "already active".  `loadSingle()` now detects this case and calls `renderer.play()`
  directly instead, which is the correct command to restart a loaded-but-stopped stream.

- Fix (dedup guard prevents restart after stream drop):
  The 60-second duplicate-loadSingle guard was firing when a user tried to reload a station
  whose stream had just dropped (room in STOPPED state), silently ignoring the request and leaving
  HA showing the entity as active while nothing was playing.  The guard now only applies when the
  room is in PLAYING or TRANSITIONING state; STOPPED rooms can always reload immediately.

## 1.2.105

- Fix (multi-room TuneIn rate limit causes ~10 min drops when several rooms play same station):
  Each room was creating its own independent TuneIn session via `loadSingle`.  With
  N rooms all calling ebrowse every 120 s on the same serial, the TuneIn API is
  throttled (15–25+ calls/5 min) and the ebrowse renewal fails → stream drops.

  The native Raumfeld app avoids this by using zone grouping — all rooms playing
  the same station share ONE zone with ONE TuneIn session.

  Fix: `loadSingle()` now checks if any other room is already PLAYING the same
  station (identified via the browse-cache `refID` → TuneIn station ID).  If a
  match is found, the room joins the existing zone via
  `zoneManager.connectRoomToZone(roomUdn, targetZoneUdn)` instead of creating a
  new independent TuneIn session.  This mirrors exactly how the native app handles
  multi-room playback.
  - Station matching uses the TuneIn station ID (e.g. `s8007`) extracted from the
    browse-cache `refID` so that `0/Favorites/RecentlyPlayed/62620` and
    `0/Favorites/MyFavorites/62621` are correctly recognised as the same station.
  - `room._lastStationId` is now tracked alongside `room._lastItemId`.
  - Zone join errors fall through to native `loadSingle` as a safe fallback.

## 1.2.104

- Fix (stream drops at 40–143 s, getting shorter with each restart):
  All `play()` paths were calling `SetAVTransportURI` with stripped/corrupted DIDL
  metadata (no `raumfeld:ebrowse`, no `raumfeld:section`).  Each successive run read
  back that degraded kernel state as its input, making it worse.  The Raumfeld kernel
  auto-retried the raw CDN connection but without valid TuneIn credentials each reconnect
  lasted shorter than the last (40 s → 15 s → …).

  Root cause: our code used `renderer.rendererState.AVTransportURIMetaData` as the
  metadata source, but that state was already stripped by previous integration runs.
  We were iteratively corrupting the kernel's own state.

  Fix: **stop using `SetAVTransportURI` with CDN URLs in `play()` entirely.**
  - `dlna-playsingle://` state → bare `renderer.play()` (kernel manages TuneIn natively)
  - CDN-URL state (corrupted from a previous run) → `renderer.loadSingle(itemId)`,
    deriving the ContentDirectory item ID from the corrupted metadata (`ext/X` → `0/X`).
    This restores the kernel to `dlna-playsingle://` mode with a full fresh TuneIn
    session (ebrowse + section + durability) so it can play indefinitely.
  - ECONNRESET retry now uses `renderer.loadSingle(itemId)` instead of
    `SetAVTransportURI` with stale metadata.
  - `loadSingle()` CDN shortcut guarded by `hasEbrowse` check: only bypasses
    session-dispatch when the cached metadata still contains `raumfeld:ebrowse`;
    falls through to native `loadSingle` when metadata is corrupted.
  - `room._lastItemId` now tracked so `play()` can reload the correct station
    even after multiple stop/start cycles.

## 1.2.103

- Fix (ebrowse stripped from CDN metadata causes ~143 s stream drop):
  `_stripTuneInMarkers` was removing `raumfeld:ebrowse` from the DIDL metadata.
  The CDN server (e.g. orf-live.ors-shoutcast.at) closes TCP connections every
  ~120–143 s and expects the client to reconnect.  The Raumfeld kernel uses the
  ebrowse URL to obtain a fresh CDN session token on reconnect.  Without ebrowse
  the kernel cannot renew the session when the TCP connection closes, so the stream
  drops at exactly that ~143 s boundary.  This explained why v1.2.102 still dropped
  at 143 s despite the section=RadioTime preservation fix.

  The native Raumfeld app plays indefinitely because it always provides full TuneIn
  metadata (ebrowse + section) to the kernel, allowing transparent CDN reconnection.

  Fix: keep `raumfeld:ebrowse` in the DIDL sent to SetAVTransportURI.  Instead:
    - Zero `raumfeld:durability` (force an immediate ebrowse refresh on connect)
    - Remove `<res>` elements whose URL contains `Tune.ashx?id=` (session-dispatch
      URLs that are throttled); the kernel will use the cheaper ebrowse path instead
    - Keep id/parentID neutralisation (0/ → ext/) and refID stripping to block
      ContentDirectory lookups that would re-expose session-dispatch res URLs

  Summary of what _stripTuneInMarkers now keeps vs strips:
    KEPT:   raumfeld:ebrowse            (CDN session renewal — CRITICAL)
            raumfeld:section=RadioTime  (live-radio kernel mode)
            dc:title, upnp:albumArtURI, upnp:class, raumfeld:name
    ZEROED: raumfeld:durability 0       (force immediate ebrowse refresh)
    REMOVED: <res Tune.ashx?id=…>       (session-dispatch, throttled)
             refID attribute            (blocks ContentDirectory walk-back)
    CHANGED: id/parentID prefix 0/ → ext/  (blocks ContentDirectory lookup)

## 1.2.102

- Fix (stripped raumfeld:section=RadioTime causes kernel ~143 s reconnect drop):
  `_stripTuneInMarkers` removed `raumfeld:section=RadioTime` from the DIDL metadata.
  Without this field the Raumfeld kernel no longer recognises the stream as a live
  radio broadcast — it treats it as a regular media file instead.  In regular-file
  mode the kernel exposes `CurrentTransportActions = Pause,Stop,Seek,…` (instead of
  the live-radio `Stop`-only set) and applies an internal reconnect / end-of-track
  timer at approximately 120–150 s.  When that timer fires the kernel drops the
  stream, resulting in the new 143 s drops observed in v1.2.101.

  Fix: keep `raumfeld:section=RadioTime` in the stripped metadata — it is required
  so the kernel treats the stream as an infinite live broadcast (no pause, no seek,
  no reconnect timer).  Without an ebrowse URL or a valid ContentDirectory refID the
  kernel has no path to call TuneIn, so the no-TuneIn goal is preserved.

  To additionally block ContentDirectory lookup by item id (which could recover the
  ebrowse URL from the item hierarchy), change the id / parentID prefix from "0/" to
  "ext/" — a prefix that does not exist in the kernel's ContentDirectory.  Per-item
  uniqueness is preserved (no cross-room coupling).

  Summary of what _stripTuneInMarkers now keeps vs strips:
    KEPT:   raumfeld:section=RadioTime  (live-radio kernel mode)
            dc:title, upnp:albumArtURI, upnp:class, raumfeld:name  (display)
            item id uniqueness (ext/ prefix)
    STRIPPED: raumfeld:ebrowse, raumfeld:durability, refID attribute,
              id/parentID prefix changed 0/ → ext/

## 1.2.101

- Fix (v1.2.100 permanent-CDN shortcut missed the play() STOPPED→native path):
  v1.2.100 added `_isPermanentCdnUrl` / `_stripTuneInMarkers` and applied them to
  every `setAvTransportUri` call site (Path A, Path B, ECONNRESET, loadSingle CDN
  shortcut).  However, the `play()` method's `dlna-playsingle://` guard fires BEFORE
  any of those paths are reached and calls bare `renderer.play()` directly.  With the
  kernel's AVTransportURI still set to `dlna-playsingle://` at startup (from the
  previous session), all three rooms went through the native guard → each created its
  own independent TuneIn session → 3 ebrowse calls per 60 s → rate-limit at ~280 s →
  drop.  Confirmed in the log: `play() live stream (STOPPED→native)` for all 3 rooms;
  no `STOPPED→permanent-CDN` log entry.
  Fix: extend the `dlna-playsingle://` guard in `play()` to first attempt the
  permanent CDN shortcut.  When a cached permanent CDN URL is available AND the
  kernel's `AVTransportURIMetaData` `refID` matches the cached metadata's `refID`
  (same station), call `SetAVTransportURI(CDN URL, stripped metadata)` instead of
  bare `play()`.  Falls through to native play only when no CDN cache or station
  mismatch.  This activates correctly at startup because the Raumfeld kernel reports
  `CurrentTrackURI = CDN URL` even for rooms in STOPPED state with a
  `dlna-playsingle://` AVTransportURI (the last-played URL is retained in
  CurrentTrackURI between sessions), so `_lastSeenCdnUri` is always populated.

## 1.2.100

- Fix (3-room same-station TuneIn rate-limit → ~300 s drops):
  With three rooms independently playing the same station (e.g. Ö3), the Raumfeld
  kernel creates a separate TuneIn session per room.  Each session calls
  `Tune.ashx?c=ebrowse` every 60 s for renewal.  Three rooms = 3 ebrowse calls per
  minute for the same (serial, station) pair.  TuneIn's rate limit for the pair is
  roughly 12–15 calls per 5-minute window; the 13th–15th call returns a throttled
  (very short) session, causing the stream to drop at approximately 300 s — exactly
  5 renewal windows × 60 s.  This was observed consistently: sessions always lasted
  288–298 s before dropping, regardless of whether the initial load came from the
  integration or from the native app.

  Root observation: Ö3's CDN URL (`orf-live.ors-shoutcast.at/oe3-q2a`) is a
  permanent, public ORF/Shoutcast stream with no TuneIn session token in the URL.
  It does not need ebrowse calls to remain alive — the CDN connection stays open
  indefinitely.  However, because the DIDL-Lite metadata still carries
  `raumfeld:section=RadioTime`, `refID`, and `raumfeld:ebrowse`, the kernel
  treats it as a TuneIn-managed stream and keeps calling ebrowse every 60 s.
  Stripping those markers makes the kernel play it as a plain HTTP stream — zero
  TuneIn calls, zero rate-limit exposure, plays forever regardless of room count.

  Fix: add `_isPermanentCdnUrl(url)` (returns true for direct CDN streams that
  do not carry a TuneIn session token; returns false for `rndfnk.`
  dispatcher URLs, `radiotime.com`, `tunein.com`, `aggregator=tunein`, etc.) and
  `_stripTuneInMarkers(metaXml)` (removes `raumfeld:ebrowse`, `raumfeld:durability`,
  `raumfeld:section`, and `refID` from DIDL-Lite while preserving the item `id` and
  all display fields so each room keeps its own unique item reference).

  Applied in all SetAVTransportURI call sites:
  - Path A (play STOPPED→CDN): permanent URL → stripped metadata, kernel plays as
    plain HTTP.
  - Path B (CDN-direct fallback): same.
  - ECONNRESET retry: same.
  - loadSingle CDN shortcut: permanent URL → stripped metadata (replaces
    durability=0 path); TuneIn-dispatcher URL → durability=0 unchanged.

  For TuneIn-dispatcher URLs (e.g. `dispatcher.rndfnk.com/…?aggregator=tunein`),
  session markers are preserved and the existing ebrowse renewal path continues
  unchanged.  A single-room dispatcher stream is unaffected; multi-room same-station
  dispatcher streams may still see ~300 s drops with 3+ rooms, which requires zone
  grouping to solve at the Raumfeld layer.

## 1.2.99

- Fix (loadSingle triggers slow TuneIn session-dispatch → 90 s TRANSITIONING):
  When the user selects a station from the HA media browser, `loadSingle` makes the
  kernel load the item via `dlna-playsingle://`.  The kernel then calls two TuneIn
  endpoints in sequence: (1) `Tune.ashx?c=ebrowse` for session metadata — fast,
  not throttled, always returns durability=120 — and (2) `Tune.ashx?id=<event-id>`
  (session-dispatch) to resolve the actual CDN stream URL.  The dispatch endpoint has
  a separate, stricter throttle tier.  When throttled it does not fail outright: it
  stalls for 90+ seconds before timing out, leaving the renderer in TRANSITIONING
  with the user seeing no playback.  The native Raumfeld app avoids this entirely
  by reusing the active CDN connection when restarting the same station; it never
  hits the dispatch endpoint again.
  Fix: `loadSingle` now applies a CDN shortcut when (a) the room is STOPPED,
  (b) we have a cached CDN URL and station metadata, and (c) the requested item's
  `refID` (looked up from the browse cache) resolves to the same station ID as the
  cached metadata.  In that case `SetAVTransportURI(CDN URL, metadata with
  durability=0)` is called directly, bypassing `dlna-playsingle://` entirely.
  `durability=0` tells the kernel the session is expired, so it calls ebrowse
  immediately (the fast path) to obtain a fresh CDN session rather than waiting for
  the 60 s renewal window.  This mirrors the native app's reconnect-via-CDN behaviour
  and brings loadSingle response time from 90 s to under 2 s even when the
  session-dispatch endpoint is throttled.
  Also added `refID` field to `_parseBrowseXml` item parsing so the browse cache
  can supply refID lookups for the station-match check.

## 1.2.98

- Fix (SetAVTransportURI corrupts native dlna-playsingle:// state → 3-room TuneIn throttle):
  When the native Raumfeld app (or the kernel itself) sets a room's AVTransportURI to a
  `dlna-playsingle://` reference, the kernel manages TuneIn session registration,
  renewal and cross-room session sharing internally — exactly one ebrowse call per
  station shared across all rooms playing that station.  Our integration was bypassing
  this by calling SetAVTransportURI(CDN URL, ebrowse DIDL) via Path B (CDN-direct),
  which replaced the `dlna-playsingle://` state with an independent CDN URL for each
  room.  With 3 rooms each registering their own TuneIn session for the same station
  and serial, TuneIn throttled aggressively → sessions as short as 8 s → chain of
  drops and restarts → more ebrowse calls → deeper throttle.  The stale
  `raumfeld:durability` value captured at startup (109 s remaining) made it worse: the
  kernel saw an already-expired session and called TuneIn immediately.
  Fix: add a `dlna-playsingle://` guard at the top of the STOPPED live-radio branch in
  `play()`.  When `AVTransportURI` starts with `dlna-playsingle://`, always call bare
  `renderer.play()` instead of any SetAVTransportURI path.  The kernel takes over
  natively — session sharing, renewal scheduling and ContentDirectory browsing are all
  handled internally, matching the native Raumfeld app's behaviour.

## 1.2.97

- Fix (serial extraction always fails — `&amp;` XML encoding not handled):
  The TuneIn device serial lives inside a `raumfeld:ebrowse` URL embedded in DIDL-Lite
  XML.  XML requires `&` to be escaped as `&amp;`, so the URL looks like
  `...&amp;serial=78%3Aa5...`.  The extraction regex `/[?&]serial=/` expects a literal
  `&`, which never appears in the encoded string — so `_tuneInSerial` was always `null`
  and `_tryInjectEbrowse` always skipped with "serial not yet populated".
  Fix: change the regex to `/[?&](?:amp;)?serial=/` to match both the encoded and
  unencoded forms.

- Fix (CDN metadata cache never populated for native-app rooms):
  `_lastSeenCdnUri` was only updated when `AVTransportURI` was an HTTPS CDN URL.
  Rooms loaded via the native app use `dlna-playsingle://` as their `AVTransportURI`
  but still report the resolved CDN URL in `CurrentTrackURI`.  Because `_lastSeenCdnUri`
  was never set for those rooms, their full TuneIn ebrowse DIDL (available in
  `CurrentTrackMetaData`) was never saved to the shared CDN metadata cache on disk.
  Fix: when `AVTransportURI` is not an HTTPS CDN URL, also check `CurrentTrackURI`
  as a fallback source for `_lastSeenCdnUri`.  This allows rooms like Kati (which has
  the full ebrowse DIDL from a native-app load) to contribute to the cross-room cache.

- Fix (room processed before cache contributor — cross-room metadata not restored):
  In `_broadcastRoomStates`, rooms are iterated in registry-insertion order.  Kueche
  (whose `AVTransportURIMetaData` is `id="cdn/direct"` from a previous run) was
  inserted before Kati (which has the good ebrowse DIDL).  When the cold-start
  recovery ran for Kueche during the first-pass loop, Kati had not yet been processed
  and `_cdnMetaCache` was still empty → recovery failed → `_radioAvtMetadata` stayed
  `null` → `play()` fell through to the `cdn/direct` raw fallback → kernel in CDN-direct
  mode → ~100 s drops (same symptom as `_makeCdnMeta`).
  Fix: add a second-pass loop in `_broadcastRoomStates` that runs after all rooms have
  been processed and caches fully populated.  Any room that still lacks
  `_radioAvtMetadata` is restored from `_cdnMetaCache` using its `_lastSeenCdnUri`.

## 1.2.96

- Fix (stream drops after ~296 s — TuneIn ebrowse/refID stripped for permanent CDN URLs):
  The `_makeCdnMeta()` helper was applied to metadata before `SetAVTransportURI` for all
  permanent CDN URLs (e.g. `orf-live.ors-shoutcast.at`).  This stripped `raumfeld:ebrowse`,
  `raumfeld:durability`, `refID`, and `raumfeld:section` from the DIDL, leaving the kernel
  with no TuneIn session management capability.  Result: the kernel had to borrow an existing
  TuneIn session from another renderer; when that session expired the stream dropped.
  Empirical evidence: `_makeCdnMeta` → ~100 s drops; refID preserved → ~296 s drops;
  full ebrowse preserved → ~291 s (all three scenarios bottleneck at TuneIn throttling
  from repeated test runs, not at the CDN URL itself).
  Fix: remove `_makeCdnMeta()` from Path A, Path B CDN-direct, and the ECONNRESET
  retry path.  Metadata is now passed as-is so the kernel can manage its own independent
  TuneIn session via `raumfeld:ebrowse` (direct renewal) or via `refID` (ContentDirectory
  lookup → ebrowse URL).  In production (serial not throttled) this results in indefinite
  play; during heavy testing (throttled serial) drop intervals grow with throttle recovery.
- Fix (`_tryInjectEbrowse` always fails on cold start — serial not persisted):
  `_tuneInSerial` (the Raumfeld device MAC used for TuneIn `ebrowse` calls) was extracted
  from subscription events but never written to disk.  After an add-on restart the serial
  was `null` until at least one room reported an ebrowse URL in its state — which could
  take minutes or never happen at all when all rooms had been left in a CDN-URL state.
  Fix: persist the serial to `/data/tunein_serial.json` the first time it is extracted
  and reload it at startup.  `_tryInjectEbrowse` now works on the very first `play()`
  call after a restart without waiting for a room state event to supply the serial.

## 1.2.95

- Fix (100 s stream drop — Kueche loses TuneIn session when another room changes station):
  When `_radioAvtMetadata` is null at play time (startup metadata has no `raumfeld:ebrowse`)
  the raw-fallback path in Path A uses `renderer.rendererState.AVTransportURIMetaData`
  directly.  Previous code then applied `_makeCdnMeta()` which stripped `refID` and
  `raumfeld:section` from the DIDL.  Without those markers the kernel has no way to
  look up the station's `ebrowse` URL in its own ContentDirectory, so it *borrows* the
  TuneIn session from another renderer that happens to be playing the same CDN URL (e.g.
  KellerStueberl playing Hitradio Ö3 via `dlna-playsingle://`).  When that renderer
  changes station, its session expires ~19 s later — and Kueche drops simultaneously.
  Fix: track the raw-fallback path with an `isRawFallback` flag and skip `_makeCdnMeta()`
  for that case.  The DIDL keeps `refID` / `raumfeld:section`; the kernel follows the
  `refID` to the ContentDirectory entry for the station, finds the `ebrowse` URL there,
  and establishes an **independent** TuneIn session for Kueche — not shared with other
  renderers.
- Diagnostic: add per-guard log lines to `_tryInjectEbrowse()` so future logs reveal
  exactly which condition (no DIDL, no serial, no refID match) prevents ebrowse
  injection.

## 1.2.94

- Fix (stream always falls to bare `play()` — `_radioAvtMetadata` absent when kernel
  reports no `raumfeld:ebrowse` in startup metadata):
  After a clean restart the Raumfeld kernel populates `AVTransportURIMetaData` for
  zones that were last playing a radio station, but the metadata it reports may contain
  only minimal DIDL (song title, `refID`, `raumfeld:section`) **without** a
  `raumfeld:ebrowse` element.  The existing caching guard (`hasRealEbrowse`) therefore
  leaves `room._radioAvtMetadata = null`.  As a result:
  - Path A gate (`isDirectCdn && effectiveMeta`) evaluates false even though the zone
    renderer's `CurrentTrackURI` is a valid permanent CDN URL.
  - Path B CDN-direct gate (`fallbackCdnUri && fallbackMeta`) also evaluates false
    because `_makeCdnMeta(null)` returns null.
  Both paths fall through to the bare `Play()` which causes TuneIn session management
  and the associated throttle-induced drops (93 s, 59 s in the latest test).
  Fix (Path A): when `_tryInjectEbrowse` cannot produce ebrowse metadata and the
  current `AVTransportURI` is a permanent CDN URL (not rndfnk / aggregator=tunein),
  use the renderer's raw `AVTransportURIMetaData` as `effectiveMeta` directly.
  `_makeCdnMeta()` then strips all TuneIn markers before the `SetAVTransportURI`
  call, so the kernel plays the CDN URL as a plain stream — no ebrowse, no TuneIn
  session management.
  Fix (Path B CDN-direct): restrict CDN-direct to permanent CDN URLs only (rndfnk
  and aggregator=tunein continue to use bare `Play()` so the kernel manages TuneIn
  session renewal).  When `room._radioAvtMetadata` is absent, fall back to
  `renderer.rendererState?.AVTransportURIMetaData` as the metadata source for
  `_makeCdnMeta()`.

## 1.2.93

- Fix (recurring ~157 s stream drop — multi-room TuneIn session throttling):
  When multiple rooms (Sauna, Kati, Bad, Kueche) all have the same TuneIn station
  as their last-played item, the Raumfeld kernel calls `ebrowse` for each room at
  startup.  This burst of concurrent ebrowse calls exceeds TuneIn's per-serial
  rate limit, causing the kernel to receive a throttled session with
  `durability=37.6 s`.  After 37.6 + 120 = **157.6 s** the throttled session
  expires and the stream stops — regardless of whether the CDN URL itself is still
  perfectly valid.
  Root cause: `_stripEbrowse()` removes `raumfeld:ebrowse` and
  `raumfeld:durability` from the metadata, but leaves `refID` (e.g.
  `refID="0/RadioTime/Search/s-s8007"`) and `raumfeld:section="RadioTime"`.  The
  kernel follows the `refID` to its internal ContentDirectory entry for the
  station, finds the stored ebrowse URL there, and still manages a TuneIn session
  — completely bypassing the stripped metadata.
  Fix: new `_makeCdnMeta()` method strips ALL TuneIn markers: ebrowse, durability,
  `raumfeld:section`, `raumfeld:name`, the `refID` attribute, and neutralises
  `item id` / `parentID` to `cdn/direct` / `cdn`.  With no ContentDirectory
  reference left, the kernel treats the play as a plain audio stream — zero
  ebrowse calls, zero TuneIn rate-limit exposure, stream plays indefinitely.
  Changes: (1) Path A (permanent CDN URL restart) now calls `_makeCdnMeta()` in
  place of `_stripEbrowse()`; (2) Path B (bare `play()` fallback) now first
  attempts a `setAvTransportUri` with `_makeCdnMeta(room._radioAvtMetadata)` +
  `room._lastSeenCdnUri` before falling back to the kernel-managed bare `play()`,
  ensuring the CDN-direct path is taken even when `CurrentTrackURI` on the zone
  renderer is a `dlna-playsingle://` URI; (3) ECONNRESET recovery path also uses
  `_makeCdnMeta()` for permanent CDN URLs.

## 1.2.92

- Fix (recurring ~291 s stream drop — stale durability in CDN restart metadata):
  When the integration restarts Kueche via a CDN URL (Path A in `play()`), the
  cached `_radioAvtMetadata` still contains `<raumfeld:durability>37.6</raumfeld:durability>`
  from a previous session stored in the kernel's `RecentlyPlayed` database.  The
  kernel reads this value and schedules ebrowse renewal calls every ~37.6 s.
  TuneIn rate-limits those calls and eventually returns a zero-durability response
  that tears the stream down (~291 s = 8 × 37.6 s after stream start).
  Root cause: `_stripEbrowse()` already existed for exactly this scenario
  ("When streaming from a permanent CDN URL ebrowse/durability must NOT be sent")
  but was never called in Path A or the ECONNRESET fallback.  Fix: for permanent
  CDN URLs (not `rndfnk` / `aggregator=tunein` TuneIn CDN URLs that do require
  renewal), both call sites now wrap the metadata with `_stripEbrowse()` before
  passing it to `setAvTransportUri`.
- Fix (pre-fetch introduced 2 s drop): the v1.2.91 pre-fetch called
  `ContentDirectory.Browse('0/Favorites/MyFavorites')` 3 s after `systemReady`,
  creating TuneIn sessions for all favourites stations (including s8007 /
  Hitradio Ö3).  When the user then played Hitradio Ö3 ~99 s later via
  `loadSingle`, the kernel found the pre-fetch session with only ~21 s remaining
  and fired a pre-emptive renewal — conflicting with the `dlna-playsingle`
  session — causing a 2 s stream drop.  Fix: the pre-fetch is removed entirely.
- Fix (browse cache lost on restart): the `_browseCache` Map was in-memory only,
  so the cache was empty on every addon restart and the first browse always hit
  the kernel (triggering ebrowse for all TuneIn stations and potentially causing
  a stream drop).  Fix: cache is now persisted to `/data/browse_cache.json`.  On
  startup the file is read before `systemReady` so all subsequent Browse requests
  are served from cache without ever contacting the kernel.  The cache is updated
  after each kernel Browse and cleared (+ file wiped) by `clearBrowseCache()`.

## 1.2.91

- Fix (Browse first-hit still drops stream): the v1.2.90 browse cache prevented
  all *subsequent* browse calls from hitting the kernel, but the very *first*
  `ContentDirectory.Browse('0/Favorites/MyFavorites')` still reached the kernel
  and triggered ebrowse for every radio station in the container, stopping the
  active TuneIn stream ~48 s later (TuneIn throttles the new session). Fix: at
  `systemReady + 3 s`, a new `_preFetchBrowseCache()` method pre-warms the cache
  for `0/Favorites` and `0/Favorites/MyFavorites` in the background. The
  pre-fetch is skipped if a live stream is already PLAYING (e.g. stream started
  via the native app before the addon), to avoid triggering the same ebrowse
  problem. When the stream is STOPPED at startup (the normal case), the cache is
  populated before the user opens the media browser, so every browse from then on
  is served from cache.
- Feature (Stop vs Pause button for live streams): the native Raumfeld app shows
  a Stop button (not Pause) when a live radio station is playing, and a Pause
  button for regular tracks. The HA integration now matches this behaviour: the
  `PAUSE` feature flag is removed and only `STOP` is advertised when the currently
  playing item is an `audiobroadcast` (UPnP class). For regular music tracks both
  `PAUSE` and `STOP` are advertised (HA shows the Pause button).

## 1.2.90

- Fix (Browse kills stream): clicking FAVOURITES in the HA media browser caused
  Kueche (and any room playing a TuneIn station) to stop immediately. Root cause:
  `ContentDirectory.Browse('0/Favorites/MyFavorites')` causes the Raumfeld kernel
  to call the TuneIn ebrowse endpoint for every radio station in the container,
  including the one currently playing. This creates a new TuneIn session for that
  station, which the kernel then loads by tearing down and restarting the active
  stream (~3 s interruption). Fix: Browse results are now cached in
  `RaumkernelHelper._browseCache` (Map). The first call for each container still
  hits the kernel (and may cause a brief interruption), but all subsequent calls
  are served from cache with no kernel contact. Add `clearBrowseCache()` for
  programmatic cache invalidation.
- Fix (ContentDirectory SUBSCRIBE startup race): the ContentDirectory SUBSCRIBE
  fired at T+0 ms (during device discovery), BEFORE `systemReady` set
  `global._raumfeldMediaServerPorts` at T~30–200 ms. Because the port was unknown
  at that moment, `portMatch=false` and the subscription slipped through,
  meaning ContentDirectory NOTIFYs were still being delivered for the first
  ~5 minutes (until the 5-min renewal was correctly suppressed). Fix: all
  non-physical kernel SUBSCRIBE calls now go through a new `kernelSubscribeProxy`
  (modelled on `physicalSubscribeProxy`). The proxy polls every 50 ms until
  `_raumfeldMediaServerPorts` is set, then decides: MediaServer port or
  `/cd/` path → fake 24 h SID (suppress); all other ports → real SUBSCRIBE
  (allow virtual renderer AVTransport/RC). Timeout after 5 s → fail-open.
  Also extended the path pattern to match the actual eventSubURL used by current
  Raumfeld firmware: `/cd/Event` (not `/ContentDirectory/event`).
- Fix (KellerStueberl / standby device Play fails): when a device is in
  PAUSED_PLAYBACK state but its physical speaker is in deep standby, calling
  bare `renderer.play()` returns ECONNRESET. The integration now catches this
  for live streams and retries via a CDN URL reload (`setAvTransportUri`) so
  the kernel sends a fresh SetAVTransportURI to the device, waking it up and
  re-establishing the TuneIn session.

## 1.2.89

- Fix (P2 ContentDirectory suppression was broken in v1.2.88): the previous
  check matched the SUBSCRIBE request path against `/contentdirectory/i`, but
  the Raumfeld MediaServer's ContentDirectory eventSubURL apparently does not
  embed the service name in its path (e.g. it may be just `/event`), so the
  regex never matched and ContentDirectory subscriptions were never suppressed.
  Fix: dual-check approach — (1) port-based: `RaumkernelHelper` now discovers
  the MediaServer's dynamically-assigned UPnP HTTP port at `systemReady` and
  stores it in `global._raumfeldMediaServerPorts` (Set\<string\>); the patch
  compares the SUBSCRIBE request port against this set (robust against any
  eventSubURL path format); (2) path-based fallback retained for firmware
  variants that do embed the service name. Either match suppresses.
- Add diagnostic logging: every non-physical kernel SUBSCRIBE call now emits a
  `[KernelSub]` line showing host, port, path, and both match flags so the
  actual eventSubURL structure is visible in logs for future analysis.

## 1.2.88

- Fix (presence certificate): physical SUBSCRIBE filter was matching renderer UDN
  against the URL *path* of the SUBSCRIBE request, but physical Raumfeld speaker
  event endpoints use paths like `/AVTransport/event` — the UDN never appears in
  the path. As a result all 12 physical subscriptions were suppressed in v1.2.87,
  the same as v1.2.85, making the "presence certificate" ineffective. Fix: switch
  to HOST (IP address) based filtering. `RaumkernelHelper._updateSubscriptionFilter`
  now resolves active renderer UDNs → IP addresses via `deviceManager.mediaRenderers`
  and stores them in `global._raumfeldActivePhysicalHosts`. The proxy in
  `tunein-patch.cjs` checks `_raumfeldActivePhysicalHosts.has(host)`. If the IP
  lookup fails for all active renderers the global is set to `null` (fail-open:
  all physical subscriptions are allowed, same as v1.2.84).
- Fix (P2 stream drop at T+355s): suppress ContentDirectory subscriptions from
  the MediaListManager. The Raumfeld MediaServer sends 4 ContentDirectory NOTIFY
  callbacks every ~60 s to our HTTP server. Even though
  `loadMediaItemListsByContainerUpdateIds` is patched to a no-op, the kernel
  processes each NOTIFY it sends us internally; this processing competes with the
  kernel's own ebrowse TuneIn-session renewal timer. When that renewal loses the
  race to TuneIn's throttle, the stream stops. Fix: intercept SUBSCRIBE requests
  to the kernel host whose path contains "ContentDirectory" and return a fake 24 h
  SID — the kernel never establishes the subscription, never sends NOTIFY batches,
  and its ebrowse timer operates uncontested.

## 1.2.87

- Fix (P1): subscribe to physical (speaker) renderers only for ACTIVE zones.
  Raumfeld's kernel runs an internal zone health-check ~5 s after the first UPnP
  subscription arrives. The check reads `AVTransportURIMetaData.durability` for
  every playing zone. When the integration starts while a stream has been running
  through the native app for more than a few minutes, that durability value is
  stale (negative). Without any physical subscriptions the kernel performs a full
  session validation and stops the stream. Having at least one physical speaker
  subscription per active zone acts as a "presence certificate" that satisfies the
  health-check without triggering the validation. v1.2.85 suppressed all physical
  subscriptions → P1. v1.2.86 re-enabled all physical subscriptions to fix P1 but
  increased load. v1.2.87 takes the middle path: only subscribe to the physical
  renderer for each ACTIVE zone (typically 2–4 devices), suppressing all standby-
  zone physical renderers with a fake 24 h subscription (no real UPnP traffic).
  Implementation: `RaumkernelHelper._updateSubscriptionFilter()` parses the Zone
  Configuration `powerState` attributes on first `systemReady` (and on subsequent
  `zoneConfigurationChanged` events) and writes the active renderer UDN set to
  `global._raumfeldActivePhysicalUdns`. A polling proxy in `tunein-patch.cjs`
  (`physicalSubscribeProxy`) holds each physical SUBSCRIBE request until that
  global is populated (polled every 100 ms, fail-open after 3 s), then routes it
  to the real device or returns a fake 24 h SID.
- Fix (load): reduces physical subscription count from all-zones (12+) to
  active-zones only (typically 2–4), lowering UPnP traffic and kernel processing
  load, which also gives the kernel more headroom for TuneIn ebrowse renewals
  (mitigates P2 840 s drops).

## 1.2.86

- Revert: re-enable UPnP subscriptions to physical (speaker) renderer devices. Field testing of v1.2.85 revealed that suppressing physical-device subscriptions introduced an immediate 3-second stream drop at addon startup (followed by a ~5-minute kernel self-restart), a regression absent in v1.2.84. Root cause: physical speaker subscriptions change the Node.js event-loop timing at startup — the 23 incoming initial NOTIFYs from physical speakers stagger the processing of virtual-renderer NOTIFYs, preventing a concentrated burst that the Raumfeld kernel interprets as a trigger to drop the playing TuneIn session. Without those NOTIFYs the burst is sharper and hits a kernel timing edge-case. The 0–15 s renewal jitter (from v1.2.85) safely handles the increased ~46-subscription renewal burst, so keeping physical subscriptions active does not reintroduce the HTTP 412 renewal errors that prompted their removal.

## 1.2.85

- Fix: stop subscribing to physical (speaker) renderers — subscribe only to virtual (zone/room) renderers. Physical renderer subscriptions were redundant: virtual renderers carry all zone-level state needed by the integration (TransportState, volume, metadata). The extra ~24 physical subscriptions doubled the startup burst to the Raumfeld kernel's HTTP server, triggered unnecessary internal zone health checks in the kernel (causing the kernel to reload stale TuneIn sessions when the integration starts), and generated an equal-sized renewal burst at T+210 s. Fix: intercept `http.request` in `tunein-patch.cjs` and return a fake 200 OK for any SUBSCRIBE or UNSUBSCRIBE request whose target host is not the Raumfeld kernel host (`192.168.243.1`). The fake SUBSCRIBE response carries a 24-hour timeout so the renewal timer effectively never fires. Physical devices never receive a SUBSCRIBE; they never send NOTIFYs to our server. Subscription count drops from ~47 to ~23.
- Fix: reduce subscription renewal jitter from 0–60 s to 0–15 s. The previous 60 s cap caused HTTP 412 (Precondition Failed) errors: for a 240 s granted timeout the renewal window is 210 s; adding up to 60 s pushed some renewals to 270 s — 30 s past the 240 s expiry. With 15 s jitter, renewals land at 210–225 s, safely within the 240 s window. The 23 remaining virtual-renderer renewals spread across 15 s (~1.5/s) — well within the kernel's capacity.

## 1.2.84

- Fix: prevent subscription renewal burst from killing live-stream TuneIn sessions. All ~46 UPnP subscriptions (AVTransport + RenderingControl for every renderer) are created within a 5-second window at startup. The Raumfeld kernel grants ~240-second subscription timeouts, so `upnp-device-client` schedules every renewal at T+210 s — a second burst identical in size to the startup burst. This burst hits the kernel's HTTP server at the exact moment Kueche's TuneIn CDN-session renewal is also due, causing the kernel to miss the renewal window and drop the stream (~T+211 s, confirmed in logs). Fix: patch `global.setTimeout` before any module loads (in `tunein-patch.cjs`) to add 0–60 s of random jitter to timers whose delay falls in the 120 000–300 000 ms range. That range is exclusive to UPnP subscription renewal timers. With jitter, ~46 renewals spread evenly across 60 seconds (~0.8/s) instead of all at once.

## 1.2.83

- Fix: detect and recover from a stuck TRANSITIONING state. Previously, if the Raumfeld kernel entered TRANSITIONING (e.g. triggered by the native app or an HA automation) and then got stuck there because TuneIn was throttled and the CDN connection never opened, pressing Play via HA would log "kernel already loading, not interrupting" and do nothing — leaving the room unresponsive until the native app was used. Fix: track `room._transitioningStartTime` on every TRANSITIONING entry. In `play()`, if the kernel has been in TRANSITIONING for more than 30 seconds, force-call `renderer.stop()` (600 ms pause for the STOPPED subscription to arrive), then proceed with the normal Path A / Path B play logic. This means pressing Play on a hung room via HA will always recover within one press, regardless of how long the kernel has been stuck.

## 1.2.82

- Fix: eliminate the last source of unnecessary TuneIn session registrations — the "Poisoned CDN" cleanup. The `loadSingle` approach used since v1.2.80 registers a new TuneIn session at every startup where the kernel is in "poisoned" state (CDN URL + no ebrowse in metadata). Even though this cleanup was the right fix structurally, TuneIn throttles all recent sessions from the same serial, so the cleanup was deepening throttle instead of helping. New approach: at play time, if `_radioAvtMetadata` is empty (no cached ebrowse) but `CurrentTrackURI` is a direct CDN URL, `play()` attempts to reconstruct the ebrowse element directly from the kernel's `AVTransportURIMetaData` `refID` attribute (station ID) and `_tuneInSerial` (the device serial, extracted from the first real ebrowse URL seen in any room's subscription data). This produces complete station metadata with `raumfeld:ebrowse` and `raumfeld:durability` using only information already available from the kernel state, with **no ContentDirectory lookup and no new TuneIn session registration**.
- The `_tuneInSerial` field is now extracted passively from the first ebrowse URL seen in any room's `AVTransportURIMetaData` or `CurrentTrackMetaData` subscription events, making it available by the time the user presses Play.

## 1.2.81

- Fix: strip `<res>` from `AVTransportURIMetaData` before caching in `_radioAvtMetadata`. Previously, when the cleanup `loadSingle` (or a native-app play) produced `AVTransportURIMetaData` with both `raumfeld:ebrowse` and a `<res>` TuneIn relay URL, the metadata was cached as-is. Path A then called `setAvTransportUri(cdnUrl, metaWith<res>)`, which caused the kernel to fetch `<res>` and register yet another new TuneIn session. Registering Session 3 on top of the cleanup's Session 2 caused TuneIn to throttle the 2nd renewal → short-lived CDN token → drop at 312 s. Fix: always strip `<res>` from `AVTransportURIMetaData` before caching, exactly as the `CurrentTrackMetaData` path already did.
- Fix: at cleanup TRANSITIONING, save the fresh CDN URL (`CurrentTrackURI` = Session 2's URL) in `room._cleanupCdnUri`. Path A now prefers this URL over the stale pre-cleanup `CurrentTrackURI`, ensuring the active TuneIn session and the CDN URL used for streaming are always consistent.
- Fix: sync the bundled integration copy (`ha-raumkernel-addon/teufel_raumfeld_raumkernel/`) from `custom_components`, ensuring `integration=` in the startup log matches the addon version.

## 1.2.80

- Fix live radio drops after Play on a "poisoned CDN" state: v1.2.78 called `SetAVTransportURI` with stripped metadata (no `raumfeld:ebrowse`), leaving the kernel's persisted `AVTransportURI` as a plain HTTPS CDN URL with no ebrowse in its stored metadata. On the next restart, `_radioAvtMetadata` stays empty because no ebrowse is found in either `AVTransportURIMetaData` or `CurrentTrackMetaData`; Path A is skipped; bare `Play()` (Path B) falls through; the kernel re-resolves ContentDirectory and registers a new TuneIn session — which is throttled → drops at 102 s / 63 s. Fix: on initial subscription (`prevState === undefined`), if a stopped renderer has a direct HTTPS CDN URL as `AVTransportURI` but no `<raumfeld:ebrowse>` in its metadata, run the same `loadSingle + stop-at-TRANSITIONING` cleanup already used for stale TuneIn relay URLs. This restores the kernel to proper `dlna-playsingle://` state with full ContentDirectory metadata (including ebrowse) before the user presses Play, so Path A works correctly on the next play command.

## 1.2.79

- Fix live radio stream drops at ~511 s after pressing Play: the CDN URL used for BR Schlager and similar stations (`?aggregator=tunein`) is a TuneIn-session-dependent URL — without ebrowse renewal the CDN closes the connection once the initial token expires. v1.2.78 was stripping `raumfeld:ebrowse` and `raumfeld:durability` from the metadata before calling `SetAVTransportURI`, preventing the kernel from renewing. Fix: preserve ebrowse/durability in the metadata so the kernel renews the TuneIn session normally. The `_radioAvtMetadata` cache already has `<res>` stripped (from the stateChanged logic), so the metadata is correct: CDN URL via `CurrentURI`, station-level ebrowse for renewal, no raw TuneIn relay `<res>` URL.

## 1.2.78

- Fix live radio drops after pressing Play on a stopped stream: replace bare `Play()` (Path B) with CDN URL path (Path A) as the primary restart mechanism. Bare `Play()` on a `dlna-playsingle://` AVTransportURI forces the Raumfeld kernel to re-browse ContentDirectory and register a new TuneIn session; TuneIn throttles repeated registrations from the same device serial, causing drops at 82–126 s. Path A sends `SetAVTransportURI` with the CDN URL (retained in `CurrentTrackURI` across PLAYING→STOPPED) and station metadata with `ebrowse`/`durability` stripped, so the kernel streams the CDN URL directly with no TuneIn involvement, no renewal clock, and no throttle risk. Path B (bare `Play()`) is retained as fallback when no CDN URL is available (cold start).

## 1.2.77

- Fix TuneIn throttle from duplicate loadSingle: if the user taps a favorites item a second time within 60 s (e.g. because the HA frontend hadn't yet refreshed to show PLAYING), the second call is silently ignored. Without this guard, two TuneIn session registrations in quick succession trigger throttling and produce drops as short as 7 s.

## 1.2.76

- Fix persistent live radio drops caused by the HA integration calling `SetAVTransportURI` when the user presses Play on a stopped stream (Path C). Each such call registers a new TuneIn session; back-to-back registrations (e.g. Play then `loadSingle` within 30 s) trigger TuneIn throttling, causing drops as short as 37 s. The fix: always use a bare UPnP `Play()` for stopped live streams — identical to the native Raumfeld app — so the kernel reuses its own session context, which handles renewals stably even when durability is deeply negative. Also remove Path D (kernel auto-switch session refresh) for the same reason.

## 1.2.75

- Fix live radio stream drops at :02 past the minute: the root cause was that Path A (SetAVTransportURI with CDN URL) skipped the ContentDirectory lookup that fetches the TuneIn `<res>` session URL. Without that fetch, TuneIn has no record of a new session and kills renewal calls after 1–2 cycles. Replace Path A with Path C: always use the `dlna-playsingle://` URI (identical to what the native Raumfeld app does), which causes the kernel to fetch ContentDirectory → `<res>` URL → fresh TuneIn session registration → stable renewals indefinitely. Cache the dlna-playsingle:// URI so it remains available even if a previous run had corrupted AVTransportURI to a CDN URL.

## 1.2.74

- Fix live radio streams dropping at :02 past the minute after pressing Play via HA: Path A (CDN URL restart) was passing `<raumfeld:ebrowse>` and `<raumfeld:durability>` in the metadata, causing the kernel to schedule periodic TuneIn session renewal calls. TuneIn rate-limits those calls and tears down the stream. Strip both elements before calling `SetAVTransportURI` so the kernel streams the permanent CDN URL as a plain HTTP stream with no renewal cycle.

## 1.2.73

- Fix spurious "Previous" button on live radio streams: instead of routing play through `dlna-playsingle://` (which re-introduces TuneIn session renewal and drops at :02 past the minute), suppress `canPlayPrev` for any live stream directly in state extraction. The stable CDN URL path (Path A) is now the only live-stream restart path.

## 1.2.71

- Fix spurious "Previous" button appearing in HA media player when play is triggered via the integration after the native app had loaded a station via dlna-playsingle://

## 1.2.13

- Fix track images which are hosted on Raumfeld devices (e.g. Local music, Tidal) not showing up.
- Add information/debug page to the addon (reachable at the default port).

## 1.2.12

- Added a setting to manually set the Raumfeld host address if auto discovery fails.

## 1.2.11

- Add support for media_content_id. It is now possible to see which media is currently playing.

## 1.2.10

- Fixes a crash if homeassistant sends a "prev" command even if prev is not allowed
- Fix issues with seek.

## 1.2.9

- Automatic install of integration

## 1.2.7

- Add Seek
- Improved Zone Handling
- Reboot Devices

## 1.2.2

- Add reboot feature to restart Raumfeld devices via SSH

## 1.0.0

- Initial release
