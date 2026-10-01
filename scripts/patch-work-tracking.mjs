import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
const workTrackingFile = new URL('../dist/work-tracking.js', import.meta.url);
let source = await readFile(file, 'utf8');
let workTrackingSource = await readFile(workTrackingFile, 'utf8');

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`[work-tracking patch] Marker fehlt: ${label}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[work-tracking patch] Marker ist nicht eindeutig: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

function replaceWorkTrackingOnce(search, replacement, label) {
  const first = workTrackingSource.indexOf(search);
  if (first === -1) throw new Error(`[work-tracking patch] Marker fehlt in work-tracking.js: ${label}`);
  if (workTrackingSource.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[work-tracking patch] Marker ist nicht eindeutig in work-tracking.js: ${label}`);
  }
  workTrackingSource =
    workTrackingSource.slice(0, first) + replacement + workTrackingSource.slice(first + search.length);
}

replaceOnce(
  "import { config } from './config.js';\n",
  "import { config } from './config.js';\nimport { fridayCompletionStatus, installWorkTracking, weeklyWorkTrackingSection, workTrackingCommands } from './work-tracking.js';\n",
  'Imports'
);

replaceOnce(
  'installProjectTools(client);\ninstallMeetingBackfill(client);\ninstallDailyEdit(client);',
  'installProjectTools(client);\ninstallMeetingBackfill(client);\ninstallDailyEdit(client);\ninstallWorkTracking(client);',
  'Arbeitszeiterfassung installieren'
);

replaceOnce(
  'commands.push(...projectCommands, meetingBackfillCommand, dailyEditCommand);',
  'commands.push(...projectCommands, meetingBackfillCommand, dailyEditCommand, ...workTrackingCommands);',
  'Arbeitszeit-Commands registrieren'
);

replaceOnce(
  "!['task', 'blocker', 'entscheidung', 'meeting-nachtragen', 'daily-bearbeiten'].includes(interaction.commandName)",
  "!['task', 'blocker', 'entscheidung', 'meeting-nachtragen', 'daily-bearbeiten', 'feierabend', 'arbeitszeit'].includes(interaction.commandName)",
  'Doppelte Command-Verarbeitung verhindern'
);

replaceOnce(
  "return report.join('\\n') + weeklyProjectReportSection();",
  "return report.join('\\n') + weeklyWorkTrackingSection(entries, date) + weeklyProjectReportSection();",
  'Arbeitszeiten in Wochenbericht'
);

replaceOnce(
  "async function weeklyReportJob() {\n    const thread = await createWeeklyReport();\n    const channel = await getScrumChannel();\n    await channel.send(`📋 **Der Wochenbericht wurde als Entwurf erstellt.**\\nBitte kurz prüfen: <#${thread.id}>`);\n}",
  "async function weeklyReportJob(allowOpenFridayEnd = false) {\n    const scans = await weeklyScans();\n    const completion = fridayCompletionStatus(scans.daily.entries, scans.absence.entries);\n    if (!completion.ready) {\n        const onlyMissingWorkTimes = completion.missing.length > 0 && completion.missing.every((entry) => entry.endsWith('Arbeitszeit noch nicht beendet'));\n        if (!allowOpenFridayEnd || !onlyMissingWorkTimes) {\n            console.log(`[Weekly] Freitag noch nicht vollständig abgeschlossen: ${completion.missing.join('; ')}`);\n            return;\n        }\n        console.log(`[Weekly] Samstag-Fallback: offene Freitags-Arbeitszeiten werden als Nicht übermittelt übernommen: ${completion.missing.join('; ')}`);\n    }\n    const forum = await getForum(config.weeklyForumId);\n    const existingThreads = await allForumThreads(forum);\n    const weekStart = nowBerlin().startOf('week').startOf('day');\n    const weekEnd = nowBerlin().endOf('week').endOf('day');\n    const reportAlreadyExists = existingThreads.some((entry) => {\n        if (!entry.name.startsWith('Wochenbericht für Herrn Tepper |') || !entry.createdAt) return false;\n        const createdAt = toBerlin(entry.createdAt);\n        return createdAt >= weekStart && createdAt <= weekEnd && (createdAt.weekday === 5 || createdAt.weekday === 6);\n    });\n    if (reportAlreadyExists) {\n        console.log('[Weekly] Finaler Wochenbericht für diese Kalenderwoche existiert bereits.');\n        return;\n    }\n    const thread = await createWeeklyReport();\n    const channel = await getScrumChannel();\n    await channel.send(`📋 **Der Wochenbericht wurde als Entwurf erstellt.**\\nBitte kurz prüfen: <#${thread.id}>`);\n}",
  'Weekly erst nach abgeschlossenem Freitag erstellen'
);

replaceOnce(
  "cron.schedule(config.cron.weeklyReport, () => void weeklyReportJob().catch(console.error), { timezone: config.timezone });",
  "cron.schedule(config.cron.weeklyReport, () => void weeklyReportJob().catch(console.error), { timezone: config.timezone });\n    cron.schedule(config.cron.weeklyReportRecovery, () => void weeklyReportJob(true).catch(console.error), { timezone: config.timezone });",
  'Samstags-Recovery für Wochenbericht'
);

replaceWorkTrackingOnce(
  "out.push(`- **${label}:** seit ${parseIso(session.startAt).toFormat('HH:mm')} Uhr · Arbeitstag noch nicht abgeschlossen`);",
  "out.push(DateTime.fromISO(day, { zone: config.timezone }).weekday === 5\n          ? `- **${label}:** Nicht übermittelt`\n          : `- **${label}:** seit ${parseIso(session.startAt).toFormat('HH:mm')} Uhr · Arbeitstag noch nicht abgeschlossen`);",
  'Offene Freitags-Arbeitszeit als Nicht übermittelt'
);

replaceWorkTrackingOnce(
  "`- **${label}:** Daily um ${daily.createdAt.toFormat('HH:mm')} Uhr · Arbeitszeit nicht erfasst (Altbestand vor Arbeitszeiterfassung)`",
  "DateTime.fromISO(day, { zone: config.timezone }).weekday === 5\n            ? `- **${label}:** Nicht übermittelt`\n            : `- **${label}:** Daily um ${daily.createdAt.toFormat('HH:mm')} Uhr · Arbeitszeit nicht erfasst (Altbestand vor Arbeitszeiterfassung)`",
  'Fehlende Freitags-Arbeitszeit als Nicht übermittelt'
);

source = source.replace(
  '`/daily` · Daily/Abmeldung  •  `/daily-bearbeiten` · heutiges Daily korrigieren',
  '`/daily` · Daily/Abmeldung  •  `/daily-bearbeiten` · heutiges Daily korrigieren  •  `/feierabend` · Arbeitstag abschließen  •  `/arbeitszeit` · Zeiten anzeigen/nachtragen'
);

await writeFile(workTrackingFile, workTrackingSource, 'utf8');
await writeFile(file, source, 'utf8');
console.log('[work-tracking patch] Button-Zeiterfassung und Samstag-Fallback wurden in dist integriert.');
