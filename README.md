# Scrum Master Bot

Discord Scrum-Master-Bot für das Hauptprojekt. Der Bot überwacht Daily-Scrum-Posts in einem Discord-Forum, erinnert werktags an fehlende Dailies, erinnert am Tagesende ans Committen/Pushen und erstellt aus den Daily-Posts einen strukturierten Wochenbericht.

> Der Bot hat **keinen Zugriff auf das private Hauptprojekt-GitHub-Repository** und versucht daher ausdrücklich nicht, Commits oder Branches zu verifizieren. Git-Hinweise sind reine Workflow-Erinnerungen.

## Funktionen

- Daily-Scrum-Tracking Montag bis Freitag
- Erinnerungen um 11:00 und 11:45 Uhr, Deadline um 12:00 Uhr
- Abschlussstatus um 12:00 Uhr
- Validierung neuer Daily-Posts
- Git-/Branch-Erinnerung um 16:30 Uhr
- gezielte Erinnerung, wenn im Daily `Noch zu pushen: Ja` steht
- automatischer Wochenbericht freitags um 15:00 Uhr
- Slash Commands für Status, Vorschau, manuelle Berichtserstellung und Tests
- Docker-Unterstützung
- Zeitzone `Europe/Berlin`

## Daily-Vorlage

```md
## Seit dem letzten Daily
- Was wurde seit dem letzten Daily erledigt?

## Heute
- Was steht heute an?

## Blocker
Keine

## Branch / Git
- Branch: feature/mein-feature
- Noch zu pushen: Ja / Nein

## Sonstiges
- Optional
```

Die Standardstruktur ist empfohlen, aber der Bot zählt einen Post trotzdem als Daily. Nur der Abschnitt `Heute` wird als besonders wichtig behandelt.

## Discord-Struktur

Der Bot erwartet drei Discord-Kanäle:

- ein Forum für `daily-scrum`
- ein Forum für `wochenberichte`
- einen normalen Textkanal für Scrum-Master-Meldungen

Die IDs werden ausschließlich über `.env` gesetzt und deshalb nicht im öffentlichen Repository gespeichert.

## Einrichtung

1. Repository klonen.
2. `.env.example` nach `.env` kopieren.
3. Discord-Bot-Token und Channel-/User-IDs eintragen.
4. Im Discord Developer Portal den **Message Content Intent** aktivieren.
5. Bot mit den Scopes `bot` und `applications.commands` einladen.
6. Der Bot benötigt mindestens: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions und Embed Links.
7. `npm install`
8. `npm run dev`

## Docker

```bash
cp .env.example .env
# .env ausfüllen
docker compose up -d --build
```

## Slash Commands

- `/scrum status` – heutiger Abgabestatus
- `/scrum heute` – zeigt den aktuellen Daily-Status
- `/wochenbericht vorschau` – Vorschau für die aktuelle Woche
- `/wochenbericht erstellen` – Bericht jetzt als Entwurf erzeugen
- `/wochenbericht freigeben` – neuesten Entwurf freigeben
- `/bot status` – Bot-/Konfigurationsstatus
- `/test daily-reminder` – 11-Uhr-Erinnerung testen
- `/test daily-deadline` – 12-Uhr-Abschluss testen
- `/test git-reminder` – Feierabend-Git-Erinnerung testen
- `/test weekly-report` – Wochenbericht testen

Die `/test`-Befehle sind auf Mitglieder mit `Server verwalten` beschränkt.

## Zeitplan

| Uhrzeit | Aktion |
|---|---|
| 09:00 | Daily-Runde eröffnet, ohne Ping |
| 11:00 | Fehlende Personen werden erinnert |
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

Der Bot benötigt nur Discord-Daten aus dem konfigurierten Server. Tokens und IDs gehören in `.env`; `.env` wird nicht committed. Es gibt keine GitHub-API-Integration und keine Speicherung in einer externen Datenbank.

## Lizenz

MIT
