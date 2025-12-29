"""Media Player for Teufel Raumfeld."""

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components.media_player import (
    BrowseMedia,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
)
from homeassistant.components.media_player.const import MediaClass, MediaType
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_platform
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import RaumfeldApiClient
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Teufel Raumfeld media player."""
    client: RaumfeldApiClient = hass.data[DOMAIN][entry.entry_id]

    platform = entity_platform.async_get_current_platform()

    platform.async_register_entity_service(
        "play_system_sound",
        {
            vol.Required("sound_id"): cv.string,
        },
        "async_play_system_sound",
    )

    known_udns = set()

    @callback
    def handle_message(data: dict[str, Any]) -> None:
        if data.get("type") in ("zones", "zoneStateChanged"):
            rooms = data.get("payload", [])
            new_entities = []
            for room in rooms:
                if room["udn"] not in known_udns:
                    known_udns.add(room["udn"])
                    new_entities.append(RaumfeldMediaPlayer(client, room))

            if new_entities:
                async_add_entities(new_entities)

        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableRooms", [])
            new_entities = []
            for room in rooms:
                if room["udn"] not in known_udns:
                    known_udns.add(room["udn"])
                    new_entities.append(RaumfeldMediaPlayer(client, room))
            if new_entities:
                async_add_entities(new_entities)

    client.register_listener(handle_message)

    # Trigger initial fetch if already connected
    if client.connected:
        hass.async_create_task(client.get_zones())


class RaumfeldMediaPlayer(MediaPlayerEntity):
    """Teufel Raumfeld Media Player Entity."""

    def __init__(self, client: RaumfeldApiClient, room_data: dict[str, Any]) -> None:
        """Initialize."""
        self._client = client
        self._udn = room_data["udn"]
        self._attr_name = room_data.get("name")
        self._attr_unique_id = self._udn
        self._attr_icon = "mdi:speaker-multiple"
        self.update_state(room_data)

    @property
    def device_info(self):
        """Return device info."""
        return {
            "identifiers": {(DOMAIN, self._udn)},
            "name": self.name,
            "manufacturer": "Teufel",
            "model": "Raumfeld Room",
        }

    async def async_added_to_hass(self) -> None:
        """Run when this Entity has been added to HA."""
        self._client.register_listener(self._handle_event)

    @callback
    def _handle_event(self, data: dict[str, Any]) -> None:
        """Handle incoming events."""
        if data.get("type") in ("zones", "zoneStateChanged"):
            rooms = data.get("payload", [])
            for room in rooms:
                if room["udn"] == self._udn:
                    self.update_state(room)
                    self.async_write_ha_state()
                    break
        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableZones", [])
            for room in rooms:
                if room["udn"] == self._udn:
                    self.update_state(room)
                    self.async_write_ha_state()
                    break

    def update_state(self, room_data: dict[str, Any]) -> None:
        """Update state from data."""
        self._attr_available = True

        now_playing = room_data.get("nowPlaying", {})

        # Check power state first - if in standby, show as idle
        # PowerState can be: ACTIVE, IDLE, STANDBY, MANUAL_STANDBY, AUTOMATIC_STANDBY
        # Use IDLE instead of OFF to keep the UI expanded and controls visible
        power_state = now_playing.get("powerState", "ACTIVE")

        if "STANDBY" in power_state:
            self._attr_state = MediaPlayerState.IDLE
        elif now_playing.get("isPlaying"):
            self._attr_state = MediaPlayerState.PLAYING
        elif now_playing.get("isLoading"):
            self._attr_state = MediaPlayerState.BUFFERING
        else:
            self._attr_state = MediaPlayerState.PAUSED

        self._attr_volume_level = (now_playing.get("volume", 0) or 0) / 100.0
        self._attr_is_volume_muted = now_playing.get("isMuted", False)

        self._attr_media_title = now_playing.get("track")
        self._attr_media_artist = now_playing.get("artist")
        self._attr_media_image_url = now_playing.get("image")

        # Store zone info for extra state attributes
        self._zone_name = room_data.get("zoneName")
        self._zone_members = room_data.get("zoneMembers", [])
        self._current_zone_udn = room_data.get("currentZoneUdn")

        # Supported features
        features = (
            MediaPlayerEntityFeature.PLAY
            | MediaPlayerEntityFeature.PAUSE
            | MediaPlayerEntityFeature.STOP
            | MediaPlayerEntityFeature.VOLUME_SET
            | MediaPlayerEntityFeature.VOLUME_MUTE
            | MediaPlayerEntityFeature.PLAY_MEDIA
            | MediaPlayerEntityFeature.BROWSE_MEDIA
            | MediaPlayerEntityFeature.TURN_OFF
            | MediaPlayerEntityFeature.TURN_ON
        )

        if now_playing.get("canPlayNext"):
            features |= MediaPlayerEntityFeature.NEXT_TRACK

        if now_playing.get("canPlayPrev"):
            features |= MediaPlayerEntityFeature.PREVIOUS_TRACK

        self._attr_supported_features = features

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return extra state attributes."""
        return {
            "room_udn": self._udn,
            "zone_name": self._zone_name,
            "current_zone_udn": self._current_zone_udn,
            "zone_members": self._zone_members,
        }

    async def async_media_play(self) -> None:
        """Play."""
        _LOGGER.debug("Calling async_media_play for %s", self._udn)
        await self._client.play(self._udn)

    async def async_media_pause(self) -> None:
        """Pause."""
        _LOGGER.debug("Calling async_media_pause for %s", self._udn)
        await self._client.pause(self._udn)

    async def async_media_stop(self) -> None:
        """Stop."""
        _LOGGER.debug("Calling async_media_stop for %s", self._udn)
        await self._client.stop(self._udn)

    async def async_turn_off(self) -> None:
        """Turn off the device."""
        _LOGGER.info("Turning off %s (%s)", self.name, self._udn)

        # First pause playback if playing
        try:
            await self.async_media_pause()
        except Exception as err:
            _LOGGER.warning("Failed to pause %s before turn off: %s", self.name, err)

        # Then attempt standby
        try:
            await self._client.enter_standby(self._udn)
        except Exception as err:
            _LOGGER.warning("Failed to enter standby for %s: %s", self.name, err)

    async def async_turn_on(self) -> None:
        """Turn on the device (wake from standby)."""
        _LOGGER.info("Waking up %s (%s)", self.name, self._udn)

        # Wake the device by calling play
        # This will trigger leaveStandby in the add-on
        try:
            await self._client.play(self._udn)
        except Exception as err:
            _LOGGER.warning("Failed to wake %s: %s", self.name, err)

    async def async_set_volume_level(self, volume: float) -> None:
        """Set volume level, range 0..1."""
        await self._client.set_volume(self._udn, int(volume * 100))

    async def async_mute_volume(self, mute: bool) -> None:
        """Mute the volume."""
        await self._client.set_mute(self._udn, mute)

    async def async_media_next_track(self) -> None:
        """Send next track command."""
        _LOGGER.debug("Calling async_media_next_track for %s", self._udn)
        try:
            await self._client.next(self._udn)
        except Exception as err:
            _LOGGER.error("Failed to skip next %s: %s", self._udn, err)
            raise

    async def async_media_previous_track(self) -> None:
        """Send previous track command."""
        _LOGGER.debug("Calling async_media_previous_track for %s", self._udn)
        try:
            await self._client.prev(self._udn)
        except Exception as err:
            _LOGGER.error("Failed to skip previous %s: %s", self._udn, err)
            raise

    async def async_play_media(
        self, media_type: MediaType | str, media_id: str, **kwargs: Any
    ) -> None:
        """Play a piece of media."""
        # Check if media_id is a URL or something else.
        if (
            media_type == MediaType.URL
            or media_id.startswith("http")
            or media_id.startswith("raumfeld-line-in")
        ):
            await self._client.load_uri(self._udn, media_id)
        elif media_type in (
            MediaType.PLAYLIST,
            MediaType.ALBUM,
            MediaType.ARTIST,
            "container",
        ):
            await self._client.load_container(self._udn, media_id)
        elif media_type in (MediaType.TRACK, MediaType.MUSIC, "item"):
            await self._client.load_single(self._udn, media_id)
        else:
            await self._client.load_container(self._udn, media_id)

    async def async_play_system_sound(self, sound_id: str) -> None:
        """Play a system sound on the speaker."""
        await self._client.play_system_sound(self._udn, sound_id)

    async def async_browse_media(
        self,
        media_content_type: str | None = None,
        media_content_id: str | None = None,
    ) -> BrowseMedia:
        """Browse media."""
        if media_content_id is None:
            media_content_id = "0/Favorites"

        # Helper to map UPNP class to HA MediaClass
        def _get_media_class(upnp_class: str) -> str:
            if not upnp_class:
                return MediaClass.DIRECTORY
            if upnp_class.startswith("object.container.playlistContainer"):
                return MediaClass.PLAYLIST
            if upnp_class.startswith("object.container.album.musicAlbum"):
                return MediaClass.ALBUM
            if upnp_class.startswith("object.container.person.musicArtist"):
                return MediaClass.ARTIST
            if upnp_class.startswith("object.item.audioItem.musicTrack"):
                return MediaClass.TRACK
            if "radio" in upnp_class.lower() or "broadcast" in upnp_class.lower():
                return MediaClass.CHANNEL
            if upnp_class.startswith("object.container"):
                return MediaClass.DIRECTORY
            return MediaClass.MUSIC

        items = await self._client.browse(media_content_id)

        children = []
        for item in items:
            media_class = _get_media_class(item.get("class"))
            is_container = item.get("isContainer", False)
            can_play = item.get("playable", False)

            # If it's a container, we generally can browse it.
            # If it's an item, we can't browse (expand) it.
            can_expand = is_container

            children.append(
                BrowseMedia(
                    title=item.get("title", "Unknown"),
                    media_class=media_class,
                    media_content_id=item.get("id"),
                    media_content_type="container" if is_container else "item",
                    can_play=can_play,
                    can_expand=can_expand,
                    thumbnail=item.get("image"),
                )
            )

        # We assume the root or current level is a directory for now
        # Ideally we would get info about the parent from the API,
        # but for now we construct a generic parent.
        return BrowseMedia(
            title="Teufel Raumfeld",
            media_class=MediaClass.DIRECTORY,
            media_content_id=media_content_id,
            media_content_type="container",
            can_play=False,
            can_expand=True,
            children=children,
        )
