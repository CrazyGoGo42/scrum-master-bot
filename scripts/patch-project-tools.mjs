import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
let source = await readFile(file, 'utf8');

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`[project-tools patch] Marker fehlt: ${label}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[project-tools patch] Marker ist nicht eindeutig: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

replaceOnce(
  "import { config } from './config.js';\n",
  "import { config } from './config.js';\nimport { createScheduledMeeting, installProjectTools, meetingActionRow, offerDailyTasks, openBlockersSummary, projectCommands, projectToolsInfoText, trackDailyBlockers, weeklyMarkdownAttachment } from './project-tools.js';\n",
  'Import'
);

replaceOnce(
  '\nfunction teamMember(id) {',
  '\ninstallProjectTools(client);\n\nfunction teamMember(id) {',
  'Project-Tools installieren'
);

replaceOnce(
  'Wenn du heute nicht arbeiten kannst, kannst du dich hier abmelden.`',
  'Wenn du heute nicht arbeiten kannst, kannst du dich hier abmelden.${await openBlockersSummary(interaction.user.id)}`',
  'Offene Blocker im Daily anzeigen'
);

replaceOnce(
  'const chunks = splitDiscordText(botInfoText());',
  'const chunks = splitDiscordText(`${botInfoText()}\\n\\n${projectToolsInfoText()}`);',
  'Info-Text erweitern'
);

replaceOnce(
  ".addSubcommand((sub) => sub.setName('freigeben').setDescription('Markiert den neuesten Wochenbericht als freigegeben')),",
  ".addSubcommand((sub) => sub.setName('freigeben').setDescription('Markiert den neuesten Wochenbericht als freigegeben'))\n        .addSubcommand((sub) => sub.setName('export').setDescription('Exportiert den aktuellen Wochenbericht als Markdown-Datei')),",
  'Wochenbericht Export Command'
);

replaceOnce(
  '].map((command) => command.toJSON());',
  '].map((command) => command.toJSON()).concat(projectCommands);',
  'Projekt-Commands registrieren'
);

replaceOnce(
  "        if (sub === 'erstellen') {",
  "        if (sub === 'export') {\n            await interaction.deferReply({ flags: MessageFlags.Ephemeral });\n            const scans = await weeklyScans();\n            const report = buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);\n            await interaction.editReply({\n                content: '📄 Wochenbericht als Markdown-Datei:',\n                files: [weeklyMarkdownAttachment(report)]\n            });\n            return;\n        }\n\n        if (sub === 'erstellen') {",
  'Wochenbericht Export Handler'
);

replaceOnce(
  'components: [meetingVoiceRow()],',
  'components: [meetingVoiceRow(), meetingActionRow()],',
  'Meeting-Aktionen'
);

replaceOnce(
  "    await message.react('✅').catch(() => undefined);\n    await message.react('❌').catch(() => undefined);",
  "    await message.react('✅').catch(() => undefined);\n    await message.react('❌').catch(() => undefined);\n    const scheduledEventUrl = await createScheduledMeeting(client, title, start, end, agenda);\n    if (scheduledEventUrl) {\n        await interaction.followUp({\n            content: `📅 Discord-Termin erstellt: ${scheduledEventUrl}`,\n            flags: MessageFlags.Ephemeral\n        });\n    }",
  'Discord Scheduled Event'
);

replaceOnce(
  "            const thread = await createDailyFromDraft(draft);\n            await cancelActiveAbsenceIfPresent(interaction.user.id);",
  "            const thread = await createDailyFromDraft(draft);\n            await trackDailyBlockers(interaction.user.id, draft.blocker ?? 'Keine', thread.id).catch((error) =>\n                console.error('[Projekttools] Daily-Blocker konnten nicht übernommen werden.', error)\n            );\n            await offerDailyTasks(thread, interaction.user.id, draft.today ?? '').catch((error) =>\n                console.error('[Projekttools] Daily-Aufgaben-Angebot konnte nicht erstellt werden.', error)\n            );\n            await cancelActiveAbsenceIfPresent(interaction.user.id);",
  'Daily Aufgaben und Blocker'
);

replaceOnce(
  '    if (interaction.isChatInputCommand())\n        void handleCommand(interaction).catch(console.error);',
  "    if (interaction.isChatInputCommand() && !['task', 'blocker', 'entscheidung'].includes(interaction.commandName))\n        void handleCommand(interaction).catch(console.error);",
  'Doppelte Command-Verarbeitung verhindern'
);

replaceOnce(
  '    if (interaction.isButton())\n        void handleButton(interaction).catch(console.error);',
  "    if (interaction.isButton() && !interaction.customId.startsWith('project:'))\n        void handleButton(interaction).catch(console.error);",
  'Doppelte Button-Verarbeitung verhindern'
);

replaceOnce(
  '    if (interaction.isModalSubmit())\n        void handleModal(interaction).catch(console.error);',
  "    if (interaction.isModalSubmit() && !interaction.customId.startsWith('project:'))\n        void handleModal(interaction).catch(console.error);",
  'Doppelte Modal-Verarbeitung verhindern'
);

await writeFile(file, source, 'utf8');
console.log('[project-tools patch] Projekttools wurden in dist/index.js integriert.');
