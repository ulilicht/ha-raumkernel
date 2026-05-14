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
