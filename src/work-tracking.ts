import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  TextChannel
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
      .setStyle(ButtonStyle.Danger)
  );
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
  if (start.toISODate() !== now.toISODate()) {
    await interaction.reply({
      content:
        `⚠️ Deine offene Arbeitszeit stammt vom **${start.toFormat('dd.MM.yyyy')} um ${start.toFormat('HH:mm')} Uhr**. ` +
        'Damit wir nicht versehentlich die ganze Nacht als Arbeitszeit zählen, trage das tatsächliche Ende bitte mit **/arbeitszeit nachtragen** ein.',
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
  if (start.toISODate() !== now.toISODate()) {
    await interaction.reply({
      content:
        `⚠️ Deine offene Arbeitszeit stammt vom **${start.toFormat('dd.MM.yyyy')} um ${start.toFormat('HH:mm')} Uhr**. ` +
        'Damit wir nicht versehentlich die ganze Nacht als Arbeitszeit zählen, trage das tatsächliche Ende bitte mit **/arbeitszeit nachtragen** ein.',
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
  const startRaw = interaction.options.getString('start', true).trim();
  const endRaw = interaction.options.getString('ende', true).trim();
  const pause = interaction.options.getInteger('pause') ?? 0;
  const quality = interaction.options.getString('qualität') ?? 'genau';

  const start = DateTime.fromFormat(`${dateRaw} ${startRaw}`, 'dd.MM.yyyy HH:mm', {
    zone: config.timezone,
    locale: 'de'
  });
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
  if (pause < 0 || pause >= gross) {
    await interaction.reply({ content: '❌ Die Pausenzeit ist für diesen Zeitraum ungültig.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const date = sessionDate(start);
  let session = state.sessions.find((entry) => entry.userId === interaction.user.id && entry.date === date);
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
      pauses: undefined,
      provenance,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    state.sessions.push(session);
  } else {
    session.startAt = start.toISO() ?? start.toJSDate().toISOString();
    session.endAt = end.toISO() ?? end.toJSDate().toISOString();
    session.pauseMinutes = pause;
    session.pauses = undefined;
    session.stopped = undefined;
    session.provenance = provenance;
    session.updatedAt = nowIso;
    session.endReminderSentAt = undefined;
  }

  await saveState(state);
  const net = durationMinutes(session) ?? 0;
  const overnight = end.toISODate() !== start.toISODate();
  await interaction.reply({
    content:
      `✅ Arbeitszeit für **${dateRaw}** gespeichert: ${startRaw}–${endRaw}${overnight ? ' Uhr am Folgetag' : ' Uhr'} · ` +
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
    `**Ende** · Arbeitstag abschließen\n\n` +
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
        `Start war um **${start.toFormat('HH:mm')} Uhr**. Bitte trage das tatsächliche Ende mit **/arbeitszeit nachtragen** nach. ` +
        `Wenn du nach Mitternacht aufgehört hast, gib einfach z. B. Start \`20:00\` und Ende \`01:15\` an. Der Bot versteht das Ende dann als Folgetag.`,
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
        .setDescription('Trägt eine vergangene Arbeitszeit nach, auch über Mitternacht')
        .addStringOption((option) => option.setName('datum').setDescription('Startdatum TT.MM.JJJJ').setRequired(true).setMaxLength(10))
        .addStringOption((option) => option.setName('start').setDescription('Start HH:MM').setRequired(true).setMaxLength(5))
        .addStringOption((option) => option.setName('ende').setDescription('Ende HH:MM; kleinere Uhrzeit = Folgetag').setRequired(true).setMaxLength(5))
        .addIntegerOption((option) => option.setName('pause').setDescription('Gesamte Pause in Minuten').setMinValue(0).setMaxValue(720))
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
