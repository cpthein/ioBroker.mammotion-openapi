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
- one automatic re-authentication attempt on HTTP/API code `401`
- automatic mower discovery via `/v1/mowers`
- multiple mower support
- read-only mower detail polling
- read-only saved-plan discovery via `/v1/mower/{deviceId}/plan`
- online state
- operating status plus previous status and change time
- battery level
- raw `chargeStatus` plus previous value and change time
- firmware version
- Wi-Fi availability and RSSI
- cellular availability and RSSI
- API health/error states, HTTP status and Mammotion request ID

## Mammotion Open API credentials

The adapter does **not** use a Mammotion e-mail/password login and it does **not** require a manually copied access token. It uses a Mammotion Open API **Client ID** and **Client Secret**.

### 1. Open the Mammotion Developer Portal

Go to:

https://developer.mammotion.com/credentials

Sign in with the Mammotion account that can see the mower in the Mammotion app. A mower shared from another Mammotion account can also work; this has been confirmed with the test LUBA listed above.

### 2. Create Open API credentials

Create credentials in the Developer Portal and copy these two values:

- `Client ID`
- `Client Secret`

No access token needs to be copied into ioBroker.

### 3. Configure the ioBroker adapter instance

Open the adapter instance configuration and enter:

- **Mammotion Client ID**
- **Mammotion Client Secret**
- **Polling interval** — 60 seconds is recommended for normal operation

The Client Secret is defined in `io-package.json` as `encryptedNative`. ioBroker therefore stores it encrypted and automatically provides the decrypted value to the adapter at runtime.

The adapter sends the Client ID and Client Secret only to Mammotion's OAuth endpoint in order to obtain an access token. The access token is kept in memory and is renewed automatically before expiry. If the API rejects a token with `401`, the adapter requests a fresh token once and retries the request.

### Testing note about multiple clients

During development, obtaining a new access token with the same credentials appeared to invalidate an older token that was still present in another shell/session. Therefore it is best to avoid running several independent clients with the same credentials while testing.

## Saved plans and map areas

Mammotion map areas and saved plans are separate things.

The tested mower has four map areas (`Bereich 1` to `Bereich 4`), selected manually in the Mammotion app when starting mowing. No saved tasks/plans are currently configured, so the official endpoint:

`GET /v1/mower/{deviceId}/plan`

returns an empty array on the test system.

The adapter therefore exposes plan data read-only as raw JSON plus the returned plan count. We will not guess the structure of non-empty plan entries until a real saved plan has been tested.

## Observed mower states

The following values have been observed on the test LUBA through the official API:

- `Working` — mower actively working/mowing
- `Returning` — mower returning to the charging station
- `Standby` — observed while idle and also after docking
- `chargeStatus = 0` — observed while working and while returning
- `chargeStatus = 2` — observed after docking while the mower was visibly charging

A normal completed mowing session was observed as:

`Working -> Returning -> Standby`

with `chargeStatus` changing from `0` to `2` after docking.

These are real observations from the tested mower, not assumptions about every Mammotion model or firmware version.

## Planned

- status history
- reliable detection of recharge-during-task sequences
- additional documented mapping of Mammotion operating states based on real mower observations
- test a real non-empty saved plan response
- pause/resume/return/start controls from documented Open API endpoints
- safe command handling with explicit write states
- VIS-friendly states and statistics

## Development principle

Do not guess undocumented Mammotion values. Unknown values are exposed as raw data until their meaning is confirmed by documentation or repeatable real-world observation.

## Official Mammotion documentation

https://developer.mammotion.com/

## Status

This repository is under active development and is not yet published in the ioBroker adapter repositories or npm.

## Changelog

### 0.0.1 (development)

- Initial adapter project structure
- Official Mammotion Open API proof of concept validated on a shared LUBA 2 AWD 3000X
- Added guided Client ID / Client Secret configuration
- Added encrypted Client Secret storage through ioBroker `encryptedNative`
- Added robust token renewal and one retry on `401`
- Added read-only saved-plan discovery
- Added previous status / charge status change tracking
- Documented first real mower state transitions

## License

MIT
