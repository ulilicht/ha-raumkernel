# Teufel Raumfeld (Raumkernel Addon)

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]

A Home Assistant Add-on that provides a bridge to Teufel Raumfeld devices using the `node-raumkernel` library.

## Description

This add-on allows Home Assistant to communicate with Teufel Raumfeld multi-room audio systems. It wraps the `node-raumkernel` library and exposes a WebSocket API that the corresponding Home Assistant integration uses to control playback, volume, and grouping.

## Features

- **Stable Room Entities**: Provides consistent identifiers for your Raumfeld rooms.
- **Unified Control**: Seamlessly handles the transition between standalone playback and zone-based grouping.
- **WebSocket API**: High-performance communication between the add-on and the integration.

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
