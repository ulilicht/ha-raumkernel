import JSDOM from 'jsdom';
import * as RaumkernelLib from 'node-raumkernel';
import { NodeSSH } from 'node-ssh';


class RaumkernelHelper {
    constructor() {
        this.raumkernel = new RaumkernelLib.Raumkernel();
        const initialState = {
            isReady: false,
            availableZones: [],
            favourites: []
        };
        this.state = JSON.parse(JSON.stringify(initialState));


        this.raumkernel.createLogger(1);
        this.raumkernel.logger.on('log', (_logData) => {
            console.log(`[RK][level-${_logData.logType}][${new Date().toLocaleString('de-DE')}] ${_logData.log}`);
        })

        this.raumkernel.init();

        //every 2 hours, raumkernel needs to be restarted. Watchdog will restart the app.
        // setTimeout(() => {
        //    process.exit(1); // 
        // }, 1000 * 60 * 60 * 2);



        this.raumkernel.on('systemReady', (_ready) => {
            console.log('EVENT: systemReady', _ready);

            this.state.isReady = _ready

            if (_ready) {
                this.loadFavourites();
            }
        });

        this.raumkernel.on('systemHostLost', () => {
            this.state = JSON.parse(JSON.stringify(initialState));
            console.log('EVENT: systemHostLost');
        });

        this.raumkernel.on('combinedZoneStateChanged', this.handleCombinedZoneStateChanged.bind(this));
    }

    getState() {
        return this.state;
    }


    async handleCombinedZoneStateChanged(_combinedStateData) {
        const availableZones = this.getAvailableZones(JSON.parse(JSON.stringify(_combinedStateData)));

        this.state.availableZones = availableZones;
    }

    getZoneForUdnOrName(zoneUdnOrName) {
        let zone = this.state.availableZones.find(zone => zone.udn === zoneUdnOrName);
        if (!zone && zoneUdnOrName && zoneUdnOrName.length > 2) {
            const foundZones = this.state.availableZones.filter(zone => zone.name.toLowerCase().includes(zoneUdnOrName.toLowerCase()));
            if (foundZones.length === 1) {
                zone = foundZones[0];
            }
        }
        return zone;
    }

    getAvailableZones(combinedZoneState) {
        const zones = combinedZoneState.zones;

        let availableZones = [];

        zones.forEach((zone) => {
            const zoneObj = {
                name: zone.name,
                udn: zone.udn,
                isZone: zone.isZone
            }

            const nowPlaying = this.getNowPlayingStateForZoneObj(zoneObj);
            zoneObj.isPlaying = !!nowPlaying.isPlaying;
            zoneObj.nowPlaying = nowPlaying;

            availableZones.push(zoneObj);
        });

        availableZones.sort((a, b) => (a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0));

        return availableZones;
    }

    /**
     * @deprecated
     */
    async getAutoSelectZone(availableZones) {

        const getNowPlayingStateMap = () => {
            let nowPlayingStates = new Map();

            for (const zone of availableZones) {
                nowPlayingStates.set(zone, this.getNowPlayingStateForZoneObj(zone));
            }

            return nowPlayingStates;
        }

        // todo: Here is a bug: _combinedStateData for some reason changes while we are using it.
        // "rendererState" is only filled after some time which causes AutoselectZone to fail.
        // setting a timeout helps here.

        let getNowPlayingStateMapPromise = new Promise((resolve) => {
            setTimeout(() => {
                resolve(getNowPlayingStateMap())
            }, 2)
        });

        let nowPlayingStateMap = await getNowPlayingStateMapPromise;

        let autoselectZone = null;
        nowPlayingStateMap.forEach((value, key) => {
            if (!autoselectZone && (value.isPlaying || value.isLoading)) {
                autoselectZone = key;
            }
        });

        if (!autoselectZone) {
            autoselectZone = availableZones[0];
            console.log('DID NOT FIND A ZONE FOR AUTOSELECT, NOW TAKING ', autoselectZone);
        }

        return autoselectZone;
    }

    getNowPlayingStateForZoneObj(zone) {
        if (!this.state.isReady) {
            return {
                artist: '',
                hasMediaRenderer: false,
                track: '',
                image: '',
                isPlaying: false,
                isLoading: false,
                isMuted: false,
                volume: 0,
                canPlayPause: false,
                canPlayNext: false
            };
        }


        const mediaRenderer = this.getRendererForZoneObj(zone);

        const metaDataXML = mediaRenderer && (mediaRenderer.rendererState.CurrentTrackMetaData || mediaRenderer.rendererState.AVTransportURIMetaData);
        let metaData = this.getMetaDataforXML(metaDataXML);

        const isLoading = mediaRenderer && mediaRenderer.rendererState.TransportState === "TRANSITIONING";
        const isPlaying = mediaRenderer && mediaRenderer.rendererState.TransportState === "PLAYING";

        let canPlayNext = false;
        let canPlayPause = false;
        if (mediaRenderer && mediaRenderer.rendererState.CurrentTransportActions) {
            const CTA = mediaRenderer.rendererState.CurrentTransportActions;

            canPlayNext = CTA.indexOf("Next") > -1;
            canPlayPause = (CTA.indexOf("Play") > -1 || CTA.indexOf("Pause") > -1 || CTA.indexOf("Stop") > -1);
        }

        let artistString = metaData.artist;
        if (artistString === '') {
            if (metaData.classString === 'object.item.audioItem.audioBroadcast.radio') {
                artistString = 'Radiostation';
            } else if (metaData.classString === 'object.item.audioItem.podcastEpisode') {
                artistString = 'Podcast';
            }
        }

        return {
            artist: artistString,
            hasMediaRenderer: !!mediaRenderer,
            track: metaData.track,
            image: metaData.image && metaData.image.replace('http://', 'https://'),
            isPlaying: isPlaying,
            isLoading: isLoading,
            isMuted: mediaRenderer && mediaRenderer.rendererState.Mute === 1,
            volume: mediaRenderer && parseInt(mediaRenderer.rendererState.Volume),
            canPlayPause: canPlayPause,
            canPlayNext: !isLoading && isPlaying && canPlayNext
        }
    }

    async getSleepTimerState(zone) {
        if (this.isFetchingSleepTimerState) {
            console.log('getSleepTimerState: already fetching sleep timer state. skipping.');
            return;
        }

        const mediaRenderer = this.getRendererForZoneObj(zone);

        let hasSleepTimer = false;
        let secondsUntilSleep = 0;
        const canSetSleepTimer = !!mediaRenderer.getSleepTimerState;

        if (mediaRenderer && canSetSleepTimer) {
            this.isFetchingSleepTimerState = true;
            const sleepTimerState = await mediaRenderer.getSleepTimerState();
            this.isFetchingSleepTimerState = false;
            if (sleepTimerState.Active === '1') {
                hasSleepTimer = true;
                secondsUntilSleep = sleepTimerState.SecondsUntilSleep;
            }
        }

        return {
            canSetSleepTimer: canSetSleepTimer,
            hasSleepTimer: hasSleepTimer,
            secondsUntilSleep: secondsUntilSleep
        }
    }

    async setSleepTimer(zone, secondsUntilSleep) {
        const mediaRenderer = this.getRendererForZoneObj(zone);
        const secondsUntilVolumeRamp = 51; //must be >50; 

        if (mediaRenderer) {
            await mediaRenderer.startSleepTimer(secondsUntilSleep, secondsUntilVolumeRamp);
            return {
                canSetSleepTimer: !!mediaRenderer.getSleepTimerState,
                hasSleepTimer: true,
                secondsUntilSleep: secondsUntilSleep
            }
        } else {
            throw 'could not find media renderer';
        }
    }

    async deleteSleepTimer(zone) {
        const mediaRenderer = this.getRendererForZoneObj(zone);

        if (mediaRenderer) {
            await mediaRenderer.cancelSleepTimer();
            return {
                canSetSleepTimer: !!mediaRenderer.getSleepTimerState,
                hasSleepTimer: false,
                secondsUntilSleep: 0
            }
        } else {
            throw 'could not find media renderer';
        }
    }

    getRendererForZoneObj(zone) {
        let mediaRenderer = null;

        if (!zone.isZone) {
            const rendererUDNs = this.raumkernel.managerDisposer.zoneManager.getRendererUdnsForRoomUdnOrName(zone.udn);
            const rendererUDN = rendererUDNs[0]; // todo: Check if this leads to an error if multiple devices in one room.

            mediaRenderer = this.raumkernel.managerDisposer.deviceManager.mediaRenderers.get(rendererUDN);
        } else {
            mediaRenderer = this.raumkernel.managerDisposer.deviceManager.mediaRenderersVirtual.get(zone.udn);
        }

        return mediaRenderer;
    }

    getMetaDataforXML(AVTransportURIMetaData) {
        const result = {
            track: 'Nothing currently playing',
            image: '',
            artist: '',
            album: '',
            classString: ''
        }

        if (AVTransportURIMetaData) {
            const dom = new JSDOM.JSDOM("");
            const DOMParser = dom.window.DOMParser;
            const parser = new DOMParser;

            let xmlDoc = parser.parseFromString(AVTransportURIMetaData, "text/xml");

            const hasRelevantContent = xmlDoc.getElementsByTagName('upnp:class').length > 0;
            if (!hasRelevantContent) {
                return result;
            }

            const classStringNode = xmlDoc.getElementsByTagName('upnp:class')[0];
            const trackNode = xmlDoc.getElementsByTagName('dc:title')[0]
            const imageNode = xmlDoc.getElementsByTagName('upnp:albumArtURI')[0]

            result.classString = classStringNode && classStringNode.childNodes[0] && classStringNode.childNodes[0].nodeValue;
            result.track = trackNode && trackNode.childNodes[0] && trackNode.childNodes[0].nodeValue || '';
            result.image = imageNode && imageNode.childNodes[0] && imageNode.childNodes[0].nodeValue || '';

            if (result.classString === 'object.item.audioItem.musicTrack') {
                const artistNode = xmlDoc.getElementsByTagName('upnp:artist')[0];
                const albumNode = xmlDoc.getElementsByTagName('upnp:album')[0];

                result.artist = artistNode && artistNode.childNodes[0] && artistNode.childNodes[0].nodeValue || '';
                result.album = albumNode && albumNode.childNodes[0] && albumNode.childNodes[0].nodeValue || '';
            }
        }

        return result;
    }

    setPause(zone, shouldPause) {
        const renderer = this.getRendererForZoneObj(zone);
        if (!renderer || typeof renderer.pause !== 'function') {
            console.warn(`Tried to pause, but renderer not available or invalid for zone: ${zone?.name || zone}`);
            return;
        }
        return shouldPause ? renderer.pause() : renderer.play();
    }

    setStop(zone) {
        let renderer = this.getRendererForZoneObj(zone);
        if (!renderer) {
            console.log('Could not load zone renderer for UDN ', zone);
        }

        return renderer.stop();
    }

    setNext(zone) {
        let renderer = this.getRendererForZoneObj(zone);
        if (!renderer) {
            console.log('Could not load zone renderer for UDN ', zone);
        }

        return renderer.next();
    }

    setPrev(zone) {
        let renderer = this.getRendererForZoneObj(zone);
        if (!renderer) {
            console.log('Could not load zone renderer for UDN ', zone);
        }
        renderer.prev(); //need to call this twice, otherwise it only jumps to beginning of track; 
        return renderer.prev();
    }

    setMute(zone, shouldMute) {
        let renderer = this.getRendererForZoneObj(zone);
        if (!renderer) {
            console.log('Could not load zone renderer for UDN ', zone);
        }
        return renderer.setMute(shouldMute);
    }

    setVolume(zone, targetVolume) {
        let renderer = this.getRendererForZoneObj(zone);
        if (!renderer) {
            console.log('Could not load zone renderer for UDN ', zone);
            return;
        }
        return renderer.setVolume(targetVolume);
    }

    async playFavourite(zone, id, classType) {
        let zoneRenderer;
        try {
            zoneRenderer = await this.getOrCreateRendererForZoneOrRoomUDN(zone);
        } catch (err) {
            console.error(`[playFavourite] Could not get or create renderer for zone: ${zone?.name || zone?.udn || zone}. Error:`, err);
            return;
        }

        if (!zoneRenderer) {
            console.error(`[playFavourite] No renderer found for zone: ${zone?.name || zone?.udn || zone}`);
            return;
        }

        this.leaveStandby(zoneRenderer).then(() => {
            if (classType.startsWith('object.container')) {
                zoneRenderer.loadContainer(id);
            } else if (classType.startsWith('object.item')) {
                zoneRenderer.loadSingle(id);
            } else {
                console.log(`Playback of ${classType} not implemented yet.`);
            }
        }).catch(err => {
            console.error(`[playFavourite] Error leaving standby for zone: ${zone?.name || zone?.udn || zone}`, err);
        });
    }

    /**
     * Plays the system sound on the given zone
     * @param {*} zone zone object
     * @param {*} soundName either "Success" or "Failure"
     */
    async playSystemSound(zone, soundName = "Success") {
        if (!zone.isZone) {
            const rendererUDNs = this.raumkernel.managerDisposer.zoneManager.getRendererUdnsForRoomUdnOrName(zone.udn);
            const rendererUDN = rendererUDNs[0];
            const mediaRenderer = this.raumkernel.managerDisposer.deviceManager.mediaRenderers.get(rendererUDN);
            if (mediaRenderer && typeof mediaRenderer.playSystemSound === 'function') {
                mediaRenderer.playSystemSound(soundName);
            } else {
                console.warn(`[playSystemSound] No valid mediaRenderer for UDN ${rendererUDN}`);
            }
        } else {
            let zoneRenderer = await this.getOrCreateRendererForZoneOrRoomUDN(zone);
            if (!zoneRenderer || typeof zoneRenderer.getRoomRendererUDNs !== 'function') {
                console.warn(`[playSystemSound] No valid zoneRenderer for zone ${zone?.name || zone?.udn || zone}`);
                return;
            }
            const roomRendererUDNs = zoneRenderer.getRoomRendererUDNs();
            for (let roomRendererUDN of roomRendererUDNs) {
                const roomRenderer = this.raumkernel.managerDisposer.deviceManager.getMediaRenderer(roomRendererUDN);
                if (roomRenderer && typeof roomRenderer.playSystemSound === 'function') {
                    roomRenderer.playSystemSound(soundName);
                } else {
                    console.warn(`[playSystemSound] No valid roomRenderer for UDN ${roomRendererUDN}`);
                }
            }
        }
    }

    async getOrCreateRendererForZoneOrRoomUDN(zone) {
        let zoneUDN = null;
        if (!zone.isZone) {
            try {
                await this.raumkernel.managerDisposer.zoneManager.connectRoomToZone(zone.udn, '', true);
            } catch (err) {
                console.error(`[getOrCreateRendererForZoneOrRoomUDN] Failed to connect room to zone for UDN ${zone.udn}:`, err);
                return undefined;
            }
            zoneUDN = this.raumkernel.managerDisposer.zoneManager.getZoneUDNFromRoomUDN(zone.udn);
        } else {
            zoneUDN = zone.udn;
        }

        let mediaRenderer = this.raumkernel.managerDisposer.deviceManager.mediaRenderersVirtual.get(zoneUDN);

        if (!mediaRenderer) {
            mediaRenderer = this.raumkernel.managerDisposer.deviceManager.mediaRenderers.get(zone.udn);
            console.log('tried to get non-virtual renderer for udn. ', zone.udn, mediaRenderer);
        }

        if (!mediaRenderer) {
            console.log('Could not load zone renderer for UDN ', zone.udn);
            return undefined;
        }

        return mediaRenderer;
    }

    async leaveStandby(_mediaRendererVirtual) {
        if (!_mediaRendererVirtual || typeof _mediaRendererVirtual.getRoomRendererUDNs !== 'function') {
            console.error('[leaveStandby] Invalid or undefined mediaRendererVirtual');
            return [];
        }
        let resultSum = [];
        let rendererUDNs = _mediaRendererVirtual.getRoomRendererUDNs();

        for (const rendererUDN of rendererUDNs) {
            let mediaRendererRoom = this.raumkernel.managerDisposer.deviceManager.getMediaRenderer(rendererUDN);
            if (mediaRendererRoom) {
                try {
                    let result = await mediaRendererRoom.leaveStandby(true);
                    resultSum.push(result);
                } catch (_exception) {
                    console.error(_exception.toString());
                }
            }
        }

        return resultSum;
    }

    async loadFavourites() {
        const favourites = [];
        const teufelFavourites = '0/Favorites/MyFavorites';
        //const teufelRecentlyPlayed = '0/Favorites/RecentlyPlayed';

        const favouriteMediaList = await this.raumkernel.managerDisposer.mediaListManager.getMediaList(teufelFavourites, teufelFavourites);
        favouriteMediaList && favouriteMediaList.forEach(mediaListEntry => {
            if (!favourites.find(fav => fav.id === mediaListEntry.id)) {
                const name = typeof mediaListEntry.title === 'string'
                    ? mediaListEntry.title
                    : (typeof mediaListEntry.artist === 'string' ? mediaListEntry.artist : '[No Name]');

                favourites.push({
                    name,
                    image: mediaListEntry.albumArtURI?.replace('http://', 'https://') || '',
                    id: mediaListEntry.id,
                    class: mediaListEntry.class,
                    type: mediaListEntry.class === 'object.item.audioItem.audioBroadcast.radio' ? 'radioStation' : 'podcast'
                });
            }
        });


        this.state.favourites = favourites;
    }

    // does not work yet 
    async searchItems(query = '0') {
        const result = [];
        console.log('searching', query);

        const mediaServer = this.raumkernel.managerDisposer.deviceManager.getRaumfeldMediaServer();
        const mediaList = await mediaServer.browse(query);

            mediaList && mediaList.forEach(mediaListEntry => {
                if (!result.find(res => res.id === mediaListEntry.id)) {

                    result.push({
                        name: mediaListEntry.title,
                        image: mediaListEntry.albumArtURI && mediaListEntry.albumArtURI.replace('http://', 'https://'),
                        id: mediaListEntry.id,
                        class: mediaListEntry.class,
                        type: mediaListEntry.class === 'object.item.audioItem.audioBroadcast.radio' ? 'radioStation' : 'podcast'
                    })
                }
            });

        return result;
    }

    getDevices() {
        const devices = [];
        const mediaRenderers = this.raumkernel.managerDisposer.deviceManager.mediaRenderers;

        for (let [udn, renderer] of mediaRenderers) {
            devices.push({
                name: renderer.name(),
                roomName: renderer.roomName(),
                udn: udn,
                ip: renderer.host(),
                powerState: renderer.rendererState.PowerState
            })
        }
        return devices;
    }

    getDeviceForUdn(udn) {
        return this.getDevices().find(device => device.udn === udn);
    }

    async rebootDevice(device) {
        const ssh = new NodeSSH();
        let result = '';

        try {
            await ssh.connect({
                host: device.ip,
                username: 'root'
            });

            const msg = await ssh.execCommand('/sbin/reboot');
            result = `Rebooting ${device.name} at ${device.ip} ... ${msg.stdout}`;
        } catch (err) {
            result = `Could not connect to ${device.name} at ${device.ip}, error: ${err}`;
        } finally {
            ssh.dispose();
            result += ' ...connection closed';
        }


        return result;
    }

}

export default RaumkernelHelper;