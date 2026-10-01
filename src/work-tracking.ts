import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel
} from 'discord.js';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config } from './config.js';

type SessionProvenance = 'daily' | 'manual-exact' | 'manual-estimated';

type WorkSession = {
  id: string;
  userId: string;
  date: string;
  dailyThreadId?: string;
  startAt: string;
  endAt?: string;
  pauseMinutes: number;
  provenance: SessionProvenance;
  createdAt: string;
  updatedAt: string;
};

type WorkState = {
  nextSession: number;
  sessions: WorkSession[];
};

export type DailyForWorkReport = {
  ownerId: string;
  ownerName: string;
  createdAt: DateTime;
};

export type AbsenceForWorkReport = {
  ownerId: string;
  createdAt: DateTime;
};

export type WeeklyCompletionStatus = {
  ready: boolean;
  missing: string[];
};

const statePath = process.env.WORK_TRACKING_FILE || path.join(process.cwd(), 'data', 'work-sessions.json');
let statePromise: Promise<WorkState> | undefined;
let saveQueue = Promise.resolve();
let installed = false;

function nowBerlin(): DateTime {
  return DateTime.now().setZone(config.timezone);
}

function isTeamMember(userId: string): boolean {
  return config.members.some((member) => member.discordId === userId);
}

function memberName(userId: string): string {
  return config.members.find((member) => member.discordId === userId)?.name ?? userId;
}

function freshState(): WorkState {
  return { nextSession: 1, sessions: [] };
}

function readStateSync(): WorkState {
  if (!existsSync(statePath)) return freshState();
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<WorkState>;
    return {
      nextSession: Number.isFinite(parsed.nextSession) ? Number(parsed.nextSession) : 1,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch (error) {
    console.error('[Arbeitszeit] Status konnte nicht gelesen werden.', error);
    return freshState();
  }
}

async function loadState(): Promise<WorkState> {
  if (!statePromise) {
    statePromise = Promise.resolve(readStateSync());
  }
  return statePromise;
}

async function saveState(state: WorkState): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, statePath);
  });
  await saveQueue;
}

function nextSessionId(state: WorkState): string {
  return `W-${String(state.nextSession++).padStart(4, '0')}`;
}

function parseIso(value: string): DateTime {
  return DateTime.fromISO(value, { zone: config.timezone });
}

function sessionDate(date: DateTime): string {
  return date.toISODate() ?? date.toFormat('yyyy-MM-dd');
}

function durationMinutes(session: WorkSession): number | undefined {
  if (!session.endAt) return undefined;
  const start = parseIso(session.startAt);
  const end = parseIso(session.endAt);
  if (!start.isValid || !end.isValid) return undefined;
  return Math.max(0, Math.round(end.diff(start, 'minutes').minutes) - Math.max(0, session.pauseMinutes));
}

function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

function provenanceText(session: WorkSession): string {
  if (session.provenance === 'manual-estimated') return ' · nachgetragen, geschätzt';
  if (session.provenance === 'manual-exact') return ' · nachgetragen';
  return '';
}

function endButton(session: WorkSession): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`work:end:${session.id}`)
      .setLabel('Arbeit für heute beenden')
      .setEmoji('🏁')
      .setStyle(ButtonStyle.Success)
  );
}

function pauseInput(defaultValue = '0'): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId('pause')
      .setLabel('Pausenzeit in Minuten')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(3)
      .setValue(defaultValue)
  );
}

function endModal(session: WorkSession): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`work:end-modal:${session.id}`)
    .setTitle('Arbeitstag abschließen')
    .addComponents(pauseInput(String(session.pauseMinutes ?? 0)));
}

async function findOpenSession(userId: string, date = nowBerlin()): Promise<WorkSession | undefined> {
  const state = await loadState();
  const key = sessionDate(date);
  return state.sessions.find((session) => session.userId === userId && session.date === key && !session.endAt);
}

export async function startWorkSession(thread: ThreadChannel, userId: string): Promise<void> {
  if (!isTeamMember(userId)) return;

  const state = await loadState();
  const start = nowBerlin();
  const date = sessionDate(start);
  const existing = state.sessions.find((session) => session.userId === userId && session.date === date);

  if (existing) {
    if (!existing.endAt) {
      await thread.send({
        content: `🕒 **Arbeitszeit läuft bereits seit ${parseIso(existing.startAt).toFormat('HH:mm')} Uhr.**`,
        components: [endButton(existing)],
        allowedMentions: { parse: [] }
      }).catch(() => undefined);
    }
    return;
  }

  const nowIso = start.toISO() ?? new Date().toISOString();
  const session: WorkSession = {
    id: nextSessionId(state),
    userId,
    date,
    dailyThreadId: thread.id,
    startAt: nowIso,
    pauseMinutes: 0,
    provenance: 'daily',
    createdAt: nowIso,
    updatedAt: nowIso
  };
  state.sessions.push(session);
  await saveState(state);

  await thread.send({
    content:
      `🕒 **Arbeitszeit gestartet: ${start.toFormat('HH:mm')} Uhr**\n` +
      `Wenn du für heute fertig bist, beende den Arbeitstag über den Button oder mit **/feierabend**.`,
    components: [endButton(session)],
    allowedMentions: { parse: [] }
  });
}

async function showEndModal(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const session = await findOpenSession(interaction.user.id);
  if (!session) {
    await interaction.reply({
      content: 'ℹ️ Für heute läuft keine offene Arbeitszeit. Falls ein alter Tag fehlt, nutze **/arbeitszeit nachtragen**.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.showModal(endModal(session));
}

async function finishSession(interaction: ModalSubmitInteraction, sessionId: string): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Keine Berechtigung.', flags: MessageFlags.Ephemeral });
    return;
  }

  const pause = Number(interaction.fields.getTextInputValue('pause').trim());
  if (!Number.isInteger(pause) || pause < 0 || pause > 480) {
    await interaction.reply({ content: '❌ Bitte eine Pausenzeit zwischen 0 und 480 Minuten angeben.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const session = state.sessions.find((entry) => entry.id === sessionId && entry.userId === interaction.user.id);
  if (!session) {
    await interaction.reply({ content: '❌ Die Arbeitszeit wurde nicht gefunden.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.endAt) {
    await interaction.reply({ content: 'ℹ️ Dieser Arbeitstag wurde bereits abgeschlossen.', flags: MessageFlags.Ephemeral });
    return;
  }

  const end = nowBerlin();
  const start = parseIso(session.startAt);
  const gross = Math.round(end.diff(start, 'minutes').minutes);
  if (pause >= gross) {
    await interaction.reply({ content: '❌ Die Pause darf nicht so lang wie die gesamte Arbeitszeit sein.', flags: MessageFlags.Ephemeral });
    return;
  }

  session.endAt = end.toISO() ?? new Date().toISOString();
  session.pauseMinutes = pause;
  session.updatedAt = session.endAt;
  await saveState(state);

  const net = durationMinutes(session) ?? 0;
  await interaction.reply({
    content:
      `🏁 **Arbeitstag abgeschlossen.**\n` +
      `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')} Uhr · Pause ${pause} min · **${durationText(net)} Arbeitszeit**`,
    flags: MessageFlags.Ephemeral
  });
}

async function backfill(interaction: ChatInputCommandInteraction): Promise<void> {
  const dateRaw = interaction.options.getString('datum', true).trim();
  const startRaw = interaction.options.getString('start', true).trim();
  const endRaw = interaction.options.getString('ende', true).trim();
  const pause = interaction.options.getInteger('pause') ?? 0;
  const quality = interaction.options.getString('qualität') ?? 'genau';

  const start = DateTime.fromFormat(`${dateRaw} ${startRaw}`, 'dd.MM.yyyy HH:mm', {
    zone: config.timezone,
    locale: 'de'
  });
  const end = DateTime.fromFormat(`${dateRaw} ${endRaw}`, 'dd.MM.yyyy HH:mm', {
    zone: config.timezone,
    locale: 'de'
  });

  if (!start.isValid || !end.isValid || end <= start) {
    await interaction.reply({
      content: '❌ Datum bitte als **TT.MM.JJJJ**, Zeiten als **HH:MM** angeben. Die Endzeit muss nach der Startzeit liegen.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (start > nowBerlin()) {
    await interaction.reply({ content: '❌ Arbeitszeit kann nicht für die Zukunft nachgetragen werden.', flags: MessageFlags.Ephemeral });
    return;
  }

  const gross = Math.round(end.diff(start, 'minutes').minutes);
  if (pause < 0 || pause >= gross) {
    await interaction.reply({ content: '❌ Die Pausenzeit ist für diesen Zeitraum ungültig.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const date = sessionDate(start);
  let session = state.sessions.find((entry) => entry.userId === interaction.user.id && entry.date === date);
  const nowIso = nowBerlin().toISO() ?? new Date().toISOString();
  const provenance: SessionProvenance = quality === 'geschätzt' ? 'manual-estimated' : 'manual-exact';

  if (!session) {
    session = {
      id: nextSessionId(state),
      userId: interaction.user.id,
      date,
      startAt: start.toISO() ?? start.toJSDate().toISOString(),
      endAt: end.toISO() ?? end.toJSDate().toISOString(),
      pauseMinutes: pause,
      provenance,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    state.sessions.push(session);
  } else {
    session.startAt = start.toISO() ?? start.toJSDate().toISOString();
    session.endAt = end.toISO() ?? end.toJSDate().toISOString();
    session.pauseMinutes = pause;
    session.provenance = provenance;
    session.updatedAt = nowIso;
  }

  await saveState(state);
  const net = durationMinutes(session) ?? 0;
  await interaction.reply({
    content:
      `✅ Arbeitszeit für **${dateRaw}** gespeichert: ${startRaw}–${endRaw} Uhr · Pause ${pause} min · **${durationText(net)}**` +
      (provenance === 'manual-estimated' ? '\n_Diese Zeit ist ausdrücklich als geschätzt gekennzeichnet._' : ''),
    flags: MessageFlags.Ephemeral
  });
}

async function status(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = await loadState();
  const own = state.sessions
    .filter((session) => session.userId === interaction.user.id)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7);

  if (own.length === 0) {
    await interaction.reply({
      content: 'Noch keine Arbeitszeiten gespeichert. Bereits vorhandene alte Dailies bleiben trotzdem im Wochenbericht erhalten.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const lines = own.map((session) => {
    const start = parseIso(session.startAt);
    const end = session.endAt ? parseIso(session.endAt) : undefined;
    const net = durationMinutes(session);
    return end && net !== undefined
      ? `• **${DateTime.fromISO(session.date).toFormat('dd.MM.yyyy')}** · ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')} · ${durationText(net)}${provenanceText(session)}`
      : `• **${DateTime.fromISO(session.date).toFormat('dd.MM.yyyy')}** · seit ${start.toFormat('HH:mm')} Uhr · noch offen`;
  });

  await interaction.reply({ content: `## Deine Arbeitszeiten\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
}

export const workTrackingCommands = [
  new SlashCommandBuilder()
    .setName('feierabend')
    .setDescription('Beendet deine heutige Arbeitszeit'),
  new SlashCommandBuilder()
    .setName('arbeitszeit')
    .setDescription('Arbeitszeiten anzeigen oder nachtragen')
    .addSubcommand((sub) => sub.setName('status').setDescription('Zeigt deine letzten Arbeitszeiten'))
    .addSubcommand((sub) =>
      sub
        .setName('nachtragen')
        .setDescription('Trägt eine vergangene Arbeitszeit nach')
        .addStringOption((option) => option.setName('datum').setDescription('TT.MM.JJJJ').setRequired(true).setMaxLength(10))
        .addStringOption((option) => option.setName('start').setDescription('HH:MM').setRequired(true).setMaxLength(5))
        .addStringOption((option) => option.setName('ende').setDescription('HH:MM').setRequired(true).setMaxLength(5))
        .addIntegerOption((option) => option.setName('pause').setDescription('Pause in Minuten').setMinValue(0).setMaxValue(480))
        .addStringOption((option) =>
          option
            .setName('qualität')
            .setDescription('Ist die Zeit genau bekannt oder geschätzt?')
            .addChoices(
              { name: 'Genau', value: 'genau' },
              { name: 'Geschätzt', value: 'geschätzt' }
            )
        )
    )
].map((command) => command.toJSON());

export function weeklyWorkTrackingSection(dailies: DailyForWorkReport[], date = nowBerlin()): string {
  const state = readStateSync();
  const weekStart = date.startOf('week').startOf('day');
  const friday = weekStart.plus({ days: 4 }).endOf('day');
  const weekDailies = dailies.filter((daily) => daily.createdAt >= weekStart && daily.createdAt <= friday);
  const weekSessions = state.sessions.filter((session) => {
    const day = DateTime.fromISO(session.date, { zone: config.timezone });
    return day.isValid && day >= weekStart && day <= friday;
  });

  if (weekDailies.length === 0 && weekSessions.length === 0) return '';

  const out: string[] = ['', '', '## Arbeitszeiten'];
  for (const member of config.members) {
    const memberDailies = weekDailies.filter((daily) => daily.ownerId === member.discordId);
    const memberSessions = weekSessions.filter((session) => session.userId === member.discordId);
    const dates = new Set<string>([
      ...memberDailies.map((daily) => sessionDate(daily.createdAt)),
      ...memberSessions.map((session) => session.date)
    ]);
    if (dates.size === 0) continue;

    out.push('', `### ${member.name}`);
    let total = 0;

    for (const day of [...dates].sort()) {
      const label = DateTime.fromISO(day, { zone: config.timezone }).setLocale('de').toFormat('cccc, dd.MM.yyyy');
      const session = memberSessions.find((entry) => entry.date === day);
      const daily = memberDailies.find((entry) => sessionDate(entry.createdAt) === day);

      if (session?.endAt) {
        const start = parseIso(session.startAt);
        const end = parseIso(session.endAt);
        const net = durationMinutes(session) ?? 0;
        total += net;
        out.push(
          `- **${label}:** ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')} Uhr · Pause ${session.pauseMinutes} min · ${durationText(net)}${provenanceText(session)}`
        );
      } else if (session) {
        out.push(`- **${label}:** seit ${parseIso(session.startAt).toFormat('HH:mm')} Uhr · Arbeitstag noch nicht abgeschlossen`);
      } else if (daily) {
        out.push(
          `- **${label}:** Daily um ${daily.createdAt.toFormat('HH:mm')} Uhr · Arbeitszeit nicht erfasst (Altbestand vor Arbeitszeiterfassung)`
        );
      }
    }

    if (total > 0) out.push(`**Erfasste Wochenarbeitszeit:** ${durationText(total)}`);
  }

  out.push(
    '',
    '_Bei Dailies aus der Zeit vor der Arbeitszeiterfassung werden keine Arbeitszeiten erfunden. Nachträge können mit `/arbeitszeit nachtragen` als genau oder geschätzt gekennzeichnet werden._'
  );
  return out.join('\n');
}

export function fridayCompletionStatus(
  dailies: DailyForWorkReport[],
  absences: AbsenceForWorkReport[],
  date = nowBerlin()
): WeeklyCompletionStatus {
  const friday = date.startOf('week').plus({ days: 4 }).startOf('day');
  const fridayKey = sessionDate(friday);
  const state = readStateSync();
  const missing: string[] = [];

  for (const member of config.members) {
    const absent = absences.some(
      (entry) => entry.ownerId === member.discordId && sessionDate(entry.createdAt) === fridayKey
    );
    if (absent) continue;

    const daily = dailies.some(
      (entry) => entry.ownerId === member.discordId && sessionDate(entry.createdAt) === fridayKey
    );
    if (!daily) {
      missing.push(`${member.name}: Daily oder Abmeldung fehlt`);
      continue;
    }

    const session = state.sessions.find((entry) => entry.userId === member.discordId && entry.date === fridayKey);
    if (!session?.endAt) missing.push(`${member.name}: Arbeitstag noch nicht abgeschlossen`);
  }

  return { ready: missing.length === 0, missing };
}

export function installWorkTracking(client: Client): void {
  if (installed) return;
  installed = true;

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'feierabend') {
        await showEndModal(interaction);
        return;
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'arbeitszeit') {
        if (!isTeamMember(interaction.user.id)) {
          await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
          return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'status') await status(interaction);
        if (sub === 'nachtragen') await backfill(interaction);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('work:end:')) {
        await showEndModal(interaction);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('work:end-modal:')) {
        const sessionId = interaction.customId.slice('work:end-modal:'.length);
        await finishSession(interaction, sessionId);
      }
    })().catch((error) => console.error('[Arbeitszeit] Interaction-Fehler', error));
  });
}
