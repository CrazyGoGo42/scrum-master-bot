import {
  ChatInputCommandInteraction,
  Client,
  Events,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';
import { DateTime } from 'luxon';
import { config } from './config.js';
import {
  consumeMeetingVenue,
  meetingLocationRow,
  selectMeetingVenue
} from './meeting-venues.js';
import { meetingActionRow } from './project-tools.js';
import { recordMeeting } from './weekly-project.js';

const COMMAND_NAME = 'meeting-nachtragen';

function isTeamMember(userId: string): boolean {
  return config.members.some((member) => member.discordId === userId);
}

function teamNames(): string {
  return config.members.map((member) => member.name).join(', ');
}

export const meetingBackfillCommand = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Trägt ein bereits vergangenes Meeting für den Wochenbericht nach')
  .addStringOption((option) =>
    option.setName('titel').setDescription('Titel des Meetings').setRequired(true).setMaxLength(100)
  )
  .addStringOption((option) =>
    option.setName('datum').setDescription('Datum als TT.MM.JJJJ').setRequired(true).setMaxLength(10)
  )
  .addStringOption((option) =>
    option.setName('uhrzeit').setDescription('Startzeit als HH:MM').setRequired(true).setMaxLength(5)
  )
  .addIntegerOption((option) =>
    option.setName('dauer').setDescription('Dauer in Minuten').setRequired(true).setMinValue(10).setMaxValue(480)
  )
  .addStringOption((option) =>
    option
      .setName('ort')
      .setDescription('Wo fand das Meeting statt?')
      .setRequired(true)
      .addChoices(
        { name: 'Discord Voice', value: 'discord' },
        { name: 'Alfaview', value: 'alfaview' },
        { name: 'Anderer Link / Teams', value: 'external' }
      )
  )
  .addStringOption((option) =>
    option.setName('agenda').setDescription('Agenda oder Ziel des Meetings').setMaxLength(1000)
  )
  .addStringOption((option) =>
    option.setName('link').setDescription('Nur bei „Anderer Link“: Teams- oder Meeting-Link').setMaxLength(1000)
  )
  .toJSON();

async function handleMeetingBackfill(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({
      content: '⛔ Du gehörst nicht zum konfigurierten Projektteam und hast für diese Funktion keine Zuständigkeit.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.channelId !== config.meetingCreateChannelId) {
    await interaction.reply({
      content: `Meetings werden nur in <#${config.meetingCreateChannelId}> erstellt oder nachgetragen.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const title = interaction.options.getString('titel', true).trim();
  const date = interaction.options.getString('datum', true).trim();
  const time = interaction.options.getString('uhrzeit', true).trim();
  const duration = interaction.options.getInteger('dauer', true);
  const venueKind = interaction.options.getString('ort', true);
  const agenda = interaction.options.getString('agenda')?.trim() ?? '';
  const customUrl = interaction.options.getString('link')?.trim();

  const start = DateTime.fromFormat(`${date} ${time}`, 'dd.MM.yyyy HH:mm', {
    zone: config.timezone,
    locale: 'de'
  });

  if (!start.isValid) {
    await interaction.reply({
      content: '❌ Bitte Datum als **TT.MM.JJJJ** und Uhrzeit als **HH:MM** angeben.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const now = DateTime.now().setZone(config.timezone);
  if (start > now) {
    await interaction.reply({
      content: '❌ Dieses Meeting liegt in der Zukunft. Dafür bitte **/meeting** verwenden.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const venueError = selectMeetingVenue(interaction.user.id, venueKind, customUrl);
  if (venueError) {
    await interaction.reply({ content: `❌ ${venueError}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const venue = consumeMeetingVenue(interaction.user.id);
  if (!venue) {
    await interaction.reply({
      content: '❌ Der Meeting-Ort konnte nicht übernommen werden. Bitte den Befehl erneut ausführen.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const end = start.plus({ minutes: duration });
  const timestamp = Math.floor(start.toSeconds());
  const attendanceLine =
    venue.kind === 'discord'
      ? `**Team eingeladen:** ${teamNames()}\n`
      : `**Teilnehmer:** ${teamNames()}\n`;

  await interaction.reply({
    content:
      `## 🕘 Nachgetragenes Meeting · ${title}\n` +
      `**Start:** <t:${timestamp}:F>\n` +
      `**Dauer:** ca. ${duration} Minuten · bis ${end.toFormat('HH:mm')} Uhr\n` +
      `**Ort:** ${venue.label}\n` +
      attendanceLine +
      `**Nachgetragen von:** <@${interaction.user.id}>\n\n` +
      `### Agenda\n${agenda || 'Keine Agenda nachgetragen.'}\n\n` +
      `_Dieses Meeting wurde nachträglich dokumentiert und fließt in den Wochenbericht der entsprechenden Woche ein._`,
    components: [meetingLocationRow(venue), meetingActionRow()],
    allowedMentions: { users: [interaction.user.id] }
  });

  const message = await interaction.fetchReply();

  try {
    await recordMeeting({
      messageId: message.id,
      title,
      start,
      end,
      agenda,
      venue,
      creatorId: interaction.user.id
    });
  } catch (error) {
    console.error('[Meeting] Nachgetragenes Meeting konnte nicht für den Wochenbericht gespeichert werden.', error);
    await interaction.followUp({
      content: '⚠️ Das Meeting wurde im Channel gepostet, konnte aber nicht in der Meeting-Historie gespeichert werden.',
      flags: MessageFlags.Ephemeral
    });
  }
}

export function installMeetingBackfill(client: Client): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) return;
    void handleMeetingBackfill(interaction).catch((error) => {
      console.error('[Meeting] Fehler beim Nachtragen eines Meetings.', error);
      if (!interaction.replied && !interaction.deferred) {
        void interaction.reply({
          content: '❌ Das Meeting konnte nicht nachgetragen werden.',
          flags: MessageFlags.Ephemeral
        }).catch(() => undefined);
      }
    });
  });
}
