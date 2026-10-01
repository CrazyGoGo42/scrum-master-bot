import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  ForumChannel,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel
} from 'discord.js';
import { DateTime } from 'luxon';
import { config } from './config.js';

const PUSH_DONE_MARKER = '**Push-Status:** ✅ Erledigt';
let installed = false;

function nowBerlin(): DateTime {
  return DateTime.now().setZone(config.timezone);
}

function formatDate(date = nowBerlin()): string {
  return date.toFormat('dd.MM.yyyy');
}

function formatTime(date = nowBerlin()): string {
  return date.toFormat('HH:mm');
}

function teamMember(userId: string) {
  return config.members.find((member) => member.discordId === userId);
}

function cleanSection(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .join('\n');
}

function section(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`(?:^|\\n)#{1,3}\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`, 'i'));
  return match ? cleanSection(match[1]) : '';
}

function linesAsBullets(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : '-';
}

function modalInput(
  id: string,
  label: string,
  style: TextInputStyle,
  value: string,
  maxLength: number
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setRequired(true)
      .setMaxLength(maxLength)
      .setValue(value.slice(0, maxLength))
  );
}

function editModal(threadId: string, content: string): ModalBuilder {
  const previous = section(content, 'Seit dem letzten Daily') || section(content, 'Gestern');
  const today = section(content, 'Heute');
  const blocker = section(content, 'Blocker') || 'Keine';
  const branch = content.match(/^- Branch:\s*(.+)$/im)?.[1]?.trim() || '-';
  const pushPending = content.match(/^- Noch zu pushen:\s*(Ja|Nein)$/im)?.[1] || 'Nein';

  return new ModalBuilder()
    .setCustomId(`daily-edit:${threadId}`)
    .setTitle('Daily bearbeiten')
    .addComponents(
      modalInput('previous', 'Seit dem letzten Daily', TextInputStyle.Paragraph, previous || '-', 1000),
      modalInput('today', 'Heute', TextInputStyle.Paragraph, today || '-', 1000),
      modalInput('blocker', 'Blocker', TextInputStyle.Paragraph, blocker, 1000),
      modalInput('branch', 'Branch', TextInputStyle.Short, branch, 200),
      modalInput('push', 'Noch zu pushen? Ja oder Nein', TextInputStyle.Short, pushPending, 4)
    );
}

async function forumForUser(client: Client, userId: string): Promise<ForumChannel | undefined> {
  const member = teamMember(userId);
  if (!member) return undefined;
  const channel = await client.channels.fetch(member.dailyForumId);
  return channel?.isThreadOnly() ? (channel as ForumChannel) : undefined;
}

async function findTodayDaily(client: Client, userId: string): Promise<ThreadChannel | undefined> {
  const member = teamMember(userId);
  if (!member) return undefined;
  const forum = await forumForUser(client, userId);
  if (!forum) return undefined;

  const expectedName = `Daily Scrum ${member.name} ${formatDate()}`;
  const active = await forum.threads.fetchActive();
  const activeMatch = active.threads.find((thread) => thread.name === expectedName);
  if (activeMatch) return activeMatch;

  const archived = await forum.threads.fetchArchived({ type: 'public', limit: 100 });
  return archived.threads.find((thread) => thread.name === expectedName);
}

function pushRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`daily:mark-pushed:${userId}`)
      .setLabel('Als gepusht markieren')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );
}

async function handleCommand(client: Client, interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName !== 'daily-bearbeiten') return;
  if (!teamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const thread = await findTodayDaily(client, interaction.user.id);
  if (!thread) {
    await interaction.reply({
      content: '❌ Für heute wurde noch kein Daily gefunden. Bearbeitet werden kann nur dein bereits abgesendetes Daily von heute.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await interaction.reply({ content: '❌ Der Daily-Startbeitrag konnte nicht gefunden werden.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.showModal(editModal(thread.id, starter.content));
}

async function handleModal(client: Client, interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.customId.startsWith('daily-edit:')) return;
  if (!teamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Keine Berechtigung.', flags: MessageFlags.Ephemeral });
    return;
  }

  const threadId = interaction.customId.slice('daily-edit:'.length);
  const channel = await client.channels.fetch(threadId);
  if (!channel?.isThread()) {
    await interaction.reply({ content: '❌ Der Daily-Thread wurde nicht gefunden.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = teamMember(interaction.user.id);
  if (!member || channel.parentId !== member.dailyForumId) {
    await interaction.reply({ content: '⛔ Dieses Daily gehört nicht zu dir.', flags: MessageFlags.Ephemeral });
    return;
  }

  const starter = await channel.fetchStarterMessage();
  if (!starter) {
    await interaction.reply({ content: '❌ Der Daily-Startbeitrag konnte nicht gefunden werden.', flags: MessageFlags.Ephemeral });
    return;
  }

  const previous = interaction.fields.getTextInputValue('previous').trim();
  const today = interaction.fields.getTextInputValue('today').trim();
  const blocker = interaction.fields.getTextInputValue('blocker').trim();
  const branch = interaction.fields.getTextInputValue('branch').trim();
  const pushRaw = interaction.fields.getTextInputValue('push').trim().toLocaleLowerCase('de-DE');

  if (!['ja', 'nein'].includes(pushRaw)) {
    await interaction.reply({ content: '❌ Bei „Noch zu pushen?“ bitte nur **Ja** oder **Nein** eintragen.', flags: MessageFlags.Ephemeral });
    return;
  }

  const pushPending = pushRaw === 'ja' ? 'Ja' : 'Nein';
  const createdLine = starter.content.match(/^\*\*Daily erstellt:\*\*[^\n]*/m)?.[0] ?? `**Daily erstellt:** ${formatTime()} Uhr`;
  const pushDoneLine = starter.content
    .split('\n')
    .find((line) => line.startsWith(PUSH_DONE_MARKER));

  const content =
    `${createdLine}\n\n` +
    `## Seit dem letzten Daily\n${linesAsBullets(previous)}\n\n` +
    `## Heute\n${linesAsBullets(today)}\n\n` +
    `## Blocker\n${/^keine$/i.test(blocker) ? 'Keine' : linesAsBullets(blocker)}\n\n` +
    `## Branch / Git\n- Branch: ${branch}\n- Noch zu pushen: ${pushPending}\n\n` +
    `**Zuletzt bearbeitet:** ${formatDate()} ${formatTime()} Uhr` +
    (pushDoneLine ? `\n${pushDoneLine}` : '');

  const showPushButton = pushPending === 'Ja' && !pushDoneLine;
  await starter.edit({
    content,
    components: showPushButton ? [pushRow(interaction.user.id)] : []
  });

  await interaction.reply({
    content:
      `✅ Dein heutiges Daily wurde aktualisiert: <#${channel.id}>\n` +
      `_Hinweis: Bereits freiwillig ins Aufgabenboard übernommene Tasks werden dadurch nicht automatisch verändert._`,
    flags: MessageFlags.Ephemeral
  });
}

export const dailyEditCommand = new SlashCommandBuilder()
  .setName('daily-bearbeiten')
  .setDescription('Bearbeitet dein bereits abgesendetes Daily von heute')
  .toJSON();

export function installDailyEdit(client: Client): void {
  if (installed) return;
  installed = true;

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'daily-bearbeiten') {
        await handleCommand(client, interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('daily-edit:')) {
        await handleModal(client, interaction);
      }
    })().catch((error) => console.error('[Daily bearbeiten] Interaction-Fehler', error));
  });
}
