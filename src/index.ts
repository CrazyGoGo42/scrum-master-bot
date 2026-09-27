import cron from 'node-cron';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  ForumChannel,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel
} from 'discord.js';
import { DateTime } from 'luxon';
import { config } from './config.js';
import { currentWeekRange, formatDate, formatTime, isWorkday, nowBerlin } from './utils/dates.js';

type TeamMember = (typeof config.members)[number];

type DailyEntry = {
  thread: ThreadChannel;
  ownerId: string;
  ownerName: string;
  createdAt: DateTime;
  content: string;
};

type DailyDraft = {
  userId: string;
  previous?: string;
  today?: string;
  blocker?: string;
  branch?: string;
  pushPending?: string;
};

const drafts = new Map<string, DailyDraft>();

const DAILY_TEMPLATE = `## Seit dem letzten Daily
- Was habe ich seit dem letzten Daily gemacht?

## Heute
- Was mache ich heute?

## Blocker
Keine

## Branch / Git
- Branch: feature/mein-feature
- Noch zu pushen: Ja`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function memberName(id: string): string {
  return config.members.find((member) => member.discordId === id)?.name ?? id;
}

function teamMember(id: string): TeamMember | undefined {
  return config.members.find((member) => member.discordId === id);
}

function isTeamMember(id: string): boolean {
  return Boolean(teamMember(id));
}

function memberByForumId(forumId: string | null): TeamMember | undefined {
  if (!forumId) return undefined;
  return config.members.find((member) => member.dailyForumId === forumId);
}

function toBerlin(date: Date): DateTime {
  return DateTime.fromJSDate(date).setZone(config.timezone);
}

function dailyPostTitle(member: TeamMember, date = nowBerlin()): string {
  return `Daily Scrum ${member.name} ${formatDate(date)}`;
}

function dailyStartRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('daily:start')
      .setLabel('Daily ausfüllen')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary)
  );
}

function nextButton(customId: string, label: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Primary)
  );
}

function blockerButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('daily:blocker-none')
      .setLabel('Keine Blocker')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('daily:blocker-yes')
      .setLabel('Blocker eintragen')
      .setEmoji('⚠️')
      .setStyle(ButtonStyle.Danger)
  );
}

function pushButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('daily:push-no')
      .setLabel('Nein')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('daily:push-yes')
      .setLabel('Ja')
      .setEmoji('📤')
      .setStyle(ButtonStyle.Primary)
  );
}

function previewButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('daily:submit')
      .setLabel('Daily absenden')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('daily:edit')
      .setLabel('Bearbeiten')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('daily:cancel')
      .setLabel('Abbrechen')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger)
  );
}

function textarea(id: string, label: string, placeholder: string, value?: string): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function shortInput(id: string, label: string, placeholder: string, value?: string): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function questionOneModal(draft?: DailyDraft): ModalBuilder {
  const monday = nowBerlin().weekday === 1;
  const label = monday ? 'Was hast du Freitag / am Wochenende gemacht?' : 'Was hast du gestern gemacht?';

  return new ModalBuilder()
    .setCustomId('daily:q1')
    .setTitle('Daily Scrum • Frage 1/4')
    .addComponents(textarea('answer', label, 'Kurz und konkret: Was hast du erledigt?', draft?.previous));
}

function questionTwoModal(draft?: DailyDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('daily:q2')
    .setTitle('Daily Scrum • Frage 2/4')
    .addComponents(textarea('answer', 'Was wirst du heute machen?', 'Welche Aufgaben stehen heute an?', draft?.today));
}

function blockerModal(draft?: DailyDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('daily:q3')
    .setTitle('Daily Scrum • Frage 3/4')
    .addComponents(
      textarea(
        'answer',
        'Welche Probleme oder Blocker hast du?',
        'Was hält dich aktuell auf?',
        draft?.blocker === 'Keine' ? undefined : draft?.blocker
      )
    );
}

function questionFourModal(draft?: DailyDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('daily:q4')
    .setTitle('Daily Scrum • Frage 4/4')
    .addComponents(shortInput('branch', 'An welchem Branch arbeitest du?', 'z. B. feature/login', draft?.branch));
}

async function getForum(id: string): Promise<ForumChannel> {
  const channel = await client.channels.fetch(id);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    throw new Error(`Kanal ${id} ist kein Forum.`);
  }
  return channel;
}

async function getScrumChannel(): Promise<TextChannel> {
  const channel = await client.channels.fetch(config.scrumChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('SCRUM_MASTER_CHANNEL_ID ist kein normaler Textkanal.');
  }
  return channel;
}

async function allForumThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: 100 });
  const unique = new Map<string, ThreadChannel>();

  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    unique.set(thread.id, thread);
  }

  return [...unique.values()];
}

async function starterContent(thread: ThreadChannel): Promise<string> {
  try {
    const starter = await thread.fetchStarterMessage();
    return starter?.content ?? '';
  } catch {
    return '';
  }
}

function section(content: string, names: string[]): string[] {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(`(?:^|\\n)#{1,3}\\s*(?:${escaped})\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`, 'i');
  const match = content.match(regex);

  if (!match) return [];

  return match[1]
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function isCompleteDailyContent(content: string): boolean {
  return (
    section(content, ['Seit dem letzten Daily', 'Gestern']).length > 0 &&
    section(content, ['Heute']).length > 0 &&
    section(content, ['Blocker']).length > 0 &&
    section(content, ['Branch / Git', 'Git', 'Branch']).length > 0
  );
}

function matchesMemberDailyTitle(thread: ThreadChannel, member: TeamMember): boolean {
  return thread.name.toLocaleLowerCase('de-DE').startsWith(`daily scrum ${member.name} `.toLocaleLowerCase('de-DE'));
}

async function dailyEntriesInRange(start: DateTime, end: DateTime): Promise<DailyEntry[]> {
  const entries: DailyEntry[] = [];

  for (const member of config.members) {
    const forum = await getForum(member.dailyForumId);
    const threads = await allForumThreads(forum);

    for (const thread of threads) {
      if (!thread.createdAt || !matchesMemberDailyTitle(thread, member)) continue;

      const createdAt = toBerlin(thread.createdAt);
      if (createdAt < start || createdAt > end) continue;

      const content = await starterContent(thread);
      if (!isCompleteDailyContent(content)) continue;

      entries.push({
        thread,
        ownerId: member.discordId,
        ownerName: member.name,
        createdAt,
        content
      });
    }
  }

  return entries.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function dailyEntriesForDate(date = nowBerlin()): Promise<DailyEntry[]> {
  return dailyEntriesInRange(date.startOf('day'), date.endOf('day'));
}

async function dailyEntriesForWeek(date = nowBerlin()): Promise<DailyEntry[]> {
  const { start, end } = currentWeekRange(date);
  return dailyEntriesInRange(start, end);
}

function missingMembers(entries: DailyEntry[]) {
  const submitted = new Set(entries.map((entry) => entry.ownerId));
  return config.members.filter((member) => !submitted.has(member.discordId));
}

function mentionList(ids: string[]): string {
  return ids.map((id) => `<@${id}>`).join(' ');
}

async function sendDailyOpen(): Promise<void> {
  if (!isWorkday()) return;

  const channel = await getScrumChannel();
  await channel.send({
    content:
      `☕ **Daily Scrum gestartet · ${formatDate()}**\n` +
      `Beantwortet die vier kurzen Fragen bis spätestens **12:00 Uhr**. ` +
      `Nach dem Absenden erstellt der Bot automatisch euren heutigen Daily-Post im persönlichen Forum.`,
    components: [dailyStartRow()]
  });
}

async function sendDailyReminder(final = false): Promise<void> {
  if (!isWorkday()) return;

  const entries = await dailyEntriesForDate();
  const missing = missingMembers(entries);
  if (missing.length === 0) return;

  const channel = await getScrumChannel();
  const mentions = mentionList(missing.map((member) => member.discordId));
  const title = final ? '⏰ **15 Minuten bis zur Daily-Deadline**' : '📋 **Daily-Scrum Erinnerung**';
  const ending = final
    ? 'euer Daily fehlt noch. Deadline ist **12:00 Uhr**.'
    : 'euer Daily Scrum fehlt heute noch. Bitte beantwortet alle vier Fragen bis **12:00 Uhr**.';

  await channel.send({
    content: `${title}\n${mentions} ${ending}`,
    components: [dailyStartRow()],
    allowedMentions: { users: missing.map((member) => member.discordId) }
  });
}

async function sendDailyDeadline(): Promise<void> {
  if (!isWorkday()) return;

  const entries = await dailyEntriesForDate();
  const channel = await getScrumChannel();
  const latestByOwner = new Map<string, DailyEntry>();

  for (const entry of entries) latestByOwner.set(entry.ownerId, entry);

  const lines = config.members.map((member) => {
    const entry = latestByOwner.get(member.discordId);
    return entry
      ? `✅ **${member.name}** · ${formatTime(entry.createdAt)} Uhr`
      : `❌ **${member.name}** · nicht abgegeben`;
  });

  await channel.send(
    `### Daily Scrum · ${formatDate()}\n${lines.join('\n')}\n\n**Vollständigkeit: ${latestByOwner.size}/${config.members.length}**`
  );
}

function hasPushPending(content: string): boolean {
  return /noch\s+zu\s+pushen\s*:\s*(ja|yes|true)/i.test(content);
}

async function sendGitReminder(): Promise<void> {
  if (!isWorkday()) return;

  const entries = await dailyEntriesForDate();
  const pending = [...new Set(entries.filter((entry) => hasPushPending(entry.content)).map((entry) => entry.ownerId))];
  const channel = await getScrumChannel();

  if (pending.length > 0) {
    await channel.send({
      content:
        `💾 **Git-Check zum Feierabend**\n${mentionList(pending)} ihr habt im Daily angegeben, dass noch etwas zu pushen ist. ` +
        `Falls die Arbeit für heute fertig ist: sinnvoll committen und euren Branch pushen.`,
      allowedMentions: { users: pending }
    });
    return;
  }

  await channel.send(
    '💾 **Git-Check zum Feierabend**\nFalls ihr heute am Code gearbeitet habt: Änderungen sinnvoll committen, euren aktuellen Branch pushen und kurz prüfen, ob nichts Wichtiges nur lokal herumliegt.'
  );
}

function containsBlocker(content: string): boolean {
  const blockers = section(content, ['Blocker']);
  if (blockers.length === 0) return false;

  const joined = blockers.join(' ').trim().toLowerCase();
  return !['keine', 'keine blocker', '-', 'nichts', 'aktuell keine'].includes(joined);
}

function buildWeeklyReport(entries: DailyEntry[], date = nowBerlin()): string {
  const { start } = currentWeekRange(date);
  const friday = start.plus({ days: 4 });
  const report: string[] = [
    '# Wochenbericht',
    '',
    `**Zeitraum:** ${formatDate(start)} – ${formatDate(friday)}`,
    '',
    '## Zusammenfassung',
    'Der Bericht wurde automatisch aus den vollständig abgegebenen Daily Scrums von Joline, David und Duy erstellt und sollte vor der Weitergabe kurz geprüft werden.',
    ''
  ];

  for (const member of config.members) {
    const memberEntries = entries.filter((entry) => entry.ownerId === member.discordId);
    report.push(`## ${member.name}`);

    if (memberEntries.length === 0) {
      report.push('- Für diese Woche wurden keine vollständigen Daily-Scrum-Einträge gefunden.', '');
      continue;
    }

    for (const entry of memberEntries) {
      const done = section(entry.content, ['Seit dem letzten Daily', 'Gestern']);
      const today = section(entry.content, ['Heute']);
      report.push(`**${entry.createdAt.toFormat('cccc, dd.MM.')}**`);
      done.forEach((item) => report.push(`- Erledigt: ${item}`));
      today.forEach((item) => report.push(`- Geplant: ${item}`));
    }

    report.push('');
  }

  const blockers = entries
    .filter((entry) => containsBlocker(entry.content))
    .flatMap((entry) => section(entry.content, ['Blocker']).map((item) => `- **${entry.ownerName}:** ${item}`));

  report.push('## Blocker');
  report.push(blockers.length ? blockers.join('\n') : '- Keine dokumentierten Blocker.');
  report.push('', '## Aktueller Stand / nächste Schritte');

  for (const member of config.members) {
    const latest = entries
      .filter((entry) => entry.ownerId === member.discordId)
      .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0];

    if (!latest) continue;
    const planned = section(latest.content, ['Heute']);
    planned.forEach((item) => report.push(`- **${member.name}:** ${item}`));
  }

  report.push('', '_Automatisch aus den Daily-Scrum-Einträgen erstellt. Bitte vor Weitergabe prüfen._');
  return report.join('\n');
}

function splitDiscordText(text: string, maxLength = 1900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const block of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${block}` : block;

    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);

    if (block.length <= maxLength) {
      current = block;
      continue;
    }

    current = '';
    for (const line of block.split('\n')) {
      const lineCandidate = current ? `${current}\n${line}` : line;
      if (lineCandidate.length <= maxLength) {
        current = lineCandidate;
      } else {
        if (current) chunks.push(current);
        current = line.slice(0, maxLength);
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function createWeeklyReport(): Promise<ThreadChannel> {
  const entries = await dailyEntriesForWeek();
  const forum = await getForum(config.weeklyForumId);
  const chunks = splitDiscordText(buildWeeklyReport(entries));

  const thread = await forum.threads.create({
    name: `Wochenbericht für Herrn Tepper | ${formatDate()}`,
    message: { content: chunks[0] },
    reason: 'Automatischer Wochenbericht des Scrum-Master-Bots'
  });

  for (const chunk of chunks.slice(1)) {
    await thread.send(chunk);
  }

  return thread;
}

async function weeklyReportJob(): Promise<void> {
  const thread = await createWeeklyReport();
  const channel = await getScrumChannel();
  await channel.send(`📋 **Der Wochenbericht wurde als Entwurf erstellt.**\nBitte kurz prüfen: <#${thread.id}>`);
}

function linesAsBullets(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');
}

function normalizeYesNo(value: string): string {
  return /^(ja|yes|j|true|y)$/i.test(value.trim()) ? 'Ja' : 'Nein';
}

function draftContent(draft: DailyDraft): string {
  return (
    `## Seit dem letzten Daily\n${linesAsBullets(draft.previous ?? '')}\n\n` +
    `## Heute\n${linesAsBullets(draft.today ?? '')}\n\n` +
    `## Blocker\n${draft.blocker === 'Keine' ? 'Keine' : linesAsBullets(draft.blocker ?? '')}\n\n` +
    `## Branch / Git\n- Branch: ${draft.branch}\n- Noch zu pushen: ${normalizeYesNo(draft.pushPending ?? 'Nein')}`
  );
}

function previewText(draft: DailyDraft): string {
  return `### Vorschau deines Daily Scrums\n\n${draftContent(draft)}\n\nWenn alles passt, kannst du das Daily jetzt absenden.`;
}

async function alreadySubmitted(userId: string): Promise<DailyEntry | undefined> {
  const entries = await dailyEntriesForDate();
  return entries.find((entry) => entry.ownerId === userId);
}

async function startDailyForInteraction(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({
      content: 'Dieser Daily-Assistent ist nur für das konfigurierte Projektteam.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const draft = drafts.get(interaction.user.id) ?? { userId: interaction.user.id };
  drafts.set(interaction.user.id, draft);

  // Wichtig: Vor showModal keine Discord-API-Abfragen. Interactions müssen sehr schnell bestätigt werden.
  await interaction.showModal(questionOneModal(draft));
}

async function createDailyFromDraft(draft: DailyDraft): Promise<ThreadChannel> {
  const member = teamMember(draft.userId);
  if (!member) throw new Error(`Unbekanntes Teammitglied: ${draft.userId}`);

  const forum = await getForum(member.dailyForumId);
  return forum.threads.create({
    name: dailyPostTitle(member),
    message: {
      content: draftContent(draft),
      allowedMentions: { parse: [] }
    },
    reason: `Daily Scrum von ${member.name}`
  });
}

const commands = [
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Startet deinen interaktiven Daily-Scrum-Assistenten'),
  new SlashCommandBuilder()
    .setName('scrum')
    .setDescription('Daily-Scrum Funktionen')
    .addSubcommand((sub) => sub.setName('status').setDescription('Zeigt den heutigen Daily-Status'))
    .addSubcommand((sub) => sub.setName('heute').setDescription('Zeigt den heutigen Daily-Status')),
  new SlashCommandBuilder()
    .setName('wochenbericht')
    .setDescription('Wochenbericht verwalten')
    .addSubcommand((sub) => sub.setName('vorschau').setDescription('Zeigt eine Vorschau des aktuellen Wochenberichts'))
    .addSubcommand((sub) => sub.setName('erstellen').setDescription('Erstellt den Wochenbericht jetzt'))
    .addSubcommand((sub) => sub.setName('freigeben').setDescription('Markiert den neuesten Wochenbericht als freigegeben')),
  new SlashCommandBuilder()
    .setName('bot')
    .setDescription('Bot-Funktionen')
    .addSubcommand((sub) => sub.setName('status').setDescription('Zeigt den Bot-Status'))
    .addSubcommand((sub) => sub.setName('struktur').setDescription('Zeigt dir privat die Daily-Scrum-Vorlage zum Kopieren')),
  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Testet geplante Bot-Aktionen')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName('aktion')
        .setDescription('Welche Aktion soll getestet werden?')
        .setRequired(true)
        .addChoices(
          { name: 'Daily Start', value: 'daily-start' },
          { name: 'Daily Reminder', value: 'daily-reminder' },
          { name: 'Daily Deadline', value: 'daily-deadline' },
          { name: 'Git Reminder', value: 'git-reminder' },
          { name: 'Weekly Report', value: 'weekly-report' }
        )
    )
].map((command) => command.toJSON());

async function replyDailyStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const entries = await dailyEntriesForDate();
  const latest = new Map(entries.map((entry) => [entry.ownerId, entry]));

  const lines = config.members.map((member) => {
    const entry = latest.get(member.discordId);
    return entry ? `✅ ${member.name} · ${formatTime(entry.createdAt)} Uhr` : `⏳ ${member.name} · fehlt noch`;
  });

  await interaction.editReply(`### Daily-Status · ${formatDate()}\n${lines.join('\n')}`);
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === 'daily') {
    await startDailyForInteraction(interaction);
    return;
  }

  if (interaction.commandName === 'scrum') {
    await replyDailyStatus(interaction);
    return;
  }

  if (interaction.commandName === 'bot') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'struktur') {
      await interaction.reply({
        content:
          `### Daily-Scrum Vorlage\n\n\`\`\`md\n${DAILY_TEMPLATE}\n\`\`\`\n` +
          `Alternativ kannst du einfach **/daily** verwenden und die vier Fragen interaktiv beantworten.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content:
        `🟢 **Scrum Master ist online**\n` +
        `Daily-Scrum Q&A: ✅\n` +
        `Persönliche Daily-Foren: 3/3 ✅\n` +
        `Wochenberichte: ✅\n` +
        `Teammitglieder: ${config.members.length}/${config.members.length}\n` +
        `Zeitzone: ${config.timezone}`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.commandName === 'wochenbericht') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'vorschau') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const entries = await dailyEntriesForWeek();
      const chunks = splitDiscordText(buildWeeklyReport(entries));
      await interaction.editReply(chunks[0]);

      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (sub === 'erstellen') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const thread = await createWeeklyReport();
      await interaction.editReply(`Wochenbericht erstellt: <#${thread.id}>`);
      return;
    }

    if (sub === 'freigeben') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const forum = await getForum(config.weeklyForumId);
      const threads = await allForumThreads(forum);
      const newest = threads
        .filter((thread) => thread.createdTimestamp)
        .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))[0];

      if (!newest) {
        await interaction.editReply('Kein Wochenbericht gefunden.');
        return;
      }

      await newest.send(`✅ **Freigegeben von ${interaction.user} am ${formatDate()}**`);
      await interaction.editReply(`Wochenbericht freigegeben: <#${newest.id}>`);
      return;
    }
  }

  if (interaction.commandName === 'test') {
    const member = interaction.member as GuildMember | null;

    if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'Dafür brauchst du die Berechtigung „Server verwalten“.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const action = interaction.options.getString('aktion', true);
    await interaction.reply({ content: `Teste **${action}** …`, flags: MessageFlags.Ephemeral });

    if (action === 'daily-start') await sendDailyOpen();
    if (action === 'daily-reminder') await sendDailyReminder(false);
    if (action === 'daily-deadline') await sendDailyDeadline();
    if (action === 'git-reminder') await sendGitReminder();
    if (action === 'weekly-report') await weeklyReportJob();
  }
}

async function showPreviewFromButton(interaction: ButtonInteraction, draft: DailyDraft): Promise<void> {
  if (!draft.previous || !draft.today || !draft.blocker || !draft.branch || !draft.pushPending) {
    await interaction.reply({
      content: 'Es fehlen noch Antworten. Starte das Daily bitte erneut mit **/daily**.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.update({
    content: previewText(draft),
    components: [previewButtons()],
    allowedMentions: { parse: [] }
  });
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId === 'daily:start') {
    await startDailyForInteraction(interaction);
    return;
  }

  if (!interaction.customId.startsWith('daily:')) return;

  const draft = drafts.get(interaction.user.id);
  if (!draft) {
    await interaction.reply({
      content: 'Deine Daily-Sitzung ist abgelaufen. Starte sie bitte erneut mit **/daily**.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId === 'daily:next-q2') {
    await interaction.showModal(questionTwoModal(draft));
    return;
  }

  if (interaction.customId === 'daily:blocker-none') {
    draft.blocker = 'Keine';
    await interaction.showModal(questionFourModal(draft));
    return;
  }

  if (interaction.customId === 'daily:blocker-yes') {
    await interaction.showModal(blockerModal(draft));
    return;
  }

  if (interaction.customId === 'daily:next-q4') {
    await interaction.showModal(questionFourModal(draft));
    return;
  }

  if (interaction.customId === 'daily:push-no') {
    draft.pushPending = 'Nein';
    await showPreviewFromButton(interaction, draft);
    return;
  }

  if (interaction.customId === 'daily:push-yes') {
    draft.pushPending = 'Ja';
    await showPreviewFromButton(interaction, draft);
    return;
  }

  if (interaction.customId === 'daily:edit') {
    await interaction.showModal(questionOneModal(draft));
    return;
  }

  if (interaction.customId === 'daily:cancel') {
    drafts.delete(interaction.user.id);
    await interaction.update({ content: 'Daily abgebrochen. Es wurde nichts veröffentlicht.', components: [] });
    return;
  }

  if (interaction.customId === 'daily:submit') {
    await interaction.deferUpdate();

    const existing = await alreadySubmitted(interaction.user.id);
    if (existing) {
      drafts.delete(interaction.user.id);
      await interaction.editReply({
        content: `✅ Dein Daily für heute ist bereits abgegeben: <#${existing.thread.id}>`,
        components: []
      });
      return;
    }

    const thread = await createDailyFromDraft(draft);
    drafts.delete(interaction.user.id);
    await interaction.editReply({
      content: `✅ **Daily vollständig abgegeben!**\nDein heutiger Post wurde erstellt: <#${thread.id}>`,
      components: []
    });
  }
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.customId.startsWith('daily:')) return;

  const draft = drafts.get(interaction.user.id) ?? { userId: interaction.user.id };
  drafts.set(interaction.user.id, draft);

  if (interaction.customId === 'daily:q1') {
    draft.previous = interaction.fields.getTextInputValue('answer').trim();
    await interaction.reply({
      content:
        `✅ **Frage 1/4 beantwortet**\n\n` +
        `**Deine Antwort:**\n${draft.previous}\n\n` +
        `Weiter mit Frage 2:`,
      components: [nextButton('daily:next-q2', 'Weiter zu Frage 2')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId === 'daily:q2') {
    draft.today = interaction.fields.getTextInputValue('answer').trim();
    await interaction.reply({
      content:
        `✅ **Frage 2/4 beantwortet**\n\n` +
        `**Deine Antwort:**\n${draft.today}\n\n` +
        `### Frage 3/4\nHast du aktuell Probleme oder Blocker?`,
      components: [blockerButtons()],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId === 'daily:q3') {
    draft.blocker = interaction.fields.getTextInputValue('answer').trim();
    await interaction.reply({
      content:
        `✅ **Frage 3/4 beantwortet**\n\n` +
        `**Blocker:**\n${draft.blocker}\n\n` +
        `Weiter mit der letzten Frage:`,
      components: [nextButton('daily:next-q4', 'Weiter zu Frage 4')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId === 'daily:q4') {
    draft.branch = interaction.fields.getTextInputValue('branch').trim();
    await interaction.reply({
      content:
        `✅ **Branch gespeichert:** \`${draft.branch}\`\n\n` +
        `### Frage 4/4\nMusst du noch etwas committen oder pushen?`,
      components: [pushButtons()],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function validateConfiguredChannels(): Promise<void> {
  await getScrumChannel();
  await getForum(config.weeklyForumId);

  for (const member of config.members) {
    await getForum(member.dailyForumId);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Scrum Master online als ${readyClient.user.tag}`);
  console.log(`Bot User ID: ${readyClient.user.id}`);

  try {
    const guild = await client.guilds.fetch(config.guildId);
    await validateConfiguredChannels();
    await guild.commands.set(commands);
    console.log(`Slash Commands auf ${guild.name} registriert.`);
    console.log('Daily-Foren für Joline, David und Duy sind erreichbar.');
  } catch (error) {
    console.error(
      'Server oder konfigurierte Kanäle konnten nicht geladen werden. Prüfe die IDs und Bot-Berechtigungen.',
      error
    );
    return;
  }

  cron.schedule(config.cron.dailyOpen, () => void sendDailyOpen().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyReminder, () => void sendDailyReminder(false).catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyFinalReminder, () => void sendDailyReminder(true).catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyDeadline, () => void sendDailyDeadline().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.gitReminder, () => void sendGitReminder().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.weeklyReport, () => void weeklyReportJob().catch(console.error), { timezone: config.timezone });
});

client.on(Events.ThreadCreate, (thread) => {
  const member = memberByForumId(thread.parentId);
  if (!member || thread.ownerId === client.user?.id) return;

  void (async () => {
    const content = await starterContent(thread);
    if (isCompleteDailyContent(content)) return;

    await thread.send(
      `⚠️ Dieser Post zählt noch nicht als vollständiges Daily für **${member.name}**. ` +
      `Nutze am einfachsten **/daily** oder **/bot struktur**.`
    );
  })().catch(console.error);
});

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand()) void handleCommand(interaction).catch(console.error);
  if (interaction.isButton()) void handleButton(interaction).catch(console.error);
  if (interaction.isModalSubmit()) void handleModal(interaction).catch(console.error);
});

client.login(config.token);
