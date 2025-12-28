"""Config flow for Raumfeld integration."""

import logging
from typing import Any, Dict, Optional

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN

try:
    from homeassistant.components.hassio import is_hassio, get_addon_info

    HASSIO_AVAILABLE = True
except ImportError:
    HASSIO_AVAILABLE = False

_LOGGER = logging.getLogger(__name__)

DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST, default="localhost"): str,
        vol.Required(CONF_PORT, default=3000): int,
    }
)


class RaumfeldConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Raumfeld."""

    VERSION = 1

    async def async_step_user(
        self, user_input: Optional[Dict[str, Any]] = None
    ) -> FlowResult:
        """Handle the initial step."""
        errors: Dict[str, str] = {}

        if user_input is not None:
            # validate connection here if needed
            return self.async_create_entry(title="Raumfeld", data=user_input)

        # Try to discover addon if running on Hass.io
        host = "localhost"
        port = 3000

        if HASSIO_AVAILABLE and is_hassio(self.hass):
            for slug in ("local_ha-raumkernel-addon", "ha-raumkernel-addon"):
                try:
                    info = await get_addon_info(self.hass, slug)
                    if info and info.get("state") == "started":
                        _LOGGER.debug("Found Raumfeld addon: %s", slug)
                        port = info.get("options", {}).get("PORT", 3000)
                        break
                except Exception:  # pylint: disable=broad-except
                    continue

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST, default=host): str,
                    vol.Required(CONF_PORT, default=port): int,
                }
            ),
            errors=errors,
        )
