# Scrum Master Bot

Discord Scrum-Master-Bot für das Hauptprojekt. Der Bot führt das Team durch ein interaktives Daily Scrum mit vier Pflichtfragen, erinnert werktags an fehlende Dailies, erinnert am Tagesende ans Committen/Pushen und erstellt freitags automatisch einen Wochenbericht.

## Bot hinzufügen

[➕ Scrum Master zu einem Discord-Server hinzufügen](https://discord.com/oauth2/authorize?client_id=1553772454835392642&permissions=326417599552&integration_type=0&scope=bot+applications.commands)

> Der Bot hat **keinen Zugriff auf das private Hauptprojekt-GitHub-Repository**. Git-Hinweise sind reine Workflow-Erinnerungen.

## Daily-Struktur

Jedes Teammitglied besitzt ein eigenes Discord-Forum:

- Joline
- David
- Duy

Nach einem vollständig beantworteten Q&A erstellt der Bot im jeweiligen persönlichen Forum **einen neuen Post für den aktuellen Tag**.

```text
Joline-Forum
├── Daily Scrum Joline 28.09.2026
├── Daily Scrum Joline 29.09.2026
└── ...

David-Forum
├── Daily Scrum David 28.09.2026
└── ...

Duy-Forum
├── Daily Scrum Duy 28.09.2026
└── ...
```

Die Zuordnung erfolgt **nicht anhand des Channels, in dem `/daily` ausgeführt wird**, sondern anhand der Discord-User-ID. `/daily` kann deshalb beispielsweise auch in `#general` gestartet werden.

- Joline → Joline-Forum
- David → David-Forum
- Duy → Duy-Forum
- andere Discord-IDs → keine Berechtigung

## Zugriffssteuerung

Die Funktionen `/daily`, `/scrum`, `/bot` und `/wochenbericht` sind nur für die drei in `.env` konfigurierten Teammitglieder nutzbar. Auch die Buttons und Modals des Daily-Q&A prüfen die Discord-ID erneut.

Nicht bekannte Benutzer erhalten nur eine private Meldung:

```text
⛔ Du gehörst nicht zum konfigurierten Projektteam und hast für diese Funktion keine Zuständigkeit.
```

Die gleichen Regeln gelten für die manuellen Wochenbericht-Befehle. Der automatische Wochenbericht am Freitag läuft unabhängig davon über den Bot selbst.

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

Danach erhält der Benutzer eine **private Vorschau** mit:

- `Daily absenden`
- `Bearbeiten`
- `Abbrechen`

Erst nach **Daily absenden** gilt das Daily als vollständig. Beim finalen Absenden prüft der Bot nur das persönliche Forum des aktuellen Benutzers. Eine fehlerhafte Forum-ID eines anderen Teammitglieds blockiert das eigene Daily daher nicht mehr.

## Erinnerungen

- 09:00 Uhr: Daily-Runde mit Button wird eröffnet
- 11:00 Uhr: nur fehlende Personen werden gepingt
- 11:45 Uhr: letzte Erinnerung
- 12:00 Uhr: Abschlussstatus
- 16:30 Uhr: Git-/Push-Erinnerung

Ein begonnenes, aber nicht abgesendetes Q&A zählt **nicht** als Daily.

Falls eines der drei Daily-Foren falsch konfiguriert oder nicht erreichbar ist, bleibt der Bot online. `/bot status` zeigt dann das betroffene Forum als Fehler an.

## Wochenbericht

Freitags um **14:00 Uhr** erstellt der Bot automatisch einen Wochenbericht im Wochenberichte-Forum.

Dafür liest er die vollständigen Daily-Posts aus allen drei persönlichen Foren für die aktuelle Woche ein und gruppiert die Inhalte nach:

- Joline
- David
- Duy
- dokumentierten Blockern
- aktuellem Stand / nächsten Schritten

Ist ein Daily-Forum nicht erreichbar, wird das im Bericht für das betreffende Teammitglied kenntlich gemacht, statt den kompletten Bericht abzubrechen. Längere Berichte werden automatisch auf mehrere Discord-Nachrichten aufgeteilt.

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

- ein persönliches Daily-Forum für Joline
- ein persönliches Daily-Forum für David
- ein persönliches Daily-Forum für Duy
- ein Forum für `wochenberichte`
- einen normalen Textkanal für Scrum-Master-Meldungen

Die Zuordnung erfolgt über `.env`.

## Benötigte Umgebungsvariablen

```env
DISCORD_TOKEN=
DISCORD_GUILD_ID=
WEEKLY_REPORT_FORUM_ID=
SCRUM_MASTER_CHANNEL_ID=

JOLINE_DISCORD_ID=
JOLINE_DAILY_FORUM_ID=
DAVID_DISCORD_ID=
DAVID_DAILY_FORUM_ID=
DUY_DISCORD_ID=
DUY_DAILY_FORUM_ID=

TIMEZONE=Europe/Berlin
DAILY_OPEN_CRON=0 9 * * 1-5
DAILY_REMINDER_CRON=0 11 * * 1-5
DAILY_FINAL_REMINDER_CRON=45 11 * * 1-5
DAILY_DEADLINE_CRON=0 12 * * 1-5
GIT_REMINDER_CRON=30 16 * * 1-5
WEEKLY_REPORT_CRON=0 14 * * 5
```

## Einrichtung

1. Repository klonen.
2. `.env.example` nach `.env` kopieren.
3. Discord-Bot-Token sowie Channel- und User-IDs eintragen.
4. Im Discord Developer Portal **Server Members Intent** und **Message Content Intent** aktivieren.
5. Bot mit `bot` und `applications.commands` einladen.
6. Der Bot benötigt mindestens: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions und Embed Links.
7. `npm install`
8. `npm run check`
9. `npm run dev`

## Automatischer Start beim Server-Reboot

Im Repository liegt `scripts/start-bot.sh`. Das Script:

- findet das Repository relativ zu sich selbst
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

## Slash Commands

- `/daily` – startet den interaktiven Daily-Assistenten
- `/scrum status` – heutiger Abgabestatus
- `/scrum heute` – heutiger Abgabestatus
- `/bot struktur` – private Copy-Paste-Vorlage
- `/bot status` – Bot-/Konfigurationsstatus inklusive Forum-Prüfung
- `/wochenbericht vorschau` – Wochenbericht als private Vorschau
- `/wochenbericht erstellen` – Wochenbericht sofort erstellen
- `/wochenbericht freigeben` – neuesten Wochenbericht freigeben
- `/test` → `Daily Start`
- `/test` → `Daily Reminder`
- `/test` → `Daily Deadline`
- `/test` → `Git Reminder`
- `/test` → `Weekly Report`

## Zeitplan

| Uhrzeit | Aktion |
|---|---|
| 09:00 | Daily-Runde mit `Daily ausfüllen`-Button |
| 11:00 | Fehlende Personen werden erinnert |
| 11:45 | Letzte Erinnerung |
| 12:00 | Daily-Abschlussstatus |
| 14:00 Freitag | Wochenbericht als Entwurf |
| 16:30 | Git-/Branch-Erinnerung |

## TODO

- Meetings in Voice Channels
- Meeting-Tracking und mögliche Zusammenfassungen, sobald die Voice-Channel-Struktur feststeht

## Datenschutz / Secrets

Tokens gehören ausschließlich in `.env`; `.env` wird nicht committed. Unfertige Daily-Q&A-Sitzungen liegen nur temporär im Arbeitsspeicher. Es gibt keine GitHub-API-Integration und keine externe Datenbank.

## Lizenz

MIT
