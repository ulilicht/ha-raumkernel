/**
 * RaumkernelHelper - Manages Raumfeld devices for Home Assistant integration
 * 
 * ARCHITECTURE OVERVIEW:
 * ---------------------
 * The Raumfeld system uses several types of identifiers that are easy to confuse:
 * 
 * 1. RENDERER UDN (rendererUdn)
 *    - Physical device hardware identifier
 *    - Example: uuid:846851e1-0ad8-4664-b38a-5656ef1fb4ee
 *    - Used to: Look up MediaRenderer objects, match against getRoomRendererUDNs()
 * 
 * 2. ROOM UDN (roomUdn)  
 *    - Logical room identifier
 *    - Example: uuid:a5f7900f-3d53-47c9-a6f1-3e9440461036
 *    - Used to: Identify entities in Home Assistant, zone management operations
 * 
 * 3. ZONE UDN (zoneUdn)
 *    - Virtual renderer identifier (dynamic, changes with zone composition)
 *    - Example: uuid:d673d7dc-b412-4405-94d8-b811ca3ee775
 *    - Used to: Control grouped playback via MediaRendererVirtual
 * 
 * CRITICAL: These are NOT interchangeable!
 * - zoneManager.connectRoomToZone() expects a ROOM UDN
 * - renderer.getRoomRendererUDNs() returns RENDERER UDNs
 * - deviceManager.mediaRenderers is keyed by RENDERER UDN
 * - deviceManager.mediaRenderersVirtual is keyed by ZONE UDN
 */

import { JSDOM } from 'jsdom';
import * as RaumkernelLib from 'node-raumkernel';

// ============================================================================
// TYPE DEFINITIONS (JSDoc for IDE support)
// ============================================================================

/**
 * @typedef {Object} RoomInfo
 * @property {string} name - Display name of the room
 * @property {string} roomUdn - Logical room identifier for zone operations
 * @property {string} rendererUdn - Physical device identifier
 * @property {string|null} zoneUdn - Current zone this room belongs to
 * @property {string[]} zoneMembers - UDNs of other rooms in the same zone
 * @property {string|null} zoneName - Display name of the current zone
 */

/**
 * @typedef {Object} NowPlayingState
 * @property {string} artist - Current artist name
 * @property {string} track - Current track title
 * @property {string} image - Album art URL (https)
 * @property {boolean} isPlaying - Whether playback is active
 * @property {boolean} isLoading - Whether transitioning between tracks
 * @property {boolean} isMuted - Whether audio is muted
 * @property {number} volume - Volume level (0-100)
 * @property {boolean} canPlayPause - Whether play/pause is available
 * @property {boolean} canPlayNext - Whether next track is available
 * @property {boolean} canPlayPrev - Whether previous track is available
 * @property {string} duration - Track duration
 * @property {string} position - Current playback position
 */

/**
 * @typedef {Object} RoomState
 * @property {string} name - Room display name
 * @property {string} udn - Room UDN (stable identifier)
 * @property {string} roomUdn - Same as udn (for compatibility)
 * @property {string} rendererUdn - Physical renderer UDN
 * @property {boolean} isZone - Always false (we expose rooms, not zones)
 * @property {string|null} zoneUdn - Current zone UDN if grouped
 * @property {string|null} zoneName - Zone display name if grouped
 * @property {string[]} zoneMembers - Room UDNs of zone members
 * @property {boolean} isPlaying - Whether room is playing
 * @property {NowPlayingState} nowPlaying - Current playback state
 */

/**
 * @typedef {Object} MediaMetadata
 * @property {string} track - Track title
 * @property {string} artist - Artist name
 * @property {string} album - Album name
 * @property {string} image - Album art URL
 * @property {string} classString - UPnP object class
 */

// ============================================================================
// LOGGING CONFIGURATION
// ============================================================================

const LOG_PREFIX = {
    REGISTRY: '[Registry]',
    RENDERER: '[Renderer]',
    COMMAND: '[Command]',
    MEDIA: '[Media]',
    BROWSE: '[Browse]'
};

// ============================================================================
// MAIN CLASS
// ============================================================================

class RaumkernelHelper {
    constructor() {
        /** @type {RaumkernelLib.Raumkernel} */
        this.raumkernel = new RaumkernelLib.Raumkernel();

        // Configure manual host if set
        if (process.env.RAUMFELD_HOST && process.env.RAUMFELD_HOST.trim() !== '') {
            this.raumkernel.settings.raumfeldHost = process.env.RAUMFELD_HOST.trim();
            console.log(`[RK] [INFO] Using configured Raumfeld Host: ${this.raumkernel.settings.raumfeldHost}`);
        }
        
        /** @type {Map<string, RoomInfo>} Room registry keyed by RENDERER UDN */
        this._rooms = new Map();
        
        /** @type {{isReady: boolean, availableRooms: RoomState[], favourites: []}} */
        this._state = {
            isReady: false,
            availableRooms: [],
            favourites: []
        };

        this._setupLogging();
        this._setupEventHandlers();
        this.raumkernel.init();
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    _setupLogging() {
        const logLevel = process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL) : 2;
        this.raumkernel.createLogger(logLevel);
        
        const logPrefixes = ['ERROR', 'WARN ', 'INFO ', 'VERB ', 'DEBUG', 'SILLY'];
        this.raumkernel.logger.on('log', (data) => {
            const prefix = logPrefixes[data.logType] || `LVL${data.logType}`;
            console.log(`[RK] [${prefix}] ${data.log}`);
        });
    }

    _setupEventHandlers() {
        this.raumkernel.on('systemReady', (ready) => {
            console.log(`${LOG_PREFIX.REGISTRY} System ready: ${ready}`);
            this._state.isReady = ready;
            if (ready) {
                // If we have a fixed host, we might want to log it
                if (this.raumkernel.getSettings().raumfeldHost !== "0.0.0.0") {
                     console.log(`${LOG_PREFIX.REGISTRY} Connected to fixed host: ${this.raumkernel.getSettings().raumfeldHost}`);
                }
                this._refreshRoomRegistry();
                
                // Process initial zone state
                const zoneManager = this._getZoneManager();
                if (zoneManager && zoneManager.zoneState) {
                    console.log(`${LOG_PREFIX.REGISTRY} Processing initial zone state`);
                    this._handleZoneStateChange(zoneManager.zoneState);
                }
            }
        });

        this.raumkernel.on('systemHostLost', () => {
            console.log(`${LOG_PREFIX.REGISTRY} System host lost`);
            this._resetState();
        });

        this.raumkernel.on('combinedZoneStateChanged', (data) => {
            this._handleZoneStateChange(data);
        });

        this.raumkernel.on('rendererStateChanged', () => {
            // Defer processing to the next event-loop tick so that the NOTIFY
            // acknowledgment (200 OK from our HTTP server) can be sent immediately
            // rather than blocking for ~50 ms while _broadcastRoomStates() runs
            // synchronously.  The Raumfeld kernel waits for our ACK before it can
            // proceed with the next operation — including issuing the outbound
            // TuneIn ebrowse HTTP call for session renewal.  When we're slow (e.g.
            // during the 38-request burst after a UPnP device-list rediscovery),
            // the kernel stalls and misses the 120-second renewal window → STOPPED.
            //
            // Deduplication: if multiple events arrive before the deferred call runs
            // (burst during device rediscovery), only one _broadcastRoomStates()
            // executes — the final one after all events have settled.
            if (this._broadcastScheduled) return;
            this._broadcastScheduled = true;
            setImmediate(() => {
                this._broadcastScheduled = false;
                this._broadcastRoomStates();
            });
        });

    }

    _resetState() {
        this._state = { isReady: false, availableRooms: [], favourites: [] };
        this._rooms.clear();
    }

    // ========================================================================
    // PUBLIC API - State Access
    // ========================================================================

    /**
     * Returns the current state for broadcasting to clients
     */
    getState() {
        return this._state;
    }

    // ========================================================================
    // ROOM REGISTRY MANAGEMENT
    // ========================================================================

    /**
     * Refreshes the room registry from current device state.
     * Called on system ready and when devices change.
     */
    _refreshRoomRegistry() {
        const deviceManager = this._getDeviceManager();
        if (!deviceManager) return;

        for (const [rendererUdn, renderer] of deviceManager.mediaRenderers) {
            if (this._rooms.has(rendererUdn)) continue;

            const roomInfo = this._createRoomInfo(rendererUdn, renderer);
            
            // Skip rooms with empty name or roomUdn - this happens when the device
            // is discovered before the zone configuration is available from the host.
            // The room will be added on subsequent updates when metadata is populated.
            if (!roomInfo.name || !roomInfo.roomUdn) {
                console.log(`${LOG_PREFIX.REGISTRY} Skipping renderer ${rendererUdn}: ` +
                    `incomplete metadata (name: "${roomInfo.name}", roomUdn: "${roomInfo.roomUdn}")`);
                continue;
            }
            
            this._rooms.set(rendererUdn, roomInfo);
            
            console.log(`${LOG_PREFIX.REGISTRY} Added: ${roomInfo.name} ` +
                `(room: ${roomInfo.roomUdn}, renderer: ${roomInfo.rendererUdn})`);
        }

        this._broadcastRoomStates();
    }

    /**
     * Creates a RoomInfo object from a renderer
     * @param {string} rendererUdn 
     * @param {*} renderer 
     * @returns {RoomInfo}
     */
    _createRoomInfo(rendererUdn, renderer) {
        const name = renderer.roomName?.() ?? renderer.name?.() ?? 'Unknown Room';
        const roomUdn = renderer.roomUdn?.() ?? rendererUdn;

        return {
            name,
            roomUdn,
            rendererUdn,
            zoneUdn: null,
            zoneMembers: [roomUdn],
            zoneName: null
        };
    }

    /**
     * Updates zone mappings when zone state changes
     * @param {*} combinedStateData 
     */
    _handleZoneStateChange(combinedStateData) {
        const state = JSON.parse(JSON.stringify(combinedStateData));
        
        this._refreshRoomRegistry();
        this._updateZoneMappings(state);
        this._broadcastRoomStates();
    }

    /**
     * Maps rooms to their current zones based on combined zone state
     * @param {{zones: Array}} combinedState 
     */
    _updateZoneMappings(combinedState) {
        if (!combinedState?.zones) return;

        // Reset all zone mappings
        for (const room of this._rooms.values()) {
            room.zoneUdn = null;
            room.zoneMembers = [room.roomUdn];
            room.zoneName = null;
        }

        // Apply zone mappings from state
        for (const zone of combinedState.zones) {
            // Log zone details for debugging
            // console.log(`${LOG_PREFIX.REGISTRY} Processing zone: ${zone.udn} (isZone: ${zone.isZone}, name: ${zone.name})`);
            
            if (!zone.isZone) continue;

            const memberUdns = zone.rooms?.map(r => r.udn) ?? [];
            // console.log(`${LOG_PREFIX.REGISTRY} Zone ${zone.name} (${zone.udn}) has members: ${memberUdns.join(', ')}`);
            
            for (const memberUdn of memberUdns) {
                const room = this._findRoomByAnyUdn(memberUdn);
                if (room) {
                    room.zoneUdn = zone.udn;
                    room.zoneMembers = memberUdns;
                    room.zoneName = zone.name;
                    // console.log(`${LOG_PREFIX.REGISTRY} Mapped room ${room.name} to zone ${zone.name}`);
                } else {
                    console.warn(`${LOG_PREFIX.REGISTRY} Could not find room for member UDN: ${memberUdn}`);
                }
            }
        }
    }

    /**
     * Builds and publishes the room state array
     */
    _broadcastRoomStates() {
        const rooms = [];

        for (const room of this._rooms.values()) {
            const nowPlaying = this._getNowPlayingForRoom(room);
            
            rooms.push({
                name: room.name,
                udn: room.roomUdn,
                roomUdn: room.roomUdn,
                rendererUdn: room.rendererUdn,
                isZone: false,
                zoneUdn: room.zoneUdn,
                currentZoneUdn: room.zoneUdn, // Alias for compatibility
                zoneName: room.zoneName,
                zoneMembers: room.zoneMembers,
                isPlaying: nowPlaying.isPlaying,
                nowPlaying
            });
        }

        rooms.sort((a, b) => a.name.localeCompare(b.name));
        this._state.availableRooms = rooms;
    }

    // ========================================================================
    // ROOM LOOKUP
    // ========================================================================

    /**
     * Finds a room by UDN or name.
     * Always returns the RICH room object from this._rooms (which carries
     * persistent per-room state like position tracker fields).  The plain
     * objects in _state.availableRooms are rebuilt on every broadcast and
     * must NOT be used as the target for any mutable state.
     * @param {string} identifier - Room UDN, zone UDN, or partial name
     * @returns {RoomInfo|undefined}
     */
    findRoom(identifier) {
        if (!identifier) return undefined;

        // Try renderer UDN (registry key)
        if (this._rooms.has(identifier)) return this._rooms.get(identifier);

        // Try room UDN or zone UDN
        for (const room of this._rooms.values()) {
            if (room.roomUdn === identifier || room.zoneUdn === identifier) return room;
        }

        // Try partial name match (only if unambiguous)
        if (identifier.length > 2) {
            const lc = identifier.toLowerCase();
            const matches = [...this._rooms.values()].filter(r =>
                r.name.toLowerCase().includes(lc)
            );
            if (matches.length === 1) return matches[0];
        }

        return undefined;
    }

    /**
     * Finds a room in the registry by any UDN type
     * @param {string} udn
     * @returns {RoomInfo|undefined}
     */
    _findRoomByAnyUdn(udn) {
        // Try renderer UDN (registry key)
        if (this._rooms.has(udn)) return this._rooms.get(udn);

        // Try room UDN or zone UDN
        for (const room of this._rooms.values()) {
            if (room.roomUdn === udn || room.zoneUdn === udn) return room;
        }

        return undefined;
    }

    // ========================================================================
    // RENDERER RESOLUTION
    // ========================================================================

    /**
     * Gets the best renderer for controlling a room.
     * Priority: Zone renderer > Virtual renderer by match > Physical renderer
     * @param {RoomState} room 
     * @returns {*} MediaRenderer or MediaRendererVirtual
     */
    _getRendererForRoom(room) {
        if (!room) return null;

        const deviceManager = this._getDeviceManager();
        const zoneManager = this._getZoneManager();
        if (!deviceManager) return null;

        // Strategy 1: Try live zone lookup
        let zoneUdn = zoneManager?.getZoneUDNFromRoomUDN(room.roomUdn) ?? null;

        // Strategy 2: Fall back to cached zone
        if (!zoneUdn && room.zoneUdn) {
            zoneUdn = room.zoneUdn;
        }

        // Strategy 3: Try direct zone renderer lookup
        if (zoneUdn) {
            const zoneRenderer = deviceManager.mediaRenderersVirtual.get(zoneUdn);
            if (zoneRenderer) return zoneRenderer;
        }

        // Strategy 4: Search virtual renderers by renderer UDN
        for (const [, renderer] of deviceManager.mediaRenderersVirtual) {
            const memberUdns = renderer.getRoomRendererUDNs?.() ?? [];
            if (room.rendererUdn && memberUdns.includes(room.rendererUdn)) {
                return renderer;
            }
        }

        // Strategy 5: Fall back to physical renderer (limited functionality)
        return deviceManager.mediaRenderers.get(room.rendererUdn);
    }

    /**
     * Gets or creates a virtual renderer for a room.
     * Used when switching from Spotify to standard UPnP playback.
     * @param {RoomState} room 
     * @returns {Promise<*>}
     */
    async _ensureVirtualRenderer(room) {
        if (!room) return undefined;

        const deviceManager = this._getDeviceManager();
        const zoneManager = this._getZoneManager();
        if (!deviceManager || !zoneManager) return undefined;

        // Force the room into UPnP mode by connecting to a zone
        try {
            await zoneManager.connectRoomToZone(room.roomUdn, '', false);
        } catch (err) {
            console.warn(`${LOG_PREFIX.RENDERER} Zone connect failed for ${room.name}: ${err.message}`);
        }

        // Poll for zone creation
        const maxAttempts = 15;
        for (let i = 0; i < maxAttempts; i++) {
            const zoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
            if (zoneUdn && deviceManager.mediaRenderersVirtual.has(zoneUdn)) {
                return deviceManager.mediaRenderersVirtual.get(zoneUdn);
            }
            if (i < maxAttempts - 1) {
                await this._delay(500);
            }
        }

        // Search by renderer UDN as fallback
        for (const [, renderer] of deviceManager.mediaRenderersVirtual) {
            const memberUdns = renderer.getRoomRendererUDNs?.() ?? [];
            if (memberUdns.includes(room.rendererUdn)) {
                return renderer;
            }
        }

        // Last resort: physical renderer
        console.warn(`${LOG_PREFIX.RENDERER} Could not create virtual renderer for ${room.name}`);
        return deviceManager.mediaRenderers.get(room.rendererUdn);
    }

    // ========================================================================
    // PLAYBACK STATE
    // ========================================================================

    /**
     * Gets the current playback state for a room
     * @param {RoomInfo} room 
     * @returns {NowPlayingState}
     */
    _getNowPlayingForRoom(room) {
        if (!this._state.isReady) return this._createEmptyNowPlaying();

        const deviceManager = this._getDeviceManager();
        if (!deviceManager) return this._createEmptyNowPlaying();

        // Try zone renderer first, then physical renderer
        let renderer = room.zoneUdn 
            ? deviceManager.mediaRenderersVirtual.get(room.zoneUdn)
            : null;

        if (!renderer) {
            renderer = deviceManager.mediaRenderers.get(room.rendererUdn);
        }

        return renderer 
            ? this._extractNowPlaying(renderer, room)
            : this._createEmptyNowPlaying();
    }

    /**
     * @returns {NowPlayingState}
     */
    _createEmptyNowPlaying() {
        return {
            artist: '',
            track: '',
            uri: '',
            image: '',
            isPlaying: false,
            isLoading: false,
            isMuted: false,
            volume: 0,
            canPlayPause: false,
            canPlayNext: false,
            canPlayPrev: false,
            duration: 0,
            position: 0,
            powerState: 'STANDBY'
        };
    }

    /**
     * Extracts playback state from a renderer
     * @param {*} renderer 
     * @param {RoomInfo} room - Room info to get physical renderer for power state
     * @returns {NowPlayingState}
     */
    _extractNowPlaying(renderer, room = null) {
        const state = renderer.rendererState;
        const metadata = this._parseMetadata(
            state.CurrentTrackMetaData || state.AVTransportURIMetaData
        );

        const isLoading = state.TransportState === 'TRANSITIONING';
        const isPlaying = state.TransportState === 'PLAYING';

        // Detect track changes by watching a fingerprint of AVTransportURI + CurrentTrack.
        // AVTransportURI alone is not enough for container/playlist playback where the URI
        // is a constant dlna-playcontainer:// reference and only CurrentTrack changes.
        // When the fingerprint changes we reset the position tracker to 0.
        // This is safe: our corrective Seek in play() does NOT change the URI or track
        // number, so this detection cannot be triggered by late subscription events.
        if (room) {
            const currentUri = state.AVTransportURI || '';
            const currentTrackNum = String(state.CurrentTrack ?? '');
            const fingerprint = currentUri ? `${currentUri}::${currentTrackNum}` : '';

            if (fingerprint) {
                if (room._resumeAnchorTrack === undefined) {
                    // First encounter — just record it; tracker may already be set
                    room._resumeAnchorTrack = fingerprint;
                    room._resumeAnchorUri = currentUri;
                } else if (fingerprint !== room._resumeAnchorTrack) {
                    // Track changed: device loaded a new track externally.
                    // Only reset _isLiveStream when the URI itself changes (new media source).
                    // If only the track number changed (same URI, e.g. song update on a radio
                    // stream), preserve the live-stream flag set earlier for that URI.
                    const uriActuallyChanged = currentUri !== room._resumeAnchorUri;
                    room._resumeAnchorTrack = fingerprint;
                    room._resumeAnchorUri = currentUri;
                    room._resumeAnchorSeconds = 0;
                    room._resumeAnchorTime = isPlaying ? Date.now() : null;
                    if (uriActuallyChanged) {
                        room._isLiveStream     = undefined;
                        room._radioOriginalUrl = undefined;
                        room._radioRefId       = undefined;
                        room._radioAvtMetadata = undefined;
                    }
                    console.log(`${LOG_PREFIX.RENDERER} Track changed for ${room.name}: position tracker reset`);
                }
            }

            // Thaw the position tracker when the device transitions to PLAYING.
            // This covers external play events (Music Assistant, original app) and
            // playlist auto-advance.  The freeze lives exclusively in pause() so
            // late subscription events from our corrective Seek cannot trigger it.
            if (isPlaying && room._resumeAnchorSeconds !== undefined && !room._resumeAnchorTime) {
                room._resumeAnchorTime = Date.now();
            }
        }

        // Parse transport actions
        let canPlayPause = false;
        let canPlayNext = false;
        let canPlayPrev = false;

        const actions = state.CurrentTransportActions ?? '';
        if (actions) {
            canPlayPause = /Play|Pause|Stop/i.test(actions);
            canPlayNext = actions.includes('Next');
            canPlayPrev = actions.includes('Previous');
        }

        // Detect radio/live-stream content from UPnP object class.
        // Stored on the room so play() can use it without re-parsing metadata.
        // STICKY: only ever set to true, never overwrite back to false.
        // When a radio station's "now playing" metadata updates, the UPnP class
        // often changes to musicTrack for the current song — overwriting with
        // false here would make play() think it's a file and issue a corrective
        // seek on the live stream, disconnecting the source.
        // The flag is reset to undefined only when a genuinely new URI is loaded
        // (loadUri / loadContainer / loadSingle, or URI change detected above).
        const isRadio = !!(metadata.classString?.includes('audioBroadcast') ||
                           metadata.classString?.includes('radio'));
        if (room && isRadio) room._isLiveStream = true;

        // ---- Radio session management --------------------------------------------
        // The Raumfeld kernel manages TuneIn session renewal internally via the
        // dlna-playsingle:// URI mechanism: when the zone renderer's AVTransportURI
        // is a dlna-playsingle:// reference, the kernel browses the MediaServer for
        // the item (obtaining the raumfeld:ebrowse URL from its DIDL-Lite metadata)
        // and handles all TuneIn session renewals without any assistance from us.
        //
        // Cache _radioRefId and _radioAvtMetadata for informational purposes.
        // They are no longer passed to loadSingle() in play(); play() now uses a
        // bare UPnP Play() command so the kernel can reuse its existing session state.
        //
        // Sources for the metadata (in priority order):
        //   1. AVTransportURIMetaData — set by the native Raumfeld app when it loads
        //      a station; contains ebrowse but no <res> URL.  Best choice.
        //   2. CurrentTrackMetaData with <res> stripped — always present after the
        //      first successful stream start, covers HA-initiated loads where
        //      AVTransportURIMetaData is minimal.
        if (room) {
            // Cache the content-directory refID (e.g. "0/Favorites/MyFavorites/36318")
            // so play() can reload the station after a drop.
            if (isRadio && metadata.refId) {
                room._radioRefId = metadata.refId;
            }

            // Cache station-level metadata that includes raumfeld:ebrowse so that
            // play() can issue a fresh-session reload when the user presses Play.
            if (isRadio) {
                const avtMeta   = state.AVTransportURIMetaData || '';
                const trackMeta = state.CurrentTrackMetaData  || '';
                if (avtMeta.includes('raumfeld:ebrowse')) {
                    // Ideal: native-app-provided metadata already has ebrowse and
                    // no raw session URL (no <res>) — use as-is.
                    room._radioAvtMetadata = avtMeta;
                } else if (trackMeta.includes('raumfeld:ebrowse') && !room._radioAvtMetadata) {
                    // Fallback: strip the <res> element from CurrentTrackMetaData so
                    // we pass station-level info only (the kernel fetches a fresh
                    // session URL via ebrowse at load time).
                    room._radioAvtMetadata = trackMeta.replace(/<res\b[^>]*>[\s\S]*?<\/res>/g, '');
                }
            }

            const prevState = room._prevTransportState;
            const currState = state.TransportState;
            room._prevTransportState = currState;

            // Record session-start time when entering PLAYING (only on the actual
            // transition into PLAYING, not on song-title metadata updates that fire
            // rendererStateChanged while already in PLAYING).
            if (currState === 'PLAYING' && prevState !== 'PLAYING') {
                room._lastPlayingTime = Date.now();
            }

            // Log when a live-stream session ends.
            // No auto-restart is issued: the Raumfeld kernel manages its own TuneIn
            // session renewals internally.  However, when a session was very short
            // (< 180 s) this indicates TuneIn is throttling the device serial.
            // The kernel auto-restarts ~28 s after such a drop, making another
            // ebrowse call that re-throttles TuneIn — a self-sustaining cascade.
            //
            // Break the cascade: send stop() 2 s after a short drop.  The kernel
            // interprets an explicit Stop while already stopped as "user wants it
            // stopped — cancel pending retry".  We guard on TransportState so the
            // stop() is skipped if the user or kernel has already restarted.
            //
            // Note: this is stop() while STOPPED (safe).  Calling stop() during
            // TRANSITIONING (as v1.2.53 did) caused an immediate re-TRANSITIONING
            // loop — that risk does not apply here.
            const isStopped = currState === 'STOPPED' || currState === 'NO_MEDIA_PRESENT';
            if (isStopped && room._isLiveStream === true) {
                if (prevState === 'PLAYING') {
                    const sessionAge = room._lastPlayingTime
                        ? (Date.now() - room._lastPlayingTime) : undefined;
                    const ageStr = sessionAge !== undefined
                        ? `${Math.round(sessionAge / 1000)}s` : '?';
                    console.log(`${LOG_PREFIX.COMMAND} Stream dropped for ${room.name} (session ${ageStr}) — press Play to restart`);

                    if (sessionAge !== undefined && sessionAge < 180000) {
                        const r2 = this._getRendererForRoom(room);
                        if (r2) {
                            console.log(
                                `${LOG_PREFIX.COMMAND} Short session (${ageStr}) for ${room.name}` +
                                ` — stop() in 2 s to cancel kernel auto-restart (TuneIn throttled)`
                            );
                            setTimeout(() => {
                                const st = r2.rendererState?.TransportState;
                                if (st === 'STOPPED' || st === 'NO_MEDIA_PRESENT') {
                                    r2.stop().catch(() => {});
                                }
                            }, 2000);
                        }
                    }
                } else if (prevState === 'TRANSITIONING') {
                    console.log(`${LOG_PREFIX.COMMAND} Stream load failed or stopped for ${room.name}`);
                }
            }
        }
        // --------------------------------------------------------------------------

        // Fallback: Enable next/prev for container-based content (e.g. playlists)
        // only if not already explicitly enabled by transport actions.
        if (!canPlayNext || !canPlayPrev) {
            const isContainer = this._isContainerMedia(metadata.classString);
            const hasMultipleTracks = (parseInt(state.NumberOfTracks) || 0) > 1;

            // Radio stations never fallback to enabling next/prev buttons unless explicitly
            // reported by the device's current transport actions.
            if (!isRadio && ((isContainer && metadata.track) || hasMultipleTracks)) {
                canPlayNext = true;
                canPlayPrev = true;
            }
        }

        // PowerState must come from the PHYSICAL renderer, not the zone renderer
        // Zone renderers don't have accurate PowerState for individual devices
        let powerState = 'ACTIVE';
        if (room) {
            const deviceManager = this._getDeviceManager();
            const physicalRenderer = deviceManager?.mediaRenderers.get(room.rendererUdn);
            powerState = physicalRenderer?.rendererState?.PowerState || 'ACTIVE';
        } else {
            // Fallback if no room info provided
            powerState = state.PowerState || 'ACTIVE';
        }

        // Parse time strings to seconds (helper)
        const parseToSeconds = (timeVal) => {
            if (typeof timeVal === 'number') return timeVal;
            if (!timeVal) return 0;
            try {
                const parts = timeVal.split(':').map(Number);
                if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                if (parts.length === 2) return parts[0] * 60 + parts[1];
                return 0;
            } catch {
                return 0;
            }
        };

        const durationSeconds = parseToSeconds(state.CurrentTrackDuration);
        const positionSeconds = typeof state.RelativeTimePosition === 'number' 
            ? state.RelativeTimePosition 
            : parseToSeconds(state.RelativeTimePosition);

        // Derive shuffle / repeat from UPnP CurrentPlayMode
        const playMode = (state.CurrentPlayMode || 'NORMAL').toUpperCase();
        const shuffle = playMode === 'SHUFFLE' || playMode === 'RANDOM';
        let repeat = 'off';
        if (playMode === 'REPEAT_ONE') repeat = 'one';
        else if (playMode === 'REPEAT_ALL' || playMode === 'RANDOM') repeat = 'all';

        return {
            artist: metadata.artist,
            track: metadata.track,
            album: metadata.album,
            uri: metadata.uri || state.AVTransportURI || '',
            image: this._sanitizeImageUrl(metadata.image),
            classString: metadata.classString,
            isPlaying,
            isLoading,
            isMuted: state.Mute === 1,
            volume: parseInt(state.Volume) || 0,
            canPlayPause,
            canPlayNext,
            canPlayPrev,
            duration: state.CurrentTrackDuration || 0,
            durationSeconds,
            position: this._getPositionForRoom(room, state.RelativeTimePosition || 0),
            positionSeconds: this._getPositionForRoom(room, positionSeconds),
            shuffle,
            repeat,
            powerState
        };
    }

    /**
     * Gets the position for a room, using seek position if recently seeked
     * @param {RoomInfo} room 
     * @param {number} defaultPosition - Position in seconds
     * @returns {number} Position in seconds
     */
    _getPositionForRoom(room, defaultPosition) {
        if (!room) return defaultPosition;

        // Recent explicit seek override (5-second window)
        const seekTime = room._lastSeekTime;
        const seekPos = room._lastSeekPosition;
        if (seekTime && typeof seekPos === 'number' && (Date.now() - seekTime) < 5000) {
            return seekPos;
        }

        // Elapsed-time position tracker.
        //   _resumeAnchorSeconds  – last-known position in seconds
        //   _resumeAnchorTime     – wall-clock when tracking started (null = frozen/paused)
        // This avoids relying on the Raumfeld device's RelativeTimePosition which does
        // not advance during playback (it stays frozen at the last seek anchor).
        if (room._resumeAnchorSeconds !== undefined) {
            if (room._resumeAnchorTime) {
                // Device is playing: position = anchor + elapsed
                return Math.max(0, room._resumeAnchorSeconds + (Date.now() - room._resumeAnchorTime) / 1000);
            }
            // Device is paused/stopped: return frozen position
            return Math.max(0, room._resumeAnchorSeconds);
        }

        return defaultPosition;
    }

    _isContainerMedia(classString) {
        if (!classString) return false;
        // UPnP container classes start with object.container
        // We also include podcast to handle podcast containers, but exclude items like musicTrack
        return classString.startsWith('object.container') || 
               /playlist|album|podcastContainer/i.test(classString);
    }

    /**
     * Sanitizes an image URL, upgrading to HTTPS where supported.
     * Local Raumfeld device URLs (e.g., /raumfeldImage on private IPs) are kept as HTTP
     * because the device doesn't support TLS on these endpoints.
     * @param {string} url 
     * @returns {string}
     */
    _sanitizeImageUrl(url) {
        if (!url) return '';
        // Don't convert local Raumfeld image proxy URLs to HTTPS - device doesn't support TLS
        // These URLs point to the Raumfeld host and redirect to external services
        if (url.includes('/raumfeldImage') || 
            /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|localhost|127\.)/.test(url)) {
            return url;
        }
        // Upgrade external URLs to HTTPS
        return url.replace('http://', 'https://');
    }

    // ========================================================================
    // METADATA PARSING
    // ========================================================================

    /**
     * Parses DIDL-Lite XML metadata
     * @param {string} xml 
     * @returns {MediaMetadata}
     */
    _parseMetadata(xml) {
        const result = { track: '', artist: '', album: '', image: '', uri: '', classString: '', ebrowseUrl: '', refId: '' };
        if (!xml) return result;

        try {
            const parser = new (new JSDOM('')).window.DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');

            const getText = (tag) => doc.getElementsByTagName(tag)[0]?.textContent ?? '';

            result.classString = getText('upnp:class');
            result.track = getText('dc:title');
            result.artist = getText('upnp:artist');
            result.album = getText('upnp:album');
            result.image = getText('upnp:albumArtURI');
            result.uri = getText('res');
            // Raumfeld-specific: URL used to get a fresh TuneIn session URL on renewal
            result.ebrowseUrl = getText('raumfeld:ebrowse');
            // Content-directory reference ID used by play() to reload the station
            // via loadSingle() after a TuneIn session drop.
            //
            // Critical: the Raumfeld kernel only sets up internal TuneIn session renewal
            // (the raumfeld:ebrowse mechanism) when the item is loaded via a Favorites or
            // RecentlyPlayed path.  When loaded directly from 0/RadioTime/Search/s-XXXXX
            // the kernel skips renewal and the session drops after the initial 120 s.
            //
            // Priority:
            //   1. id starts with "0/Favorites/" → use id directly (Favorites/RecentlyPlayed
            //      path enables kernel renewal; after loadSingle the metadata keeps the same
            //      Favorites id, so subsequent restarts stay on the renewal-capable path)
            //   2. refID present → use refID (RadioTime canonical id for the station)
            //   3. Fall back to id (RadioTime/Search path — renewal won't work, but it's
            //      the best we have when no Favorites path is available)
            const itemEl = doc.getElementsByTagName('item')[0];
            const idAttr   = itemEl?.getAttribute('id')    ?? '';
            const refIDAttr = itemEl?.getAttribute('refID') ?? '';
            result.refId = idAttr.startsWith('0/Favorites/') ? idAttr : (refIDAttr || idAttr);
        } catch (err) {
            console.warn(`${LOG_PREFIX.MEDIA} Metadata parse error: ${err.message}`);
        }

        return result;
    }

    // ========================================================================
    // PLAYBACK COMMANDS
    // ========================================================================

    async seek(roomIdentifier, value) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        // Format value to HH:MM:SS if it's a number (seconds)
        let targetValue = value;
        if (typeof value === 'number') {
            const h = Math.floor(value / 3600);
            const m = Math.floor((value % 3600) / 60);
            const s = Math.floor(value % 60);
            targetValue = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }

        // Perform the seek
        console.log(`${LOG_PREFIX.COMMAND} Seeking ${room.name} to ${targetValue} (raw: ${value})`);
        await renderer.seek('ABS_TIME', targetValue);

        // Wait briefly for the seek to take effect
        await this._delay(300);

        // Poll the new position and update state for all rooms in the zone
        try {
            const positionInfo = await renderer.getPositionInfo();
            if (positionInfo) {
                // Update position for all rooms in this zone
                const zoneUdn = room.zoneUdn;
                for (const r of this._rooms.values()) {
                    if (r.zoneUdn === zoneUdn || r.roomUdn === room.roomUdn) {
                        // Force position update in next broadcast
                        // Store as seconds for consistency with positionSeconds
                        r._lastSeekPosition = typeof value === 'number' ? value : 0;
                        r._lastSeekTime = Date.now();
                        // Advance the elapsed-time tracker to the new seek position
                        // so display and resume both stay correct after this seek.
                        r._resumeAnchorSeconds = r._lastSeekPosition;
                        r._resumeAnchorTime = Date.now();
                    }
                }
                
                // Broadcast updated state immediately
                this._broadcastRoomStates();
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX.COMMAND} Failed to get position after seek: ${err.message}`);
            // Still broadcast to update clients
            this._broadcastRoomStates();
        }
    }

    async play(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;


        await this._wakeRenderer(renderer);

        // Work around a Raumfeld device quirk: when resuming from PAUSED_PLAYBACK
        // the device restarts from the last seek anchor (set by SetAVTransportURI or
        // a prior Seek call) instead of the actual paused position. This is most
        // visible with Music Assistant playback where the player loads a URI and then
        // seeks into it — the anchor stays at the seek target, so a later pause +
        // resume jumps back to that target rather than where playback was paused.
        //
        // Fix: before calling play(), refresh the anchor to the current position by
        // issuing a Seek to that position while still paused, then wait for the device
        // to process the seek before resuming play.
        //
        // IMPORTANT: The corrective seek is only safe for finite-duration file media.
        // Live streams (TuneIn, internet radio) have no duration and don't support
        // seeking. Attempting a seek on a live stream causes the device to disconnect
        // from the source; the device may play from a small buffer for a while, then
        // stop. We detect this via CurrentTransportActions ("Seek" absent) and
        // CurrentTrackDuration (zero/NOT_IMPLEMENTED means live stream).
        //
        // We also skip the seek when the track URI changed externally (e.g. Music
        // Assistant loaded a new track bypassing our loadUri), because our elapsed-
        // time tracker would be stale from the previous track.
        if (renderer.rendererState?.TransportState === 'PAUSED_PLAYBACK') {
            // Four independent live-stream guards — any one is enough to skip seek:
            //  1. Duration: missing / zero / NOT_IMPLEMENTED → no seekable timeline
            //  2. Media class: audioBroadcast / radio stored from last _extractNowPlaying call
            //     (sticky: set to true and never overwritten by song-metadata updates on
            //      the same URI — see _extractNowPlaying for details)
            //  3. Fresh metadata parse: catches the window after loadUri() resets
            //     _isLiveStream but before the first state update arrives
            //  4. URI extension: stream URLs (TuneIn, internet radio) never end with
            //     a common audio file extension; NAS files almost always do.
            //     This is the most reliable guard when the device reports the current
            //     *song* class (musicTrack) rather than the station class (audioBroadcast),
            //     causing guards 1-3 to all evaluate false.
            //     Exception: dlna-playcontainer / dlna-playsingle URIs are finite-media
            //     containers and must still be seekable.
            const durationStr = renderer.rendererState?.CurrentTrackDuration ?? '';
            const isLiveByDuration = !durationStr || durationStr === '0:00:00' || durationStr === 'NOT_IMPLEMENTED';
            const isLiveByClass = !!(room?._isLiveStream);
            const metaXml = renderer.rendererState?.CurrentTrackMetaData ||
                            renderer.rendererState?.AVTransportURIMetaData || '';
            let isLiveByMeta = false;
            if (metaXml) {
                try {
                    const meta = this._parseMetadata(metaXml);
                    isLiveByMeta = !!(meta.classString?.includes('audioBroadcast') ||
                                      meta.classString?.includes('radio'));
                } catch { /* ignore parse errors */ }
            }
            const transportActions = renderer.rendererState?.CurrentTransportActions ?? '';
            const canSeek = /\bSeek\b/i.test(transportActions);
            const currentUri = renderer.rendererState?.AVTransportURI ?? '';
            const currentTrackNum = String(renderer.rendererState?.CurrentTrack ?? '');
            const currentFingerprint = currentUri ? `${currentUri}::${currentTrackNum}` : '';
            const trackerFingerprint = room?._resumeAnchorTrack;
            const uriChanged = !!(trackerFingerprint && currentFingerprint && trackerFingerprint !== currentFingerprint);

            // Guard 4: URIs that lack an audio file extension are treated as streams.
            // dlna-play* URIs are container/single references (always finite files).
            const audioExtRe = /\.(mp3|flac|wav|aac|ogg|wma|m4a|opus|alac|aiff|ape|ac3|dts|aif|dsf|dff)(\?|#|$)/i;
            const isDlnaContainer = /^dlna-play(container|single):\/\//i.test(currentUri);
            const isLiveByUri = !audioExtRe.test(currentUri) && !isDlnaContainer;

            const isLiveStream = isLiveByDuration || isLiveByClass || isLiveByMeta || isLiveByUri;

            let pos = null;

            if (room?._resumeAnchorSeconds !== undefined) {
                // Position tracker is initialised — use it (works for both the first
                // pause and all subsequent ones).
                //   • _resumeAnchorTime == null  → timer frozen at pause: use as-is
                //   • _resumeAnchorTime != null  → timer still running (edge case):
                //                                   add elapsed to get current position
                let anchorSeconds = room._resumeAnchorSeconds;
                if (room._resumeAnchorTime) {
                    anchorSeconds += (Date.now() - room._resumeAnchorTime) / 1000;
                }
                anchorSeconds = Math.max(0, anchorSeconds);
                const h = Math.floor(anchorSeconds / 3600);
                const m = Math.floor((anchorSeconds % 3600) / 60);
                const s = Math.floor(anchorSeconds % 60);
                pos = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            } else {
                // No position tracking yet (no loadUri/seek before this resume) —
                // fall back to getPositionInfo() which is reliable on the very first
                // pause before any of our corrective seeks have run.
                try {
                    const posInfo = await renderer.getPositionInfo();
                    const relTime = posInfo?.RelTime;
                    if (relTime && relTime !== '0:00:00' && relTime !== 'NOT_IMPLEMENTED') {
                        pos = relTime;
                    }
                } catch {
                    const statePos = renderer.rendererState?.RelativeTimePosition;
                    if (statePos && statePos !== '0:00:00' && statePos !== 'NOT_IMPLEMENTED') {
                        pos = statePos;
                    }
                }
            }

            // Diagnostic log — visible in add-on logs whenever play() is called
            // after a pause. Useful for diagnosing stream-stop regressions.
            console.log(
                `${LOG_PREFIX.COMMAND} play() resume for ${room?.name}: ` +
                `byDur=${isLiveByDuration} byClass=${isLiveByClass} byMeta=${isLiveByMeta} ` +
                `byUri=${isLiveByUri} → isLive=${isLiveStream} | ` +
                `canSeek=${canSeek} pos=${pos} uriChanged=${uriChanged} | ` +
                `uri="${currentUri.slice(0, 80)}" dur="${durationStr}"`
            );

            if (pos && !isLiveStream && canSeek && !uriChanged) {
                try {
                    await renderer.seek('ABS_TIME', pos);
                    // Give the device time to process the seek before play() is issued;
                    // without this pause the device may not have updated its anchor yet
                    // and will still resume from the old position.
                    await this._delay(300);
                    // Record anchor + start-time so subsequent resumes can estimate
                    // position via elapsed time instead of querying the device.
                    if (room) {
                        const parts = pos.split(':').map(Number);
                        room._resumeAnchorSeconds = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
                        room._resumeAnchorTime = Date.now();
                    }
                    console.log(`${LOG_PREFIX.COMMAND} Resume anchor refreshed: ${room?.name} → ${pos}`);
                } catch (err) {
                    console.warn(`${LOG_PREFIX.COMMAND} Resume anchor refresh failed for ${room?.name}: ${err.message}`);
                }
            } else {
                // Seek skipped — just unfreeze the position tracker so elapsed time
                // continues to advance from the frozen position.
                if (room?._resumeAnchorSeconds !== undefined && !room._resumeAnchorTime) {
                    room._resumeAnchorTime = Date.now();
                }
                if (uriChanged) {
                    // Track changed externally; invalidate the stale tracker so the
                    // next resume starts fresh.
                    if (room) {
                        room._resumeAnchorSeconds = undefined;
                        room._resumeAnchorUri = currentUri;
                    }
                    console.log(`${LOG_PREFIX.COMMAND} Skipping seek: URI changed externally for ${room?.name}`);
                } else if (isLiveStream) {
                    console.log(`${LOG_PREFIX.COMMAND} Skipping seek: live stream for ${room?.name}`);
                } else if (!canSeek) {
                    console.log(`${LOG_PREFIX.COMMAND} Skipping seek: not supported by device for ${room?.name}`);
                }
            }
        }

        // For live radio streams in STOPPED state: use a bare UPnP Play() command.
        // The zone renderer already has the dlna-playsingle:// URI loaded; Play() tells
        // the Raumfeld kernel to restart the stream using its own internal session state.
        // This mirrors exactly what the kernel does on its own auto-restart (it issues
        // Play(), not SetAVTransportURI), and TuneIn treats it as a session continuation
        // rather than a brand-new request — so the response is much faster and the
        // resulting CDN session is longer-lived.
        //
        // We previously called loadSingle(durability=0) here, which forced a completely
        // new TuneIn ebrowse call.  TuneIn rate-limits new-session requests far more
        // aggressively than renewals: in throttled conditions this caused multi-minute
        // TRANSITIONING hangs and progressively shorter sessions.
        // PAUSED_PLAYBACK is not affected: the CDN connection is still live.
        if (room?._isLiveStream === true &&
            renderer.rendererState?.TransportState === 'STOPPED') {
            console.log(
                `${LOG_PREFIX.COMMAND} play() live stream (STOPPED→kernel restart) for ${room.name}`
            );
            room._lastPlayCommandTime = Date.now();
            return renderer.play();
        }

        // Live stream already in TRANSITIONING: the kernel is already contacting TuneIn.
        // Interrupting with stop()+loadSingle resets the ebrowse clock and makes any
        // ongoing throttle worse.  Do nothing — let the kernel finish the transition.
        // If the user needs to abort a very long hang, they should press Stop first
        // (which puts the renderer in STOPPED), then Play.
        if (room?._isLiveStream === true &&
            renderer.rendererState?.TransportState === 'TRANSITIONING') {
            console.log(
                `${LOG_PREFIX.COMMAND} play() live stream (TRANSITIONING→wait) for ${room.name}` +
                ` — kernel already loading, not interrupting`
            );
            return;
        }

        return renderer.play();
    }

    async pause(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);

        // Freeze the elapsed-time tracker at the current position estimate.
        // Doing this here — when the pause command is received — avoids a race
        // condition where a late subscription event from our corrective Seek
        // (which carries TransportState=PAUSED_PLAYBACK from while we were still
        // paused) arrives after _resumeAnchorTime was set, triggering a spurious
        // freeze that resets the position back to the first-pause value.
        if (room && room._resumeAnchorSeconds !== undefined && room._resumeAnchorTime) {
            const elapsed = (Date.now() - room._resumeAnchorTime) / 1000;
            room._resumeAnchorSeconds = Math.max(0, room._resumeAnchorSeconds + elapsed);
            room._resumeAnchorTime = null;
        }


        if (renderer) return renderer.pause();
    }

    async stop(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        // Stop resets the device; clear the elapsed-time tracker so the next
        // pause/resume cycle starts fresh from whatever new track/position is loaded.
        if (room) {
            room._resumeAnchorSeconds = undefined;
            room._resumeAnchorTime = null;
        }

        try {
            return await renderer.stop();
        } catch (err) {
            // 701 = Transition not available (already stopped)
            if (err.errorCode === '701' || err.message?.includes('701')) {
                return;
            }
            // Try pause as fallback
            try {
                return await renderer.pause();
            } catch {
                console.warn(`${LOG_PREFIX.COMMAND} Stop/pause failed for ${room?.name}`);
            }
        }
    }

    async next(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.next();
    }

    /**
     * Sets shuffle on or off while preserving the current repeat mode.
     * UPnP play-mode matrix:
     *   shuffle=false, repeat=off  → NORMAL
     *   shuffle=true,  repeat=off  → SHUFFLE
     *   shuffle=false, repeat=one  → REPEAT_ONE
     *   shuffle=false, repeat=all  → REPEAT_ALL
     *   shuffle=true,  repeat=all  → RANDOM
     * @param {string} roomIdentifier
     * @param {boolean} shuffle
     */
    async setShuffle(roomIdentifier, shuffle) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        const current = (renderer.rendererState?.CurrentPlayMode || 'NORMAL').toUpperCase();
        const repeatAll = current === 'REPEAT_ALL' || current === 'RANDOM';
        const repeatOne = current === 'REPEAT_ONE';

        let mode;
        if (shuffle) {
            mode = repeatAll ? 'RANDOM' : 'SHUFFLE';
        } else {
            if (repeatAll) mode = 'REPEAT_ALL';
            else if (repeatOne) mode = 'REPEAT_ONE';
            else mode = 'NORMAL';
        }

        console.log(`${LOG_PREFIX.COMMAND} SetPlayMode ${room?.name}: shuffle=${shuffle} → ${mode}`);
        return renderer.setPlayMode(mode);
    }

    /**
     * Sets repeat mode while preserving the current shuffle state.
     * @param {string} roomIdentifier
     * @param {'off'|'one'|'all'} repeat - HA repeat mode string
     */
    async setRepeat(roomIdentifier, repeat) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (!renderer) return;

        const current = (renderer.rendererState?.CurrentPlayMode || 'NORMAL').toUpperCase();
        const isShuffle = current === 'SHUFFLE' || current === 'RANDOM';

        let mode;
        if (repeat === 'all') {
            mode = isShuffle ? 'RANDOM' : 'REPEAT_ALL';
        } else if (repeat === 'one') {
            mode = 'REPEAT_ONE';
        } else {
            mode = isShuffle ? 'SHUFFLE' : 'NORMAL';
        }

        console.log(`${LOG_PREFIX.COMMAND} SetPlayMode ${room?.name}: repeat=${repeat} → ${mode}`);
        return renderer.setPlayMode(mode);
    }

    async playSystemSound(roomIdentifier, soundId) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        // System sounds must be played on the physical renderer, not the virtual zone renderer
        const deviceManager = this._getDeviceManager();
        const renderer = deviceManager?.mediaRenderers.get(room.rendererUdn);

        if (renderer) {
            // Wake the device from standby if needed
            await this._wakeRenderer(renderer);
            return renderer.playSystemSound(soundId);
        } else {
             console.warn(`${LOG_PREFIX.COMMAND} System sound failed: No physical renderer found for room ${room.name} (${room.roomUdn})`);
        }
    }

    async prev(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) {
            try {
                // Call prev twice for proper track rewind behavior
                await renderer.prev();
                await renderer.prev();
            } catch (err) {
                // 701 = Transition not available
                if (err.errorCode === '701' || err.message?.includes('701')) {
                    console.warn(`${LOG_PREFIX.COMMAND} Prev (701) ignored for ${room?.name}`);
                    return;
                }
                throw err;
            }
        }
    }

    async setVolume(roomIdentifier, volume) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.setVolume(volume);
    }

    async setMute(roomIdentifier, mute) {
        const room = this.findRoom(roomIdentifier);
        const renderer = this._getRendererForRoom(room);
        if (renderer) return renderer.setMute(mute);
    }

    async enterStandby(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        console.log(`${LOG_PREFIX.COMMAND} Entering standby for ${room.name} (Room UDN: ${room.roomUdn}, Renderer UDN: ${room.rendererUdn})`);

        try {
            // We must target the physical renderer for standby
            const deviceManager = this._getDeviceManager();
            const renderer = deviceManager.mediaRenderers.get(room.rendererUdn);
            
            if (renderer) {
                if (renderer.enterManualStandby) {
                    await renderer.enterManualStandby();
                    console.log(`${LOG_PREFIX.COMMAND} Successfully entered standby for ${room.name}`);
                    
                    // Wait a moment for the renderer state to update
                    await this._delay(500);
                    
                    // Broadcast updated state immediately
                    this._broadcastRoomStates();
                } else {
                     console.warn(`${LOG_PREFIX.COMMAND} Renderer ${room.name} does not support enterManualStandby`);
                }
            } else {
                 console.warn(`${LOG_PREFIX.COMMAND} Renderer not found for ${room.name}. Available renderers: ${Array.from(deviceManager.mediaRenderers.keys()).join(', ')}`);
            }
        } catch (err) {
             console.error(`${LOG_PREFIX.COMMAND} Failed to enter standby for ${room.name}: ${err.message}`);
             throw err; // Re-throw so caller knows it failed
        }
    }

    // ========================================================================
    // GROUPING COMMANDS
    // ========================================================================

    async joinGroup(roomIdentifier, zoneIdentifier) {
        const room = this.findRoom(roomIdentifier);
        if (!room) {
             console.warn(`${LOG_PREFIX.COMMAND} joinGroup: Room not found for identifier ${roomIdentifier}`);
             return;
        }

        const zoneManager = this._getZoneManager();
        const deviceManager = this._getDeviceManager();
        if (!zoneManager || !deviceManager) {
            console.error(`${LOG_PREFIX.COMMAND} joinGroup failed: managers not available`);
            return;
        }

        // Resolve target zone UDN
        let targetZoneUdn = zoneIdentifier;
        const targetRoom = this.findRoom(zoneIdentifier);
        
        // Check if target has a valid zone
        if (targetRoom) {
            if (targetRoom.zoneUdn) {
                targetZoneUdn = targetRoom.zoneUdn;
            } else {
                // Target room exists but has no zone (likely Spotify mode)
                // We need to create a zone for the target first
                console.log(`${LOG_PREFIX.COMMAND} Target room ${targetRoom.name} has no zone (likely Spotify mode), creating zone first`);
                
                try {
                    // Create a standalone zone for the target room to force UPnP mode
                    await zoneManager.connectRoomToZone(targetRoom.roomUdn, '', false);
                    
                    // Wait for the zone to be created
                    const maxAttempts = 15;
                    let targetZoneCreated = false;
                    for (let i = 0; i < maxAttempts; i++) {
                        const newZoneUdn = zoneManager.getZoneUDNFromRoomUDN(targetRoom.roomUdn);
                        if (newZoneUdn && deviceManager.mediaRenderersVirtual.has(newZoneUdn)) {
                            console.log(`${LOG_PREFIX.COMMAND} Target room ${targetRoom.name} now has zone: ${newZoneUdn}`);
                            targetZoneUdn = newZoneUdn;
                            targetZoneCreated = true;
                            
                            // Wait for the Raumfeld host to stabilize after zone creation
                            // Without this delay, immediate join attempts may silently fail
                            // Increased to 4s as 1.5s was sometimes insufficient
                            console.log(`${LOG_PREFIX.COMMAND} Waiting for zone to stabilize...`);
                            await this._delay(4000);
                            break;
                        }
                        if (i < maxAttempts - 1) {
                            await this._delay(500);
                        }
                    }
                    
                    if (!targetZoneCreated) {
                        console.warn(`${LOG_PREFIX.COMMAND} Target room ${targetRoom.name} zone creation may not have completed`);
                        // Use room UDN as fallback
                        targetZoneUdn = targetRoom.roomUdn;
                    }
                } catch (err) {
                    console.warn(`${LOG_PREFIX.COMMAND} Failed to create zone for target ${targetRoom.name}: ${err.message}`);
                    targetZoneUdn = targetRoom.roomUdn;
                }
            }
        }

        console.log(`${LOG_PREFIX.COMMAND} Joining ${room.name} (${room.roomUdn}) to zone ${targetZoneUdn}`);

        // Check if the room being joined currently has a virtual renderer (i.e., is in UPnP mode)
        // If not, the room is likely in Spotify Connect mode and needs to be transitioned first
        let roomHasVirtualRenderer = false;
        const currentZoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
        if (currentZoneUdn && deviceManager.mediaRenderersVirtual.has(currentZoneUdn)) {
            roomHasVirtualRenderer = true;
        }
        
        if (!roomHasVirtualRenderer) {
            // Room is likely in Spotify Connect mode - transition it to UPnP mode first
            // by creating a standalone zone for it
            console.log(`${LOG_PREFIX.COMMAND} Room ${room.name} has no virtual renderer (likely Spotify mode), transitioning to UPnP mode first`);
            
            try {
                // Create a standalone zone for this room to force UPnP mode
                await zoneManager.connectRoomToZone(room.roomUdn, '', false);
                
                // Wait for the zone and virtual renderer to be created
                const maxAttempts = 15;
                let transitioned = false;
                for (let i = 0; i < maxAttempts; i++) {
                    const newZoneUdn = zoneManager.getZoneUDNFromRoomUDN(room.roomUdn);
                    if (newZoneUdn && deviceManager.mediaRenderersVirtual.has(newZoneUdn)) {
                        console.log(`${LOG_PREFIX.COMMAND} Room ${room.name} successfully transitioned to UPnP mode (zone: ${newZoneUdn})`);
                        transitioned = true;
                        break;
                    }
                    if (i < maxAttempts - 1) {
                        await this._delay(500);
                    }
                }
                
                if (!transitioned) {
                    console.warn(`${LOG_PREFIX.COMMAND} Room ${room.name} may not have fully transitioned to UPnP mode, attempting join anyway`);
                }
            } catch (err) {
                console.warn(`${LOG_PREFIX.COMMAND} Failed to create standalone zone for ${room.name}: ${err.message}`);
                // Continue anyway - the main connectRoomToZone might still work
            }
        }
        
        // Now connect room to the target zone
        try {
            await zoneManager.connectRoomToZone(room.roomUdn, targetZoneUdn);
            console.log(`${LOG_PREFIX.COMMAND} Successfully joined ${room.name} to zone ${targetZoneUdn}`);
        } catch (err) {
            console.error(`${LOG_PREFIX.COMMAND} joinGroup failed: ${err.message}`);
            throw err;
        }
    }

    async leaveGroup(roomIdentifier) {
        const room = this.findRoom(roomIdentifier);
        if (!room) {
             console.warn(`${LOG_PREFIX.COMMAND} leaveGroup: Room not found for identifier ${roomIdentifier}`);
             return;
        }

        console.log(`${LOG_PREFIX.COMMAND} Removing ${room.name} (${room.roomUdn}) from zone`);

        const zoneManager = this._getZoneManager();
        if (zoneManager) {
            try {
                // dropRoomFromZone takes the room UDN
                await zoneManager.dropRoomFromZone(room.roomUdn);
            } catch (err) {
                console.error(`${LOG_PREFIX.COMMAND} leaveGroup failed: ${err.message}`);
                throw err;
            }
        }
    }

    // ========================================================================
    // MEDIA LOADING
    // ========================================================================

    async loadUri(roomIdentifier, url) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadUri) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadUri) {
            await this._wakeRenderer(renderer);
            // New track: reset position tracker and live-stream flag.
            room._resumeAnchorSeconds = 0;
            room._resumeAnchorTime    = Date.now();
            room._resumeAnchorUri     = url;
            room._resumeAnchorTrack   = undefined; // Will be set by _extractNowPlaying after load
            room._isLiveStream          = undefined; // Will be re-detected from metadata
            room._radioOriginalUrl      = url;
            room._lastPlayCommandTime   = Date.now();
            return renderer.loadUri(url);
        }

        console.error(`${LOG_PREFIX.MEDIA} No renderer for URI load: ${room.name}`);
    }

    async loadContainer(roomIdentifier, containerId) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadContainer) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadContainer) {
            await this._wakeRenderer(renderer);
            // New track: reset position tracker and live-stream flag
            room._resumeAnchorSeconds = 0;
            room._resumeAnchorTime    = Date.now();
            room._resumeAnchorTrack   = undefined;
            room._isLiveStream          = undefined;
            room._lastPlayCommandTime   = Date.now();
            console.log(`${LOG_PREFIX.MEDIA} Loading container ${containerId} on ${room.name}`);
            return renderer.loadContainer(containerId);
        }

        console.warn(`${LOG_PREFIX.MEDIA} No renderer for container load: ${room.name}`);
    }

    async loadSingle(roomIdentifier, itemId) {
        const room = this.findRoom(roomIdentifier);
        if (!room) return;

        let renderer = this._getRendererForRoom(room);

        if (!renderer?.loadSingle) {
            renderer = await this._ensureVirtualRenderer(room);
        }

        if (renderer?.loadSingle) {
            await this._wakeRenderer(renderer);
            // New track: reset position tracker and live-stream flag
            room._resumeAnchorSeconds = 0;
            room._resumeAnchorTime    = Date.now();
            room._resumeAnchorTrack   = undefined;
            room._isLiveStream          = undefined;
            room._radioAvtMetadata      = undefined;
            room._lastPlayCommandTime   = Date.now();
            console.log(`${LOG_PREFIX.MEDIA} Loading single ${itemId} on ${room.name}`);
            return renderer.loadSingle(itemId);
        }

        console.warn(`${LOG_PREFIX.MEDIA} No renderer for single load: ${room.name}`);
    }




    /**
     * Returns a copy of a DIDL-Lite metadata string with raumfeld:durability
     * forced to 0 (expired).  Passing durability=0 (or negative) to the
     * Raumfeld kernel's SetAVTransportURI signals that the current TuneIn
     * session is expired, prompting the kernel to immediately call the
     * raumfeld:ebrowse URL and obtain a fresh session URL.
     *
     * If durability is NOT zeroed at restart time the kernel reuses the
     * previous — already-expired — session URL, causing the stream to drop
     * almost immediately again.
     *
     * @param {string} metaXml  DIDL-Lite XML (may be empty)
     * @returns {string}  XML with durability replaced by 0, or original if no match
     */
    /**
     * Wakes up all physical renderers in a virtual renderer
     * Only wakes devices that are actually in standby
     * @param {*} renderer 
     */
    async _wakeRenderer(renderer) {
        if (!renderer) return;

        // Physical renderer
        if (renderer.leaveStandby && !renderer.getRoomRendererUDNs) {
            // Only wake if in standby
            const powerState = renderer.rendererState?.PowerState;
            if (powerState && powerState.includes('STANDBY')) {
                try {
                    await renderer.leaveStandby(true);
                } catch { /* ignore */ }
            }
            return;
        }

        // Virtual renderer - wake all physical members
        const memberUdns = renderer.getRoomRendererUDNs?.() ?? [];
        const deviceManager = this._getDeviceManager();

        for (const udn of memberUdns) {
            const physicalRenderer = deviceManager?.getMediaRenderer(udn);
            if (physicalRenderer?.leaveStandby) {
                // Only wake if in standby
                const powerState = physicalRenderer.rendererState?.PowerState;
                if (powerState && powerState.includes('STANDBY')) {
                    try {
                        await physicalRenderer.leaveStandby(true);
                    } catch { /* ignore */ }
                }
            }
        }
    }

    // ========================================================================
    // MEDIA BROWSING
    // ========================================================================

    async browse(objectId = '0') {
        const mediaServer = this._getDeviceManager()?.getRaumfeldMediaServer();
        if (!mediaServer) {
            console.warn(`${LOG_PREFIX.BROWSE} No media server available`);
            return [];
        }

        try {
            const response = await mediaServer.browse(objectId);
            return this._parseBrowseResponse(response);
        } catch (err) {
            console.error(`${LOG_PREFIX.BROWSE} Error browsing ${objectId}: ${err.message}`);
            return [];
        }
    }

    /**
     * @param {string|Array} response 
     * @returns {Array}
     */
    _parseBrowseResponse(response) {
        if (!response) return [];

        if (typeof response === 'string') {
            return this._parseBrowseXml(response);
        }

        if (Array.isArray(response)) {
            return response.map(item => ({
                id: item.id,
                title: item.title || item.name || 'Unknown',
                artist: item.artist,
                album: item.album,
                image: this._sanitizeImageUrl(item.albumArtURI),
                class: item.class,
                playable: item.class?.startsWith('object.item') || item.class?.startsWith('object.container'),
                isContainer: item.class?.startsWith('object.container') ?? false
            }));
        }

        return [];
    }

    /**
     * Parses DIDL-Lite browse result XML
     * @param {string} xml 
     * @returns {Array}
     */
    _parseBrowseXml(xml) {
        const items = [];

        try {
            const parser = new (new JSDOM('')).window.DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');

            const getText = (node, tag) => node.getElementsByTagName(tag)[0]?.textContent ?? null;

            // Parse containers
            for (const node of doc.getElementsByTagName('container')) {
                items.push({
                    id: node.getAttribute('id'),
                    title: getText(node, 'dc:title') || 'Unknown',
                    artist: getText(node, 'upnp:artist'),
                    album: getText(node, 'upnp:album'),
                    image: this._sanitizeImageUrl(getText(node, 'upnp:albumArtURI')),
                    class: getText(node, 'upnp:class'),
                    playable: true,
                    isContainer: true
                });
            }

            // Parse items
            for (const node of doc.getElementsByTagName('item')) {
                items.push({
                    id: node.getAttribute('id'),
                    title: getText(node, 'dc:title') || 'Unknown',
                    artist: getText(node, 'upnp:artist'),
                    album: getText(node, 'upnp:album'),
                    image: this._sanitizeImageUrl(getText(node, 'upnp:albumArtURI')),
                    class: getText(node, 'upnp:class'),
                    playable: true,
                    isContainer: false
                });
            }
        } catch (err) {
            console.error(`${LOG_PREFIX.BROWSE} XML parse error: ${err.message}`);
        }

        return items;
    }

    // ========================================================================
    // UTILITY METHODS
    // ========================================================================

    _getDeviceManager() {
        return this.raumkernel.managerDisposer?.deviceManager ?? null;
    }

    _getZoneManager() {
        return this.raumkernel.managerDisposer?.zoneManager ?? null;
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ========================================================================
    // LEGACY API COMPATIBILITY
    // ========================================================================

    // These methods match the old API signatures for backward compatibility

    getRoomForUdnOrName(identifier) {
        return this.findRoom(identifier);
    }

    getRendererForRoom(room) {
        return this._getRendererForRoom(room);
    }

    async setPause(roomIdentifier, shouldPause) {
        return shouldPause ? this.pause(roomIdentifier) : this.play(roomIdentifier);
    }

    async setStop(roomIdentifier) {
        return this.stop(roomIdentifier);
    }

    async setNext(roomIdentifier) {
        return this.next(roomIdentifier);
    }

    async setPrev(roomIdentifier) {
        return this.prev(roomIdentifier);
    }

    async load(roomIdentifier, url) {
        return this.loadUri(roomIdentifier, url);
    }
}

export default RaumkernelHelper;
