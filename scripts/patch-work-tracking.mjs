import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
let source = await readFile(file, 'utf8');

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`[work-tracking patch] Marker fehlt: ${label}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[work-tracking patch] Marker ist nicht eindeutig: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

replaceOnce(
  "import { config } from './config.js';\n",
  "import { config } from './config.js';\nimport { fridayCompletionStatus, installWorkTracking, startWorkSession, weeklyWorkTrackingSection, workTrackingCommands } from './work-tracking.js';\n",
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
  'const thread = await createDailyFromDraft(draft);',
  "const thread = await createDailyFromDraft(draft);\n            await startWorkSession(thread, interaction.user.id).catch((error) =>\n                console.error('[Arbeitszeit] Arbeitsstart konnte nicht gespeichert werden.', error)\n            );",
  'Arbeitszeit nach Daily starten'
);

replaceOnce(
  "return report.join('\\n') + weeklyProjectReportSection();",
  "return report.join('\\n') + weeklyWorkTrackingSection(entries, date) + weeklyProjectReportSection();",
  'Arbeitszeiten in Wochenbericht'
);

replaceOnce(
  "async function weeklyReportJob() {\n    const thread = await createWeeklyReport();\n    const channel = await getScrumChannel();\n    await channel.send(`📋 **Der Wochenbericht wurde als Entwurf erstellt.**\\nBitte kurz prüfen: <#${thread.id}>`);\n}",
  "async function weeklyReportJob() {\n    const scans = await weeklyScans();\n    const completion = fridayCompletionStatus(scans.daily.entries, scans.absence.entries);\n    if (!completion.ready) {\n        console.log(`[Weekly] Freitag noch nicht vollständig abgeschlossen: ${completion.missing.join('; ')}`);\n        return;\n    }\n    const forum = await getForum(config.weeklyForumId);\n    const expectedName = `Wochenbericht für Herrn Tepper | ${formatDate()}`;\n    const existingThreads = await allForumThreads(forum);\n    if (existingThreads.some((entry) => entry.name === expectedName)) {\n        console.log('[Weekly] Wochenbericht für heute existiert bereits.');\n        return;\n    }\n    const thread = await createWeeklyReport();\n    const channel = await getScrumChannel();\n    await channel.send(`📋 **Der Wochenbericht wurde als Entwurf erstellt.**\\nBitte kurz prüfen: <#${thread.id}>`);\n}",
  'Weekly erst nach abgeschlossenem Freitag erstellen'
);

source = source.replace(
  '`/daily` · Daily/Abmeldung  •  `/daily-bearbeiten` · heutiges Daily korrigieren',
  '`/daily` · Daily/Abmeldung  •  `/daily-bearbeiten` · heutiges Daily korrigieren  •  `/feierabend` · Arbeitstag abschließen  •  `/arbeitszeit` · Zeiten anzeigen/nachtragen'
);

await writeFile(file, source, 'utf8');
console.log('[work-tracking patch] Arbeitszeiterfassung wurde in dist/index.js integriert.');
