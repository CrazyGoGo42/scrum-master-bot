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
type AbsenceKind = 'Krankheit' | 'Termin' | 'Anderes';

type DailyEntry = {
  thread: ThreadChannel;
  ownerId: string;
  ownerName: string;
  createdAt: DateTime;
  content: string;
};

type AbsenceEntry = {
  thread: ThreadChannel;
  ownerId: string;
  ownerName: string;
  createdAt: DateTime;
  kind: AbsenceKind;
  detail?: string;
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

type DailyScanResult = {
  entries: DailyEntry[];
  unavailableMemberIds: Set<string>;
};

type AbsenceScanResult = {
  entries: AbsenceEntry[];
  unavailableMemberIds: Set<string>;
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

const NO_PERMISSION = '⛔ Du gehörst nicht zum konfigurierten Projektteam und hast für diese Funktion keine Zuständigkeit.';
const INFO_MARKER = '# Scrum Master Bot · Projektübersicht';
const PUSH_REMINDER_MARKER = '🔔 **Push-Erinnerung**';
const PUSH_DONE_MARKER = '**Push-Status:** ✅ Erledigt';
const ABSENCE_CANCELLED_MARKER = '**Abmeldung aufgehoben:**';
const SICKNESS_INTRANET_URL = 'https://intranet.bib.de/tiki-index.php?page=welcome';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function teamMember(id: string): TeamMember | undefined {
  return config.members.find((member) => member.discordId === id);
}

function memberName(id: string): string {
  return teamMember(id)?.name ?? id;
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

function absencePostTitle(member: TeamMember, date = nowBerlin()): string {
  return `Abmeldung ${member.name} ${formatDate(date)}`;
}

function mentionList(ids: string[]): string {
  return ids.map((id) => `<@${id}>`).join(' ');
}

function normalizeYesNo(value: string): string {
  return /^(ja|yes|j|true|y)$/i.test(value.trim()) ? 'Ja' : 'Nein';
}

function linesAsBullets(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');
}

function previousWorkday(date: DateTime): DateTime {
  let result = date.minus({ days: 1 }).startOf('day');
  while (!isWorkday(result)) result = result.minus({ days: 1 });
  return result;
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

function dailyAvailabilityRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('daily:work-yes')
      .setLabel('Ja, Daily starten')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('daily:work-no')
      .setLabel('Nein, abmelden')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary)
  );
}

function weekendDailyRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('daily:work-yes')
      .setLabel('Freiwilliges Daily starten')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary)
  );
}

function absenceReasonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('absence:sick')
      .setLabel('Krankheit')
      .setEmoji('🤒')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('absence:appointment')
      .setLabel('Termin')
      .setEmoji('📅')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('absence:other')
      .setLabel('Anderes')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary)
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

function pushDoneRow(ownerId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`daily:mark-pushed:${ownerId}`)
      .setLabel('Als gepusht markieren')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );
}

function meetingVoiceRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Zum Voice-Channel')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${config.guildId}/${config.meetingVoiceChannelId}`)
  );
}

function textarea(
  id: string,
  label: string,
  placeholder: string,
  value?: string,
  required = true,
  maxLength = 1000
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(required)
    .setMaxLength(maxLength);

  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function shortInput(
  id: string,
  label: string,
  placeholder: string,
  value?: string,
  required = true,
  maxLength = 200
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(maxLength);

  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function questionOneModal(draft?: DailyDraft): ModalBuilder {
  const monday = nowBerlin().weekday === 1;
  const label = monday ? 'Was hast du Freitag / am Wochenende gemacht?' : 'Was hast du seit dem letzten Daily gemacht?';

  return new ModalBuilder()
    .setCustomId('daily:q1')
    .setTitle('Daily Scrum • Frage 1/4')
    .addComponents(textarea('answer', label, 'Kurz und konkret: Was hast du erledigt?', draft?.previous));
}

function questionTwoModal(draft?: DailyDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('daily:q2')
    .setTitle('Daily Scrum • Frage 2/4')
    .addComponents(textarea('answer', 'Was möchtest du heute machen?', 'Plane deinen Arbeitstag.', draft?.today));
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

function absenceDetailModal(kind: 'appointment' | 'other'): ModalBuilder {
  const appointment = kind === 'appointment';
  return new ModalBuilder()
    .setCustomId(`absence:details:${kind}`)
    .setTitle(appointment ? 'Abmeldung • Termin' : 'Abmeldung • Anderes')
    .addComponents(
      textarea(
        'reason',
        appointment ? 'Welcher Termin verhindert dein Daily?' : 'Warum kannst du heute kein Daily machen?',
        appointment ? 'z. B. Arzttermin, Behördentermin ...' : 'Kurzer Grund für die Abmeldung',
        undefined,
        true,
        500
      )
    );
}

function meetingModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('meeting:create')
    .setTitle('Meeting erstellen')
    .addComponents(
      shortInput('title', 'Titel', 'z. B. Wochenplanung', undefined, true, 100),
      shortInput('date', 'Datum', 'TT.MM.JJJJ', undefined, true, 10),
      shortInput('time', 'Uhrzeit', 'HH:MM', undefined, true, 5),
      shortInput('duration', 'Dauer in Minuten', 'z. B. 30', undefined, true, 3),
      textarea('agenda', 'Agenda / Ziel', 'Was soll im Meeting besprochen werden?', undefined, false, 700)
    );
}

async function getForum(id: string): Promise<ForumChannel> {
  const channel = await client.channels.fetch(id);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    throw new Error(`Kanal ${id} ist kein Forum.`);
  }
  return channel;
}

async function getTextChannel(id: string, label: string): Promise<TextChannel> {
  const channel = await client.channels.fetch(id);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`${label} (${id}) ist kein normaler Textkanal.`);
  }
  return channel;
}

async function getScrumChannel(): Promise<TextChannel> {
  return getTextChannel(config.scrumChannelId, 'SCRUM_MASTER_CHANNEL_ID');
}

async function getInfoChannel(): Promise<TextChannel> {
  return getTextChannel(config.infoChannelId, 'SCRUM_INFO_CHANNEL_ID');
}

async function getMeetingCreateChannel(): Promise<TextChannel> {
  return getTextChannel(config.meetingCreateChannelId, 'MEETING_CREATE_CHANNEL_ID');
}

async function validateMeetingVoiceChannel(): Promise<void> {
  const channel = await client.channels.fetch(config.meetingVoiceChannelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`MEETING_VOICE_CHANNEL_ID (${config.meetingVoiceChannelId}) ist kein Voice-Channel.`);
  }
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

function matchesMemberAbsenceTitle(thread: ThreadChannel, member: TeamMember): boolean {
  return thread.name.toLocaleLowerCase('de-DE').startsWith(`abmeldung ${member.name} `.toLocaleLowerCase('de-DE'));
}

function hasPushPending(content: string): boolean {
  return /noch\s+zu\s+pushen\s*:\s*(ja|yes|true)/i.test(content);
}

function hasPushDone(content: string): boolean {
  return content.includes(PUSH_DONE_MARKER);
}

function absenceKind(content: string): AbsenceKind | undefined {
  const match = content.match(/(?:^|\n)-?\s*Grund:\s*(Krankheit|Termin|Anderes)\b/i);
  if (!match) return undefined;
  const normalized = match[1].toLowerCase();
  if (normalized === 'krankheit') return 'Krankheit';
  if (normalized === 'termin') return 'Termin';
  return 'Anderes';
}

function absenceDetail(content: string): string | undefined {
  return content.match(/(?:^|\n)-?\s*Details:\s*(.+)/i)?.[1]?.trim();
}

function absenceLabel(entry: AbsenceEntry): string {
  if (entry.kind === 'Krankheit') return 'Krankheit (entschuldigt)';
  if (entry.detail) return `${entry.kind}: ${entry.detail}`;
  return entry.kind;
}

function sameCalendarDay(a: DateTime, b: DateTime): boolean {
  return a.toISODate() === b.toISODate();
}

async function dailyEntriesForMemberInRange(
  member: TeamMember,
  start: DateTime,
  end: DateTime
): Promise<DailyEntry[]> {
  const forum = await getForum(member.dailyForumId);
  const threads = await allForumThreads(forum);
  const entries: DailyEntry[] = [];

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

  return entries.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function absenceEntriesForMemberInRange(
  member: TeamMember,
  start: DateTime,
  end: DateTime
): Promise<AbsenceEntry[]> {
  const forum = await getForum(member.dailyForumId);
  const threads = await allForumThreads(forum);
  const entries: AbsenceEntry[] = [];

  for (const thread of threads) {
    if (!thread.createdAt || !matchesMemberAbsenceTitle(thread, member)) continue;

    const createdAt = toBerlin(thread.createdAt);
    if (createdAt < start || createdAt > end) continue;

    const content = await starterContent(thread);
    if (content.includes(ABSENCE_CANCELLED_MARKER)) continue;
    const kind = absenceKind(content);
    if (!kind) continue;

    entries.push({
      thread,
      ownerId: member.discordId,
      ownerName: member.name,
      createdAt,
      kind,
      detail: absenceDetail(content),
      content
    });
  }

  return entries.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

async function scanDailyEntriesInRange(start: DateTime, end: DateTime): Promise<DailyScanResult> {
  const entries: DailyEntry[] = [];
  const unavailableMemberIds = new Set<string>();

  for (const member of config.members) {
    try {
      entries.push(...(await dailyEntriesForMemberInRange(member, start, end)));
    } catch (error) {
      unavailableMemberIds.add(member.discordId);
      console.error(`[Daily] Forum für ${member.name} (${member.dailyForumId}) konnte nicht gelesen werden.`, error);
    }
  }

  entries.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return { entries, unavailableMemberIds };
}

async function scanAbsencesInRange(start: DateTime, end: DateTime): Promise<AbsenceScanResult> {
  const entries: AbsenceEntry[] = [];
  const unavailableMemberIds = new Set<string>();

  for (const member of config.members) {
    try {
      entries.push(...(await absenceEntriesForMemberInRange(member, start, end)));
    } catch (error) {
      unavailableMemberIds.add(member.discordId);
      console.error(`[Abmeldung] Forum für ${member.name} (${member.dailyForumId}) konnte nicht gelesen werden.`, error);
    }
  }

  entries.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return { entries, unavailableMemberIds };
}

async function dailyEntriesForDate(date = nowBerlin()): Promise<DailyEntry[]> {
  return (await scanDailyEntriesInRange(date.startOf('day'), date.endOf('day'))).entries;
}

function mergeUnavailable(...sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function missingMembers(
  entries: DailyEntry[],
  unavailableMemberIds = new Set<string>(),
  absences: AbsenceEntry[] = []
) {
  const submitted = new Set(entries.map((entry) => entry.ownerId));
  const absent = new Set(absences.map((entry) => entry.ownerId));
  return config.members.filter(
    (member) =>
      !submitted.has(member.discordId) &&
      !absent.has(member.discordId) &&
      !unavailableMemberIds.has(member.discordId)
  );
}

async function sendDailyOpen(): Promise<void> {
  if (!isWorkday()) return;

  const channel = await getScrumChannel();
  await channel.send({
    content:
      `☕ **Daily Scrum ist offen · ${formatDate()}**\n` +
      `Es gibt keine feste Startzeit. Entscheidend ist nur: **Daily zuerst, danach Projektarbeit.** ` +
      `Wenn ihr heute nicht arbeiten könnt, könnt ihr euch direkt über den Daily-Dialog abmelden.`,
    components: [dailyStartRow()]
  });
}

async function sendDailyReminder(evening = false): Promise<void> {
  if (!isWorkday()) return;

  const start = nowBerlin().startOf('day');
  const end = nowBerlin().endOf('day');
  const dailyScan = await scanDailyEntriesInRange(start, end);
  const absenceScan = await scanAbsencesInRange(start, end);
  const unavailable = mergeUnavailable(dailyScan.unavailableMemberIds, absenceScan.unavailableMemberIds);
  const missing = missingMembers(dailyScan.entries, unavailable, absenceScan.entries);
  if (missing.length === 0) return;

  const channel = await getScrumChannel();
  const mentions = mentionList(missing.map((member) => member.discordId));
  const text = evening
    ? 'falls ihr heute noch am Projekt arbeiten möchtet: macht euer Daily bitte **vor Arbeitsbeginn**. Wenn ihr heute nicht könnt, könnt ihr euch abmelden.'
    : 'kleine Erinnerung: falls ihr heute am Projekt arbeitet, macht euer Daily bitte **unmittelbar vor Arbeitsbeginn**. Es gibt keine feste Uhrzeit.';

  await channel.send({
    content: `📋 **Daily-Erinnerung**\n${mentions} ${text}`,
    components: [dailyStartRow()],
    allowedMentions: { users: missing.map((member) => member.discordId) }
  });
}

async function reportMissingDailies(): Promise<void> {
  const target = nowBerlin().minus({ days: 1 }).startOf('day');
  if (!isWorkday(target)) return;

  const dailyScan = await scanDailyEntriesInRange(target.startOf('day'), target.endOf('day'));
  const absenceScan = await scanAbsencesInRange(target.startOf('day'), target.endOf('day'));
  const unavailable = mergeUnavailable(dailyScan.unavailableMemberIds, absenceScan.unavailableMemberIds);
  const missing = missingMembers(dailyScan.entries, unavailable, absenceScan.entries);
  if (missing.length === 0) return;

  const channel = await getScrumChannel();
  const lines: string[] = [`### Daily-Dokumentation · ${formatDate(target)}`];
  const previous = previousWorkday(target);

  for (const member of missing) {
    lines.push(`❌ **${member.name}** · für diesen Arbeitstag liegt weder ein Daily noch eine Abmeldung vor.`);

    try {
      const previousDailies = await dailyEntriesForMemberInRange(member, previous.startOf('day'), previous.endOf('day'));
      const previousAbsences = await absenceEntriesForMemberInRange(member, previous.startOf('day'), previous.endOf('day'));
      if (previousDailies.length === 0 && previousAbsences.length === 0) {
        lines.push(
          `⚠️ **${member.name}** · damit seit **2 Arbeitstagen in Folge** ohne Daily oder Abmeldung. Diese Inaktivität wird dokumentiert.`
        );
      }
    } catch {
      lines.push(`⚠️ **${member.name}** · vorheriger Status konnte wegen eines Forumfehlers nicht geprüft werden.`);
    }
  }

  lines.push('', '_Eine fehlende Dokumentation ist keine automatische Sanktion._');
  await channel.send(lines.join('\n'));
}

async function sendDelayedPushReminders(): Promise<void> {
  const now = nowBerlin();
  const start = now.minus({ hours: 36 });
  const scan = await scanDailyEntriesInRange(start, now);
  const thresholdMs = config.pushReminderAfterHours * 60 * 60 * 1000;

  for (const entry of scan.entries) {
    if (!hasPushPending(entry.content) || hasPushDone(entry.content)) continue;
    if (now.toMillis() - entry.createdAt.toMillis() < thresholdMs) continue;

    const recent = await entry.thread.messages.fetch({ limit: 50 });
    const reminderExists = recent.some(
      (message) => message.author.id === client.user?.id && message.content.includes(PUSH_REMINDER_MARKER)
    );
    if (reminderExists) continue;

    await entry.thread.send({
      content:
        `${PUSH_REMINDER_MARKER}\n<@${entry.ownerId}> du hattest im Daily angegeben, dass noch etwas zu pushen ist. ` +
        `Seit dem Daily sind ungefähr ${config.pushReminderAfterHours} Stunden vergangen. Nur eine Erinnerung, keine Pflicht.`,
      components: [pushDoneRow(entry.ownerId)],
      allowedMentions: { users: [entry.ownerId] }
    });
  }
}

function containsBlocker(content: string): boolean {
  const blockers = section(content, ['Blocker']);
  if (blockers.length === 0) return false;

  const joined = blockers.join(' ').trim().toLowerCase();
  return !['keine', 'keine blocker', '-', 'nichts', 'aktuell keine'].includes(joined);
}

function closedWorkdaysThisWeek(date = nowBerlin()): DateTime[] {
  const { start } = currentWeekRange(date);
  const yesterday = date.startOf('day').minus({ days: 1 });
  const friday = start.plus({ days: 4 }).endOf('day');
  const end = yesterday < friday ? yesterday : friday;
  const days: DateTime[] = [];

  for (let cursor = start.startOf('day'); cursor <= end; cursor = cursor.plus({ days: 1 })) {
    if (isWorkday(cursor)) days.push(cursor);
  }

  return days;
}

function buildWeeklyReport(
  entries: DailyEntry[],
  absences: AbsenceEntry[],
  unavailableMemberIds = new Set<string>(),
  date = nowBerlin()
): string {
  const { start } = currentWeekRange(date);
  const friday = start.plus({ days: 4 });
  const closedDays = closedWorkdaysThisWeek(date);
  const effectiveAbsences = absences.filter(
    (absence) =>
      !entries.some(
        (entry) => entry.ownerId === absence.ownerId && sameCalendarDay(entry.createdAt, absence.createdAt)
      )
  );

  const normalizeReportItem = (value: string): string =>
    value
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/\s+/g, ' ')
      .replace(/[.!?]+$/, '')
      .toLocaleLowerCase('de-DE');

  const uniqueReportItems = (items: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const raw of items) {
      const clean = raw.trim().replace(/^[-*]\s*/, '');
      if (!clean) continue;
      const key = normalizeReportItem(clean);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(clean);
    }

    return result;
  };

  const listAsText = (items: string[]): string => {
    const clean = uniqueReportItems(items).map((item) => item.replace(/[.!?]+$/, ''));
    if (clean.length === 0) return '';
    if (clean.length === 1) return clean[0];
    if (clean.length === 2) return `${clean[0]} und ${clean[1]}`;
    return `${clean.slice(0, -1).join(', ')} sowie ${clean.at(-1)}`;
  };

  const sentence = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  };

  const reportAbsenceLabel = (entry: AbsenceEntry): string => {
    if (entry.kind === 'Krankheit') return 'Krankheit (entschuldigt)';
    if (entry.kind === 'Termin') return entry.detail ? `Termin: ${entry.detail}` : 'Termin';
    return entry.detail ? entry.detail : 'anderer Grund';
  };

  const summaries = config.members.map((member) => {
    const memberEntries = entries.filter((entry) => entry.ownerId === member.discordId);
    const memberAbsences = effectiveAbsences.filter((entry) => entry.ownerId === member.discordId);
    const done = uniqueReportItems(
      memberEntries.flatMap((entry) => section(entry.content, ['Seit dem letzten Daily', 'Gestern']))
    );
    const blockers = uniqueReportItems(
      memberEntries
        .filter((entry) => containsBlocker(entry.content))
        .flatMap((entry) => section(entry.content, ['Blocker']))
    );
    const latest = [...memberEntries].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0];
    const next = latest ? uniqueReportItems(section(latest.content, ['Heute'])) : [];
    const documentedDates = new Set([
      ...memberEntries.map((entry) => entry.createdAt.toISODate()),
      ...memberAbsences.map((entry) => entry.createdAt.toISODate())
    ]);
    const missingDates = closedDays.filter((day) => !documentedDates.has(day.toISODate()));

    return {
      member,
      memberEntries,
      memberAbsences,
      done,
      blockers,
      next,
      missingDates,
      unavailable: unavailableMemberIds.has(member.discordId)
    };
  });

  const teamDone = uniqueReportItems(summaries.flatMap((summary) => summary.done));
  const totalBlockers = summaries.reduce((sum, summary) => sum + summary.blockers.length, 0);
  const totalMissing = summaries.reduce((sum, summary) => sum + summary.missingDates.length, 0);

  const report: string[] = [
    '# Wochenbericht Hauptprojekt',
    '',
    `**Berichtszeitraum:** ${formatDate(start)} – ${formatDate(friday)}`,
    `**Erstellt:** ${formatDate(date)} · ${formatTime(date)} Uhr`,
    '',
    '## Wochenüberblick',
    sentence(
      `In dieser Woche wurden insgesamt ${entries.length} vollständige Daily Scrums und ${effectiveAbsences.length} Abmeldung${effectiveAbsences.length === 1 ? '' : 'en'} dokumentiert`
    )
  ];

  if (teamDone.length > 0) {
    report.push(
      sentence(`Als zentrale dokumentierte Arbeitspunkte wurden unter anderem ${listAsText(teamDone.slice(0, 5))} festgehalten`)
    );
  }

  report.push(
    totalBlockers === 0
      ? 'Es wurden keine fachlichen oder technischen Blocker dokumentiert.'
      : sentence(`${totalBlockers} unterschiedliche Problem- bzw. Blocker-Einträge wurden dokumentiert`)
  );

  report.push(
    totalMissing === 0
      ? 'Für alle bereits abgeschlossenen regulären Arbeitstage liegt eine Dokumentation oder Abmeldung vor.'
      : sentence(`Für ${totalMissing} bereits abgeschlossene Team-Arbeitstag${totalMissing === 1 ? '' : 'e'} fehlt eine Dokumentation oder Abmeldung`)
  );

  report.push('', '## Dokumentationsübersicht');

  const tableRows = summaries.map((summary) =>
    summary.unavailable
      ? [summary.member.name, 'n. v.', 'n. v.', 'n. v.', 'n. v.']
      : [
          summary.member.name,
          String(summary.memberEntries.length),
          String(summary.memberAbsences.length),
          String(summary.blockers.length),
          String(summary.missingDates.length)
        ]
  );
  const headers = ['Person', 'Dailies', 'Abgem.', 'Blocker', 'Fehlend'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index].length))
  );
  const tableLine = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');

  report.push(
    '```text',
    tableLine(headers),
    tableLine(widths.map((width) => '-'.repeat(width))),
    ...tableRows.map((row) => tableLine(row)),
    '```'
  );

  report.push('', '## Arbeit der Teammitglieder');

  for (const summary of summaries) {
    report.push(`### ${summary.member.name}`);

    if (summary.unavailable) {
      report.push('Das zugeordnete Daily-Forum konnte beim Erstellen des Berichts nicht gelesen werden.', '');
      continue;
    }

    if (summary.done.length > 0) {
      report.push(
        sentence(
          `${summary.member.name} dokumentierte in dieser Woche folgende Arbeiten bzw. Ergebnisse: ${listAsText(summary.done)}`
        )
      );
    } else {
      report.push(`Für ${summary.member.name} wurden in dieser Woche keine abgeschlossenen Arbeitspunkte aus Dailies dokumentiert.`);
    }

    report.push(
      summary.blockers.length > 0
        ? sentence(`Dokumentierte Probleme bzw. Blocker: ${listAsText(summary.blockers)}`)
        : 'Es wurden keine Probleme oder Blocker dokumentiert.'
    );

    report.push(
      summary.next.length > 0
        ? sentence(`Aktueller Stand bzw. nächste Schritte laut letztem Daily: ${listAsText(summary.next)}`)
        : 'Aus den vorhandenen Dailies lässt sich derzeit kein nächster Schritt ableiten.'
    );

    if (summary.memberAbsences.length > 0) {
      const absenceText = summary.memberAbsences
        .map((entry) => `${formatDate(entry.createdAt)}: ${reportAbsenceLabel(entry)}`)
        .join('; ');
      report.push(sentence(`Dokumentierte Abwesenheit: ${absenceText}`));
    }

    if (summary.missingDates.length > 0) {
      report.push(
        sentence(`Ohne Daily oder Abmeldung: ${summary.missingDates.map((day) => formatDate(day)).join(', ')}`)
      );
    }

    report.push('');
  }

  report.push('## Probleme und Blocker');
  const blockerLines = summaries.flatMap((summary) =>
    summary.blockers.map((blocker) => `- **${summary.member.name}:** ${blocker}`)
  );
  report.push(blockerLines.length > 0 ? blockerLines.join('\n') : '- Keine dokumentierten Blocker.');

  report.push('', '## Abwesenheiten');
  if (effectiveAbsences.length === 0) {
    report.push('- Keine Abmeldungen dokumentiert.');
  } else {
    effectiveAbsences.forEach((entry) =>
      report.push(`- **${entry.ownerName} · ${formatDate(entry.createdAt)}:** ${reportAbsenceLabel(entry)}`)
    );
  }

  report.push('', '## Fehlende Dokumentation');
  const missingLines = summaries.flatMap((summary) =>
    summary.missingDates.length > 0
      ? [`- **${summary.member.name}:** ${summary.missingDates.map((day) => formatDate(day)).join(', ')}`]
      : []
  );
  report.push(
    missingLines.length > 0
      ? missingLines.join('\n')
      : '- Für alle bereits abgeschlossenen regulären Arbeitstage liegt eine Dokumentation vor.'
  );

  report.push('', '## Stand zum Ende der Woche');
  const nextLines = summaries.flatMap((summary) =>
    summary.next.length > 0 ? [`- **${summary.member.name}:** ${listAsText(summary.next)}`] : []
  );
  report.push(nextLines.length > 0 ? nextLines.join('\n') : '- Noch keine nächsten Schritte dokumentiert.');

  report.push(
    '',
    '_Der Bericht wurde automatisch und ausschließlich aus den Daily-Scrum-Einträgen und Abmeldungen erstellt. Exakte Wiederholungen werden zusammengeführt; inhaltlich neue Aussagen werden nicht ergänzt. Bitte vor der Weitergabe kurz prüfen._'
  );

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

async function weeklyScans(): Promise<{
  daily: DailyScanResult;
  absence: AbsenceScanResult;
  unavailableMemberIds: Set<string>;
}> {
  const { start, end } = currentWeekRange();
  const daily = await scanDailyEntriesInRange(start, end);
  const absence = await scanAbsencesInRange(start, end);
  return {
    daily,
    absence,
    unavailableMemberIds: mergeUnavailable(daily.unavailableMemberIds, absence.unavailableMemberIds)
  };
}

async function createWeeklyReport(): Promise<ThreadChannel> {
  const scans = await weeklyScans();
  const forum = await getForum(config.weeklyForumId);
  const chunks = splitDiscordText(
    buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds)
  );

  const thread = await forum.threads.create({
    name: `Wochenbericht für Herrn Tepper | ${formatDate()}`,
    message: { content: chunks[0] },
    reason: 'Automatischer Wochenbericht des Scrum-Master-Bots'
  });

  for (const chunk of chunks.slice(1)) await thread.send(chunk);
  return thread;
}

async function weeklyReportJob(): Promise<void> {
  const thread = await createWeeklyReport();
  const channel = await getScrumChannel();
  await channel.send(`📋 **Der Wochenbericht wurde als Entwurf erstellt.**\nBitte kurz prüfen: <#${thread.id}>`);
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

async function alreadySubmitted(userId: string, date = nowBerlin()): Promise<DailyEntry | undefined> {
  const member = teamMember(userId);
  if (!member) return undefined;

  const entries = await dailyEntriesForMemberInRange(member, date.startOf('day'), date.endOf('day'));
  return entries[0];
}

async function activeAbsence(userId: string, date = nowBerlin()): Promise<AbsenceEntry | undefined> {
  const member = teamMember(userId);
  if (!member) return undefined;
  const entries = await absenceEntriesForMemberInRange(member, date.startOf('day'), date.endOf('day'));
  return entries[0];
}

async function startDailyForInteraction(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });
    return;
  }

  const draft = drafts.get(interaction.user.id) ?? { userId: interaction.user.id };
  drafts.set(interaction.user.id, draft);

  if (!isWorkday()) {
    await interaction.reply({
      content:
        `### 🌙 Heute ist kein regulärer Projekttag\n` +
        `Am Wochenende ist kein Daily erforderlich. Falls du freiwillig am Projekt arbeitest, gilt trotzdem: **Daily zuerst, danach Projektarbeit.**`,
      components: [weekendDailyRow()],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    content:
      `### Kannst du heute dein Daily machen?\n` +
      `Wenn du heute am Projekt arbeitest, mach das Daily bitte **unmittelbar vor Arbeitsbeginn**. ` +
      `Wenn du heute nicht arbeiten kannst, kannst du dich hier abmelden.`,
    components: [dailyAvailabilityRow()],
    flags: MessageFlags.Ephemeral
  });
}

async function createDailyFromDraft(draft: DailyDraft): Promise<ThreadChannel> {
  const member = teamMember(draft.userId);
  if (!member) throw new Error(`Unbekanntes Teammitglied: ${draft.userId}`);

  const forum = await getForum(member.dailyForumId);
  const needsPush = normalizeYesNo(draft.pushPending ?? 'Nein') === 'Ja';
  const createdAt = nowBerlin();

  return forum.threads.create({
    name: dailyPostTitle(member, createdAt),
    message: {
      content: `**Daily erstellt:** ${formatTime(createdAt)} Uhr\n\n${draftContent(draft)}`,
      components: needsPush ? [pushDoneRow(draft.userId)] : [],
      allowedMentions: { parse: [] }
    },
    reason: `Daily Scrum von ${member.name}`
  });
}

function absenceContent(kind: AbsenceKind, detail: string | undefined, date = nowBerlin()): string {
  const status = kind === 'Krankheit' ? 'Entschuldigt' : 'Abgemeldet';
  return (
    `## Abmeldung\n` +
    `- Status: ${status}\n` +
    `- Grund: ${kind}\n` +
    (detail ? `- Details: ${detail}\n` : '') +
    `- Gemeldet: ${formatTime(date)} Uhr`
  );
}

async function createAbsence(userId: string, kind: AbsenceKind, detail?: string): Promise<ThreadChannel> {
  const member = teamMember(userId);
  if (!member) throw new Error(`Unbekanntes Teammitglied: ${userId}`);

  const existingDaily = await alreadySubmitted(userId);
  if (existingDaily) throw new Error('DAILY_ALREADY_EXISTS');

  const existingAbsence = await activeAbsence(userId);
  if (existingAbsence) return existingAbsence.thread;

  const date = nowBerlin();
  const forum = await getForum(member.dailyForumId);
  const thread = await forum.threads.create({
    name: absencePostTitle(member, date),
    message: {
      content: absenceContent(kind, detail, date),
      allowedMentions: { parse: [] }
    },
    reason: `Abmeldung von ${member.name}`
  });

  const channel = await getScrumChannel();
  const display = kind === 'Krankheit' ? 'Krankheit (entschuldigt)' : detail ? `${kind}: ${detail}` : kind;
  await channel.send(`🟦 **Abmeldung · ${formatDate(date)}**\n**${member.name}** · ${display}`);
  return thread;
}

async function cancelActiveAbsenceIfPresent(userId: string): Promise<void> {
  const absence = await activeAbsence(userId);
  if (!absence) return;

  const starter = await absence.thread.fetchStarterMessage();
  if (!starter || starter.content.includes(ABSENCE_CANCELLED_MARKER)) return;
  await starter.edit(
    `${starter.content}\n\n${ABSENCE_CANCELLED_MARKER} ${formatDate()} ${formatTime(nowBerlin())} Uhr · späteres Daily eingereicht.`
  );
}

function botInfoText(): string {
  return (
    `${INFO_MARKER}\n\n` +
    `Der Bot organisiert Dailies, Abmeldungen, Erinnerungen, Meetings und Wochenberichte.\n\n` +
    `## Daily Scrum\n` +
    `**Wann mache ich mein Daily?** Immer unmittelbar **bevor du an diesem Tag mit der Projektarbeit beginnst**. Es gibt keine feste Startzeit. Morgens, nachmittags, abends oder nachts ist alles möglich. Entscheidend ist: **Daily zuerst, danach Projektarbeit.**\n` +
    `Reguläre Daily-Tage sind **Montag bis Freitag**. Am Wochenende ist kein Daily erforderlich; freiwillige Projektarbeit kann trotzdem mit einem Daily dokumentiert werden.\n` +
    `**09:00** · Daily-Runde öffnet · **15:00** und **20:00** · freundliche Erinnerungen an noch nicht dokumentierte Personen.\n` +
    `Ein Daily besteht aus 4 Fragen und wird als \`Daily Scrum <Name> TT.MM.JJJJ\` gespeichert. Im Post steht zusätzlich die Uhrzeit **Daily erstellt: HH:MM Uhr**.\n\n` +
    `## Abmelden\n` +
    `Wer an einem regulären Projekttag kein Daily machen kann, wählt im Daily-Dialog **Nein, abmelden**. Gründe: **Krankheit**, **Termin** oder **Anderes**. Abgemeldete Personen werden an diesem Tag nicht mehr wegen eines fehlenden Dailys gepingt.\n` +
    `Bei **Krankheit** gilt zusätzlich: bitte vor Unterrichtsbeginn um **08:00 Uhr** im bib-Intranet krankmelden: ${SICKNESS_INTRANET_URL}\n\n` +
    `## Push & Wochenbericht\n` +
    `Bei \`Noch zu pushen: Ja\` folgt nach ca. **${config.pushReminderAfterHours} Stunden** einmalig eine Erinnerung. Freitag **14:00** entsteht der Wochenbericht aus Dailies, Abmeldungen und fehlender Dokumentation.\n\n` +
    `## Meetings & Befehle\n` +
    `Meetings: \`/bot meeting\` in <#${config.meetingCreateChannelId}> · Voice: <#${config.meetingVoiceChannelId}>\n` +
    `\`/daily\` · Daily/Abmeldung  •  \`/scrum status\` · Tagesstatus  •  \`/bot struktur\` · Vorlage  •  \`/bot status\` · Bot prüfen  •  \`/bot info\` · diese Übersicht aktualisieren`
  );
}

async function publishBotInfo(): Promise<void> {
  const channel = await getInfoChannel();
  const recent = await channel.messages.fetch({ limit: 50 });
  const existing = recent.find(
    (message) => message.author.id === client.user?.id && message.content.startsWith(INFO_MARKER)
  );

  const chunks = splitDiscordText(botInfoText());
  const message = existing ? await existing.edit(chunks[0]) : await channel.send(chunks[0]);
  if (!message.pinned) await message.pin('Zentrale Scrum-Master-Info').catch(() => undefined);

  for (const chunk of chunks.slice(1)) await channel.send(chunk);
}

async function replyDailyStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isWorkday()) {
    const entries = await dailyEntriesForDate();
    const voluntary = entries.length
      ? `\n\n**Freiwillige Dailies heute:**\n${entries.map((entry) => `✅ ${entry.ownerName} · ${formatTime(entry.createdAt)} Uhr`).join('\n')}`
      : '';
    await interaction.editReply(
      `### Daily-Status · ${formatDate()}\n🌙 **Heute ist kein regulärer Projekttag.**\n` +
        `Am Wochenende ist kein Daily Scrum erforderlich. Wer freiwillig am Projekt arbeitet, macht sein Daily bitte vor Arbeitsbeginn.${voluntary}`
    );
    return;
  }

  const start = nowBerlin().startOf('day');
  const end = nowBerlin().endOf('day');
  const dailyScan = await scanDailyEntriesInRange(start, end);
  const absenceScan = await scanAbsencesInRange(start, end);
  const unavailable = mergeUnavailable(dailyScan.unavailableMemberIds, absenceScan.unavailableMemberIds);
  const latest = new Map(dailyScan.entries.map((entry) => [entry.ownerId, entry]));
  const absent = new Map(absenceScan.entries.map((entry) => [entry.ownerId, entry]));

  const lines = config.members.map((member) => {
    if (unavailable.has(member.discordId)) return `⚠️ ${member.name} · Forum nicht erreichbar`;
    const entry = latest.get(member.discordId);
    if (entry) return `✅ ${member.name} · Daily ${formatTime(entry.createdAt)} Uhr`;
    const absence = absent.get(member.discordId);
    if (absence) return `🟦 ${member.name} · abgemeldet: ${absenceLabel(absence)}`;
    return `⏳ ${member.name} · heute noch keine Dokumentation`;
  });

  await interaction.editReply(
    `### Daily-Status · ${formatDate()}\n${lines.join('\n')}\n\n_Daily immer vor Beginn der eigenen Projektarbeit. Es gibt keine feste Startzeit._`
  );
}

async function replyBotStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const lines: string[] = [];

  for (const member of config.members) {
    try {
      await getForum(member.dailyForumId);
      lines.push(`✅ Daily-Forum ${member.name}`);
    } catch {
      lines.push(`❌ Daily-Forum ${member.name}`);
    }
  }

  const checks: Array<[string, () => Promise<unknown>]> = [
    ['Scrum-Status-Channel', () => getScrumChannel()],
    ['Info-Channel', () => getInfoChannel()],
    ['Meeting-Erstellen-Channel', () => getMeetingCreateChannel()],
    ['Meeting-Voice-Channel', () => validateMeetingVoiceChannel()],
    ['Wochenbericht-Forum', () => getForum(config.weeklyForumId)]
  ];

  for (const [label, check] of checks) {
    try {
      await check();
      lines.push(`✅ ${label}`);
    } catch {
      lines.push(`❌ ${label}`);
    }
  }

  await interaction.editReply(`🟢 **Scrum Master ist online**\n${lines.join('\n')}\nZeitzone: ${config.timezone}`);
}

function isBotSubcommand(interaction: ChatInputCommandInteraction, subcommand: string): boolean {
  return interaction.commandName === 'bot' && interaction.options.getSubcommand(false) === subcommand;
}

const commands = [
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Startet Daily oder Abmeldung für deinen Arbeitstag'),
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
    .addSubcommand((sub) => sub.setName('info').setDescription('Aktualisiert die öffentliche Bot-Übersicht im Info-Channel'))
    .addSubcommand((sub) => sub.setName('struktur').setDescription('Zeigt dir privat die Daily-Scrum-Vorlage zum Kopieren'))
    .addSubcommand((sub) => sub.setName('meeting').setDescription('Erstellt ein neues Meeting im Meeting-Channel')),
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
          { name: 'Daily Evening Reminder', value: 'daily-evening-reminder' },
          { name: 'Missing Daily Report', value: 'missing-daily-report' },
          { name: 'Push Reminder Check', value: 'push-reminder-check' },
          { name: 'Weekly Report', value: 'weekly-report' }
        )
    )
].map((command) => command.toJSON());

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });
    return;
  }

  const meetingCommand = isBotSubcommand(interaction, 'meeting');
  const infoCommand = isBotSubcommand(interaction, 'info');

  if (interaction.channelId === config.meetingCreateChannelId && !meetingCommand) {
    await interaction.reply({
      content: `Dieser Channel ist ausschließlich für **/bot meeting** gedacht.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (meetingCommand && interaction.channelId !== config.meetingCreateChannelId) {
    await interaction.reply({
      content: `Meetings werden nur in <#${config.meetingCreateChannelId}> erstellt.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.channelId === config.infoChannelId && !infoCommand) {
    await interaction.reply({
      content: `Dieser Channel ist für die Bot-Dokumentation reserviert. Nutze hier **/bot info**.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (infoCommand && interaction.channelId !== config.infoChannelId) {
    await interaction.reply({
      content: `Die öffentliche Bot-Info wird in <#${config.infoChannelId}> verwaltet.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

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

    if (sub === 'meeting') {
      await interaction.showModal(meetingModal());
      return;
    }

    if (sub === 'info') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await publishBotInfo();
      await interaction.editReply(`✅ Bot-Übersicht in <#${config.infoChannelId}> wurde aktualisiert.`);
      return;
    }

    if (sub === 'struktur') {
      await interaction.reply({
        content:
          `### Daily-Scrum Vorlage\n\n\`\`\`md\n${DAILY_TEMPLATE}\n\`\`\`\n` +
          `Alternativ kannst du einfach **/daily** verwenden und die vier Fragen interaktiv beantworten.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await replyBotStatus(interaction);
    return;
  }

  if (interaction.commandName === 'wochenbericht') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'vorschau') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const scans = await weeklyScans();
      const chunks = splitDiscordText(
        buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds)
      );
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
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
        content: 'Dafür brauchst du zusätzlich die Berechtigung „Server verwalten“.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const action = interaction.options.getString('aktion', true);
    await interaction.reply({ content: `Teste **${action}** …`, flags: MessageFlags.Ephemeral });

    if (action === 'daily-start') await sendDailyOpen();
    if (action === 'daily-reminder') await sendDailyReminder(false);
    if (action === 'daily-evening-reminder') await sendDailyReminder(true);
    if (action === 'missing-daily-report') await reportMissingDailies();
    if (action === 'push-reminder-check') await sendDelayedPushReminders();
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

async function handlePushDoneButton(interaction: ButtonInteraction): Promise<void> {
  const ownerId = interaction.customId.split(':')[2];
  if (!ownerId || interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'Nur die Person, zu der dieses Daily gehört, kann den Push-Status ändern.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.channel || !interaction.channel.isThread()) {
    await interaction.editReply('Dieser Button gehört nicht zu einem Daily-Thread.');
    return;
  }

  const thread = interaction.channel;
  const assignedMember = memberByForumId(thread.parentId);
  if (!assignedMember || assignedMember.discordId !== ownerId) {
    await interaction.editReply('Dieses Daily ist keinem passenden Teammitglied zugeordnet.');
    return;
  }

  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await interaction.editReply('Der Daily-Startbeitrag konnte nicht gefunden werden.');
    return;
  }

  if (!hasPushDone(starter.content)) {
    await starter.edit({
      content: `${starter.content}\n\n${PUSH_DONE_MARKER} · ${formatDate()} ${formatTime(nowBerlin())} Uhr`,
      components: []
    });
  }

  if (interaction.message.id !== starter.id) {
    await interaction.message.edit({ components: [] }).catch(() => undefined);
  }

  await interaction.editReply('✅ Push-Status wurde als erledigt markiert.');
}

async function handleSicknessAbsence(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  try {
    const thread = await createAbsence(interaction.user.id, 'Krankheit');
    drafts.delete(interaction.user.id);
    await interaction.editReply({
      content:
        `🤒 **Für heute als Krankheit (entschuldigt) dokumentiert.**\n` +
        `Abmeldung: <#${thread.id}>\n\n` +
        `Bitte melde dich zusätzlich **vor Unterrichtsbeginn um 08:00 Uhr** im bib-Intranet krank:\n${SICKNESS_INTRANET_URL}`,
      components: []
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'DAILY_ALREADY_EXISTS') {
      await interaction.editReply({ content: '✅ Für heute liegt bereits ein Daily vor. Eine Abmeldung ist nicht mehr nötig.', components: [] });
      return;
    }
    console.error('Krankheits-Abmeldung konnte nicht erstellt werden.', error);
    await interaction.editReply({ content: '❌ Die Abmeldung konnte nicht gespeichert werden.', components: [] });
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId.startsWith('daily:mark-pushed:')) {
    await handlePushDoneButton(interaction);
    return;
  }

  if (interaction.customId === 'daily:start') {
    await startDailyForInteraction(interaction);
    return;
  }

  if (interaction.customId === 'daily:work-yes') {
    const draft = drafts.get(interaction.user.id) ?? { userId: interaction.user.id };
    drafts.set(interaction.user.id, draft);
    await interaction.showModal(questionOneModal(draft));
    return;
  }

  if (interaction.customId === 'daily:work-no') {
    await interaction.update({
      content: '### Warum kannst du heute kein Daily machen?\nWähle den passenden Grund:',
      components: [absenceReasonRow()]
    });
    return;
  }

  if (interaction.customId === 'absence:sick') {
    await handleSicknessAbsence(interaction);
    return;
  }

  if (interaction.customId === 'absence:appointment') {
    await interaction.showModal(absenceDetailModal('appointment'));
    return;
  }

  if (interaction.customId === 'absence:other') {
    await interaction.showModal(absenceDetailModal('other'));
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

    try {
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
      await cancelActiveAbsenceIfPresent(interaction.user.id);
      drafts.delete(interaction.user.id);
      await interaction.editReply({
        content: `✅ **Daily vollständig abgegeben!**\nDein heutiger Post wurde erstellt: <#${thread.id}>`,
        components: []
      });
    } catch (error) {
      console.error(`[Daily] Daily für ${memberName(interaction.user.id)} konnte nicht veröffentlicht werden.`, error);
      const member = teamMember(interaction.user.id);
      await interaction.editReply({
        content:
          `❌ Dein Daily konnte nicht veröffentlicht werden. ` +
          `Das für dich konfigurierte Forum${member ? ` (${member.dailyForumId})` : ''} ist nicht erreichbar oder kein Discord-Forum.`,
        components: []
      });
    }
  }
}

async function handleAbsenceModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const detail = interaction.fields.getTextInputValue('reason').trim();
  const kind: AbsenceKind = interaction.customId.endsWith(':appointment') ? 'Termin' : 'Anderes';

  try {
    const thread = await createAbsence(interaction.user.id, kind, detail);
    drafts.delete(interaction.user.id);
    await interaction.editReply(`🟦 **Für heute abgemeldet.**\nGrund: **${kind}** · ${detail}\nAbmeldung: <#${thread.id}>`);
  } catch (error) {
    if (error instanceof Error && error.message === 'DAILY_ALREADY_EXISTS') {
      await interaction.editReply('✅ Für heute liegt bereits ein Daily vor. Eine Abmeldung ist nicht mehr nötig.');
      return;
    }
    console.error('Abmeldung konnte nicht erstellt werden.', error);
    await interaction.editReply('❌ Die Abmeldung konnte nicht gespeichert werden.');
  }
}

async function handleMeetingModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.channelId !== config.meetingCreateChannelId) {
    await interaction.reply({
      content: `Meetings werden nur in <#${config.meetingCreateChannelId}> erstellt.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const title = interaction.fields.getTextInputValue('title').trim();
  const date = interaction.fields.getTextInputValue('date').trim();
  const time = interaction.fields.getTextInputValue('time').trim();
  const durationRaw = interaction.fields.getTextInputValue('duration').trim();
  const agenda = interaction.fields.getTextInputValue('agenda').trim();
  const duration = Number(durationRaw);
  const start = DateTime.fromFormat(`${date} ${time}`, 'dd.MM.yyyy HH:mm', { zone: config.timezone, locale: 'de' });

  if (!start.isValid || !Number.isFinite(duration) || duration < 10 || duration > 480) {
    await interaction.reply({
      content: '❌ Bitte Datum als **TT.MM.JJJJ**, Uhrzeit als **HH:MM** und Dauer zwischen **10 und 480 Minuten** angeben.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (start < nowBerlin()) {
    await interaction.reply({ content: '❌ Das Meeting muss in der Zukunft liegen.', flags: MessageFlags.Ephemeral });
    return;
  }

  const timestamp = Math.floor(start.toSeconds());
  const end = start.plus({ minutes: duration });
  const users = config.members.map((member) => member.discordId);

  await interaction.reply({
    content:
      `## 📅 ${title}\n` +
      `${mentionList(users)}\n\n` +
      `**Start:** <t:${timestamp}:F> · <t:${timestamp}:R>\n` +
      `**Dauer:** ca. ${duration} Minuten · bis ${formatTime(end)} Uhr\n` +
      `**Ort:** <#${config.meetingVoiceChannelId}>\n` +
      `**Erstellt von:** <@${interaction.user.id}>\n\n` +
      `### Agenda\n${agenda || 'Noch keine Agenda eingetragen.'}\n\n` +
      `Reagiert mit ✅, wenn ihr dabei seid, oder mit ❌, wenn ihr nicht könnt.`,
    components: [meetingVoiceRow()],
    allowedMentions: { users }
  });

  const message = await interaction.fetchReply();
  await message.react('✅').catch(() => undefined);
  await message.react('❌').catch(() => undefined);
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId === 'meeting:create') {
    await handleMeetingModal(interaction);
    return;
  }

  if (interaction.customId.startsWith('absence:details:')) {
    await handleAbsenceModal(interaction);
    return;
  }

  if (!interaction.customId.startsWith('daily:')) return;

  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: NO_PERMISSION, flags: MessageFlags.Ephemeral });
    return;
  }

  const draft = drafts.get(interaction.user.id) ?? { userId: interaction.user.id };
  drafts.set(interaction.user.id, draft);

  if (interaction.customId === 'daily:q1') {
    draft.previous = interaction.fields.getTextInputValue('answer').trim();
    await interaction.reply({
      content: `✅ **Frage 1/4 beantwortet**\n\n**Deine Antwort:**\n${draft.previous}\n\nWeiter mit Frage 2:`,
      components: [nextButton('daily:next-q2', 'Weiter zu Frage 2')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId === 'daily:q2') {
    draft.today = interaction.fields.getTextInputValue('answer').trim();
    await interaction.reply({
      content:
        `✅ **Frage 2/4 beantwortet**\n\n**Deine Antwort:**\n${draft.today}\n\n` +
        `### Frage 3/4\nHast du aktuell Probleme oder Blocker?`,
      components: [blockerButtons()],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId === 'daily:q3') {
    draft.blocker = interaction.fields.getTextInputValue('answer').trim();
    await interaction.reply({
      content: `✅ **Frage 3/4 beantwortet**\n\n**Blocker:**\n${draft.blocker}\n\nWeiter mit der letzten Frage:`,
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

async function logHealth(): Promise<void> {
  const channelChecks: Array<[string, () => Promise<unknown>]> = [
    ['Scrum-Status-Channel', () => getScrumChannel()],
    ['Scrum-Info-Channel', () => getInfoChannel()],
    ['Meetings-erstellen-Channel', () => getMeetingCreateChannel()],
    ['Meetings-Voice-Channel', () => validateMeetingVoiceChannel()],
    ['Wochenbericht-Forum', () => getForum(config.weeklyForumId)]
  ];

  for (const [label, check] of channelChecks) {
    try {
      await check();
      console.log(`${label}: OK`);
    } catch (error) {
      console.error(`${label}: FEHLER`, error);
    }
  }

  for (const member of config.members) {
    try {
      await getForum(member.dailyForumId);
      console.log(`Daily-Forum ${member.name}: OK (${member.dailyForumId})`);
    } catch (error) {
      console.error(`Daily-Forum ${member.name}: FEHLER (${member.dailyForumId})`, error);
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Scrum Master online als ${readyClient.user.tag}`);
  console.log(`Bot User ID: ${readyClient.user.id}`);

  try {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(commands);
    console.log(`Slash Commands auf ${guild.name} registriert.`);
  } catch (error) {
    console.error(`Server ${config.guildId} konnte nicht geladen oder Commands konnten nicht registriert werden.`, error);
    return;
  }

  await logHealth();
  await publishBotInfo().catch((error) => console.error('Bot-Info konnte nicht veröffentlicht werden.', error));

  cron.schedule(config.cron.dailyOpen, () => void sendDailyOpen().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyReminder, () => void sendDailyReminder(false).catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyEveningReminder, () => void sendDailyReminder(true).catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.dailyMissingReport, () => void reportMissingDailies().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.pushReminderCheck, () => void sendDelayedPushReminders().catch(console.error), { timezone: config.timezone });
  cron.schedule(config.cron.weeklyReport, () => void weeklyReportJob().catch(console.error), { timezone: config.timezone });

  console.log('Scrum Master ist bereit.');
});

client.on(Events.ThreadCreate, (thread) => {
  const assignedMember = memberByForumId(thread.parentId);
  if (!assignedMember || thread.ownerId === client.user?.id) return;

  void (async () => {
    if (!thread.ownerId || !isTeamMember(thread.ownerId)) {
      await thread.send(NO_PERMISSION);
      return;
    }

    if (thread.ownerId !== assignedMember.discordId) {
      await thread.send(
        `⚠️ Dieses Daily-Forum ist **${assignedMember.name}** zugeordnet. ` +
          `Dein Daily wird über **/daily** automatisch in dein eigenes Forum einsortiert.`
      );
      return;
    }

    const content = await starterContent(thread);
    if (isCompleteDailyContent(content) || matchesMemberAbsenceTitle(thread, assignedMember)) return;

    await thread.send(
      `⚠️ Dieser Post zählt noch nicht als vollständiges Daily für **${assignedMember.name}**. ` +
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
