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
  "import { config } from './config.js';\nimport { consumeMeetingVenue, createScheduledMeeting, externalMeetingLinkModal, hasMeetingVenue, meetingLocationRow, meetingVenueChoiceRow, meetingVenueContinueRow, meetingVenueText, selectMeetingVenue } from './meeting-venues.js';\nimport { installProjectTools, meetingActionRow, offerDailyTasks, openBlockersSummary, projectCommands, projectToolsInfoText, trackDailyBlockers, weeklyMarkdownAttachment } from './project-tools.js';\nimport { recordMeeting, weeklyProjectReportSection } from './weekly-project.js';\nimport { installMeetingBackfill, meetingBackfillCommand } from './meeting-backfill.js';\n",
  'Imports'
);

replaceOnce(
  '\nfunction teamMember(id) {',
  '\ninstallProjectTools(client);\ninstallMeetingBackfill(client);\n\nfunction teamMember(id) {',
  'Project-Tools installieren'
);

replaceOnce(
  'Wenn du heute nicht arbeiten kannst, kannst du dich hier abmelden.`',
  'Wenn du heute nicht arbeiten kannst, kannst du dich hier abmelden.${await openBlockersSummary(interaction.user.id)}`',
  'Offene Blocker im Daily anzeigen'
);

replaceOnce(
  'const chunks = splitDiscordText(botInfoText());',
  "const staleInfoMessages = recent.filter(\n        (message) => message.author.id === client.user?.id && message.id !== existing?.id\n    );\n    for (const staleMessage of staleInfoMessages.values()) {\n        await staleMessage.delete().catch(() => undefined);\n    }\n    const projectInfo = projectToolsInfoText().replace(\n        'Meetings bieten zusätzlich Protokoll-, Aufgaben- und Entscheidungsaktionen. Wenn Discord die nötige Berechtigung erlaubt, wird außerdem ein geplanter Discord-Termin für den Voice-Channel angelegt.',\n        'Meetings bieten zusätzlich Protokoll-, Aufgaben- und Entscheidungsaktionen. Bei `/meeting` wählst du zuerst per Button den Ort: **Discord Voice**, **Alfaview** oder **Anderer Link** (z. B. Microsoft Teams). Für Alfaview wird der hinterlegte Standard-Link verwendet; bei einem anderen Ort fragt der Bot anschließend nach dem Link. Danach öffnet sich das Formular für Titel, Datum, Uhrzeit, Dauer und Agenda. Wenn Discord die nötige Berechtigung erlaubt, wird passend dazu ein geplanter Discord-Termin angelegt. Bereits vergangene Meetings können mit `/meeting-nachtragen` dokumentiert werden und fließen dadurch ebenfalls in den passenden Wochenbericht ein. Erstellte Meetings werden im Wochenbericht dokumentiert; Protokolle, Meeting-Aufgaben und Meeting-Entscheidungen erscheinen dort nur, wenn sie tatsächlich eingetragen wurden.'\n    );\n    const chunks = splitDiscordText(`${botInfoText()}\\n\\n${projectInfo}`);",
  'Info-Text erweitern und alte Info-Fortsetzungen bereinigen'
);

replaceOnce(
  "    await publishBotInfo().catch((error) => console.error('Bot-Info konnte nicht veröffentlicht werden.', error));\n",
  '',
  'Keine automatische Bot-Info beim Start'
);

replaceOnce(
  ".addSubcommand((sub) => sub.setName('freigeben').setDescription('Markiert den neuesten Wochenbericht als freigegeben')),",
  ".addSubcommand((sub) => sub.setName('freigeben').setDescription('Markiert den neuesten Wochenbericht als freigegeben'))\n        .addSubcommand((sub) => sub.setName('export').setDescription('Exportiert den aktuellen Wochenbericht als Markdown-Datei')),",
  'Wochenbericht Export Command'
);

replaceOnce(
  '].map((command) => command.toJSON());',
  `].map((command) => command.toJSON());
const botCommandIndex = commands.findIndex((command) => command.name === 'bot');
if (botCommandIndex >= 0) {
    commands.splice(
        botCommandIndex,
        1,
        new SlashCommandBuilder()
            .setName('meeting')
            .setDescription('Erstellt ein neues Meeting im Meeting-Channel')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('info')
            .setDescription('Aktualisiert die öffentliche Bot-Übersicht im Info-Channel')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Zeigt den Status des Scrum-Master-Bots')
            .toJSON()
    );
}
commands.push(...projectCommands, meetingBackfillCommand);`,
  'Projekt-Commands registrieren und Bot-Präfix entfernen'
);

replaceOnce(
  "    const meetingCommand = isBotSubcommand(interaction, 'meeting');\n    const infoCommand = isBotSubcommand(interaction, 'info');",
  "    const meetingCommand = interaction.commandName === 'meeting';\n    const infoCommand = interaction.commandName === 'info';",
  'Standalone Meeting und Info erkennen'
);

replaceOnce(
  "    if (interaction.commandName === 'bot') {",
  `    if (interaction.commandName === 'meeting') {
        await interaction.reply({
            content: '### Wo findet das Meeting statt?\\nWähle zuerst den Meeting-Ort. Danach öffnet sich das eigentliche Meeting-Formular.',
            components: [meetingVenueChoiceRow()],
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (interaction.commandName === 'info') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await publishBotInfo();
        await interaction.editReply(\`✅ Bot-Übersicht in <#\${config.infoChannelId}> wurde aktualisiert.\`);
        return;
    }

    if (interaction.commandName === 'status') {
        await replyBotStatus(interaction);
        return;
    }

    if (interaction.commandName === 'bot') {`,
  'Standalone Command Handler'
);

replaceOnce(
  "await interaction.showModal(meetingModal());",
  "await interaction.reply({\n                content: '### Wo findet das Meeting statt?\\nWähle zuerst den Meeting-Ort. Danach öffnet sich das eigentliche Meeting-Formular.',\n                components: [meetingVenueChoiceRow()],\n                flags: MessageFlags.Ephemeral\n            });",
  'Meeting-Ort Auswahl anzeigen'
);

replaceOnce(
  "        if (sub === 'erstellen') {",
  "        if (sub === 'export') {\n            await interaction.deferReply({ flags: MessageFlags.Ephemeral });\n            const scans = await weeklyScans();\n            const report = buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);\n            await interaction.editReply({\n                content: '📄 Wochenbericht als Markdown-Datei:',\n                files: [weeklyMarkdownAttachment(report)]\n            });\n            return;\n        }\n\n        if (sub === 'erstellen') {",
  'Wochenbericht Export Handler'
);

replaceOnce(
  "    if (!interaction.customId.startsWith('daily:'))\n        return;\n    const draft = drafts.get(interaction.user.id);",
  "    if (interaction.customId === 'meeting:venue:discord' || interaction.customId === 'meeting:venue:alfaview') {\n        const kind = interaction.customId.endsWith(':discord') ? 'discord' : 'alfaview';\n        const meetingVenueError = selectMeetingVenue(interaction.user.id, kind);\n        if (meetingVenueError) {\n            await interaction.reply({ content: `❌ ${meetingVenueError}`, flags: MessageFlags.Ephemeral });\n            return;\n        }\n        await interaction.showModal(meetingModal());\n        return;\n    }\n    if (interaction.customId === 'meeting:venue:external') {\n        await interaction.showModal(externalMeetingLinkModal());\n        return;\n    }\n    if (interaction.customId === 'meeting:venue:continue') {\n        if (!hasMeetingVenue(interaction.user.id)) {\n            await interaction.reply({\n                content: '❌ Die Meeting-Ort-Auswahl ist abgelaufen. Bitte starte **/meeting** erneut.',\n                flags: MessageFlags.Ephemeral\n            });\n            return;\n        }\n        await interaction.showModal(meetingModal());\n        return;\n    }\n    if (!interaction.customId.startsWith('daily:'))\n        return;\n    const draft = drafts.get(interaction.user.id);",
  'Meeting-Ort Buttons'
);

replaceOnce(
  "async function handleModal(interaction) {\n    if (interaction.customId === 'meeting:create') {",
  "async function handleModal(interaction) {\n    if (interaction.customId === 'meeting:venue-external') {\n        if (!isTeamMember(interaction.user.id)) {\n            await interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });\n            return;\n        }\n        if (interaction.channelId !== config.meetingCreateChannelId) {\n            await interaction.reply({\n                content: `Meetings werden nur in <#${config.meetingCreateChannelId}> erstellt.`,\n                flags: MessageFlags.Ephemeral\n            });\n            return;\n        }\n        const meetingVenueError = selectMeetingVenue(\n            interaction.user.id,\n            'external',\n            interaction.fields.getTextInputValue('link')\n        );\n        if (meetingVenueError) {\n            await interaction.reply({ content: `❌ ${meetingVenueError}`, flags: MessageFlags.Ephemeral });\n            return;\n        }\n        await interaction.reply({\n            content: '🔗 **Meeting-Link gespeichert.** Jetzt fehlen nur noch die Meetingdetails.',\n            components: [meetingVenueContinueRow()],\n            flags: MessageFlags.Ephemeral\n        });\n        return;\n    }\n    if (interaction.customId === 'meeting:create') {",
  'Externer Meeting-Link'
);

replaceOnce(
  'const timestamp = Math.floor(start.toSeconds());',
  "const meetingVenue = consumeMeetingVenue(interaction.user.id);\n    if (!meetingVenue) {\n        await interaction.reply({\n            content: '❌ Die Meeting-Ort-Auswahl ist abgelaufen. Bitte starte **/meeting** erneut.',\n            flags: MessageFlags.Ephemeral\n        });\n        return;\n    }\n    const timestamp = Math.floor(start.toSeconds());",
  'Meeting-Ort laden'
);

replaceOnce(
  '`**Ort:** <#${config.meetingVoiceChannelId}>\\n` +',
  '`**Ort:** ${meetingVenueText(meetingVenue)}\\n` +',
  'Meeting-Ort anzeigen'
);

replaceOnce(
  'components: [meetingVoiceRow()],',
  'components: [meetingLocationRow(meetingVenue), meetingActionRow()],',
  'Meeting-Link und Aktionen'
);

replaceOnce(
  "    await message.react('✅').catch(() => undefined);\n    await message.react('❌').catch(() => undefined);",
  "    await message.react('✅').catch(() => undefined);\n    await message.react('❌').catch(() => undefined);\n    const scheduledEventUrl = await createScheduledMeeting(client, title, start, end, agenda, meetingVenue);\n    await recordMeeting({\n        messageId: message.id,\n        title,\n        start,\n        end,\n        agenda,\n        venue: meetingVenue,\n        creatorId: interaction.user.id,\n        scheduledEventUrl\n    }).catch((error) => console.error('[Meeting] Meeting konnte nicht für den Wochenbericht gespeichert werden.', error));\n    if (scheduledEventUrl) {\n        await interaction.followUp({\n            content: `📅 Discord-Termin erstellt: ${scheduledEventUrl}`,\n            flags: MessageFlags.Ephemeral\n        });\n    }",
  'Discord Scheduled Event und Meeting-Historie'
);

replaceOnce(
  "  return report.join('\\n');",
  "  return report.join('\\n') + weeklyProjectReportSection();",
  'Meeting-Daten in Wochenbericht'
);

replaceOnce(
  "            const thread = await createDailyFromDraft(draft);\n            await cancelActiveAbsenceIfPresent(interaction.user.id);",
  "            const thread = await createDailyFromDraft(draft);\n            await trackDailyBlockers(interaction.user.id, draft.blocker ?? 'Keine', thread.id).catch((error) =>\n                console.error('[Projekttools] Daily-Blocker konnten nicht übernommen werden.', error)\n            );\n            await offerDailyTasks(thread, interaction.user.id, draft.today ?? '').catch((error) =>\n                console.error('[Projekttools] Daily-Aufgaben-Angebot konnte nicht erstellt werden.', error)\n            );\n            await cancelActiveAbsenceIfPresent(interaction.user.id);",
  'Daily Aufgaben und Blocker'
);

replaceOnce(
  '    if (interaction.isChatInputCommand())\n        void handleCommand(interaction).catch(console.error);',
  "    if (interaction.isChatInputCommand() && !['task', 'blocker', 'entscheidung', 'meeting-nachtragen'].includes(interaction.commandName))\n        void handleCommand(interaction).catch(console.error);",
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

source = source
  .replaceAll('/bot meeting', '/meeting')
  .replaceAll('/bot info', '/info')
  .replaceAll('/bot status', '/status')
  .replaceAll('**/bot struktur**', '**/daily**')
  .replaceAll('`/bot struktur` · Vorlage  •  ', '')
  .replaceAll(
    'Der Bericht wurde automatisch und ausschließlich aus den Daily-Scrum-Einträgen und Abmeldungen seit Beginn der Erfassung erstellt.',
    'Der Bericht wurde automatisch aus den Daily-Scrum-Einträgen, Abmeldungen sowie den dokumentierten Meeting- und Projekt-Einträgen seit Beginn der Erfassung erstellt.'
  );

await writeFile(file, source, 'utf8');
console.log('[project-tools patch] Projekttools wurden in dist/index.js integriert.');
