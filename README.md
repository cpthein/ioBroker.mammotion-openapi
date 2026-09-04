# ioBroker.mammotion-openapi

![Mammotion OpenAPI](admin/mammotion-openapi.png)

ioBroker-Adapter für Mammotion-Mähroboter über die **offizielle Mammotion Open API**.

[Deutsch](#deutsch) · [English](#english)

---

# Deutsch

## Status

Version **0.0.9** ist der aktuelle Entwicklungsstand. Der Adapter ist noch nicht im offiziellen ioBroker-Repository oder bei npm veröffentlicht, läuft aber bereits mit echter Hardware über die Mammotion Open API.

Dies ist ein unabhängiger, inoffizieller Community-Adapter. Er ist weder mit Mammotion verbunden noch von Mammotion bestätigt. Das handschriftliche `m` ist ein eigenständiges Adapter-Icon und kein Mammotion-Firmenlogo.

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
- schlaffreundlicher Betrieb bei abgeschalteter Ladestation

## Konfiguration

Der Adapter benötigt **keinen Mammotion-Benutzernamen und kein Passwort** und keinen manuell gepflegten Access Token.

Benötigt werden:

- `Client ID`
- `Client Secret`
- Polling-Intervall
- Einschlafschutz ein/aus
- Akkuschwelle für den Einschlafschutz

Die Zugangsdaten werden im Mammotion Developer Portal erzeugt:

https://developer.mammotion.com/credentials

Für den normalen Betrieb sind **60 Sekunden Polling** empfohlen.

Der Einschlafschutz ist standardmäßig aktiv und steht standardmäßig auf **80 %**. Die Schwelle kann in der Adapter-Einrichtung zwischen 20 und 100 % eingestellt werden.

Das Client Secret ist in `io-package.json` als `encryptedNative` definiert. ioBroker speichert es verschlüsselt und stellt es dem Adapter beim Start zur Verfügung.

Der Adapter holt automatisch ein OAuth2-Access-Token über `client_credentials`, erneuert es vor Ablauf und versucht bei HTTP/API-Code `401` einmal eine Neuanmeldung mit anschließendem Retry.

## Einschlafschutz ab Version 0.0.5

Beim getesteten LUBA 2 wurde beobachtet, dass regelmäßige OpenAPI-Abfragen den Mäher wach halten können, wenn er an einer stromlosen Ladestation steht. Version 0.0.5 kann deshalb das automatische Polling für einen einzelnen Mäher vollständig aussetzen.

Der Schlafmodus wird vorbereitet, wenn **alle** folgenden Bedingungen erfüllt sind:

```text
status = Standby
chargeStatus = 0
batteryLevel >= eingestellte Akkuschwelle
online = true
```

Diese Bedingungen müssen ungefähr **zwei Minuten stabil** bleiben. Erst danach wird das automatische OpenAPI-Polling für diesen Mäher angehalten. Die Verzögerung verhindert, dass ein kurzer Standby-Zwischenzustand versehentlich als Schlafzustand behandelt wird.

Die Akkuschwelle ist eine Mindestschwelle. Bei eingestellten 80 % greift die Logik also auch bei 81 %, 90 % oder 100 %.

Wichtig: Der Adapter **schaltet das Ladegerät nicht selbst aus**. Bis eine externe Automatisierung wie ein Shelly vorhanden ist, kann das Netzteil manuell ausgeschaltet werden. Sobald danach `chargeStatus = 0` erkannt wird und die übrigen Bedingungen passen, lässt der Adapter den Mäher in Ruhe.

Während des Schlafmodus werden für diesen Mäher **keine automatischen Geräte- oder Plan-Abfragen mehr gesendet**. Die zuletzt gelesenen Telemetriewerte bleiben deshalb absichtlich stehen; `lastUpdate` zeigt, wann zuletzt wirklich abgefragt wurde.

Datenpunkte:

```text
sleep.active
sleep.since
sleep.candidateSince
sleep.thresholdPercent
sleep.reason
sleep.resumePolling
```

`sleep.active = true` bedeutet: Der Adapter hält diesen Mäher nicht mehr durch zyklische OpenAPI-Abfragen wach.

Ohne externe Automatisierung gilt zum Aufwecken:

1. Ladestation/Netzteil wieder einschalten.
2. Warten, bis der Mäher aufwachen kann.
3. `sleep.resumePolling` auf `true` setzen.

Der Button wird danach wieder automatisch auf `false` gesetzt. Das normale Polling startet sofort wieder. Ein Steuerbefehl oder ein gespeicherter Task-Start hebt einen aktiven Schlafmodus ebenfalls auf, damit der Adapter den Befehl senden kann.

Der Schlafzustand wird nach einem Adapter-Neustart wieder aufgenommen, sofern er vorher aktiv war. Zur Gerätezuordnung wird beim Adapterstart weiterhin einmal die Geräteliste über die Open API gelesen; danach erfolgen für schlafende Mäher keine zyklischen Geräteabfragen.

Für eine spätere Shelly-Automatik ist vorgesehen: Ladegerät einschalten -> Mäher wacht auf -> `sleep.resumePolling` auslösen -> Aufgabe starten.

## Tatsächlich verwendete REST-Endpunkte

```text
GET  /v1/mowers
GET  /v1/mower/{deviceId}
GET  /v1/mower/{deviceId}/plan
POST /v1/mower/action
```

Seit Version 0.0.5 wird `GET /v1/mowers` nicht mehr in jedem normalen Polling-Zyklus erneut aufgerufen. Die bekannten Mäher werden nach der Erkennung im laufenden Adapterprozess weiterverwendet. Dadurch wird unnötiger Cloud-Verkehr reduziert.

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
0 = nicht aktiv ladend; kann auch angedockt bei stromloser Ladestation sein
1 = an der Station bei vollem Akku bzw. Ladeende beobachtet
2 = aktives Laden an der Station
```

`chargeStatus = 0` bedeutet daher **nicht automatisch**, dass der Mäher außerhalb der Ladestation steht. Die öffentliche Dokumentation beschreibt derzeit nicht alle real beobachteten Werte vollständig. Deshalb bleibt `chargeStatus` bewusst als Rohwert erhalten.

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
recharge.trackingVersion
recharge.statusHistoryJson
```

Seit Version 0.0.6 basiert die Erkennung auf zwei praktisch beobachteten Zustandsfolgen des getesteten LUBA 2:

```text
Zwischenladen: Mowing -> Returning -> TaskPaused + chargeStatus > 0 -> Mowing
Job beendet:   Mowing -> Returning -> Standby + chargeStatus > 0
```

Ein Zwischenladen wird nur vorbereitet, wenn nach bereits erkanntem Mähen `TaskPaused` **während des Ladens** erscheint. Erst die anschließende automatische Rückkehr zu `Mowing` oder `Working` bestätigt das Zwischenladen und erhöht `confirmedCount`.

`Returning`, ein positiver `chargeStatus` oder eine normale Rückkehr zu `Standby` reichen ausdrücklich nicht mehr aus. `Standby` beendet die laufende Erkennungssequenz. Dadurch wird ein später manuell gestarteter neuer Job nicht fälschlich als Fortsetzung nach Zwischenladen gezählt.

Ein vom Adapter selbst gesendetes `START`, `STOP` oder `RETURN` setzt die laufende Erkennungssequenz ebenfalls zurück.

Seit Version 0.0.7 läuft ein Kandidat nicht mehr ab, solange der Mäher `TaskPaused` meldet. Dadurch wird auch eine lange Regenpause mit Laden bis 100 % beim späteren Fortsetzen korrekt als Zwischenladen bestätigt. Außerhalb von `TaskPaused` bleibt die Vier-Stunden-Sicherheitsgrenze gegen veraltete Kandidaten bestehen.

Beim ersten Lauf mit Version 0.0.6 werden die mit der ungenaueren Erkennung aus Version 0.0.5 erzeugten Zähler und aktiven Kandidaten einmalig zurückgesetzt. Diese Migration erfolgt auch bei einem bereits schlafenden Mäher ohne Geräte- oder Planabfrage. `statusHistoryJson` bleibt als Rohhistorie erhalten. `recharge.trackingVersion = 2` kennzeichnet die neue Logik.

## Warum es keine `workParams.*`-Objekte gibt

Mammotion dokumentiert:

```text
GET /v1/mower/{deviceId}/work-params
```

Beim getesteten **LUBA 2 AWD 3000X** wurde der Aufruf zwar akzeptiert, die Antwort enthielt jedoch während realer Nutzung nur einen vollständigen Null-/Placeholder-Block, zum Beispiel `speed: 0`, `knifeHeight: 0`, `channelWidth: 0` usw.

Diese Werte stimmen nicht zuverlässig mit den realen Arbeitsparametern überein. Seit Version 0.0.4 pollt der Adapter diesen Endpunkt deshalb nicht mehr und legt keine `workParams.*`-Objekte an.

Beim Update von einer früheren Entwicklungsfassung entfernt der Adapter vorhandene `workParams.*`-Altobjekte automatisch.

Auch leere Gerätefelder wie `nickname` und die vom getesteten LUBA 2 als leer gelieferte Geräte-`icon`-URL werden nicht als eigene Datenpunkte angelegt.

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

Deshalb enthält Version 0.0.9 **keine Positions- oder Google-Maps-Datenpunkte**. Sobald Mammotion diese Daten für den LUBA 2 über die öffentliche Open API tatsächlich freigibt, kann die Funktion ergänzt werden.

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

Version **0.0.9** is the current development version. It is not yet published in the official ioBroker repository or on npm, but it is running against real hardware through the official Mammotion Open API.

This is an independent, unofficial community adapter. It is neither affiliated with nor endorsed by Mammotion. The handwritten `m` is an original adapter icon and not Mammotion's corporate logo.

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
- sleep protection enable/disable
- sleep battery threshold

Credentials are created at:

https://developer.mammotion.com/credentials

A polling interval of **60 seconds** is recommended during normal operation.

Sleep protection is enabled by default with a threshold of **80%**. The threshold can be configured from 20 to 100%.

The adapter automatically obtains and renews an OAuth2 access token using `client_credentials`. On HTTP/API code `401`, it requests a fresh token once and retries the request.

## Sleep protection since 0.0.5

Regular OpenAPI polling was observed to keep the tested LUBA 2 awake while it was docked at an unpowered charging station. Version 0.0.5 can therefore suspend automatic polling completely for an individual mower.

A sleep candidate requires all of the following:

```text
status = Standby
chargeStatus = 0
batteryLevel >= configured threshold
online = true
```

The condition must remain stable for about **two minutes**. This delay prevents short Standby transitions from accidentally suspending polling.

The battery value is a minimum threshold. With 80% configured, the rule also applies at 81%, 90% or 100%.

The adapter does **not** switch the charger itself. Until an external automation such as a Shelly is available, the charger may be switched off manually. When `chargeStatus = 0` is then observed and the other conditions match, the adapter stops contacting that mower automatically.

While sleep protection is active, **no automatic mower-detail or plan requests are sent for that mower**. Telemetry therefore intentionally remains at the last observed values; `lastUpdate` shows when the mower was last actually polled.

States:

```text
sleep.active
sleep.since
sleep.candidateSince
sleep.thresholdPercent
sleep.reason
sleep.resumePolling
```

To resume without external automation:

1. Switch the charging station/power supply back on.
2. Allow the mower to wake.
3. Set `sleep.resumePolling` to `true`.

The button resets to `false` automatically and normal polling resumes immediately. Sending an adapter control command or starting a saved task also releases active sleep protection so the command can be sent.

A previously active sleep state is restored after an adapter restart. The adapter still reads the mower list once at startup to map devices, but does not continue cyclic mower requests for sleeping devices.

A future Shelly automation can use the sequence: power charger on -> mower wakes -> trigger `sleep.resumePolling` -> start task.

## REST endpoints used

```text
GET  /v1/mowers
GET  /v1/mower/{deviceId}
GET  /v1/mower/{deviceId}/plan
POST /v1/mower/action
```

Since version 0.0.5, `GET /v1/mowers` is no longer called on every regular polling cycle. Known mowers are cached for the lifetime of the running adapter process, reducing unnecessary cloud traffic.

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

Observed `chargeStatus` values on the test mower were:

```text
0 = not actively charging; also observed while docked at an unpowered charging station
1 = observed docked at full battery / charge end
2 = active charging at the station
```

Therefore the adapter deliberately keeps the raw numeric value.

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

The adapter stores a small status/charge history and uses the available REST states to detect a possible intermediate recharge during a mowing task. Since version 0.0.6, detection is based on two sequences observed on the tested LUBA 2:

```text
Intermediate recharge: Mowing -> Returning -> TaskPaused + chargeStatus > 0 -> Mowing
Completed job:         Mowing -> Returning -> Standby + chargeStatus > 0
```

An intermediate recharge candidate is created only when `TaskPaused` is observed while charging after mowing was already seen. The recharge is confirmed retrospectively when the mower automatically returns to `Mowing` or `Working`.

`Returning`, a positive `chargeStatus`, or a normal transition to `Standby` are no longer sufficient. `Standby` ends the current tracking sequence, preventing a later manually started job from being counted as an automatic resume. Adapter-issued `START`, `STOP`, and `RETURN` commands also reset the current sequence.

Since version 0.0.7, a candidate no longer expires while the mower reports `TaskPaused`. This lets a long rain delay, including charging to 100%, be confirmed correctly when mowing resumes. Outside `TaskPaused`, the four-hour safety timeout against stale candidates remains active.

On the first run with version 0.0.6, counters and active candidates created by the less precise v0.0.5 logic are reset once. This migration also runs for an already sleeping mower without a mower-detail or plan request. `statusHistoryJson` is preserved. `recharge.trackingVersion = 2` identifies the new algorithm.

## Why there are no `workParams.*` states

The documented endpoint:

```text
GET /v1/mower/{deviceId}/work-params
```

was accepted for the tested LUBA 2 AWD 3000X but returned an all-zero placeholder set even while the mower was performing real work.

Since version 0.0.4 the adapter no longer polls this endpoint and does not create misleading `workParams.*` states. Old development-version `workParams.*` objects are removed automatically during startup.

Empty `nickname` and device-icon URL fields are likewise not exposed as dedicated states.

## Position / COORD / SSE

A `COORD` subscription was accepted successfully and the documented SSE connection produced normal heartbeats. However, no coordinate business data was pushed for the tested LUBA 2, even while the mower was manually moving.

Therefore version 0.0.9 does **not** expose position or Google Maps states. The architecture can be extended when Mammotion makes this data available for the LUBA 2 through the public Open API.

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
