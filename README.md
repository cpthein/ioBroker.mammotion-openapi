# ioBroker.mammotion-openapi

![Mammotion OpenAPI](admin/mammotion-openapi.png)

ioBroker-Adapter für Mammotion-Mähroboter über die **offizielle Mammotion Open API**.

[Deutsch](#deutsch) · [English](#english)

---

# Deutsch

## Status

Version **0.0.4** ist der aktuelle Entwicklungsstand. Der Adapter ist noch nicht im offiziellen ioBroker-Repository oder bei npm veröffentlicht, läuft aber bereits mit echter Hardware über die Mammotion Open API.

Praktisch getestet wurde mit:

- **LUBA 2 AWD 3000X**
- Firmware **1.30.29.8**
- Gerät vom Hauptkonto an ein zweites Mammotion-Konto geteilt
- Open-API-Zugangsdaten mit diesem zweiten Konto erstellt

Der Zugriff auf das geteilte Gerät wurde über die offiziellen REST-Endpunkte bestätigt.

## Grundsatz

Der Adapter zeigt nur Werte als eigene ioBroker-Objekte an, die Mammotion beim getesteten LUBA 2 tatsächlich sinnvoll liefert.

Leere Felder, Nullblöcke und nicht nutzbare Placeholder-Daten werden nicht als scheinbar gültige Telemetrie dargestellt.

Die vollständigen Rohdaten des normalen Geräteabrufs bleiben zusätzlich in `rawJson` erhalten.

## Warum dieser Adapter?

Mammotion stellt eine offizielle Open API bereit. Dieser Adapter verwendet diese unterstützte Schnittstelle und keine nachgebauten MQTT-, Aliyun- oder App-Protokolle.

Ziele:

- zuverlässige REST-Telemetrie
- automatische OAuth2-Tokenverwaltung
- Unterstützung geteilter Geräte
- gespeicherte Aufgaben aus der Mammotion-App
- verständliche ioBroker-Datenpunkte
- nachvollziehbare Steuerbefehle
- keine erfundenen oder irreführenden Placeholder-Werte

## Konfiguration

Der Adapter benötigt **keinen Mammotion-Benutzernamen und kein Passwort** und keinen manuell gepflegten Access Token.

Benötigt werden:

- `Client ID`
- `Client Secret`
- Polling-Intervall

Die Zugangsdaten werden im Mammotion Developer Portal erzeugt:

https://developer.mammotion.com/credentials

Für den normalen Betrieb sind **60 Sekunden Polling** empfohlen.

Das Client Secret ist in `io-package.json` als `encryptedNative` definiert. ioBroker speichert es verschlüsselt und stellt es dem Adapter beim Start zur Verfügung.

Der Adapter holt automatisch ein OAuth2-Access-Token über `client_credentials`, erneuert es vor Ablauf und versucht bei HTTP/API-Code `401` einmal eine Neuanmeldung mit anschließendem Retry.

## Tatsächlich verwendete REST-Endpunkte

```text
GET  /v1/mowers
GET  /v1/mower/{deviceId}
GET  /v1/mower/{deviceId}/plan
POST /v1/mower/action
```

## Gerätedaten

Unter

```text
mammotion-openapi.0.mowers.<deviceId>
```

werden folgende Werte angelegt:

```text
id
name
model
firmware
online
status
previousStatus
lastStatusChange
batteryLevel
chargeStatus
previousChargeStatus
lastChargeStatusChange
lastUpdate
rawJson
```

Netzwerkdaten:

```text
network.usedNetwork
network.wifiAvailable
network.wifiRssi
network.cellularAvailable
network.cellularRssi
```

Die Mammotion-Statuswerte werden unverändert als Text übernommen. Die offizielle API dokumentiert unter anderem:

```text
Standby
Working
Paused
Mapping
Updating
Offline
Returning
Abnormal
```

Unbekannte zukünftige Statuswerte werden ebenfalls als Rohtext übernommen.

### Ladestatus

Beim Testgerät wurden real beobachtet:

```text
0 = nicht aktiv ladend / unterwegs
1 = an der Station bei vollem Akku bzw. Ladeende beobachtet
2 = aktives Laden an der Station
```

Die öffentliche Dokumentation beschreibt derzeit nur `0` und `1`. Deshalb bleibt `chargeStatus` bewusst als Rohwert erhalten.

## Gespeicherte Aufgaben

Der Adapter liest:

```text
GET /v1/mower/{deviceId}/plan
```

Für jede von Mammotion gelieferte gespeicherte Aufgabe wird ein eigener Kanal angelegt, zum Beispiel:

```text
mowers.<deviceId>.tasks.Breich-3.taskId
mowers.<deviceId>.tasks.Breich-3.taskName
mowers.<deviceId>.tasks.Breich-3.start
```

Der `taskName` wird exakt so verwendet, wie Mammotion ihn liefert. Namen werden nicht automatisch korrigiert, weil `START` den exakten Aufgabennamen erwartet.

Wird `start` auf `true` gesetzt, sendet der Adapter:

```json
{
  "deviceId": "<deviceId>",
  "action": "START",
  "params": {
    "taskName": "<exakter Aufgabenname>"
  }
}
```

Danach wird der ioBroker-Button automatisch wieder auf `false` gesetzt.

## Steuerung

Die allgemeinen Steuerbefehle liegen unter:

```text
mowers.<deviceId>.controls.stop
mowers.<deviceId>.controls.resume
mowers.<deviceId>.controls.abort
mowers.<deviceId>.controls.returnToDock
mowers.<deviceId>.controls.cancelReturn
```

Zuordnung:

| ioBroker | Mammotion Action | Bedeutung |
|---|---|---|
| `controls.stop` | `PAUSE` | laufende Aufgabe pausieren |
| `controls.resume` | `RESUME` | pausierte Aufgabe fortsetzen |
| `controls.abort` | `STOP` | Aufgabe abbrechen |
| `controls.returnToDock` | `RETURN` | zur Ladestation fahren |
| `controls.cancelReturn` | `CANCEL_RETURN` | laufende Rückkehr abbrechen |

Das Ergebnis des letzten Befehls wird gespeichert:

```text
controls.lastCommand
controls.lastCommandOk
controls.lastCommandError
controls.lastCommandAt
```

### Praktisch bestätigt

Am Test-LUBA wurden real bestätigt:

- `START`
- `PAUSE`
- `RESUME`
- `STOP`
- `RETURN`

Für `RETURN` antwortete die offizielle API mit:

```text
Recharge command has been sent
```

`CANCEL_RETURN` ist offiziell dokumentiert und implementiert, aber noch nicht praktisch am Testgerät bestätigt.

## Statushistorie und Zwischenladen

Der Adapter führt eine kleine Status-/Ladehistorie und versucht ein Zwischenladen während einer Aufgabe anhand der öffentlich verfügbaren Zustände zu erkennen.

Datenpunkte:

```text
recharge.mowingSeenSinceIdle
recharge.candidate
recharge.candidateSince
recharge.confirmedDuringTask
recharge.lastConfirmed
recharge.confirmedCount
recharge.statusHistoryJson
```

Ein Zwischenladen wird erst rückwirkend bestätigt, wenn nach einer Rückkehr-/Ladephase wieder `Working` erscheint.

Da die Open API keine eindeutige Task-/Session-ID liefert, kann eine manuelle neue Aufgabe innerhalb des Beobachtungsfensters grundsätzlich nicht sicher von einer automatischen Wiederaufnahme unterschieden werden. Ein vom Adapter selbst gesendetes `STOP` oder `RETURN` setzt deshalb die laufende Erkennungssequenz zurück.

## Warum es keine `workParams.*`-Objekte gibt

Mammotion dokumentiert:

```text
GET /v1/mower/{deviceId}/work-params
```

Beim getesteten **LUBA 2 AWD 3000X** wurde der Aufruf zwar akzeptiert, die Antwort enthielt jedoch während realer Nutzung nur einen vollständigen Null-/Placeholder-Block, zum Beispiel `speed: 0`, `knifeHeight: 0`, `channelWidth: 0` usw.

Diese Werte stimmen nicht zuverlässig mit den realen Arbeitsparametern überein. Version 0.0.4 pollt diesen Endpunkt deshalb nicht mehr und legt keine `workParams.*`-Objekte an.

Beim Update von einer vorherigen 0.0.4-Entwicklungsfassung entfernt der Adapter vorhandene `workParams.*`-Altobjekte automatisch.

Auch leere Gerätefelder wie `nickname` und die von unserem LUBA 2 als leer gelieferte Geräte-`icon`-URL werden nicht als eigene Datenpunkte angelegt.

## Position / COORD / SSE

Die OpenAPI-Dokumentation nennt unter anderem die Subscription-Eigenschaft:

```text
COORD = Real-time device coordinate position
```

Getestet wurde mit dem LUBA 2:

1. `POST /v1/devices/subscriptions` mit `COORD` wurde mit `code: 0` und `commandResult: true` akzeptiert.
2. Die SSE-Verbindung zu `/developer-sse/api/client/sse` wurde erfolgreich aufgebaut.
3. Heartbeats wurden empfangen.
4. Auch bei realer manueller Bewegung des Mähers wurden keine `COORD`-Business-Daten gepusht.

Deshalb enthält Version 0.0.4 **keine Positions- oder Google-Maps-Datenpunkte**. Sobald Mammotion diese Daten für den LUBA 2 über die öffentliche Open API tatsächlich freigibt, kann die Funktion ergänzt werden.

## API-Diagnose

```text
api.ok
api.lastError
api.consecutiveErrors
api.lastHttpStatus
api.lastSuccess
api.tokenExpiresAt
api.requestId
info.connection
```

## Installation von GitHub

In ioBroker über die GitHub-Installation:

```text
cpthein/ioBroker.mammotion-openapi
```

Bei Updates muss eine bestehende Instanz normalerweise nicht gelöscht werden. Konfiguration und Zugangsdaten bleiben erhalten.

## Sicherheit

- kein Mammotion-Benutzerpasswort im Adapter
- OAuth2 `client_credentials`
- Client Secret über ioBroker `encryptedNative`
- kein dauerhaft manuell gepflegter Access Token
- Steuerbefehle werden nur durch beschreibbare ioBroker-Buttons ausgelöst

## Lizenz

MIT License, 2026 cpthein

---

# English

## Status

Version **0.0.4** is the current development version. It is not yet published in the official ioBroker repository or on npm, but it is running against real hardware through the official Mammotion Open API.

Tested with:

- **LUBA 2 AWD 3000X**
- firmware **1.30.29.8**
- mower shared from the main Mammotion account to a second account
- Open API credentials created with that second account

## Design principle

The adapter creates dedicated ioBroker states only for data that the tested LUBA 2 actually returns in a useful form.

Empty fields, all-zero placeholder blocks and unsupported data are not presented as if they were valid telemetry.

The complete normal mower response is still retained in `rawJson`.

## Configuration

Required:

- `Client ID`
- `Client Secret`
- polling interval

Credentials are created at:

https://developer.mammotion.com/credentials

A polling interval of **60 seconds** is recommended.

The adapter automatically obtains and renews an OAuth2 access token using `client_credentials`. On HTTP/API code `401`, it requests a fresh token once and retries the request.

## REST endpoints used

```text
GET  /v1/mowers
GET  /v1/mower/{deviceId}
GET  /v1/mower/{deviceId}/plan
POST /v1/mower/action
```

## Mower states

```text
id
name
model
firmware
online
status
previousStatus
lastStatusChange
batteryLevel
chargeStatus
previousChargeStatus
lastChargeStatusChange
lastUpdate
rawJson
```

Network states:

```text
network.usedNetwork
network.wifiAvailable
network.wifiRssi
network.cellularAvailable
network.cellularRssi
```

The official status string is stored unchanged. Documented values include `Standby`, `Working`, `Paused`, `Mapping`, `Updating`, `Offline`, `Returning` and `Abnormal`.

Observed `chargeStatus` values on the test mower were `0`, `1` and `2`; therefore the adapter deliberately keeps the raw numeric value.

## Saved tasks

Saved tasks returned by:

```text
GET /v1/mower/{deviceId}/plan
```

are exposed as individual task channels with `taskId`, `taskName` and a writable `start` button.

Starting a saved task sends `START` with the exact Mammotion `taskName`.

## Controls

```text
controls.stop         -> PAUSE
controls.resume       -> RESUME
controls.abort        -> STOP
controls.returnToDock -> RETURN
controls.cancelReturn -> CANCEL_RETURN
```

`START`, `PAUSE`, `RESUME`, `STOP` and `RETURN` have been confirmed against the real test mower. `CANCEL_RETURN` is officially documented and implemented but has not yet been physically tested.

## Recharge tracking

The adapter stores a small status/charge history and uses the available REST states to detect a possible intermediate recharge during a mowing task. Confirmation is retrospective when the mower returns to `Working` after a return/charge phase.

Because the Open API does not expose a reliable task/session ID, the logic cannot perfectly distinguish every manual restart from an automatic resume. Adapter-issued `STOP` and `RETURN` commands reset the current recharge-detection sequence.

## Why there are no `workParams.*` states

The documented endpoint:

```text
GET /v1/mower/{deviceId}/work-params
```

was accepted for the tested LUBA 2 AWD 3000X but returned an all-zero placeholder set even while the mower was performing real work.

Version 0.0.4 therefore no longer polls this endpoint and does not create misleading `workParams.*` states. Old development-version `workParams.*` objects are removed automatically during startup.

Empty `nickname` and device-icon URL fields are likewise not exposed as dedicated states.

## Position / COORD / SSE

A `COORD` subscription was accepted successfully and the documented SSE connection produced normal heartbeats. However, no coordinate business data was pushed for the tested LUBA 2, even while the mower was manually moving.

Therefore version 0.0.4 does **not** expose position or Google Maps states. The architecture can be extended when Mammotion makes this data available for the LUBA 2 through the public Open API.

## API diagnostics

```text
api.ok
api.lastError
api.consecutiveErrors
api.lastHttpStatus
api.lastSuccess
api.tokenExpiresAt
api.requestId
info.connection
```

## GitHub installation

```text
cpthein/ioBroker.mammotion-openapi
```

Existing instances normally do not need to be deleted when updating.

## License

MIT License, 2026 cpthein
