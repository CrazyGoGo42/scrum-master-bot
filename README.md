# Scrum Master Bot

Discord Scrum-Master-Bot für das Hauptprojekt. Der Bot führt das Team durch ein interaktives Daily Scrum mit vier Pflichtfragen, erinnert werktags an noch nicht vollständig abgegebene Dailies, erinnert am Tagesende ans Committen/Pushen und erstellt aus den Daily-Einträgen einen strukturierten Wochenbericht.

## Bot hinzufügen

[➕ Scrum Master zu einem Discord-Server hinzufügen](https://discord.com/oauth2/authorize?client_id=1553772454835392642&permissions=326417599552&integration_type=0&scope=bot+applications.commands)

> Der Bot hat **keinen Zugriff auf das private Hauptprojekt-GitHub-Repository** und versucht daher ausdrücklich nicht, Commits oder Branches zu verifizieren. Git-Hinweise sind reine Workflow-Erinnerungen.

## Daily-Struktur im Discord-Forum

Im Forum `daily-scrum` gibt es dauerhaft nur drei persönliche Sammelposts:

- `Joline Daily Scrums`
- `David Daily Scrums`
- `Duy Daily Scrums`

Der Bot erstellt fehlende Sammelposts beim Start automatisch. Ein fertiges Daily erzeugt **keinen neuen Forum-Post** mehr, sondern wird als neue Nachricht in den persönlichen Sammelpost geschrieben.

Beispiel:

```text
Joline Daily Scrums
├── Daily Scrum · 28.09.2026
├── Daily Scrum · 29.09.2026
├── Daily Scrum · 30.09.2026
└── ...
```

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
   - danach Buttons `Ja` / `Nein`, ob noch etwas committed oder gepusht werden muss

Nach Frage 4 erhält der Benutzer eine **private Vorschau** mit den Buttons:

- `Daily absenden`
- `Bearbeiten`
- `Abbrechen`

Erst nach **Daily absenden** wird der Eintrag in den persönlichen Sammelpost geschrieben. Ein angefangenes, aber nicht abgesendetes Q&A zählt **nicht** als abgegeben und die Person wird weiterhin erinnert.

## Funktionen

- interaktives Daily-Q&A mit Buttons und Eingabefeldern
- vier Pflichtfragen pro Daily
- drei dauerhafte persönliche Daily-Sammelposts
- private Vorschau vor dem Absenden
- Daily-Scrum-Tracking Montag bis Freitag
- Erinnerungen um 11:00 und 11:45 Uhr, Deadline um 12:00 Uhr
- Abschlussstatus um 12:00 Uhr
- Git-/Branch-Erinnerung um 16:30 Uhr
- gezielte Erinnerung, wenn im Daily `Noch zu pushen: Ja` steht
- automatischer Wochenbericht freitags um 15:00 Uhr
- Wochenbericht liest die Dailies direkt aus den drei persönlichen Sammelposts
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

## Discord-Struktur

Der Bot erwartet:

- ein Forum für `daily-scrum`, darin die drei persönlichen Sammelposts
- ein Forum für `wochenberichte`
- einen normalen Textkanal für Scrum-Master-Meldungen

Die Kanal- und Benutzer-IDs werden über `.env` gesetzt.

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

## Automatischer Start beim Server-Reboot

Im Repository liegt `scripts/start-bot.sh`. Das Script:

- findet das Repository automatisch relativ zu sich selbst
- lädt NVM, falls Node darüber installiert wurde
- installiert Abhängigkeiten nur, wenn `node_modules` fehlt
- baut den Bot mit `npm run build`
- startet ihn mit `npm start`
- startet ihn nach einem Crash nach 5 Sekunden neu
- verhindert doppelte Bot-Instanzen mit `flock`
- schreibt Logs nach `logs/bot.log`

Einmal ausführbar machen:

```bash
chmod +x scripts/start-bot.sh
```

Dann mit `crontab -e` eintragen:

```cron
@reboot /bin/bash /home/gogo/Desktop/scrum-master-bot/scrum-master-bot/scripts/start-bot.sh
```

Logs ansehen:

```bash
tail -f logs/bot.log
```

Zum Testen muss nicht neu gebootet werden:

```bash
./scripts/start-bot.sh
```

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

Der Bot benötigt nur Discord-Daten aus dem konfigurierten Server. Tokens und IDs gehören in `.env`; `.env` wird nicht committed. Unfertige Daily-Q&A-Sitzungen liegen nur temporär im Arbeitsspeicher des Bots und werden erst beim finalen Absenden in den persönlichen Sammelpost geschrieben. Es gibt keine GitHub-API-Integration und keine externe Datenbank.

## Lizenz

MIT
