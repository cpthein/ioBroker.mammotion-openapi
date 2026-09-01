# ioBroker.mammotion-openapi

ioBroker adapter for Mammotion robotic mowers using the official Mammotion Open API.

> Early development project. The first versions are intentionally read-only while API states are mapped and tested on real hardware.

## Why this adapter

Mammotion provides an official Open API. This project uses that supported API instead of reverse-engineered MQTT/cloud protocols.

The initial implementation focuses on reliable telemetry, automatic OAuth token renewal, shared-device support and a clean ioBroker object model. Control commands will be added only after the read path and mower state mapping have been validated in practice.

## Tested hardware

- LUBA 2 AWD 3000X
- Firmware 1.30.29.8
- Device shared from a primary Mammotion account to a secondary Mammotion account
- Official API credentials created with the secondary account

Shared-device access has been confirmed through the official `/v1/mowers` and `/v1/mower/{deviceId}` endpoints.

## Current development scope

- OAuth2 client-credentials authentication
- automatic access-token renewal
- automatic mower discovery via `/v1/mowers`
- multiple mower support
- read-only mower detail polling
- online state
- operating status
- battery level
- raw `chargeStatus`
- firmware version
- Wi-Fi availability and RSSI
- cellular availability and RSSI
- API health/error states

## Planned

- observed status history
- reliable detection of recharge-during-task sequences
- documented mapping of Mammotion operating states based on real mower observations
- task/area discovery where available in the official API
- pause/resume/return/start controls from documented Open API endpoints
- safe command handling with explicit write states
- VIS-friendly states and statistics

## Development principle

Do not guess undocumented Mammotion values. Unknown values such as `chargeStatus` are exposed as raw data until their meaning is confirmed by documentation or repeatable real-world observation.

## Configuration

Create Mammotion Open API credentials at the Mammotion Developer portal and enter them in the adapter instance configuration:

- Client ID
- Client Secret
- polling interval

The Client Secret is declared as an encrypted ioBroker native configuration value.

Official documentation: https://developer.mammotion.com/

## Status

This repository is under active development and is not yet published in the ioBroker adapter repositories or npm.

## Changelog

### 0.0.1 (development)

- Initial adapter project structure
- Official Mammotion Open API proof of concept validated on a shared LUBA 2 AWD 3000X

## License

MIT
