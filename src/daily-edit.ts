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
import { readDaily, rewriteDaily } from './daily-parts.js';
import { itemsAsBullets, itemsForEditing, parseItems } from './text-items.js';
import { trackDailyBlockers } from './project-tools.js';
import { splitDiscordText } from './utils/discord-text.js';

const PUSH_DONE_MARKER = '**Push-Status:** ✅ Erledigt';
// Höchstlänge eines Discord-Textfelds im Formular.
const MODAL_TEXT_LIMIT = 4000;
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

// Fürs Formular: mehrere Punkte behalten ihren Spiegelstrich, sonst würden sie beim Speichern zu einem Punkt.
function cleanSection(value: string): string {
  return itemsForEditing(parseItems(value));
}

function section(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`(?:^|\\n)#{1,3}\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`, 'i'));
  return match ? cleanSection(match[1]) : '';
}

function linesAsBullets(value: string): string {
  return itemsAsBullets(value, '-');
}

// Der vorhandene Text wird nie gekürzt: ist er länger als üblich, darf das Feld entsprechend mehr fassen.
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
      .setMaxLength(Math.max(maxLength, value.length))
      .setValue(value)
  );
}

function editFields(content: string) {
  return {
    previous: section(content, 'Seit dem letzten Daily') || section(content, 'Gestern'),
    today: section(content, 'Heute'),
    blocker: section(content, 'Blocker') || 'Keine',
    branch: content.match(/^- Branch:\s*(.+)$/im)?.[1]?.trim() || '-',
    pushPending: content.match(/^- Noch zu pushen:\s*(Ja|Nein)$/im)?.[1] || 'Nein'
  };
}

function editModal(threadId: string, content: string): ModalBuilder {
  const { previous, today, blocker, branch, pushPending } = editFields(content);

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

  const { content } = await readDaily(thread, starter);
  if (Object.values(editFields(content)).some((value) => value.length > MODAL_TEXT_LIMIT)) {
    await interaction.reply({
      content: `❌ Ein Abschnitt deines Dailys ist länger als ${MODAL_TEXT_LIMIT} Zeichen und passt nicht ins Formular. Bitte bearbeite es direkt im Thread: <#${thread.id}>`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.showModal(editModal(thread.id, content));
}

// Kann nicht gespeichert werden, bekommt die Person ihre Eingaben zurück, damit nichts verloren geht.
async function replyWithInput(interaction: ModalSubmitInteraction, reason: string, fields: Record<string, string>): Promise<void> {
  const text =
    `❌ ${reason} Hier sind deine Eingaben zum Kopieren, starte danach **/daily-bearbeiten** erneut.\n\n` +
    Object.entries(fields)
      .map(([label, value]) => `**${label}**\n\`\`\`text\n${value}\n\`\`\``)
      .join('\n');
  const [first, ...rest] = splitDiscordText(text);
  await interaction.editReply(first);
  for (const chunk of rest) await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
}

async function handleModal(client: Client, interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.customId.startsWith('daily-edit:')) return;
  if (!teamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Keine Berechtigung.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Ein Daily in mehreren Teilen braucht mehrere Discord-Aufrufe; ohne Aufschub wäre die 3-Sekunden-Frist schnell vorbei.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const previous = interaction.fields.getTextInputValue('previous').trim();
  const today = interaction.fields.getTextInputValue('today').trim();
  const blocker = interaction.fields.getTextInputValue('blocker').trim();
  const branch = interaction.fields.getTextInputValue('branch').trim();
  const pushRaw = interaction.fields.getTextInputValue('push').trim();
  const input = { 'Seit dem letzten Daily': previous, Heute: today, Blocker: blocker, Branch: branch, 'Noch zu pushen': pushRaw };

  if (!/^(ja|nein|j|n|yes|no)$/i.test(pushRaw)) {
    await replyWithInput(interaction, 'Bei „Noch zu pushen?“ bitte nur **Ja** oder **Nein** eintragen.', input);
    return;
  }

  const threadId = interaction.customId.slice('daily-edit:'.length);
  const channel = await client.channels.fetch(threadId).catch(() => null);
  if (!channel?.isThread()) {
    await replyWithInput(interaction, 'Der Daily-Thread wurde nicht gefunden.', input);
    return;
  }

  const member = teamMember(interaction.user.id);
  if (!member || channel.parentId !== member.dailyForumId) {
    await interaction.editReply('⛔ Dieses Daily gehört nicht zu dir.');
    return;
  }

  try {
    const starter = await channel.fetchStarterMessage();
    if (!starter) throw new Error(`Startbeitrag von ${channel.id} fehlt.`);
    const post = await readDaily(channel, starter);

    const pushPending = /^(ja|j|yes)$/i.test(pushRaw) ? 'Ja' : 'Nein';
    const createdLine = post.content.match(/^\*\*Daily erstellt:\*\*[^\n]*/m)?.[0] ?? `**Daily erstellt:** ${formatTime()} Uhr`;
    const pushDoneLine = post.content
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
    await rewriteDaily(channel, post, content, showPushButton ? [pushRow(interaction.user.id)] : []);
  } catch (error) {
    console.error('[Daily bearbeiten] Daily konnte nicht gespeichert werden.', error);
    await replyWithInput(interaction, 'Dein Daily konnte nicht gespeichert werden.', input);
    return;
  }

  await trackDailyBlockers(interaction.user.id, blocker, channel.id).catch((error) =>
    console.error('[Daily bearbeiten] Blocker konnten nicht aktualisiert werden.', error)
  );

  await interaction.editReply(
    `✅ Dein heutiges Daily wurde aktualisiert: <#${channel.id}>\n` +
      `_Hinweis: Bereits freiwillig ins Aufgabenboard übernommene Tasks werden dadurch nicht automatisch verändert._`
  );
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
