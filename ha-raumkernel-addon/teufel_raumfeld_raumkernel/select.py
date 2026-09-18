"""Select platform for Teufel Raumfeld."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import RaumfeldApiClient
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Raumfeld select entities."""
    _LOGGER.info("Setting up Raumfeld select entities for entry %s", entry.entry_id)
    client: RaumfeldApiClient = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([RaumfeldSpotifyPrimarySelectEntity(client, entry.entry_id)])


class RaumfeldSpotifyPrimarySelectEntity(SelectEntity):
    """Select the primary Spotify Connect device in multiroom mode."""

    _attr_has_entity_name = True
    _attr_name = "Spotify primary room"
    _attr_icon = "mdi:spotify"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_should_poll = False

    def __init__(self, client: RaumfeldApiClient, entry_id: str) -> None:
        """Initialize the select entity."""
        self._client = client
        self._attr_unique_id = f"{entry_id}_spotify_primary_room"
        self._attr_current_option: str | None = None
        self._attr_options: list[str] = []
        self._spotify_mode: str | None = None
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name="Teufel Raumfeld System",
            manufacturer="Teufel",
            model="Raumfeld System",
        )

    @property
    def available(self) -> bool:
        """Return True if entity is available."""
        return (
            self._client.connected
            and self._spotify_mode == "multiRoom"
            and len(self._attr_options) > 0
        )

    async def async_added_to_hass(self) -> None:
        """Register listener when added to HA."""
        await super().async_added_to_hass()
        self._client.register_listener(self._handle_update)
        if self._client.connected:
            await self._client.get_state()

    async def async_will_remove_from_hass(self) -> None:
        """Unregister listener when removed from HA."""
        self._client.unregister_listener(self._handle_update)
        await super().async_will_remove_from_hass()

    @callback
    def _handle_update(self, data: dict[str, Any]) -> None:
        """Handle incoming fullStateUpdate."""
        if data.get("type") != "fullStateUpdate":
            return

        payload = data.get("payload", {})
        self._spotify_mode = payload.get("spotifyMode")

        # Update available room options
        available_rooms = payload.get("availableRooms", [])
        room_names = {r["name"] for r in available_rooms if "name" in r and r["name"]}
        primary_room = payload.get("spotifyPrimaryRoom")
        if primary_room:
            room_names.add(primary_room)

        self._attr_options = sorted(room_names)
        self._attr_current_option = primary_room

        self.async_write_ha_state()

    async def async_select_option(self, option: str) -> None:
        """Change the primary Spotify room."""
        previous_option = self._attr_current_option
        self._attr_current_option = option
        self.async_write_ha_state()

        try:
            await self._client.set_spotify_primary_room(option)
        except Exception:
            self._attr_current_option = previous_option
            self.async_write_ha_state()
            _LOGGER.error("Failed to set Spotify primary room to %s", option)
            raise
