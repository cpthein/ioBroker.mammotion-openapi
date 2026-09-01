# ioBroker.mammotion-openapi

ioBroker-Adapter für Mammotion Mähroboter über die **offizielle Mammotion Open API**.

[Deutsch](#deutsch) · [English](#english)

---

# Deutsch

## Status

Version **0.0.4** ist der derzeitige Entwicklungsstand. Der Adapter ist noch nicht im offiziellen ioBroker-Repository oder bei npm veröffentlicht, läuft aber bereits mit echter Hardware über die Mammotion Open API.

Getestet wurde mit:

- **LUBA 2 AWD 3000X**
- Firmware **1.30.29.8**
- Gerät vom Hauptkonto an ein zweites Mammotion-Konto geteilt
- Open-API-Zugangsdaten mit diesem zweiten Konto erstellt

Der Zugriff auf ein geteiltes Gerät wurde über die offiziellen Endpunkte `/v1/mowers`, `/v1/mower/{deviceId}`, `/v1/mower/{deviceId}/plan`, `/v1/mower/{deviceId}/work-params` und `/v1/mower/action` bestätigt.

## Warum dieser Adapter?

Mammotion stellt eine offizielle Open API bereit. Dieser Adapter benutzt diese unterstützte Schnittstelle und keine nachgebauten MQTT-, Aliyun- oder App-Protokolle.

Ziele sind:

- zuverlässige Telemetrie
- automatische OAuth2-Tokenverwaltung
- Unterstützung geteilter Geräte
- gespeicherte Aufgaben aus der Mammotion-App
- verständliche ioBroker-Datenpunkte
- sichere, nachvollziehbare Steuerbefehle
- Rohdaten dort, wo Mammotion Werte noch nicht eindeutig dokumentiert

## Konfiguration

Der Adapter benötigt **keinen Mammotion-Benutzernamen und kein Passwort** und auch keinen manuell eingetragenen Access Token.

Benötigt werden:

- `Client ID`
- `Client Secret`
- Polling-Intervall

Die Zugangsdaten werden im Mammotion Developer Portal erzeugt:

https://developer.mammotion.com/credentials

Für den normalen Betrieb sind **60 Sekunden Polling** empfohlen.

Das Client Secret ist in `io-package.json` als `encryptedNative` definiert. ioBroker speichert es verschlüsselt und stellt es dem Adapter beim Start wieder zur Verfügung.

Der Adapter holt selbstständig ein OAuth2-Access-Token über `client_credentials`, erneuert es vor Ablauf und versucht bei HTTP/API-Code `401` genau einmal eine Neuanmeldung mit anschließendem Retry.

## Unterstützte Gerätedaten

Pro Mäher werden unter `mowers.<deviceId>` unter anderem folgende Werte angelegt:

```text
id
name
nickname
model
icon
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

Die Mammotion-Statuswerte werden als Text unverändert übernommen. Laut offizieller API sind unter anderem diese Werte möglich:

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

Unbekannte zukünftige Werte werden ebenfalls als Rohtext übernommen und nicht künstlich umgedeutet.

## Gespeicherte Aufgaben

Der Adapter liest:

```text
GET /v1/mower/{deviceId}/plan
```

Für jede dort gefundene gespeicherte Aufgabe wird ein eigener Kanal angelegt, zum Beispiel:

```text
mowers.<deviceId>.tasks.Breich-3.taskId
mowers.<deviceId>.tasks.Breich-3.taskName
mowers.<deviceId>.tasks.Breich-3.start
```

Der `taskName` wird exakt so verwendet, wie Mammotion ihn liefert. Schreibfehler oder ungewöhnliche Namen werden nicht automatisch verändert, weil Mammotion beim Start den exakten Namen erwartet.

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

Die allgemeinen Steuerbefehle liegen pro Mäher unter:

```text
mowers.<deviceId>.controls.stop
mowers.<deviceId>.controls.resume
mowers.<deviceId>.controls.abort
mowers.<deviceId>.controls.returnToDock
mowers.<deviceId>.controls.cancelReturn
```

Zuordnung zur Mammotion Open API:

| ioBroker | Mammotion Action | Bedeutung |
|---|---|---|
| `controls.stop` | `PAUSE` | laufende Aufgabe pausieren |
| `controls.resume` | `RESUME` | pausierte Aufgabe fortsetzen |
| `controls.abort` | `STOP` | Aufgabe abbrechen |
| `controls.returnToDock` | `RETURN` | zur Ladestation fahren |
| `controls.cancelReturn` | `CANCEL_RETURN` | laufende Rückkehr abbrechen |

Zusätzlich wird das Ergebnis des letzten Befehls gespeichert:

```text
controls.lastCommand
controls.lastCommandOk
controls.lastCommandError
controls.lastCommandAt
```

### Praktisch bestätigte Befehle

Auf dem Test-LUBA wurden bereits real bestätigt:

- `START`
- `PAUSE`
- `RESUME`
- `STOP`
- `RETURN` über den offiziellen Mammotion-Web/API-Aufruf mit der Antwort `Recharge command has been sent`

`CANCEL_RETURN` ist offiziell dokumentiert und im Adapter implementiert, aber noch nicht praktisch am Testgerät bestätigt.

## Aktuelle Arbeitsparameter

Version 0.0.4 liest zusätzlich:

```text
GET /v1/mower/{deviceId}/work-params
```

Die dokumentierten Werte werden unter `workParams.*` abgelegt:

```text
workParams.available
workParams.commandResult
workParams.resultMessage
workParams.edgeMode
workParams.rideBoundaryDistance
workParams.channelMode
workParams.channelModeText
workParams.jobContent
workParams.jobContentText
workParams.dumpPeriodSqm
workParams.knifeHeight
workParams.speed
workParams.channelWidth
workParams.toward
workParams.towardMode
workParams.towardModeText
workParams.towardIncludedAngle
workParams.ultraWave
workParams.ultraWaveText
workParams.boundaryZigzagOrder
workParams.boundaryZigzagOrderText
workParams.forbiddenAreaCircleTimes
workParams.visualHashsJson
workParams.lastUpdate
workParams.rawJson
```

Die textuellen Zusatzwerte basieren ausschließlich auf den offiziell dokumentierten Zahlenwerten.

### Beobachtung beim LUBA 2 AWD 3000X

Der Endpoint wird vom Testgerät akzeptiert und antwortet mit `code = 0` und `commandResult = true`. Sowohl in `Standby` als auch während `Working` wurden jedoch bisher alle eigentlichen Arbeitsparameter als `0` zurückgegeben.

Der Adapter speichert diese Werte trotzdem unverändert. Er erfindet keine Einheiten oder Bedeutungen, die Mammotion nicht liefert. Falls Mammotion die Daten später per Firmware oder API freischaltet, sind die Datenpunkte bereits vorhanden.

## Ladestatus

Die offizielle Schema-Beschreibung vereinfacht `chargeStatus` zu `0 = nicht laden` und `1 = laden`.

Am realen Testgerät wurde jedoch beobachtet:

- `chargeStatus = 0` während `Working` und `Returning`
- `chargeStatus = 2` nach dem Andocken bei sichtbar aktivem Laden
- `chargeStatus = 1` bei 100 % Akku im Dock und `Standby`

Deshalb bleibt `chargeStatus` bewusst ein **Rohwert**. Der Adapter ersetzt reale Beobachtungen nicht durch eine möglicherweise unvollständige Schema-Beschreibung.

## Status-Historie und Zwischenladen

Der Adapter führt eine kleine Historie der letzten Status-/Ladezustandswechsel:

```text
recharge.statusHistoryJson
```

Maximal werden 50 Übergänge gespeichert.

Zusätzlich gibt es einen experimentellen Detektor für eine mögliche automatische Zwischenladung während einer Aufgabe:

```text
recharge.mowingSeenSinceIdle
recharge.candidate
recharge.candidateSince
recharge.confirmedDuringTask
recharge.lastConfirmed
recharge.confirmedCount
```

Grundprinzip:

1. `Working` markiert eine laufende Mähsequenz.
2. Danach erzeugt `Returning` oder ein nicht-null Ladestatus einen Kandidaten.
3. `Working -> Returning -> Standby/Laden` allein zählt **nicht** als Zwischenladung, weil dies auch ein normales Aufgabenende sein kann.
4. Erst eine spätere Rückkehr zu `Working` innerhalb des Kandidatenfensters bestätigt die Sequenz.
5. Ein unbestätigter Kandidat verfällt nach vier Stunden.

Neu in 0.0.4: Nach einem expliziten `STOP` oder `RETURN` über den Adapter wird die laufende Zwischenlade-Sequenz zurückgesetzt. Dadurch soll ein späterer manueller Neustart nicht fälschlich als automatische Wiederaufnahme nach Zwischenladung gezählt werden.

## Position, Karte und SSE

Mammotion dokumentiert für die neue Property-Subscription unter anderem:

```text
BMS_INFO
COORD
WK_PRG
KNF_HGT
KNF_ST
WK_TRK
BASE_STN
```

`COORD` ist als Echtzeit-Geräteposition beschrieben und wäre grundsätzlich ideal für eine Karten- oder Google-Maps-Darstellung.

Der dokumentierte Ablauf ist:

1. `POST /v1/devices/subscriptions`
2. danach SSE-Verbindung zu `/developer-sse/api/client/sse`
3. Subscription jeweils 10 Minuten gültig

Mit dem Test-LUBA 2 wurde Folgendes praktisch geprüft:

- `COORD`-Subscription wird mit `code = 0` und `commandResult = true` akzeptiert
- SSE-Verbindung wird erfolgreich aufgebaut
- Heartbeats werden regelmäßig empfangen
- selbst bei manueller Bewegung des Mähers wird jedoch **kein COORD-Event** über diesen öffentlichen SSE-Kanal geliefert

Die Mammotion-Dokumentation weist darauf hin, dass diese Subscription-Funktion derzeit nur für **LUBA 3 AWD** unterstützt wird. Deshalb implementiert Version 0.0.4 bewusst keinen SSE-/COORD-Pfad für den LUBA 2.

Die Mammotion-App kann die Position des LUBA 2 live anzeigen; diese Daten laufen offenbar über einen anderen internen App-Kanal, der nicht Teil der bisher freigegebenen Open API ist.

## Kartenbereiche und gespeicherte Aufgaben

Kartengebiete und gespeicherte Aufgaben sind nicht dasselbe.

Die Open API liefert über `/plan` gespeicherte Aufgaben mit `taskId` und `taskName`. Eine gespeicherte Aufgabe verweist intern auf die in der Mammotion-App gewählten Bereiche und Parameter.

Die eigentlichen Bereichspolygone der Karte werden über die derzeit für den LUBA 2 nutzbare REST-API nicht bereitgestellt.

`visualHashs` aus `/work-params` ist laut Mammotion ein oder mehrere "Map file visual hash"-Werte. Daraus lässt sich mit den aktuell dokumentierten Endpunkten jedoch noch keine Karte abrufen.

## API-Zustand

Der Adapter stellt zusätzlich bereit:

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

## Entwicklungsprinzip

**Nicht raten.**

Unbekannte Mammotion-Werte werden als Rohdaten gespeichert, bis ihre Bedeutung entweder offiziell dokumentiert oder am echten Gerät reproduzierbar bestätigt ist.

## Installation während der Entwicklung

Der Adapter kann direkt aus GitHub installiert werden:

```text
cpthein/ioBroker.mammotion-openapi
```

Eine bestehende Instanz muss für ein Update normalerweise nicht gelöscht werden. Konfiguration und Zugangsdaten bleiben erhalten.

## Changelog

### 0.0.4

- `RETURN` / Rückkehr zur Ladestation ergänzt
- `CANCEL_RETURN` ergänzt
- `nickname` und `icon` aus `DeviceDetail` ergänzt
- vollständige dokumentierte `/work-params`-Struktur als ioBroker-Datenpunkte ergänzt
- Roh-JSON für Arbeitsparameter ergänzt
- dokumentierte Zahlenwerte zusätzlich als lesbare Texte abgebildet, wo eindeutig möglich
- Zwischenlade-Tracking nach explizitem `STOP` oder `RETURN` zurücksetzen
- tatsächliche `RETURN`-API-Antwort am LUBA 2 bestätigt
- COORD/SSE-Verhalten mit LUBA 2 praktisch untersucht und dokumentiert
- README vollständig auf Deutsch und Englisch erweitert

### 0.0.3

- Start-Button für jede gespeicherte Aufgabe
- `PAUSE`, `RESUME` und `STOP`
- Ergebnisdatenpunkte für Steuerbefehle
- POST-Kommandos mit Token-Renewal und einmaligem `401`-Retry

### 0.0.2

- Status-/Ladezustands-Historie
- experimentelles Zwischenlade-Tracking
- Vier-Stunden-Verfall für unbestätigte Kandidaten

### 0.0.1

- erster Adapterstand
- OAuth2 Client Credentials
- geteilter LUBA 2 AWD 3000X erfolgreich über die offizielle Open API ausgelesen
- Telemetrie und gespeicherte Pläne

## Lizenz

MIT

---

# English

## Overview

`ioBroker.mammotion-openapi` is an ioBroker adapter for Mammotion robotic mowers using the **official Mammotion Open API**.

Current development version: **0.0.4**.

Test hardware:

- LUBA 2 AWD 3000X
- firmware 1.30.29.8
- mower shared from a primary Mammotion account to a secondary account
- Open API credentials created with the secondary account

The adapter intentionally avoids reverse-engineered cloud/MQTT protocols and uses Mammotion's supported REST API.

## Features

- OAuth2 client-credentials authentication
- automatic access-token renewal
- one automatic retry after HTTP/API `401`
- mower discovery via `/v1/mowers`
- multiple mower support
- device detail polling
- saved-task discovery via `/v1/mower/{deviceId}/plan`
- one `start` button per saved task
- `PAUSE`, `RESUME`, `STOP`, `RETURN` and `CANCEL_RETURN` controls
- command result states
- battery, raw charging state, firmware and network telemetry
- `name`, `nickname`, `model` and `icon`
- recent state/charge transition history
- experimental intermediate-recharge sequence tracking
- documented current work parameters from `/v1/mower/{deviceId}/work-params`
- raw JSON states for mower, plan and work-parameter responses

## Credentials

Create a Mammotion Open API Client ID and Client Secret at:

https://developer.mammotion.com/credentials

Configure the adapter instance with:

- Client ID
- Client Secret
- polling interval; 60 seconds is recommended

No Mammotion e-mail/password login and no manually copied access token are required.

The Client Secret is stored through ioBroker `encryptedNative`. The adapter obtains and renews the access token automatically.

## Saved tasks

The adapter reads:

```text
GET /v1/mower/{deviceId}/plan
```

Each returned saved task creates:

```text
mowers.<deviceId>.tasks.<taskKey>.taskId
mowers.<deviceId>.tasks.<taskKey>.taskName
mowers.<deviceId>.tasks.<taskKey>.start
```

Writing `true` to `start` sends Mammotion action `START` with the exact returned `taskName`.

## General controls

```text
mowers.<deviceId>.controls.stop         -> PAUSE
mowers.<deviceId>.controls.resume       -> RESUME
mowers.<deviceId>.controls.abort        -> STOP
mowers.<deviceId>.controls.returnToDock -> RETURN
mowers.<deviceId>.controls.cancelReturn -> CANCEL_RETURN
```

The adapter records:

```text
controls.lastCommand
controls.lastCommandOk
controls.lastCommandError
controls.lastCommandAt
```

`START`, `PAUSE`, `RESUME` and `STOP` have been confirmed through the adapter on real hardware. `RETURN` has been confirmed against the official Mammotion action endpoint on the real test mower. `CANCEL_RETURN` is officially documented and implemented but has not yet been physically tested on the test mower.

## Work parameters

The adapter polls:

```text
GET /v1/mower/{deviceId}/work-params
```

and exposes the documented fields below `workParams.*`, including raw JSON.

On the tested LUBA 2 AWD 3000X the endpoint succeeds with `code = 0` and `commandResult = true`, but currently returns zero for all actual work-parameter fields both in Standby and while Working. The adapter preserves these values without inventing undocumented units or interpretations.

## Charging-state note

Mammotion's published schema describes `chargeStatus` as `0 = not charging`, `1 = charging`, but real observations on the test LUBA include:

- `0` while Working and Returning
- `2` while visibly charging after docking
- `1` at 100% battery while docked in Standby

Therefore the adapter intentionally exposes the value as raw data.

## Position / COORD / SSE

Mammotion documents a subscription/SSE mechanism with properties including `COORD`, `BMS_INFO`, `WK_PRG` and `WK_TRK`.

The documented sequence is:

1. create `/v1/devices/subscriptions`
2. connect to `/developer-sse/api/client/sse`
3. renew the subscription every 10 minutes

A real LUBA 2 test showed:

- subscription request accepted
- SSE connection established
- heartbeat events received
- no `COORD` event was delivered even while manually moving the mower

Mammotion currently documents this subscription capability as supported only for **LUBA 3 AWD**. For that reason 0.0.4 does not implement an SSE/position path for LUBA 2.

## Development rule

Do not guess undocumented Mammotion values. Unknown values remain raw until confirmed by official documentation or repeatable real-world observation.

## License

MIT
