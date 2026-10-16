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
  TextChannel,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import cron from 'node-cron';
import { config } from './config.js';
import { keepUnreadableFile } from './utils/state-files.js';

type SessionProvenance = 'daily' | 'clock' | 'manual-exact' | 'manual-estimated';

// kind 'stop': Lücke zwischen Stop und erneutem Start. Zählt weder als Arbeit noch als Pause.
// Ohne kind ist es eine normale Pause (so liegen auch alle älteren Einträge vor).
type PauseInterval = {
  startAt: string;
  endAt?: string;
  kind?: 'stop';
  // Pause zwischen dem echten Arbeitsbeginn und dem Klick auf Start (über „Start korrigieren“).
  beforeStart?: boolean;
};

type WorkSession = {
  id: string;
  userId: string;
  date: string;
  dailyThreadId?: string;
  startAt: string;
  endAt?: string;
  pauseMinutes: number;
  pauses?: PauseInterval[];
  // Mit Stop beendet: endAt ist gesetzt, ein erneuter Start am selben Tag macht weiter.
  stopped?: boolean;
  provenance: SessionProvenance;
  createdAt: string;
  updatedAt: string;
  endReminderSentAt?: string;
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

const TIME_PANEL_MARKER = '# Scrum-Zeiterfassung';
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

function normalizeSession(raw: WorkSession): WorkSession {
  return {
    ...raw,
    pauseMinutes: Number.isFinite(raw.pauseMinutes) ? Math.max(0, Number(raw.pauseMinutes)) : 0,
    pauses: Array.isArray(raw.pauses) ? raw.pauses : undefined,
    provenance: raw.provenance ?? 'daily'
  };
}

function readStateSync(): WorkState {
  if (!existsSync(statePath)) return freshState();
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<WorkState>;
    return {
      nextSession: Number.isFinite(parsed.nextSession) ? Number(parsed.nextSession) : 1,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map((entry) => normalizeSession(entry as WorkSession)) : []
    };
  } catch (error) {
    console.error('[Arbeitszeit] Status konnte nicht gelesen werden.', error);
    keepUnreadableFile(statePath);
    return freshState();
  }
}

async function loadState(): Promise<WorkState> {
  if (!statePromise) statePromise = Promise.resolve(readStateSync());
  return statePromise;
}

async function saveState(state: WorkState): Promise<void> {
  // Ein fehlgeschlagener Schreibvorgang darf spätere Speicherungen nicht blockieren.
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
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

function openPause(session: WorkSession): PauseInterval | undefined {
  return session.pauses?.findLast((pause) => !pause.endAt && pause.kind !== 'stop');
}

function intervalMinutes(interval: PauseInterval): number {
  if (!interval.endAt) return 0;
  const start = parseIso(interval.startAt);
  const end = parseIso(interval.endAt);
  if (!start.isValid || !end.isValid || end <= start) return 0;
  return Math.round(end.diff(start, 'minutes').minutes);
}

function stopMinutes(session: WorkSession): number {
  return (session.pauses ?? []).filter((interval) => interval.kind === 'stop').reduce((sum, interval) => sum + intervalMinutes(interval), 0);
}

// Pausen eines Tages bis zum nachgetragenen Ende; eine offene Pause zählt bis dahin.
function recordedPauseMinutes(session: WorkSession, end: DateTime): number {
  return (session.pauses ?? [])
    .filter((pause) => pause.kind !== 'stop')
    .reduce((sum, pause) => sum + intervalMinutes({ ...pause, endAt: pause.endAt ?? end.toISO() ?? undefined }), 0);
}

function recalculatePauseMinutes(session: WorkSession): number {
  if (!session.pauses || session.pauses.length === 0) return Math.max(0, session.pauseMinutes ?? 0);

  let minutes = 0;
  for (const pause of session.pauses) {
    if (pause.kind !== 'stop') minutes += intervalMinutes(pause);
  }
  session.pauseMinutes = Math.max(0, minutes);
  return session.pauseMinutes;
}

function durationMinutes(session: WorkSession): number | undefined {
  if (!session.endAt) return undefined;
  const start = parseIso(session.startAt);
  const end = parseIso(session.endAt);
  if (!start.isValid || !end.isValid) return undefined;
  const pause = recalculatePauseMinutes(session);
  return Math.max(0, Math.round(end.diff(start, 'minutes').minutes) - pause - stopMinutes(session));
}

// Zwischenstand beim Pausieren: Beginn, bisherige Pausen und bisherige Arbeitszeit bis zu `at`.
function interimSummary(session: WorkSession, at: DateTime): string {
  const pause = recalculatePauseMinutes(session);
  const work = durationMinutes({ ...session, endAt: at.toISO() ?? new Date().toISOString() }) ?? 0;
  return (
    `**Start:** ${parseIso(session.startAt).toFormat('HH:mm')} Uhr\n` +
    `**Pause bisher:** ${pause} min\n` +
    `**Arbeitszeit bisher:** ${durationText(work)}`
  );
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

function crossesMidnight(session: WorkSession): boolean {
  if (!session.endAt) return false;
  return parseIso(session.startAt).toISODate() !== parseIso(session.endAt).toISODate();
}

function endTimeText(session: WorkSession): string {
  if (!session.endAt) return '';
  const end = parseIso(session.endAt);
  return `${end.toFormat('HH:mm')}${crossesMidnight(session) ? ' (+1 Tag)' : ''}`;
}

// Arbeitsblöcke eines Tages, getrennt an den Stops. Ohne Stop ist es genau ein Block.
function workBlocks(session: WorkSession): { start: DateTime; end?: DateTime }[] {
  const stops = (session.pauses ?? [])
    .filter((interval) => interval.kind === 'stop' && interval.endAt)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const blocks: { start: DateTime; end?: DateTime }[] = [];
  let blockStart = parseIso(session.startAt);
  for (const stop of stops) {
    blocks.push({ start: blockStart, end: parseIso(stop.startAt) });
    blockStart = parseIso(stop.endAt as string);
  }
  blocks.push({ start: blockStart, end: session.endAt ? parseIso(session.endAt) : undefined });
  return blocks;
}

function timeRangeText(session: WorkSession): string {
  const day = parseIso(session.startAt).toISODate();
  const clock = (time: DateTime): string => `${time.toFormat('HH:mm')}${time.toISODate() !== day ? ' (+1 Tag)' : ''}`;
  return workBlocks(session)
    .map((block) => (block.end ? `${clock(block.start)}–${clock(block.end)}` : `seit ${clock(block.start)}`))
    .join(', ');
}

function todaysSession(state: WorkState, userId: string): WorkSession | undefined {
  const todayKey = sessionDate(nowBerlin());
  return state.sessions.find((entry) => entry.userId === userId && entry.date === todayKey);
}

// Arbeit über Mitternacht ist erlaubt. Erst wenn seit dem Start mehr als MAX_LIVE_HOURS vergangen sind,
// gilt Ende als vergessen und muss nachgetragen werden, damit keine Nacht als Arbeitszeit zählt.
const MAX_LIVE_HOURS = 16;

function forgottenEnd(start: DateTime, now: DateTime): boolean {
  return now.diff(start, 'hours').hours > MAX_LIVE_HOURS;
}

function timePanelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('work:clock:start')
      .setLabel('Start')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('work:clock:pause')
      .setLabel('Pause')
      .setEmoji('⏸️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('work:clock:stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('work:clock:end')
      .setLabel('Ende')
      .setEmoji('🏁')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('work:clock:correct')
      .setLabel('Start korrigieren')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
  );
}

// ---------------------------------------------------------------------------
// Start korrigieren: früher angefangen als Start gedrückt? Beginn vorverlegen, die Erfassung läuft weiter.
// ---------------------------------------------------------------------------

function correctStartModal(session: WorkSession | undefined): ModalBuilder {
  const before = (session?.pauses ?? []).filter((pause) => pause.beforeStart).reduce((sum, pause) => sum + intervalMinutes(pause), 0);
  const start = new TextInputBuilder()
    .setCustomId('start')
    .setLabel('Wann hast du heute angefangen? (HH:MM)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setPlaceholder('z. B. 07:23');
  if (session) start.setValue(parseIso(session.startAt).toFormat('HH:mm'));
  const pause = new TextInputBuilder()
    .setCustomId('pause')
    .setLabel('Pause bis zum Start-Klick? (Minuten)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(3)
    .setPlaceholder('leer = keine');
  if (before > 0) pause.setValue(String(before));
  return new ModalBuilder()
    .setCustomId('work:clock:correct-modal')
    .setTitle('Arbeitsbeginn korrigieren')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(start),
      new ActionRowBuilder<TextInputBuilder>().addComponents(pause)
    );
}

async function correctStartFromClock(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }
  const session = todaysSession(await loadState(), interaction.user.id);
  if (session?.endAt && !session.stopped) {
    await interaction.reply({
      content: 'ℹ️ Dein Arbeitstag ist schon beendet. Korrigieren kannst du ihn mit **/arbeitszeit nachtragen** (datum, start, ende).',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await interaction.showModal(correctStartModal(session));
}

async function correctStartSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const startRaw = interaction.fields.getTextInputValue('start').trim();
  const pauseRaw = interaction.fields.getTextInputValue('pause').trim();
  const now = nowBerlin();
  const start = DateTime.fromFormat(`${now.toFormat('dd.MM.yyyy')} ${startRaw}`, 'dd.MM.yyyy H:mm', { zone: config.timezone, locale: 'de' });
  const pause = pauseRaw ? Number(pauseRaw) : 0;

  if (!start.isValid || start > now) {
    await interaction.reply({ content: `❌ Bitte eine Uhrzeit von heute angeben, die nicht in der Zukunft liegt (z. B. \`07:23\`). Eingabe: ${startRaw}`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!Number.isInteger(pause) || pause < 0) {
    await interaction.reply({ content: `❌ Pause bitte als ganze Minuten angeben. Eingabe: ${pauseRaw}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  let session = todaysSession(state, interaction.user.id);
  const nowIso = now.toISO() ?? new Date().toISOString();
  const startIso = start.toISO() ?? start.toJSDate().toISOString();

  if (session?.endAt && !session.stopped) {
    await interaction.reply({ content: 'ℹ️ Dein Arbeitstag ist schon beendet. Nutze **/arbeitszeit nachtragen**.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Die Pause liegt direkt nach dem neuen Beginn und darf keine andere Pause und nicht die Gegenwart überschneiden.
  const others = (session?.pauses ?? []).filter((interval) => !interval.beforeStart);
  const firstOther = others.map((interval) => parseIso(interval.startAt)).sort((a, b) => a.toMillis() - b.toMillis())[0];
  const limit = firstOther && firstOther < now ? firstOther : now;
  if (start > limit || start.plus({ minutes: pause }) > limit) {
    await interaction.reply({
      content: `❌ Beginn plus Pause muss vor ${limit.toFormat('HH:mm')} Uhr liegen (deine erste erfasste Pause bzw. jetzt).`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!session) {
    session = { id: nextSessionId(state), userId: interaction.user.id, date: sessionDate(now), startAt: startIso, pauseMinutes: 0, pauses: [], provenance: 'clock', createdAt: nowIso, updatedAt: nowIso };
    state.sessions.push(session);
  }
  session.startAt = startIso;
  session.pauses = [
    ...(pause > 0 ? [{ startAt: startIso, endAt: start.plus({ minutes: pause }).toISO() ?? startIso, beforeStart: true }] : []),
    ...others
  ];
  recalculatePauseMinutes(session);
  session.updatedAt = nowIso;
  await saveState(state);

  await interaction.reply({
    content:
      `✏️ **Arbeitsbeginn korrigiert.** Die Zeiterfassung läuft ab hier weiter.\n\n${interimSummary(session, now)}` +
      (session.stopped ? '\n\n_Du bist gerade gestoppt. Mit **Start** geht es weiter._' : ''),
    flags: MessageFlags.Ephemeral
  });
}

function resumeRow(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`work:clock:resume:${sessionId}`)
      .setLabel('🟠 Weitermachen')
      .setStyle(ButtonStyle.Primary)
  );
}

async function findAnyOpenSession(userId: string): Promise<WorkSession | undefined> {
  const state = await loadState();
  return state.sessions
    .filter((session) => session.userId === userId && !session.endAt)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
}

async function startFromClock(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const currentOpen = state.sessions
    .filter((entry) => entry.userId === interaction.user.id && !entry.endAt)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];

  if (currentOpen) {
    const start = parseIso(currentOpen.startAt);
    const paused = Boolean(openPause(currentOpen));
    await interaction.reply({
      content:
        `ℹ️ **Bereits um ${start.toFormat('HH:mm')} Uhr angefangen.**` +
        (start.toISODate() !== nowBerlin().toISODate() ? `\nDiese Arbeitszeit gehört zum ${start.toFormat('dd.MM.yyyy')} und ist noch offen.` : '') +
        (paused ? '\nDu bist aktuell in Pause.' : ''),
      components: paused ? [resumeRow(currentOpen.id)] : [],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const now = nowBerlin();
  const todayKey = sessionDate(now);
  const completedToday = state.sessions.find(
    (entry) => entry.userId === interaction.user.id && entry.date === todayKey && Boolean(entry.endAt)
  );
  if (completedToday?.stopped && completedToday.endAt) {
    const stoppedAt = parseIso(completedToday.endAt);
    const resumedAt = now.toISO() ?? new Date().toISOString();
    completedToday.pauses ??= [];
    completedToday.pauses.push({ startAt: completedToday.endAt, endAt: resumedAt, kind: 'stop' });
    completedToday.endAt = undefined;
    completedToday.stopped = undefined;
    completedToday.updatedAt = resumedAt;
    await saveState(state);

    const gap = Math.max(0, Math.round(now.diff(stoppedAt, 'minutes').minutes));
    await interaction.reply({
      content:
        `▶️ **Weiter geht’s: ${now.toFormat('HH:mm')} Uhr.**\n` +
        `Die Unterbrechung seit ${stoppedAt.toFormat('HH:mm')} Uhr (${durationText(gap)}) zählt weder als Arbeit noch als Pause.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (completedToday) {
    await interaction.reply({
      content:
        `ℹ️ Dein Arbeitstag für heute wurde bereits um **${endTimeText(completedToday)} Uhr** beendet.\n` +
        'Wenn du später am Tag weitermachen willst, drück das nächste Mal **Stop** statt **Ende**. Für heute kannst du die Zeit mit **/arbeitszeit nachtragen** korrigieren.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const nowIso = now.toISO() ?? new Date().toISOString();
  const session: WorkSession = {
    id: nextSessionId(state),
    userId: interaction.user.id,
    date: todayKey,
    startAt: nowIso,
    pauseMinutes: 0,
    pauses: [],
    provenance: 'clock',
    createdAt: nowIso,
    updatedAt: nowIso
  };
  state.sessions.push(session);
  await saveState(state);

  await interaction.reply({
    content: `🟢 **Arbeitszeit gestartet: ${now.toFormat('HH:mm')} Uhr.**`,
    flags: MessageFlags.Ephemeral
  });
}

async function pauseFromClock(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const session = state.sessions
    .filter((entry) => entry.userId === interaction.user.id && !entry.endAt)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];

  if (!session) {
    const today = todaysSession(state, interaction.user.id);
    await interaction.reply({
      content:
        today?.stopped && today.endAt
          ? `ℹ️ Du hast um **${parseIso(today.endAt).toFormat('HH:mm')} Uhr** gestoppt. Mit **Start** geht’s weiter.`
          : 'ℹ️ Du hast aktuell keine laufende Arbeitszeit. Erst **Start** drücken. 🙂',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const activePause = openPause(session);
  if (activePause) {
    await interaction.reply({
      content:
        `⏸️ Du bist bereits seit **${parseIso(activePause.startAt).toFormat('HH:mm')} Uhr** in Pause.\n\n` +
        interimSummary(session, parseIso(activePause.startAt)),
      components: [resumeRow(session.id)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const now = nowBerlin();
  session.pauses ??= [];
  session.pauses.push({ startAt: now.toISO() ?? new Date().toISOString() });
  session.updatedAt = now.toISO() ?? new Date().toISOString();
  await saveState(state);

  await interaction.reply({
    content:
      `⏸️ **Pause gestartet: ${now.toFormat('HH:mm')} Uhr.**\n\n${interimSummary(session, now)}\n\n` +
      'Wenn du wieder da bist, drück **Weitermachen**.',
    components: [resumeRow(session.id)],
    flags: MessageFlags.Ephemeral
  });
}

async function resumeFromClock(interaction: ButtonInteraction, sessionId: string): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Keine Berechtigung.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const session = state.sessions.find((entry) => entry.id === sessionId && entry.userId === interaction.user.id && !entry.endAt);
  if (!session) {
    await interaction.reply({ content: 'ℹ️ Diese Arbeitszeit ist nicht mehr offen.', flags: MessageFlags.Ephemeral });
    return;
  }

  const activePause = openPause(session);
  if (!activePause) {
    await interaction.reply({ content: 'ℹ️ Du arbeitest bereits wieder.', flags: MessageFlags.Ephemeral });
    return;
  }

  const now = nowBerlin();
  activePause.endAt = now.toISO() ?? new Date().toISOString();
  recalculatePauseMinutes(session);
  session.updatedAt = activePause.endAt;
  await saveState(state);

  await interaction.update({
    content: `🟠 **Weiter geht’s seit ${now.toFormat('HH:mm')} Uhr.**\nBisherige Pause: ${durationText(session.pauseMinutes)}.`,
    components: []
  });
}

async function stopFromClock(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const session = state.sessions
    .filter((entry) => entry.userId === interaction.user.id && !entry.endAt)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];

  if (!session) {
    const today = todaysSession(state, interaction.user.id);
    let content = 'ℹ️ Du hast aktuell keine laufende Arbeitszeit. Erst **Start** drücken. 🙂';
    if (today?.stopped && today.endAt) {
      content = `⏹️ Du hast bereits um **${parseIso(today.endAt).toFormat('HH:mm')} Uhr** gestoppt. Mit **Start** geht’s weiter.`;
    } else if (today?.endAt) {
      content = `ℹ️ Dein Arbeitstag für heute wurde bereits um **${endTimeText(today)} Uhr** beendet.`;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  const start = parseIso(session.startAt);
  const now = nowBerlin();
  if (forgottenEnd(start, now)) {
    await interaction.reply({
      content:
        `⚠️ Deine offene Arbeitszeit läuft seit **${start.toFormat('dd.MM.yyyy')} um ${start.toFormat('HH:mm')} Uhr**, also über ${MAX_LIVE_HOURS} Stunden. ` +
        'Wahrscheinlich wurde **Ende** vergessen. Trage das tatsächliche Ende bitte mit **/arbeitszeit nachtragen** ein (nur datum und ende).',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Läuft gerade eine Pause, endete die Arbeit schon mit ihrem Beginn. Die Pause wird dann nicht gezählt.
  const activePause = openPause(session);
  const stoppedAt = activePause ? parseIso(activePause.startAt) : now;
  if (activePause) session.pauses = session.pauses?.filter((interval) => interval !== activePause);
  session.endAt = stoppedAt.toISO() ?? new Date().toISOString();
  session.stopped = true;
  session.updatedAt = now.toISO() ?? new Date().toISOString();
  recalculatePauseMinutes(session);
  await saveState(state);

  const net = durationMinutes(session) ?? 0;
  await interaction.reply({
    content:
      `⏹️ **Gestoppt: ${stoppedAt.toFormat('HH:mm')} Uhr.** Bisher heute: **${durationText(net)}**.\n` +
      (activePause ? `Deine Pause ab ${stoppedAt.toFormat('HH:mm')} Uhr zählt nicht mit, die Arbeit endete dort.\n` : '') +
      'Wenn du später weitermachst, drück einfach **Start**. Die Zeit dazwischen zählt weder als Arbeit noch als Pause. ' +
      'Machst du heute nicht mehr weiter, musst du nichts mehr drücken.',
    flags: MessageFlags.Ephemeral
  });
}

// ---------------------------------------------------------------------------
// Nachtabschaltung: Um 22:50 fragt der Bot alle, deren Arbeitszeit noch läuft, ob sie weiterarbeiten.
// Die Antworten landen in data/night-shutdown.json; scripts/night-shutdown.sh liest sie jede Minute und
// fährt den Server herunter, sobald niemand mehr arbeitet (Details in scripts/night-shutdown-check.mjs).
// ---------------------------------------------------------------------------

type NightState = { askedAt: string; waiting: string[]; staying: string[]; declined: string[] };

const nightPath = process.env.NIGHT_SHUTDOWN_FILE || path.join(process.cwd(), 'data', 'night-shutdown.json');
const NIGHT_ANSWER_MINUTES = 10;

function readNight(): NightState | undefined {
  if (!existsSync(nightPath)) return undefined;
  try {
    return JSON.parse(readFileSync(nightPath, 'utf8')) as NightState;
  } catch {
    return undefined;
  }
}

async function writeNight(night: NightState): Promise<void> {
  await fs.mkdir(path.dirname(nightPath), { recursive: true });
  await fs.writeFile(`${nightPath}.tmp`, `${JSON.stringify(night, null, 2)}\n`, 'utf8');
  await fs.rename(`${nightPath}.tmp`, nightPath);
}

function nightRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('work:night:yes').setLabel('Ja, ich arbeite noch').setEmoji('🌙').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('work:night:no').setLabel('Nein, Feierabend').setEmoji('🛌').setStyle(ButtonStyle.Secondary)
  );
}

async function askNightShutdown(client: Client): Promise<void> {
  const now = nowBerlin();
  const state = await loadState();
  const working = [
    ...new Set(state.sessions.filter((entry) => !entry.endAt && !forgottenEnd(parseIso(entry.startAt), now)).map((entry) => entry.userId))
  ];
  await writeNight({ askedAt: now.toISO() ?? new Date().toISOString(), waiting: working, staying: [], declined: [] });
  if (working.length === 0) return;

  const raw = await client.channels.fetch(config.timeTrackingChannelId);
  if (!(raw instanceof TextChannel)) return;
  await raw.send({
    content:
      `🌙 ${working.map((id) => `<@${id}>`).join(' ')} deine Arbeitszeit läuft noch. **Arbeitest du noch?**\n` +
      `Ohne Antwort in ${NIGHT_ANSWER_MINUTES} Minuten fährt der Server um 23:00 Uhr herunter (er startet um 08:00 Uhr wieder). ` +
      'Mit **Nein** wird deine Arbeitszeit jetzt beendet.',
    components: [nightRow()],
    allowedMentions: { users: working }
  });
}

async function answerNightShutdown(interaction: ButtonInteraction, stays: boolean): Promise<void> {
  const night = readNight();
  const id = interaction.user.id;
  if (!night || ![...night.waiting, ...night.staying].includes(id)) {
    await interaction.reply({ content: 'ℹ️ Diese Frage gilt nicht (mehr) für dich.', flags: MessageFlags.Ephemeral });
    return;
  }
  night.waiting = night.waiting.filter((entry) => entry !== id);
  night.staying = night.staying.filter((entry) => entry !== id);
  if (stays) night.staying.push(id);
  else night.declined.push(id);
  await writeNight(night);

  if (stays) {
    await interaction.reply({
      content: '🌙 Alles klar. Der Server bleibt an, bis du **Ende** oder **Stop** drückst (spätestens bis 04:00 Uhr).',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  // Nein: Arbeitstag wie mit dem Ende-Button abschließen.
  await endOpenSession(interaction);
}

async function endOpenSession(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const session = state.sessions
    .filter((entry) => entry.userId === interaction.user.id && !entry.endAt)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];

  if (!session) {
    const today = todaysSession(state, interaction.user.id);
    if (today?.stopped && today.endAt) {
      today.stopped = undefined;
      today.updatedAt = nowBerlin().toISO() ?? new Date().toISOString();
      await saveState(state);
      const net = durationMinutes(today) ?? 0;
      await interaction.reply({
        content:
          `🔴 **Arbeitstag abgeschlossen.** Ende war dein Stop um ${parseIso(today.endAt).toFormat('HH:mm')} Uhr.\n` +
          `${timeRangeText(today)} Uhr · Pause ${durationText(today.pauseMinutes)} · **${durationText(net)} Arbeitszeit**`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.reply({
      content: 'ℹ️ Für dich läuft aktuell keine Arbeitszeit. Falls ein vergangener Tag offen ist, nutze **/arbeitszeit nachtragen**.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const start = parseIso(session.startAt);
  const now = nowBerlin();
  if (forgottenEnd(start, now)) {
    await interaction.reply({
      content:
        `⚠️ Deine offene Arbeitszeit läuft seit **${start.toFormat('dd.MM.yyyy')} um ${start.toFormat('HH:mm')} Uhr**, also über ${MAX_LIVE_HOURS} Stunden. ` +
        'Wahrscheinlich wurde **Ende** vergessen. Trage das tatsächliche Ende bitte mit **/arbeitszeit nachtragen** ein (nur datum und ende).',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const activePause = openPause(session);
  if (activePause) activePause.endAt = now.toISO() ?? new Date().toISOString();
  recalculatePauseMinutes(session);
  session.endAt = now.toISO() ?? new Date().toISOString();
  session.updatedAt = session.endAt;
  await saveState(state);

  const net = durationMinutes(session) ?? 0;
  await interaction.reply({
    content:
      `🔴 **Arbeitstag beendet: ${now.toFormat('HH:mm')} Uhr.**\n` +
      `${timeRangeText(session)} Uhr · Pause ${durationText(session.pauseMinutes)} · **${durationText(net)} Arbeitszeit**`,
    flags: MessageFlags.Ephemeral
  });
}

async function backfill(interaction: ChatInputCommandInteraction): Promise<void> {
  const dateRaw = interaction.options.getString('datum', true).trim();
  const startRaw = interaction.options.getString('start')?.trim();
  const endRaw = interaction.options.getString('ende', true).trim();
  const pauseInput = interaction.options.getInteger('pause');
  const quality = interaction.options.getString('qualität') ?? 'genau';

  // Nur das Ende angegeben: Start, Pausen und Stops des erfassten Tages bleiben, wie sie sind.
  const day = DateTime.fromFormat(dateRaw, 'dd.MM.yyyy', { zone: config.timezone, locale: 'de' });
  const state = await loadState();
  let session = day.isValid ? state.sessions.find((entry) => entry.userId === interaction.user.id && entry.date === sessionDate(day)) : undefined;
  if (!startRaw && !session) {
    await interaction.reply({
      content: '❌ Für diesen Tag ist noch kein Start erfasst. Bitte gib zusätzlich **start** an.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const start = startRaw
    ? DateTime.fromFormat(`${dateRaw} ${startRaw}`, 'dd.MM.yyyy HH:mm', { zone: config.timezone, locale: 'de' })
    : parseIso(session!.startAt);
  let end = DateTime.fromFormat(`${dateRaw} ${endRaw}`, 'dd.MM.yyyy HH:mm', {
    zone: config.timezone,
    locale: 'de'
  });

  if (!start.isValid || !end.isValid) {
    await interaction.reply({
      content: '❌ Datum bitte als **TT.MM.JJJJ**, Zeiten als **HH:MM** angeben.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (end <= start) end = end.plus({ days: 1 });

  // Unterbrechung wie mit Stop/Start: zwei Arbeitsblöcke, die Lücke zählt weder als Arbeit noch als Pause.
  const gapFromRaw = interaction.options.getString('unterbrechung_von')?.trim();
  const gapToRaw = interaction.options.getString('unterbrechung_bis')?.trim();
  let gap: { from: DateTime; to: DateTime } | undefined;
  if (gapFromRaw || gapToRaw) {
    const at = (raw: string | undefined): DateTime => {
      const time = DateTime.fromFormat(`${dateRaw} ${raw ?? ''}`, 'dd.MM.yyyy HH:mm', { zone: config.timezone, locale: 'de' });
      return time.isValid && time < start ? time.plus({ days: 1 }) : time;
    };
    const from = at(gapFromRaw);
    let to = at(gapToRaw);
    if (to.isValid && from.isValid && to <= from) to = to.plus({ days: 1 });
    if (!gapFromRaw || !gapToRaw || !from.isValid || !to.isValid || from <= start || to >= end) {
      await interaction.reply({
        content: '❌ Für eine Unterbrechung bitte **unterbrechung_von** und **unterbrechung_bis** als HH:MM angeben, beide zwischen Start und Ende.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    gap = { from, to };
  }
  const keepPauses = !gap && pauseInput === null && Boolean(session?.pauses?.length);

  const now = nowBerlin();
  if (start > now || end > now.plus({ minutes: 2 })) {
    await interaction.reply({ content: '❌ Arbeitszeit kann nicht in der Zukunft liegen.', flags: MessageFlags.Ephemeral });
    return;
  }

  const gross = Math.round(end.diff(start, 'minutes').minutes);
  if (gross <= 0 || gross > 36 * 60) {
    await interaction.reply({ content: '❌ Der Zeitraum muss zwischen 1 Minute und 36 Stunden liegen.', flags: MessageFlags.Ephemeral });
    return;
  }
  const activePause = session && keepPauses ? openPause(session) : undefined;
  const pause = gap
    ? (pauseInput ?? 0)
    : pauseInput ?? (session && keepPauses ? recordedPauseMinutes(session, end) : pauseInput === null && session ? Math.max(0, session.pauseMinutes ?? 0) : 0);
  const gapMinutes = gap ? Math.round(gap.to.diff(gap.from, 'minutes').minutes) : 0;
  if (pause < 0 || pause >= gross - gapMinutes) {
    await interaction.reply({ content: '❌ Die Pausenzeit ist für diesen Zeitraum ungültig.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Mit Unterbrechung werden Pause und Lücke als Intervalle gespeichert; die Pause liegt im ersten Block, der sie fasst.
  let gapIntervals: PauseInterval[] | undefined;
  if (gap) {
    const iso = (time: DateTime): string => time.toISO() ?? time.toJSDate().toISOString();
    const pauseStart = start.plus({ minutes: pause }) <= gap.from ? start : gap.to;
    if (pauseStart.plus({ minutes: pause }) > (pauseStart === start ? gap.from : end)) {
      await interaction.reply({ content: '❌ Die Pause ist länger als jeder der beiden Arbeitsblöcke.', flags: MessageFlags.Ephemeral });
      return;
    }
    gapIntervals = [
      ...(pause > 0 ? [{ startAt: iso(pauseStart), endAt: iso(pauseStart.plus({ minutes: pause })) }] : []),
      { startAt: iso(gap.from), endAt: iso(gap.to), kind: 'stop' as const }
    ];
  }

  const date = sessionDate(start);
  if (session && session.date !== date) session = undefined;
  const nowIso = now.toISO() ?? new Date().toISOString();
  const provenance: SessionProvenance = quality === 'geschätzt' ? 'manual-estimated' : 'manual-exact';

  if (!session) {
    session = {
      id: nextSessionId(state),
      userId: interaction.user.id,
      date,
      startAt: start.toISO() ?? start.toJSDate().toISOString(),
      endAt: end.toISO() ?? end.toJSDate().toISOString(),
      pauseMinutes: pause,
      pauses: gapIntervals,
      provenance,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    state.sessions.push(session);
  } else {
    session.startAt = start.toISO() ?? start.toJSDate().toISOString();
    session.endAt = end.toISO() ?? end.toJSDate().toISOString();
    if (keepPauses) {
      // Eine noch offene Pause endet mit dem nachgetragenen Ende.
      if (activePause) activePause.endAt = session.endAt;
      recalculatePauseMinutes(session);
    } else {
      session.pauseMinutes = pause;
      session.pauses = gapIntervals;
    }
    session.stopped = undefined;
    if (startRaw) session.provenance = provenance;
    session.updatedAt = nowIso;
    session.endReminderSentAt = undefined;
  }

  await saveState(state);
  const net = durationMinutes(session) ?? 0;
  const overnight = end.toISODate() !== start.toISODate();
  await interaction.reply({
    content:
      `✅ Arbeitszeit für **${dateRaw}** gespeichert: ` +
      (gap
        ? `${start.toFormat('HH:mm')}–${gap.from.toFormat('HH:mm')} und ${gap.to.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`
        : `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`) +
      `${overnight ? ' Uhr (Ende am Folgetag)' : ' Uhr'} · ` +
      `Pause ${pause} min · **${durationText(net)}**` +
      (provenance === 'manual-estimated' ? '\n_Diese Zeit ist ausdrücklich als geschätzt gekennzeichnet._' : ''),
    flags: MessageFlags.Ephemeral
  });
}

const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

async function weekOverview(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = await loadState();
  const now = nowBerlin();
  const lastWeek = interaction.options.getString('zeitraum') === 'letzte';
  const weekStart = now.startOf('week').minus({ weeks: lastWeek ? 1 : 0 });
  const own = state.sessions.filter((session) => session.userId === interaction.user.id);

  const lines: string[] = [];
  let total = 0;
  let hasOpen = false;
  for (let offset = 0; offset < 7; offset++) {
    const day = weekStart.plus({ days: offset });
    const label = `**${WEEKDAY_SHORT[offset]} ${day.toFormat('dd.MM.')}**`;
    const session = own.find((entry) => entry.date === sessionDate(day));
    if (!session) {
      // Wochenende nur anzeigen, wenn dort gearbeitet wurde.
      if (offset < 5) lines.push(`${label} · –`);
      continue;
    }

    const net = durationMinutes(session);
    if (net === undefined) {
      hasOpen = true;
      const openStatus = day.hasSame(now, 'day')
        ? openPause(session) ? 'Pause läuft' : 'läuft'
        : 'Ende fehlt · bitte mit /arbeitszeit nachtragen eintragen';
      lines.push(`${label} · ${timeRangeText(session)} · ${openStatus}`);
      continue;
    }

    total += net;
    const stoppedToday = session.stopped && day.hasSame(now, 'day') ? ' · gestoppt, mit Start geht’s weiter' : '';
    lines.push(
      `${label} · ${timeRangeText(session)} · Pause ${durationText(session.pauseMinutes)} · **${durationText(net)}**${stoppedToday}`
    );
  }

  const weekEnd = weekStart.plus({ days: 6 });
  await interaction.reply({
    content:
      `## Deine Arbeitszeiten · KW ${weekStart.weekNumber} (${weekStart.toFormat('dd.MM.')}–${weekEnd.toFormat('dd.MM.yyyy')})\n` +
      `${lines.join('\n')}\n\n**Summe: ${durationText(total)}** netto` +
      (hasOpen ? '\n-# Tage ohne Ende zählen erst mit, wenn das Ende eingetragen ist.' : ''),
    flags: MessageFlags.Ephemeral
  });
}

async function ensureTimePanel(client: Client): Promise<void> {
  const raw = await client.channels.fetch(config.timeTrackingChannelId);
  if (!(raw instanceof TextChannel)) {
    console.error(`[Arbeitszeit] Zeiterfassungs-Channel ${config.timeTrackingChannelId} ist kein Text-Channel.`);
    return;
  }

  const recent = await raw.messages.fetch({ limit: 50 });
  const botMessages = recent.filter(
    (message) => message.author.id === client.user?.id && message.content.startsWith(TIME_PANEL_MARKER)
  );
  const existing = botMessages.first();
  const content =
    `${TIME_PANEL_MARKER}\n\n` +
    `**Start** · Arbeitszeit beginnen oder nach einem Stop weitermachen\n` +
    `**Pause** · kurze Unterbrechung, zählt als Pause\n` +
    `**Stop** · aufhören und später am Tag weitermachen, die Zeit dazwischen zählt nicht\n` +
    `**Ende** · Arbeitstag abschließen\n` +
    `**Start korrigieren** · früher angefangen, als du Start gedrückt hast? Beginn und Pause davor eintragen, die Erfassung läuft weiter\n\n` +
    `_Alle Klicks werden nur dir privat bestätigt. Der Channel selbst bleibt sauber._`;

  if (existing) {
    await existing.edit({ content, components: [timePanelRow()] });
  } else {
    await raw.send({ content, components: [timePanelRow()] });
  }

  for (const duplicate of botMessages.values()) {
    if (duplicate.id !== existing?.id) await duplicate.delete().catch(() => undefined);
  }
}

async function remindMissingEnds(client: Client): Promise<void> {
  const state = await loadState();
  const today = nowBerlin().startOf('day');
  const todayKey = sessionDate(today);
  const stale = state.sessions.filter((session) => {
    if (session.endAt) return false;
    const start = parseIso(session.startAt);
    return start.isValid && start.startOf('day') < today && session.endReminderSentAt !== todayKey;
  });
  if (stale.length === 0) return;

  const raw = await client.channels.fetch(config.scrumChannelId);
  if (!(raw instanceof TextChannel)) {
    console.error('[Arbeitszeit] Scrum-Status-Channel für fehlende Endzeiten nicht erreichbar.');
    return;
  }

  for (const session of stale) {
    const start = parseIso(session.startAt);
    await raw.send({
      content:
        `⏰ <@${session.userId}> **für deine Arbeitszeit vom ${start.toFormat('dd.MM.yyyy')} fehlt noch das Ende.**\n` +
        `Start war um **${start.toFormat('HH:mm')} Uhr**. Bitte trage mit **/arbeitszeit nachtragen** nur **datum** und **ende** nach, ` +
        `Start und Pausen bleiben dann wie erfasst. Hast du nach Mitternacht aufgehört, gib z. B. Ende \`01:15\` an, das gilt dann als Folgetag.`,
      allowedMentions: { users: [session.userId] }
    });
    session.endReminderSentAt = todayKey;
    session.updatedAt = nowBerlin().toISO() ?? new Date().toISOString();
  }

  await saveState(state);
}

export const workTrackingCommands = [
  new SlashCommandBuilder()
    .setName('arbeitszeit')
    .setDescription('Arbeitszeiten anzeigen oder nachtragen')
    .addSubcommand((sub) =>
      sub
        .setName('woche')
        .setDescription('Zeigt deine Arbeitszeiten der Woche mit Pausen und Summe')
        .addStringOption((option) =>
          option
            .setName('zeitraum')
            .setDescription('Welche Woche?')
            .addChoices({ name: 'Diese Woche', value: 'aktuell' }, { name: 'Letzte Woche', value: 'letzte' })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('nachtragen')
        .setDescription('Trägt ein fehlendes Ende oder eine ganze Arbeitszeit nach, auch über Mitternacht')
        .addStringOption((option) => option.setName('datum').setDescription('Startdatum TT.MM.JJJJ').setRequired(true).setMaxLength(10))
        .addStringOption((option) => option.setName('ende').setDescription('Ende HH:MM; kleinere Uhrzeit = Folgetag').setRequired(true).setMaxLength(5))
        .addStringOption((option) =>
          option.setName('start').setDescription('Nur nötig, wenn für den Tag noch kein Start erfasst ist oder er falsch ist').setMaxLength(5)
        )
        .addIntegerOption((option) =>
          option.setName('pause').setDescription('Leer lassen = erfasste Pausen bleiben. Sonst: gesamte Pause in Minuten').setMinValue(0).setMaxValue(720)
        )
        .addStringOption((option) =>
          option.setName('unterbrechung_von').setDescription('Wie Stop: Arbeit unterbrochen ab HH:MM (zählt weder als Arbeit noch Pause)').setMaxLength(5)
        )
        .addStringOption((option) =>
          option.setName('unterbrechung_bis').setDescription('Wie Start nach Stop: weitergearbeitet ab HH:MM').setMaxLength(5)
        )
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
        const net = durationMinutes(session) ?? 0;
        total += net;
        out.push(
          `- **${label}:** ${timeRangeText(session)} Uhr · Pause ${session.pauseMinutes} min · ${durationText(net)}${provenanceText(session)}`
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
    if (!session?.endAt) missing.push(`${member.name}: Arbeitszeit noch nicht beendet`);
  }

  return { ready: missing.length === 0, missing };
}

export function installWorkTracking(client: Client): void {
  if (installed) return;
  installed = true;

  client.once(Events.ClientReady, () => {
    void ensureTimePanel(client).catch((error) => console.error('[Arbeitszeit] Zeiterfassungs-Panel konnte nicht veröffentlicht werden.', error));
    void remindMissingEnds(client).catch((error) => console.error('[Arbeitszeit] Fehlende Endzeiten konnten nicht geprüft werden.', error));
    cron.schedule(
      process.env.NIGHT_ASK_CRON || '50 22 * * *',
      () => void askNightShutdown(client).catch((error) => console.error('[Arbeitszeit] Nachtabfrage fehlgeschlagen.', error)),
      { timezone: config.timezone }
    );
    cron.schedule(
      config.cron.workEndReminder,
      () => void remindMissingEnds(client).catch((error) => console.error('[Arbeitszeit] Fehlende Endzeiten konnten nicht geprüft werden.', error)),
      { timezone: config.timezone }
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'arbeitszeit') {
        if (!isTeamMember(interaction.user.id)) {
          await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
          return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'woche') await weekOverview(interaction);
        if (sub === 'nachtragen') await backfill(interaction);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'work:clock:start') {
        await startFromClock(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId === 'work:clock:pause') {
        await pauseFromClock(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId === 'work:clock:stop') {
        await stopFromClock(interaction);
        return;
      }
      if (interaction.isButton() && (interaction.customId === 'work:night:yes' || interaction.customId === 'work:night:no')) {
        await answerNightShutdown(interaction, interaction.customId === 'work:night:yes');
        return;
      }
      if (interaction.isButton() && interaction.customId === 'work:clock:correct') {
        await correctStartFromClock(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === 'work:clock:correct-modal') {
        if (!isTeamMember(interaction.user.id)) return;
        await correctStartSubmit(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId === 'work:clock:end') {
        await endOpenSession(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith('work:clock:resume:')) {
        await resumeFromClock(interaction, interaction.customId.slice('work:clock:resume:'.length));
      }
    })().catch((error) => console.error('[Arbeitszeit] Interaction-Fehler', error));
  });
}
