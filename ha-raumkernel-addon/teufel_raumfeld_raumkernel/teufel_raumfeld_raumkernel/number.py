"""Zone Volume number entity for Teufel Raumfeld."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import RaumfeldApiClient
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Raumfeld zone volume number entities."""
    client: RaumfeldApiClient = hass.data[DOMAIN][entry.entry_id]

    known_udns: set[str] = set()

    @callback
    def handle_message(data: dict[str, Any]) -> None:
        if data.get("type") in ("zones", "zoneStateChanged"):
            rooms = data.get("payload", [])
            new_entities = []
            for room in rooms:
                if room["udn"] not in known_udns:
                    known_udns.add(room["udn"])
                    new_entities.append(RaumfeldZoneVolume(client, room))
            if new_entities:
                async_add_entities(new_entities)

        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableRooms", [])
            new_entities = []
            for room in rooms:
                if room["udn"] not in known_udns:
                    known_udns.add(room["udn"])
                    new_entities.append(RaumfeldZoneVolume(client, room))
            if new_entities:
                async_add_entities(new_entities)

    client.register_listener(handle_message)

    if client.connected:
        hass.async_create_task(client.get_zones())


class RaumfeldZoneVolume(NumberEntity):
    """Zone volume slider for a Raumfeld room.

    Controls all rooms in the zone simultaneously (like the native app's
    group-volume slider).  When the room is not grouped this behaves
    identically to the regular per-device volume slider.
    """

    _attr_native_min_value = 0.0
    _attr_native_max_value = 100.0
    _attr_native_step = 1.0
    _attr_mode = NumberMode.SLIDER
    _attr_icon = "mdi:volume-high"
    _attr_has_entity_name = True

    def __init__(self, client: RaumfeldApiClient, room_data: dict[str, Any]) -> None:
        """Initialize."""
        self._client = client
        self._room_udn = room_data["udn"]
        self._attr_name = "Zone Volume"
        self._attr_unique_id = f"{self._room_udn}_zone_volume"
        self._attr_native_value = float(
            (room_data.get("nowPlaying") or {}).get("zoneVolume", 0) or 0
        )
        self._attr_device_info = {
            "identifiers": {(DOMAIN, self._room_udn)},
            "name": room_data.get("name"),
            "manufacturer": "Teufel",
            "model": "Raumfeld Room",
        }

    async def async_added_to_hass(self) -> None:
        """Register for state updates."""
        self._client.register_listener(self._handle_event)

    @callback
    def _handle_event(self, data: dict[str, Any]) -> None:
        """Handle incoming events."""
        rooms: list[dict[str, Any]] = []
        if data.get("type") in ("zones", "zoneStateChanged"):
            rooms = data.get("payload", [])
        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableRooms", [])

        for room in rooms:
            if room["udn"] == self._room_udn:
                zone_vol = (room.get("nowPlaying") or {}).get("zoneVolume")
                if zone_vol is not None:
                    self._attr_native_value = float(zone_vol)
                    self.async_write_ha_state()
                break

    async def async_set_native_value(self, value: float) -> None:
        """Set zone volume."""
        await self._client.set_zone_volume(self._room_udn, int(value))
