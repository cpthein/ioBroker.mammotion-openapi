# ioBroker.mammotion-openapi

ioBroker adapter for Mammotion robotic mowers using the official Mammotion Open API.

> Early development project. Telemetry and first task controls are being validated on real hardware before broader command support is added.

## Why this adapter

Mammotion provides an official Open API. This project uses that supported API instead of reverse-engineered MQTT/cloud protocols.

The implementation focuses on reliable telemetry, automatic OAuth token renewal, shared-device support, saved-task discovery and a clean ioBroker object model.

## Tested hardware

- LUBA 2 AWD 3000X
- Firmware 1.30.29.8
- Device shared from a primary Mammotion account to a secondary Mammotion account
- Official API credentials created with the secondary account

Shared-device access has been confirmed through the official `/v1/mowers`, `/v1/mower/{deviceId}` and `/v1/mower/{deviceId}/plan` endpoints.

## Current development scope

- OAuth2 client-credentials authentication
- automatic access-token renewal
- one automatic re-authentication attempt on HTTP/API code `401`
- automatic mower discovery via `/v1/mowers`
- multiple mower support
- mower detail polling
- saved-task discovery via `/v1/mower/{deviceId}/plan`
- one start button per discovered saved task
- general controls for the currently running task: stop/pause, resume and abort
- online state
- operating status plus previous status and change time
- battery level
- raw `chargeStatus` plus previous value and change time
- firmware version
- Wi-Fi availability and RSSI
- cellular availability and RSSI
- API health/error states, HTTP status and Mammotion request ID
- recent status/charge transition history
- experimental intermediate-recharge sequence tracking

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

## Saved tasks and map areas

Mammotion map areas and saved tasks are separate things.

To mow a specific area through the official Open API, Mammotion requires a saved task created in the Mammotion app. That task selects the desired map area and stores the mowing parameters. The task is then started through:

`POST /v1/mower/action`

with action `START` and `params.taskName`.

The first real saved task observed on the test mower returned:

```json
[
  {
    "taskId": "178826264281602824212",
    "taskName": "Breich-3"
  }
]
```

Version 0.0.3 creates a task channel for every task returned by `/plan`, for example:

```text
mowers.<deviceId>.tasks.Breich-3.taskId
mowers.<deviceId>.tasks.Breich-3.taskName
mowers.<deviceId>.tasks.Breich-3.start
```

Writing `true` to `start` sends `START` with that exact task name. The button is reset to `false` afterwards.

## General task controls

Stop, resume and abort apply to the **currently running task**, so these controls exist only once per mower:

```text
mowers.<deviceId>.controls.stop
mowers.<deviceId>.controls.resume
mowers.<deviceId>.controls.abort
```

Their Mammotion Open API actions are:

- `controls.stop` → `PAUSE`
- `controls.resume` → `RESUME`
- `controls.abort` → `STOP`

The adapter also records the last command result:

```text
mowers.<deviceId>.controls.lastCommand
mowers.<deviceId>.controls.lastCommandOk
mowers.<deviceId>.controls.lastCommandError
mowers.<deviceId>.controls.lastCommandAt
```

## Observed mower states

The following values have been observed on the test LUBA through the official API:

- `Working` — mower actively working/mowing
- `Returning` — mower returning to the charging station
- `Standby` — observed while idle and also after docking
- `chargeStatus = 0` — observed while working and while returning
- `chargeStatus = 2` — observed after docking while the mower was visibly charging
- `chargeStatus = 1` — observed at 100% battery while docked in Standby; exact meaning remains intentionally unlabelled until confirmed again

A normal completed mowing session was observed as:

`Working -> Returning -> Standby`

with `chargeStatus` changing from `0` to `2` after docking.

These are real observations from the tested mower, not assumptions about every Mammotion model or firmware version.

## Status history and recharge tracking

Version 0.0.2 introduced up to 50 recent status/charge transition samples per mower in:

`recharge.statusHistoryJson`

The adapter also exposes these read-only tracking states:

- `recharge.mowingSeenSinceIdle`
- `recharge.candidate`
- `recharge.candidateSince`
- `recharge.confirmedDuringTask`
- `recharge.lastConfirmed`
- `recharge.confirmedCount`

The recharge logic is intentionally conservative:

1. `Working` marks that mowing has been seen.
2. A later `Returning` or non-zero `chargeStatus` creates a recharge candidate.
3. `Working -> Returning -> Standby/charging` alone is **not** counted as an intermediate recharge because this is also the normal end-of-task sequence.
4. Only a later return to `Working` within the candidate window confirms an intermediate-recharge sequence.
5. An unconfirmed candidate expires after four hours.

This remains an experimental sequence detector until a real intermediate recharge and resume has been observed on the test mower.

## Planned

- validate the first real saved-task start from ioBroker
- observe Pause / Resume / Stop status transitions
- observe a real intermediate recharge and automatic resume sequence
- additional documented mapping of Mammotion operating states
- return-to-dock controls
- VIS-friendly states and statistics

## Development principle

Do not guess undocumented Mammotion values. Unknown values are exposed as raw data until their meaning is confirmed by documentation or repeatable real-world observation.

## Official Mammotion documentation

https://developer.mammotion.com/

## Status

This repository is under active development and is not yet published in the ioBroker adapter repositories or npm.

## Changelog

### 0.0.3 (development)

- Added one `start` button per discovered saved task
- Added general task controls per mower: stop/pause, resume and abort
- Added command result states and automatic button reset
- Added POST action support with the same token renewal / `401` retry strategy as polling
- Confirmed the first real `/plan` entry containing `taskId` and `taskName`

### 0.0.2

- Added recent status/charge transition history per mower
- Added read-only intermediate-recharge candidate and confirmation tracking
- Normal task completion is not counted as an intermediate recharge without a later return to `Working`
- Added four-hour expiry for unconfirmed recharge candidates
- Corrected first-poll initialization: startup is no longer recorded as a real status/charge change

### 0.0.1

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
