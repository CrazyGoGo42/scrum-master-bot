# Scrum Master Bot

Discord Scrum-Master-Bot für das Hauptprojekt. Der Bot organisiert Daily Scrums, Abmeldungen, Erinnerungen, persönliche Daily-Foren, Meetings und Wochenberichte.

> Der Bot hat **keinen Zugriff auf das private Hauptprojekt-GitHub-Repository**. Git-/Push-Hinweise basieren ausschließlich auf den Angaben im Daily.

## Grundprinzip

Der Bot erkennt Teammitglieder anhand ihrer Discord-User-ID. Deshalb kann `/daily` beispielsweise im normalen `#general`-Channel gestartet werden. Der fertige Daily-Post wird automatisch in das persönliche Forum des Benutzers einsortiert.

- Joline → Joline-Forum
- David → David-Forum
- Duy → Duy-Forum
- andere Discord-IDs → keine Berechtigung

Ein Daily wird als neuer Forum-Post gespeichert:

```text
Daily Scrum Joline 28.09.2026
Daily Scrum David 28.09.2026
Daily Scrum Duy 28.09.2026
```

Im Daily selbst wird zusätzlich die Erstellzeit dokumentiert:

```text
Daily erstellt: 15:34 Uhr
```

## Wann wird das Daily gemacht?

Das Daily wird **immer unmittelbar vor Beginn der eigenen Projektarbeit für diesen Tag** gemacht.

Es gibt keine feste Startzeit. Das Team kann morgens, nachmittags, abends oder nachts arbeiten. Entscheidend ist:

> **Daily zuerst, danach Projektarbeit.**

Reguläre Daily-Tage sind **Montag bis Freitag**. Samstag und Sonntag sind keine verpflichtenden Projekttage und benötigen deshalb kein Daily. Wer am Wochenende freiwillig am Projekt arbeitet, kann trotzdem ein Daily starten und die Arbeit dokumentieren.

## Interaktives Daily / Abmeldung

`/daily` oder der Button **Daily ausfüllen** startet zunächst die Frage, ob die Person an diesem Tag ein Daily machen kann.

### Ja, Daily starten

Der Bot führt durch vier Fragen:

1. Was wurde seit dem letzten Daily erledigt?
2. Was möchtest du heute machen?
3. Gibt es Blocker?
4. An welchem Branch arbeitest du und muss noch etwas gepusht werden?

Nach einer privaten Vorschau wird erst mit **Daily absenden** der Forum-Post erstellt. Ein angefangenes, aber nicht abgesendetes Q&A zählt nicht.

### Nein, abmelden

Wer an einem regulären Projekttag kein Daily machen kann, kann sich direkt im selben Dialog abmelden.

Mögliche Gründe:

- **Krankheit** → wird als `Krankheit (entschuldigt)` dokumentiert
- **Termin** → zusätzlicher Grund / Termin wird abgefragt
- **Anderes** → ein eigener Grund muss angegeben werden

Eine Abmeldung wird im persönlichen Forum als eigener Post gespeichert, zum Beispiel:

```text
Abmeldung Joline 28.09.2026
```

Abgemeldete Personen werden für diesen Tag nicht mehr wegen eines fehlenden Dailys gepingt und zählen nicht als inaktiv.

Bei **Krankheit** erinnert der Bot zusätzlich daran, die Krankmeldung im bib-Intranet vorzunehmen. Laut Projektregel soll dies vor Unterrichtsbeginn um **08:00 Uhr** erfolgen:

https://intranet.bib.de/tiki-index.php?page=welcome

Falls nach einer Abmeldung später doch ein Daily eingereicht wird, hat das Daily Vorrang und die Abmeldung wird als aufgehoben markiert.

## Tagesablauf

| Uhrzeit | Aktion |
|---|---|
| 09:00 | Daily-Runde wird geöffnet |
| 15:00 | freundliche Erinnerung an Personen ohne Daily oder Abmeldung |
| 20:00 | zweite Erinnerung, falls weiterhin keine Dokumentation vorliegt |
| 00:05 | fehlende Dailies / Abmeldungen des abgeschlossenen Arbeitstags werden dokumentiert |
| Freitag 14:00 | Wochenbericht als Entwurf |
| regelmäßig | Prüfung, ob eine Push-Erinnerung fällig ist |

Nach **2 Arbeitstagen in Folge ohne Daily oder Abmeldung** dokumentiert der Bot die Inaktivität ausdrücklich im Scrum-Status-Channel. Das ist Projektdokumentation, keine automatische Sanktion.

## Daily-Status

`/scrum status` zeigt an Werktagen pro Person:

- `✅` Daily vorhanden, inklusive Uhrzeit
- `🟦` für den Tag abgemeldet
- `⏳` noch keine Dokumentation
- `⚠️` Forum nicht erreichbar

Am Wochenende meldet der Bot stattdessen, dass **kein regulärer Projekttag** vorliegt. Es wird niemand als fehlend markiert.

## Push-Erinnerung

Wenn im Daily `Noch zu pushen: Ja` angegeben wird, erhält der Daily-Post den Button **Als gepusht markieren**.

Nach standardmäßig 6 Stunden prüft der Bot, ob der Push noch als offen dokumentiert ist. Falls ja, sendet er einmalig eine freundliche Erinnerung direkt im Daily-Thread. Der Button kann danach genutzt werden, um den Push-Status dauerhaft als erledigt zu markieren.

Die Erinnerung ist **keine Pflicht** und kontrolliert GitHub nicht.

## Persönliche Daily-Foren

Jedes Teammitglied besitzt ein eigenes Discord-Forum. Der Bot erstellt jeden vollständigen Daily oder eine Abmeldung als neuen Post des jeweiligen Tages.

```text
Joline-Forum
├── Daily Scrum Joline 28.09.2026
├── Abmeldung Joline 29.09.2026
├── Daily Scrum Joline 30.09.2026
└── ...
```

Eine falsch konfigurierte Forum-ID eines Teammitglieds legt den restlichen Bot nicht lahm. `/bot status` zeigt die betroffene Konfiguration als Fehler an.

## Wochenbericht

Freitags um **14:00 Uhr** erstellt der Bot automatisch einen Wochenbericht im Wochenbericht-Forum. Grundlage sind die bis zu diesem Zeitpunkt vorhandenen vollständigen Dailies und Abmeldungen der laufenden Woche.

Der Bericht enthält:

- Tätigkeiten von Joline, David und Duy
- Uhrzeit der jeweiligen Dailies
- geplante Arbeiten
- dokumentierte Blocker
- dokumentierte Abwesenheiten
- fehlende abgeschlossene Arbeitstage ohne Daily oder Abmeldung
- aktuellen Stand / nächste Schritte

Ein später am Freitag eingereichtes Daily kann über `/wochenbericht erstellen` in einem neu erzeugten Bericht berücksichtigt werden.

Zusätzlich hängt der Bot eine **PDF für den Projektbetreuer** an (Layout nach bib-Dokumentationsrichtlinie: DIN A4, Logo oben rechts, Bundsteg links, Seitenzahlen):

1. Anwesenheit und Arbeitszeiten – Tabelle Person × Wochentag mit Beginn/Ende, Netto-Stunden, Abwesenheiten und Wochensumme
2. Tätigkeiten – je Person und Tag: erledigt, geplant, Blocker
3. Meetings – Thema, Ort, Teilnehmer, Agenda, Protokoll
4. Entscheidungen
5. Probleme und Blocker – mit Status (offen / gelöst)

## Meetings

Meetings werden ausschließlich im konfigurierten `meetings-erstellen`-Channel mit `/bot meeting` erstellt.

Der Bot fragt ab:

- Titel
- Datum
- Uhrzeit
- Dauer
- Agenda / Ziel

Danach veröffentlicht er eine Meeting-Karte mit Discord-Zeitstempel, Link zum Voice-Channel und Reaktionen für Zu- oder Absage.

Im Meeting-Erstellen-Channel akzeptiert der Bot absichtlich keine anderen Projektbefehle. Für einen vollständig sauberen Channel sollten zusätzlich die Discord-Channel-Berechtigungen so gesetzt werden, dass normale Nachrichten dort möglichst eingeschränkt sind.

## Bot-Info-Channel

`/bot info` aktualisiert die zentrale, öffentliche Anleitung im konfigurierten Info-Channel. Beim Botstart versucht der Bot diese Nachricht ebenfalls automatisch zu erstellen oder zu aktualisieren und anzupinnen.

Die Info erklärt unter anderem:

- Regel `Daily zuerst, danach Projektarbeit`
- Wochenendregel
- Abmeldung bei Krankheit, Termin oder anderem Grund
- Erinnerungszeiten
- Push-Erinnerung
- Wochenbericht
- Meeting-System
- wichtigste Slash Commands

## Zugriffssteuerung

Projektfunktionen sind nur für die drei in `.env` hinterlegten Discord-User-IDs nutzbar. Unbekannte Benutzer erhalten privat:

```text
⛔ Du gehörst nicht zum konfigurierten Projektteam und hast für diese Funktion keine Zuständigkeit.
```

Buttons und Modals prüfen die User-ID ebenfalls erneut.

## Slash Commands

- `/daily` – Daily oder Abmeldung für den Arbeitstag starten
- `/scrum status` – heutigen Daily-/Abmeldestatus anzeigen
- `/scrum heute` – heutigen Status anzeigen
- `/bot struktur` – private Daily-Vorlage anzeigen
- `/bot status` – Bot- und Channel-Konfiguration prüfen
- `/bot info` – öffentliche Bot-Dokumentation aktualisieren
- `/bot meeting` – neues Meeting erstellen, nur im Meeting-Erstellen-Channel
- `/wochenbericht vorschau` – Wochenbericht privat ansehen
- `/wochenbericht erstellen` – Wochenbericht sofort neu erstellen
- `/wochenbericht freigeben` – neuesten Wochenbericht freigeben
- `/test` – geplante Bot-Aktionen manuell testen, nur mit `Server verwalten`

## Benötigte Umgebungsvariablen

```env
DISCORD_TOKEN=
DISCORD_GUILD_ID=

WEEKLY_REPORT_FORUM_ID=
SCRUM_MASTER_CHANNEL_ID=
SCRUM_INFO_CHANNEL_ID=
MEETING_CREATE_CHANNEL_ID=
MEETING_VOICE_CHANNEL_ID=

JOLINE_DISCORD_ID=
JOLINE_DAILY_FORUM_ID=
DAVID_DISCORD_ID=
DAVID_DAILY_FORUM_ID=
DUY_DISCORD_ID=
DUY_DAILY_FORUM_ID=

TIMEZONE=Europe/Berlin

DAILY_OPEN_CRON=0 9 * * 1-5
DAILY_REMINDER_CRON=0 15 * * 1-5
DAILY_EVENING_REMINDER_CRON=0 20 * * 1-5
DAILY_MISSING_REPORT_CRON=5 0 * * 2-6

PUSH_REMINDER_AFTER_HOURS=6
PUSH_REMINDER_CHECK_CRON=*/10 * * * *

WEEKLY_REPORT_CRON=0 14 * * 5
```

## Einrichtung

1. Repository klonen.
2. `.env.example` nach `.env` kopieren.
3. Token, Channel-IDs und User-IDs eintragen.
4. Im Discord Developer Portal **Server Members Intent** und **Message Content Intent** aktivieren.
5. Bot mit `bot` und `applications.commands` einladen.
6. Benötigte Rechte: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Embed Links. Für automatisches Anpinnen der Info zusätzlich Manage Messages.
7. `npm install`
8. `npm run check`
9. `npm run dev`

## Automatischer Start beim Server-Reboot

Im Repository liegt `scripts/start-bot.sh`.

```bash
chmod +x scripts/start-bot.sh
```

Dann beispielsweise in `crontab -e`:

```cron
@reboot /bin/bash /home/gogo/Desktop/scrum-master-bot/scrum-master-bot/scripts/start-bot.sh
```

Logs:

```bash
tail -f logs/bot.log
```

## TODO

- Voice-Teilnahme an Meetings protokollieren
- Meeting-Zusammenfassungen / Protokolle
- weiterführendes Blocker-Tracking

## Datenschutz / Secrets

Tokens gehören ausschließlich in `.env`; `.env` wird nicht committed. Unfertige Daily-Q&A-Sitzungen liegen nur temporär im Arbeitsspeicher. Es gibt keine GitHub-API-Integration und keine externe Datenbank.

## Lizenz

MIT
