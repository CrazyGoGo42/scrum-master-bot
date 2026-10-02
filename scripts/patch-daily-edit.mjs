import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
let source = await readFile(file, 'utf8');

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`[daily-edit patch] Marker fehlt: ${label}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[daily-edit patch] Marker ist nicht eindeutig: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

replaceOnce(
  "import { config } from './config.js';\n",
  "import { config } from './config.js';\nimport { dailyEditCommand, installDailyEdit } from './daily-edit.js';\n",
  'Imports'
);

replaceOnce(
  'installProjectTools(client);\ninstallMeetingBackfill(client);',
  'installProjectTools(client);\ninstallMeetingBackfill(client);\ninstallDailyEdit(client);',
  'Daily Edit installieren'
);

replaceOnce(
  'commands.push(...projectCommands, meetingBackfillCommand);',
  'commands.push(...projectCommands, meetingBackfillCommand, dailyEditCommand);',
  'Daily Edit Command registrieren'
);

replaceOnce(
  "!['blocker', 'entscheidung', 'meeting-nachtragen'].includes(interaction.commandName)",
  "!['blocker', 'entscheidung', 'meeting-nachtragen', 'daily-bearbeiten'].includes(interaction.commandName)",
  'Doppelte Command-Verarbeitung verhindern'
);

source = source.replace(
  '`/daily` · Daily/Abmeldung',
  '`/daily` · Daily/Abmeldung  •  `/daily-bearbeiten` · heutiges Daily korrigieren'
);

await writeFile(file, source, 'utf8');
console.log('[daily-edit patch] /daily-bearbeiten wurde in dist/index.js integriert.');
