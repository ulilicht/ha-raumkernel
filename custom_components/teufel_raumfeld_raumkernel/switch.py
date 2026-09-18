"""Spotify multiroom switch."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import RaumfeldApiClient
from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Spotify multiroom switch."""
    client: RaumfeldApiClient = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([RaumfeldSpotifyMultiroomSwitch(client, entry.entry_id)])


class RaumfeldSpotifyMultiroomSwitch(SwitchEntity):
    """Control Raumfeld Spotify multiroom mode."""

    _attr_has_entity_name = True
    _attr_name = "Spotify multiroom"
    _attr_icon = "mdi:spotify"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_should_poll = False

    def __init__(self, client: RaumfeldApiClient, entry_id: str) -> None:
        self._client = client
        self._attr_unique_id = f"{entry_id}_spotify_multiroom"
        self._attr_is_on = None
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name="Teufel Raumfeld System",
            manufacturer="Teufel",
            model="Raumfeld System",
        )

    @property
    def available(self) -> bool:
        """Return True if entity is available."""
        return self._client.connected and self._attr_is_on is not None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._client.register_listener(self._handle_update)
        if self._client.connected:
            await self._client.get_state()

    async def async_will_remove_from_hass(self) -> None:
        self._client.unregister_listener(self._handle_update)
        await super().async_will_remove_from_hass()

    @callback
    def _handle_update(self, data: dict[str, Any]) -> None:
        if data.get("type") != "fullStateUpdate":
            return

        mode = data.get("payload", {}).get("spotifyMode")
        if mode not in ("multiRoom", "singleRoom"):
            if self._attr_is_on is not None:
                self._attr_is_on = None
                self.async_write_ha_state()
            return

        self._attr_is_on = mode == "multiRoom"
        self.async_write_ha_state()

    async def async_turn_on(self, **kwargs: Any) -> None:
        self._attr_is_on = True
        self.async_write_ha_state()
        try:
            await self._client.set_spotify_mode(True)
        except Exception:
            self._attr_is_on = False
            self.async_write_ha_state()
            raise

    async def async_turn_off(self, **kwargs: Any) -> None:
        self._attr_is_on = False
        self.async_write_ha_state()
        try:
            await self._client.set_spotify_mode(False)
        except Exception:
            self._attr_is_on = True
            self.async_write_ha_state()
            raise

