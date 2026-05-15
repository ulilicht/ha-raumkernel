"""Device Volume number entity for Teufel Raumfeld.

Provides per-room individual volume control.  When a room is part of a
multi-room zone the main media-player volume slider controls the zone master
(all members together).  This entity lets you fine-tune the level of a
single device within the zone without affecting the others.
When the room is not grouped it behaves identically to the media-player
volume slider.
"""

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
    """Set up the Raumfeld device volume number entities."""
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
                    new_entities.append(RaumfeldDeviceVolume(client, room))
            if new_entities:
                async_add_entities(new_entities)

        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableRooms", [])
            new_entities = []
            for room in rooms:
                if room["udn"] not in known_udns:
                    known_udns.add(room["udn"])
                    new_entities.append(RaumfeldDeviceVolume(client, room))
            if new_entities:
                async_add_entities(new_entities)

    client.register_listener(handle_message)

    if client.connected:
        hass.async_create_task(client.get_zones())


class RaumfeldDeviceVolume(NumberEntity):
    """Per-device volume slider for a Raumfeld room.

    When the room is in a multi-room zone the main media-player card volume
    slider controls the whole zone.  This entity adjusts only this one
    speaker's level independently of the other zone members.
    """

    _attr_native_min_value = 0.0
    _attr_native_max_value = 100.0
    _attr_native_step = 1.0
    _attr_mode = NumberMode.SLIDER
    _attr_icon = "mdi:volume-medium"
    _attr_has_entity_name = True

    def __init__(self, client: RaumfeldApiClient, room_data: dict[str, Any]) -> None:
        """Initialize."""
        self._client = client
        self._room_udn = room_data["udn"]
        self._attr_name = "Device Volume"
        self._attr_unique_id = f"{self._room_udn}_device_volume"
        self._attr_native_value = float(
            (room_data.get("nowPlaying") or {}).get("volume", 0) or 0
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
                per_room_vol = (room.get("nowPlaying") or {}).get("volume")
                if per_room_vol is not None:
                    self._attr_native_value = float(per_room_vol)
                    self.async_write_ha_state()
                break

    async def async_set_native_value(self, value: float) -> None:
        """Set per-device volume (does not affect other zone members)."""
        await self._client.set_volume(self._room_udn, int(value))
