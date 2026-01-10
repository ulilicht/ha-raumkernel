"""Button entity for Teufel Raumfeld."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
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
    """Set up the Raumfeld button."""
    client: RaumfeldApiClient = hass.data[DOMAIN][entry.entry_id]

    # Add global buttons (not per-room)
    async_add_entities([RemoveIntegrationButton(client, entry)])

    known_udns = set()

    @callback
    def handle_message(data: dict[str, Any]) -> None:
        if data.get("type") in ("zones", "zoneStateChanged"):
            rooms = data.get("payload", [])
            new_entities = []
            for room in rooms:
                if room["udn"] not in known_udns:
                    known_udns.add(room["udn"])
                    new_entities.append(RaumfeldRebootButton(client, room))

            if new_entities:
                async_add_entities(new_entities)

        elif data.get("type") == "fullStateUpdate":
            rooms = data.get("payload", {}).get("availableRooms", [])
            new_entities = []
            for room in rooms:
                if room["udn"] not in known_udns:
                    known_udns.add(room["udn"])
                    new_entities.append(RaumfeldRebootButton(client, room))
            if new_entities:
                async_add_entities(new_entities)

    client.register_listener(handle_message)

    # Trigger initial fetch if already connected
    if client.connected:
        hass.async_create_task(client.get_zones())


class RaumfeldRebootButton(ButtonEntity):
    """Representation of a Raumfeld reboot button."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_icon = "mdi:restart"
    _attr_has_entity_name = True

    def __init__(self, client: RaumfeldApiClient, room_data: dict[str, Any]) -> None:
        """Initialize the button."""
        self._client = client
        self._room_udn = room_data["udn"]
        self._attr_name = "Reboot"
        self._attr_unique_id = f"{self._room_udn}_reboot"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, self._room_udn)},
            "name": room_data.get("name"),
            "manufacturer": "Teufel",
            "model": "Raumfeld Room",
        }

    async def async_press(self) -> None:
        """Handle the button press."""
        await self._client.reboot(self._room_udn)


class RemoveIntegrationButton(ButtonEntity):
    """Button to remove the integration files (for addon uninstall cleanup)."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_icon = "mdi:delete"
    _attr_has_entity_name = True

    def __init__(self, client: RaumfeldApiClient, entry: ConfigEntry) -> None:
        """Initialize the button."""
        self._client = client
        self._entry = entry
        self._attr_name = "Remove Integration Files (Addon must still be installed)"
        self._attr_unique_id = f"{DOMAIN}_remove_integration"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, "addon")},
            "name": "Teufel Raumfeld Addon",
            "manufacturer": "Teufel",
            "model": "Raumkernel Addon",
        }

    async def async_press(self) -> None:
        """Handle the button press - request addon to remove integration files."""
        await self._client.remove_integration()
