# Scrum Master Bot

Discord Scrum-Master-Bot für das Hauptprojekt. Der Bot führt das Team durch ein interaktives Daily Scrum mit vier Pflichtfragen, erinnert werktags an noch nicht vollständig abgegebene Dailies, erinnert am Tagesende ans Committen/Pushen und erstellt aus den Daily-Posts einen strukturierten Wochenbericht.

## Bot hinzufügen

[➕ Scrum Master zu einem Discord-Server hinzufügen](https://discord.com/oauth2/authorize?client_id=1553772454835392642&permissions=326417599552&integration_type=0&scope=bot+applications.commands)

> Der Bot hat **keinen Zugriff auf das private Hauptprojekt-GitHub-Repository** und versucht daher ausdrücklich nicht, Commits oder Branches zu verifizieren. Git-Hinweise sind reine Workflow-Erinnerungen.

## Interaktives Daily Scrum

Der normale Workflow läuft über den Button **Daily ausfüllen** oder den Slash Command `/daily`.

Der Bot führt jeden Benutzer nacheinander durch genau vier Pflichtfragen:

1. **Seit dem letzten Daily**
   - Montag: „Was hast du Freitag / am Wochenende gemacht?“
   - Dienstag bis Freitag: „Was hast du gestern gemacht?“
2. **Heute**
   - „Was wirst du heute machen?“
3. **Blocker**
   - Buttons `Keine Blocker` oder `Blocker eintragen`
4. **Branch / Git**
   - aktueller Branch
   - ob noch etwas gepusht werden muss

Nach Frage 4 erhält der Benutzer eine **private Vorschau** mit den Buttons:

- `Daily absenden`
- `Bearbeiten`
- `Abbrechen`

Erst nach **Daily absenden** wird automatisch ein Beitrag im Daily-Scrum-Forum erstellt. Ein angefangenes, aber nicht abgesendetes Q&A zählt **nicht** als abgegeben und die Person wird weiterhin erinnert.

## Funktionen

- interaktives Daily-Q&A mit Buttons und Eingabefeldern
- vier Pflichtfragen pro Daily
- private Vorschau vor dem Absenden
- Daily-Scrum-Tracking Montag bis Freitag
- Erinnerungen um 11:00 und 11:45 Uhr, Deadline um 12:00 Uhr
- Abschlussstatus um 12:00 Uhr
- manuelle Posts zählen nur, wenn alle vier Bereiche vorhanden sind
- Git-/Branch-Erinnerung um 16:30 Uhr
- gezielte Erinnerung, wenn im Daily `Noch zu pushen: Ja` steht
- automatischer Wochenbericht freitags um 15:00 Uhr
- Slash Commands für Status, Daily-Assistent, Vorlage, Wochenberichte und Tests
- Docker-Unterstützung
- Zeitzone `Europe/Berlin`

## Daily-Vorlage

Falls jemand das Daily ausnahmsweise manuell schreiben möchte, kann `/bot struktur` genutzt werden. Die Antwort ist nur für den jeweiligen Benutzer sichtbar.

```md
## Seit dem letzten Daily
- Was habe ich seit dem letzten Daily gemacht?

## Heute
- Was mache ich heute?

## Blocker
Keine

## Branch / Git
- Branch: feature/mein-feature
- Noch zu pushen: Ja
```

Ein manuell erstellter Post zählt erst als vollständig, wenn **alle vier Bereiche** vorhanden sind.

## Discord-Struktur

Der Bot erwartet aktuell drei Discord-Kanäle:

- ein Forum für `daily-scrum`
- ein Forum für `wochenberichte`
- einen normalen Textkanal für Scrum-Master-Meldungen

Die IDs werden ausschließlich über `.env` gesetzt und deshalb nicht im öffentlichen Repository gespeichert.

## Einrichtung

1. Repository klonen.
2. `.env.example` nach `.env` kopieren.
3. Discord-Bot-Token und Channel-/User-IDs eintragen.
4. Im Discord Developer Portal den **Server Members Intent** und **Message Content Intent** aktivieren.
5. Bot mit den Scopes `bot` und `applications.commands` einladen.
6. Der Bot benötigt mindestens: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions und Embed Links.
7. `npm install`
8. `npm run check`
9. `npm run dev`

## Docker

```bash
cp .env.example .env
# .env ausfüllen
docker compose up -d --build
```

## Slash Commands

- `/daily` – startet den interaktiven Daily-Assistenten
- `/scrum status` – heutiger Abgabestatus
- `/scrum heute` – zeigt den aktuellen Daily-Status
- `/bot struktur` – zeigt privat die Copy-Paste-Vorlage
- `/bot status` – Bot-/Konfigurationsstatus
- `/wochenbericht vorschau` – Vorschau für die aktuelle Woche
- `/wochenbericht erstellen` – Bericht jetzt als Entwurf erzeugen
- `/wochenbericht freigeben` – neuesten Entwurf freigeben
- `/test` → `Daily Start` – 09-Uhr-Nachricht mit Button testen
- `/test` → `Daily Reminder` – Erinnerung testen
- `/test` → `Daily Deadline` – 12-Uhr-Abschluss testen
- `/test` → `Git Reminder` – Feierabend-Git-Erinnerung testen
- `/test` → `Weekly Report` – Wochenbericht testen

Die `/test`-Befehle sind auf Mitglieder mit `Server verwalten` beschränkt.

## Zeitplan

| Uhrzeit | Aktion |
|---|---|
| 09:00 | Daily-Runde mit `Daily ausfüllen`-Button eröffnet |
| 11:00 | Unvollständige Dailies werden erinnert |
| 11:45 | Letzte Erinnerung |
| 12:00 | Daily-Abschlussstatus |
| 16:30 | Git-/Branch-Erinnerung |
| Freitag 15:00 | Wochenbericht als Entwurf |

## Entwicklung

```bash
npm run check
npm run build
npm start
```

## Datenschutz / Secrets

Der Bot benötigt nur Discord-Daten aus dem konfigurierten Server. Tokens und IDs gehören in `.env`; `.env` wird nicht committed. Unfertige Daily-Q&A-Sitzungen liegen nur temporär im Arbeitsspeicher des Bots und werden erst beim finalen Absenden als Forum-Post veröffentlicht. Es gibt keine GitHub-API-Integration und keine externe Datenbank.

## Lizenz

MIT
