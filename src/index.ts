import cron from 'node-cron';
import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  ForumChannel,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  ThreadChannel
} from 'discord.js';
import { DateTime } from 'luxon';
import { config } from './config.js';
import { currentWeekRange, formatDate, formatTime, isWorkday, nowBerlin } from './utils/dates.js';

type DailyEntry = {
  thread: ThreadChannel;
  ownerId: string;
  ownerName: string;
  createdAt: DateTime;
  content: string;
};

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

function isTeamMember(id: string): boolean {
  return config.members.some((member) => member.discordId === id);
}

function toBerlin(date: Date): DateTime {
  return DateTime.fromJSDate(date).setZone(config.timezone);
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

async function dailyEntriesForDate(date = nowBerlin()): Promise<DailyEntry[]> {
  const forum = await getForum(config.dailyForumId);
  const threads = await allForumThreads(forum);
  const dateKey = date.toISODate();
  const entries: DailyEntry[] = [];

  for (const thread of threads) {
    if (!thread.ownerId || !isTeamMember(thread.ownerId) || !thread.createdAt) continue;
    const createdAt = toBerlin(thread.createdAt);
    if (createdAt.toISODate() !== dateKey) continue;
    entries.push({
      thread,
      ownerId: thread.ownerId,
      ownerName: memberName(thread.ownerId),
      createdAt,
      content: await starterContent(thread)
    });
  }

  return entries.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function dailyEntriesForWeek(date = nowBerlin()): Promise<DailyEntry[]> {
  const { start, end } = currentWeekRange(date);
  const forum = await getForum(config.dailyForumId);
  const threads = await allForumThreads(forum);
  const entries: DailyEntry[] = [];

  for (const thread of threads) {
    if (!thread.ownerId || !isTeamMember(thread.ownerId) || !thread.createdAt) continue;
    const createdAt = toBerlin(thread.createdAt);
    if (createdAt < start || createdAt > end) continue;
    entries.push({
      thread,
      ownerId: thread.ownerId,
      ownerName: memberName(thread.ownerId),
      createdAt,
      content: await starterContent(thread)
    });
  }

  return entries.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
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
  await channel.send(
    `☕ **Daily Scrum gestartet · ${formatDate()}**\nBitte erstellt euren heutigen Daily Scrum bis spätestens **12:00 Uhr** im Daily-Scrum-Forum.`
  );
}

async function sendDailyReminder(final = false): Promise<void> {
  if (!isWorkday()) return;
  const entries = await dailyEntriesForDate();
  const missing = missingMembers(entries);
  if (missing.length === 0) return;
  const channel = await getScrumChannel();
  const mentions = mentionList(missing.map((member) => member.discordId));
  const title = final ? '⏰ **15 Minuten bis zur Daily-Deadline**' : '📋 **Daily-Scrum Erinnerung**';
  const ending = final ? 'euer Daily fehlt noch. Deadline ist **12:00 Uhr**.' : 'euer Daily Scrum fehlt heute noch. Deadline ist **12:00 Uhr**.';
  await channel.send(`${title}\n${mentions} ${ending}`);
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
  const count = latestByOwner.size;
  await channel.send(
    `### Daily Scrum · ${formatDate()}\n${lines.join('\n')}\n\n**Vollständigkeit: ${count}/${config.members.length}**`
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
    await channel.send(
      `💾 **Git-Check zum Feierabend**\n${mentionList(pending)} ihr habt im Daily angegeben, dass noch etwas zu pushen ist. Falls die Arbeit für heute fertig ist: sinnvoll committen und euren Branch pushen.`
    );
    return;
  }

  await channel.send(
    '💾 **Git-Check zum Feierabend**\nFalls ihr heute am Code gearbeitet habt: Änderungen sinnvoll committen, euren aktuellen Branch pushen und kurz prüfen, ob nichts Wichtiges nur lokal herumliegt.'
  );
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
    'Der folgende Bericht wurde automatisch aus den im Daily-Scrum-Forum dokumentierten Tätigkeiten erstellt und sollte vor der Weitergabe kurz geprüft werden.',
    ''
  ];

  for (const member of config.members) {
    const memberEntries = entries.filter((entry) => entry.ownerId === member.discordId);
    report.push(`## ${member.name}`);
    if (memberEntries.length === 0) {
      report.push('- Für diese Woche wurden keine Daily-Scrum-Einträge gefunden.', '');
      continue;
    }
    for (const entry of memberEntries) {
      const done = section(entry.content, ['Seit dem letzten Daily', 'Gestern']);
      const today = section(entry.content, ['Heute']);
      const activities = [...done, ...today];
      report.push(`**${entry.createdAt.toFormat('cccc, dd.MM.')}**`);
      if (activities.length) activities.forEach((item) => report.push(`- ${item}`));
      else report.push(`- Daily dokumentiert: ${entry.thread.name}`);
    }
    report.push('');
  }

  const blockers = entries
    .filter((entry) => containsBlocker(entry.content))
    .flatMap((entry) => section(entry.content, ['Blocker']).map((item) => `- **${entry.ownerName}:** ${item}`));

  report.push('## Blocker');
  report.push(blockers.length ? blockers.join('\n') : '- Keine dokumentierten Blocker.');
  report.push('', '## Nächste Schritte');

  const nextSteps = entries
    .filter((entry) => entry.createdAt.weekday === 5)
    .flatMap((entry) => section(entry.content, ['Heute']).map((item) => `- ${entry.ownerName}: ${item}`));
  report.push(nextSteps.length ? nextSteps.join('\n') : '- Werden im nächsten Daily konkretisiert.');
  report.push('', '_Automatisch aus den Daily-Scrum-Einträgen erstellt. Bitte vor Weitergabe prüfen._');

  return report.join('\n').slice(0, 4000);
}

async function createWeeklyReport(): Promise<ThreadChannel> {
  const entries = await dailyEntriesForWeek();
  const forum = await getForum(config.weeklyForumId);
  return forum.threads.create({
    name: `Wochenbericht für Herrn Tepper | ${formatDate()}`,
    message: { content: buildWeeklyReport(entries) },
    reason: 'Automatischer Wochenbericht des Scrum-Master-Bots'
  });
}

async function weeklyReportJob(): Promise<void> {
  const thread = await createWeeklyReport();
  const channel = await getScrumChannel();
  await channel.send(`📋 **Der Wochenbericht wurde als Entwurf erstellt.**\nBitte kurz prüfen: <#${thread.id}>`);
}

async function validateDailyThread(thread: ThreadChannel): Promise<void> {
  if (thread.parentId !== config.dailyForumId || !thread.ownerId || !isTeamMember(thread.ownerId)) return;
  const content = await starterContent(thread);
  const today = section(content, ['Heute']);
  const blockers = section(content, ['Blocker']);
  const git = section(content, ['Branch / Git', 'Git', 'Branch']);
  const hints: string[] = [];
  if (today.length === 0) hints.push('der Abschnitt **Heute**');
  if (blockers.length === 0) hints.push('der Abschnitt **Blocker**');
  if (git.length === 0) hints.push('der optionale Abschnitt **Branch / Git**');

  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) await starter.react('✅').catch(() => undefined);
  if (hints.length > 0) {
    await thread.send(`✅ Daily erfasst. Hinweis: Es fehlt ${hints.join(', ')}. Das Daily zählt trotzdem als abgegeben.`);
  } else {
    await thread.send('✅ Daily erfasst.');
  }
}

const commands = [
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
  new SlashCommandBuilder().setName('bot').setDescription('Bot-Funktionen').addSubcommand((sub) => sub.setName('status').setDescription('Zeigt den Bot-Status')),
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
          { name: 'Daily Reminder', value: 'daily-reminder' },
          { name: 'Daily Deadline', value: 'daily-deadline' },
          { name: 'Git Reminder', value: 'git-reminder' },
          { name: 'Weekly Report', value: 'weekly-report' }
        )
    )
].map((command) => command.toJSON());

async function replyDailyStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const entries = await dailyEntriesForDate();
  const latest = new Map(entries.map((entry) => [entry.ownerId, entry]));
  const lines = config.members.map((member) => {
    const entry = latest.get(member.discordId);
    return entry ? `✅ ${member.name} · ${formatTime(entry.createdAt)} Uhr` : `⏳ ${member.name} · fehlt noch`;
  });
  await interaction.reply({ content: `### Daily-Status · ${formatDate()}\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === 'scrum') {
    await replyDailyStatus(interaction);
    return;
  }

  if (interaction.commandName === 'bot') {
    await interaction.reply({
      content: `🟢 **Scrum Master ist online**\nDaily-Scrum: ✅\nWochenberichte: ✅\nTeammitglieder: ${config.members.length}/${config.members.length}\nZeitzone: ${config.timezone}`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.commandName === 'wochenbericht') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'vorschau') {
      const entries = await dailyEntriesForWeek();
      await interaction.reply({ content: buildWeeklyReport(entries), flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: 'Dafür brauchst du die Berechtigung „Server verwalten“.', flags: MessageFlags.Ephemeral });
      return;
    }
    const action = interaction.options.getString('aktion', true);
    await interaction.reply({ content: `Teste **${action}** …`, flags: MessageFlags.Ephemeral });
    if (action === 'daily-reminder') await sendDailyReminder(false);
    if (action === 'daily-deadline') await sendDailyDeadline();
    if (action === 'git-reminder') await sendGitReminder();
    if (action === 'weekly-report') await weeklyReportJob();
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Scrum Master online als ${readyClient.user.tag}`);
  const guild = await client.guilds.fetch(config.guildId);
  await guild.commands.set(commands);

  cron.schedule(config.cron.dailyOpen, () => void sendDailyOpen().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyReminder, () => void sendDailyReminder(false).catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyFinalReminder, () => void sendDailyReminder(true).catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyDeadline, () => void sendDailyDeadline().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.gitReminder, () => void sendGitReminder().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.weeklyReport, () => void weeklyReportJob().catch(console.error), { timezone: config.timezone });
});

client.on(Events.ThreadCreate, (thread) => void validateDailyThread(thread).catch(console.error));
client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand()) void handleCommand(interaction).catch(console.error);
});

client.login(config.token);
