import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  InteractionReplyOptions,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
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
  // Ältere Einträge: Pause vor dem Start-Klick (früherer Button „Start korrigieren“). Zählt wie jede Pause.
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
      .setLabel('Arbeitszeiten korrigieren')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
  );
}

// ---------------------------------------------------------------------------
// Aufgeräumte Bestätigungen: Jede Panel-Antwort ersetzt die vorherige der Person. Eine Antwort mit Button
// (Weitermachen) bleibt stehen, solange der Button noch gilt. Discord erlaubt das Löschen privater Antworten
// nur 15 Minuten lang; ältere verschwinden beim nächsten Neuladen von Discord von selbst.
// ---------------------------------------------------------------------------

type PanelInteraction = ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction;
const lastPanelReply = new Map<string, { interaction: PanelInteraction; hasButton: boolean }>();

async function stillPaused(userId: string): Promise<boolean> {
  const state = await loadState();
  return state.sessions.some((entry) => entry.userId === userId && !entry.endAt && Boolean(openPause(entry)));
}

async function rememberPanelReply(interaction: PanelInteraction, hasButton: boolean): Promise<void> {
  const previous = lastPanelReply.get(interaction.user.id);
  lastPanelReply.set(interaction.user.id, { interaction, hasButton });
  if (!previous || previous.interaction === interaction) return;
  // Den Weitermachen-Button nur wegräumen, wenn die neue Antwort ihn ersetzt oder die Pause vorbei ist.
  if (previous.hasButton && !hasButton && (await stillPaused(interaction.user.id))) {
    lastPanelReply.set(interaction.user.id, previous);
    return;
  }
  await previous.interaction.deleteReply().catch(() => undefined);
}

async function panelReply(interaction: PanelInteraction, options: InteractionReplyOptions): Promise<void> {
  await interaction.reply(options);
  await rememberPanelReply(interaction, Boolean(options.components?.length));
}

// ---------------------------------------------------------------------------
// Arbeitszeiten korrigieren: Tag auswählen, dann im Formular Zeit, Pause, Unterbrechungen (wie Stop) und
// Genauigkeit ändern. Gilt für jeden erfassten Tag und für Tage, die noch fehlen. Ein laufender Tag bleibt
// offen, wenn das Ende leer bleibt (z. B. früher angefangen, als Start gedrückt wurde).
// ---------------------------------------------------------------------------

const FIX_NEW = 'neu';
const TIME = /^(\d{1,2}:\d{2})$/;

function hhmm(time: DateTime): string {
  return time.toFormat('HH:mm');
}

function closedPauses(session: WorkSession): PauseInterval[] {
  return (session.pauses ?? []).filter((pause) => pause.kind !== 'stop' && pause.endAt);
}

function stopGaps(session: WorkSession): PauseInterval[] {
  return (session.pauses ?? []).filter((pause) => pause.kind === 'stop' && pause.endAt).sort((a, b) => a.startAt.localeCompare(b.startAt));
}

function sessionLabel(session: WorkSession): string {
  const day = parseIso(session.startAt);
  const net = durationMinutes(session);
  const weekday = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][day.weekday - 1];
  return `${weekday} ${day.toFormat('dd.MM.')} · ${timeRangeText(session)} · ${net === undefined ? 'läuft' : durationText(net)}`.slice(0, 100);
}

function fixPickerRow(state: WorkState, userId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const own = state.sessions
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))
    .slice(0, 24);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('work:fix:pick')
      .setPlaceholder('Welchen Tag möchtest du korrigieren?')
      .addOptions([
        { label: 'Tag nachtragen, der noch nicht erfasst ist', value: FIX_NEW, emoji: '➕' },
        ...own.map((entry) => ({ label: sessionLabel(entry), value: entry.id }))
      ])
  );
}

function fixModal(session: WorkSession | undefined): ModalBuilder {
  const field = (id: string, label: string, required: boolean, value: string | undefined, placeholder: string, maxLength: number) => {
    const input = new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(required)
      .setMaxLength(maxLength)
      .setPlaceholder(placeholder);
    if (value) input.setValue(value);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  };
  const start = session ? parseIso(session.startAt) : undefined;
  const end = session?.endAt ? parseIso(session.endAt) : undefined;
  const pause = session ? closedPauses(session).reduce((sum, interval) => sum + intervalMinutes(interval), 0) : undefined;
  const gaps = session ? stopGaps(session).map((gap) => `${hhmm(parseIso(gap.startAt))}-${hhmm(parseIso(gap.endAt as string))}`).join(', ') : '';

  const rows = [
    ...(session ? [] : [field('date', 'Datum (Tag, an dem du angefangen hast)', true, undefined, 'TT.MM.JJJJ', 10)]),
    field('time', 'Arbeitszeit von-bis', true, start ? `${hhmm(start)}-${end ? hhmm(end) : ''}` : undefined, '09:24-17:30 · Ende leer = läuft noch', 11),
    field('pause', 'Pause gesamt in Minuten', false, pause !== undefined ? String(pause) : undefined, 'leer = 0', 3),
    field('gaps', 'Unterbrechungen wie Stop (optional)', false, gaps || undefined, '12:03-19:17, 20:00-20:30', 100),
    field('quality', 'Genau oder geschätzt?', true, session?.provenance === 'manual-estimated' ? 'geschätzt' : 'genau', 'genau / geschätzt', 9)
  ];
  return new ModalBuilder()
    .setCustomId(`work:fix:save:${session?.id ?? FIX_NEW}`)
    .setTitle(start ? `Arbeitszeit ${start.toFormat('dd.MM.yyyy')} korrigieren` : 'Arbeitstag nachtragen')
    .addComponents(...rows);
}

async function fixStart(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await interaction.reply({ content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }
  await panelReply(interaction, {
    content: '### ✏️ Arbeitszeiten korrigieren\nWähle den Tag. Danach kannst du Zeit, Pause, Unterbrechungen und Genauigkeit ändern.',
    components: [fixPickerRow(await loadState(), interaction.user.id)],
    flags: MessageFlags.Ephemeral
  });
}

async function fixPick(interaction: StringSelectMenuInteraction): Promise<void> {
  const choice = interaction.values[0];
  if (choice === FIX_NEW) {
    await interaction.showModal(fixModal(undefined));
    return;
  }
  const session = (await loadState()).sessions.find((entry) => entry.id === choice && entry.userId === interaction.user.id);
  if (!session) {
    await interaction.update({ content: '❌ Diesen Tag gibt es nicht mehr. Bitte neu auswählen.', components: [fixPickerRow(await loadState(), interaction.user.id)] });
    return;
  }
  await interaction.showModal(fixModal(session));
}

/** Verteilt die Pause auf die Arbeitsblöcke, vorne beginnend. */
function placePause(blocks: { start: DateTime; end: DateTime }[], minutes: number): PauseInterval[] {
  const result: PauseInterval[] = [];
  let rest = minutes;
  for (const block of blocks) {
    if (rest <= 0) break;
    const take = Math.min(rest, Math.floor(block.end.diff(block.start, 'minutes').minutes));
    if (take <= 0) continue;
    result.push({ startAt: block.start.toISO() as string, endAt: block.start.plus({ minutes: take }).toISO() as string });
    rest -= take;
  }
  return result;
}

async function fixSave(interaction: ModalSubmitInteraction, target: string): Promise<void> {
  const field = (id: string): string => {
    try {
      return interaction.fields.getTextInputValue(id).trim();
    } catch {
      return '';
    }
  };
  const input = { date: field('date'), time: field('time'), pause: field('pause'), gaps: field('gaps'), quality: field('quality') };
  const state = await loadState();
  const now = nowBerlin();
  const session = target === FIX_NEW ? undefined : state.sessions.find((entry) => entry.id === target && entry.userId === interaction.user.id);

  // Fehler: Eingaben zurückgeben und die Tagesauswahl wieder anbieten, damit nichts verloren geht.
  const fail = async (reason: string): Promise<void> => {
    const echo = Object.entries(input).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' · ');
    const content = `❌ ${reason}\n_Deine Eingaben: ${echo}_\nBitte den Tag erneut auswählen.`;
    const components = [fixPickerRow(state, interaction.user.id)];
    if (interaction.isFromMessage()) await interaction.update({ content, components });
    else await interaction.reply({ content, components, flags: MessageFlags.Ephemeral });
  };

  if (target !== FIX_NEW && !session) return fail('Diesen Tag gibt es nicht mehr.');
  const dayRaw = session ? parseIso(session.startAt).toFormat('dd.MM.yyyy') : input.date;
  const day = DateTime.fromFormat(dayRaw, 'd.M.yyyy', { zone: config.timezone, locale: 'de' });
  if (!day.isValid) return fail('Datum bitte als **TT.MM.JJJJ** angeben.');
  if (!session && state.sessions.some((entry) => entry.userId === interaction.user.id && entry.date === sessionDate(day))) {
    return fail(`Für den ${day.toFormat('dd.MM.yyyy')} gibt es schon eine Arbeitszeit. Wähle ihn in der Liste aus.`);
  }

  const at = (raw: string, after: DateTime): DateTime | undefined => {
    if (!TIME.test(raw)) return undefined;
    const time = DateTime.fromFormat(`${day.toFormat('dd.MM.yyyy')} ${raw}`, 'dd.MM.yyyy H:mm', { zone: config.timezone, locale: 'de' });
    if (!time.isValid) return undefined;
    return time < after ? time.plus({ days: 1 }) : time;
  };
  const [startRaw = '', endRaw = ''] = input.time.split(/\s*[-–]\s*/);
  const start = at(startRaw.trim(), day.startOf('day'));
  if (!start) return fail('Arbeitszeit bitte als **HH:MM-HH:MM** angeben, z. B. `09:24-17:30`.');
  const end = endRaw.trim() ? at(endRaw.trim(), start.plus({ minutes: 1 })) : undefined;
  if (endRaw.trim() && !end) return fail('Das Ende bitte als **HH:MM** angeben.');
  if (!end && sessionDate(day) !== sessionDate(now)) return fail('Ohne Ende geht es nur für heute (die Erfassung läuft dann weiter).');
  const until = end ?? now;
  if (start > now || until > now.plus({ minutes: 2 })) return fail('Arbeitszeit kann nicht in der Zukunft liegen.');
  if (until.diff(start, 'hours').hours > 36) return fail('Ein Arbeitstag darf höchstens 36 Stunden lang sein.');

  const gaps: { from: DateTime; to: DateTime }[] = [];
  for (const raw of input.gaps.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean)) {
    const [fromRaw = '', toRaw = ''] = raw.split(/\s*[-–]\s*/);
    const from = at(fromRaw, start);
    const to = from ? at(toRaw, from.plus({ minutes: 1 })) : undefined;
    if (!from || !to || from <= start || to >= until) return fail(`Unterbrechung „${raw}“ bitte als HH:MM-HH:MM innerhalb der Arbeitszeit angeben.`);
    gaps.push({ from, to });
  }
  gaps.sort((a, b) => a.from.toMillis() - b.from.toMillis());
  if (gaps.some((gap, index) => index > 0 && gap.from < gaps[index - 1].to)) return fail('Unterbrechungen dürfen sich nicht überschneiden.');

  if (input.pause && !/^\d+$/.test(input.pause)) return fail('Pause bitte als ganze Minuten angeben.');
  const pause = Number(input.pause || 0);
  if (!/^(genau|g|geschätzt|geschaetzt|geschätz|s|ca\.?)$/i.test(input.quality)) return fail('Bei „Genau oder geschätzt?“ bitte **genau** oder **geschätzt** eintragen.');
  const estimated = !/^(genau|g)$/i.test(input.quality);

  const blocks: { start: DateTime; end: DateTime }[] = [];
  let blockStart = start;
  for (const gap of gaps) {
    blocks.push({ start: blockStart, end: gap.from });
    blockStart = gap.to;
  }
  blocks.push({ start: blockStart, end: until });
  const work = blocks.reduce((sum, block) => sum + Math.floor(block.end.diff(block.start, 'minutes').minutes), 0);
  if (pause >= work) return fail(`Die Pause (${pause} min) ist länger als die Arbeitszeit (${durationText(work)}).`);

  // Unveränderte Pausensumme: die erfassten Pausen behalten, solange sie noch in die Arbeitsblöcke passen.
  const iso = (time: DateTime): string => time.toISO() ?? time.toJSDate().toISOString();
  const recorded = session ? closedPauses(session) : [];
  const recordedSum = recorded.reduce((sum, interval) => sum + intervalMinutes(interval), 0);
  const fits = (interval: PauseInterval): boolean =>
    blocks.some((block) => parseIso(interval.startAt) >= block.start && parseIso(interval.endAt as string) <= block.end);
  const pauses = session && pause === recordedSum && recorded.every(fits) ? recorded : placePause(blocks, pause);
  const running = session && !end ? openPause(session) : undefined;
  const keptOpen = running && parseIso(running.startAt) >= blocks[blocks.length - 1].start ? [running] : [];

  const nowIso = iso(now);
  const entry: WorkSession = session ?? {
    id: nextSessionId(state),
    userId: interaction.user.id,
    date: sessionDate(start),
    startAt: iso(start),
    pauseMinutes: 0,
    provenance: 'manual-exact',
    createdAt: nowIso,
    updatedAt: nowIso
  };
  if (!session) state.sessions.push(entry);
  entry.startAt = iso(start);
  entry.endAt = end ? iso(end) : undefined;
  entry.pauses = [...pauses, ...keptOpen, ...gaps.map((gap) => ({ startAt: iso(gap.from), endAt: iso(gap.to), kind: 'stop' as const }))];
  recalculatePauseMinutes(entry);
  entry.provenance = estimated ? 'manual-estimated' : entry.provenance === 'clock' ? 'clock' : 'manual-exact';
  if (!end) entry.stopped = undefined;
  entry.endReminderSentAt = undefined;
  entry.updatedAt = nowIso;
  await saveState(state);

  const net = durationMinutes(entry);
  const content =
    `✅ **Arbeitszeit ${start.toFormat('dd.MM.yyyy')} gespeichert.**\n` +
    `${timeRangeText(entry)} Uhr · Pause ${durationText(entry.pauseMinutes)} · ` +
    (net === undefined ? `**${durationText(Math.max(0, work - entry.pauseMinutes))} bisher**, die Erfassung läuft weiter.` : `**${durationText(net)} Arbeitszeit**`) +
    (estimated ? '\n_Als geschätzt gekennzeichnet._' : '');
  if (interaction.isFromMessage()) await interaction.update({ content, components: [] });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
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
    await panelReply(interaction, { content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const currentOpen = state.sessions
    .filter((entry) => entry.userId === interaction.user.id && !entry.endAt)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];

  if (currentOpen) {
    const start = parseIso(currentOpen.startAt);
    const paused = Boolean(openPause(currentOpen));
    await panelReply(interaction, {
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
    await panelReply(interaction, {
      content:
        `▶️ **Weiter geht’s: ${now.toFormat('HH:mm')} Uhr.**\n` +
        `Die Unterbrechung seit ${stoppedAt.toFormat('HH:mm')} Uhr (${durationText(gap)}) zählt weder als Arbeit noch als Pause.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (completedToday) {
    await panelReply(interaction, {
      content:
        `ℹ️ Dein Arbeitstag für heute wurde bereits um **${endTimeText(completedToday)} Uhr** beendet.\n` +
        'Wenn du später am Tag weitermachen willst, drück das nächste Mal **Stop** statt **Ende**. Für heute kannst du die Zeit mit **Arbeitszeiten korrigieren** im Zeiterfassungs-Channel anpassen.',
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

  await panelReply(interaction, {
    content: `🟢 **Arbeitszeit gestartet: ${now.toFormat('HH:mm')} Uhr.**`,
    flags: MessageFlags.Ephemeral
  });
}

async function pauseFromClock(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await panelReply(interaction, { content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const session = state.sessions
    .filter((entry) => entry.userId === interaction.user.id && !entry.endAt)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];

  if (!session) {
    const today = todaysSession(state, interaction.user.id);
    await panelReply(interaction, {
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
    await panelReply(interaction, {
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

  await panelReply(interaction, {
    content:
      `⏸️ **Pause gestartet: ${now.toFormat('HH:mm')} Uhr.**\n\n${interimSummary(session, now)}\n\n` +
      'Wenn du wieder da bist, drück **Weitermachen**.',
    components: [resumeRow(session.id)],
    flags: MessageFlags.Ephemeral
  });
}

async function resumeFromClock(interaction: ButtonInteraction, sessionId: string): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await panelReply(interaction, { content: '⛔ Keine Berechtigung.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const session = state.sessions.find((entry) => entry.id === sessionId && entry.userId === interaction.user.id && !entry.endAt);
  if (!session) {
    await panelReply(interaction, { content: 'ℹ️ Diese Arbeitszeit ist nicht mehr offen.', flags: MessageFlags.Ephemeral });
    return;
  }

  const activePause = openPause(session);
  if (!activePause) {
    await panelReply(interaction, { content: 'ℹ️ Du arbeitest bereits wieder.', flags: MessageFlags.Ephemeral });
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
  // Die Pausen-Nachricht ist jetzt diese Nachricht (ohne Button); sie wird bei der nächsten Panel-Antwort weggeräumt.
  lastPanelReply.set(interaction.user.id, { interaction, hasButton: false });
}

async function stopFromClock(interaction: ButtonInteraction): Promise<void> {
  if (!isTeamMember(interaction.user.id)) {
    await panelReply(interaction, { content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
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
    await panelReply(interaction, { content, flags: MessageFlags.Ephemeral });
    return;
  }

  const start = parseIso(session.startAt);
  const now = nowBerlin();
  if (forgottenEnd(start, now)) {
    await panelReply(interaction, {
      content:
        `⚠️ Deine offene Arbeitszeit läuft seit **${start.toFormat('dd.MM.yyyy')} um ${start.toFormat('HH:mm')} Uhr**, also über ${MAX_LIVE_HOURS} Stunden. ` +
        'Wahrscheinlich wurde **Ende** vergessen. Trage das tatsächliche Ende bitte über **Arbeitszeiten korrigieren** im Zeiterfassungs-Channel ein.',
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
  await panelReply(interaction, {
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

type NightState = { askedAt: string; waiting: string[]; staying: string[]; declined: string[]; messageId?: string };

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

// Die Frage soll den Channel nicht zumüllen: Sie wird gelöscht, sobald alle geantwortet haben, nach Ablauf
// der Antwortzeit, und spätestens bei der nächsten Frage (falls der Server vorher heruntergefahren ist).
async function deleteNightQuestion(client: Client, messageId: string | undefined): Promise<void> {
  if (!messageId) return;
  const raw = await client.channels.fetch(config.timeTrackingChannelId).catch(() => null);
  if (raw instanceof TextChannel) await raw.messages.delete(messageId).catch(() => undefined);
}

async function askNightShutdown(client: Client): Promise<void> {
  await deleteNightQuestion(client, readNight()?.messageId);
  const now = nowBerlin();
  const state = await loadState();
  const working = [
    ...new Set(state.sessions.filter((entry) => !entry.endAt && !forgottenEnd(parseIso(entry.startAt), now)).map((entry) => entry.userId))
  ];
  await writeNight({ askedAt: now.toISO() ?? new Date().toISOString(), waiting: working, staying: [], declined: [] });
  if (working.length === 0) return;

  const raw = await client.channels.fetch(config.timeTrackingChannelId);
  if (!(raw instanceof TextChannel)) return;
  const message = await raw.send({
    content:
      `🌙 ${working.map((id) => `<@${id}>`).join(' ')} deine Arbeitszeit läuft noch. **Arbeitest du noch?**\n` +
      `Ohne Antwort in ${NIGHT_ANSWER_MINUTES} Minuten fährt der Server um 23:00 Uhr herunter (er startet um 08:00 Uhr wieder). ` +
      'Mit **Nein** wird deine Arbeitszeit jetzt beendet.',
    components: [nightRow()],
    allowedMentions: { users: working }
  });
  const night = readNight();
  if (night) await writeNight({ ...night, messageId: message.id });
  setTimeout(() => void deleteNightQuestion(client, message.id), NIGHT_ANSWER_MINUTES * 60 * 1000);
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
  if (night.waiting.length === 0) await deleteNightQuestion(interaction.client, night.messageId);

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
    await panelReply(interaction, { content: '⛔ Du gehörst nicht zum konfigurierten Projektteam.', flags: MessageFlags.Ephemeral });
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
      await panelReply(interaction, {
        content:
          `🔴 **Arbeitstag abgeschlossen.** Ende war dein Stop um ${parseIso(today.endAt).toFormat('HH:mm')} Uhr.\n` +
          `${timeRangeText(today)} Uhr · Pause ${durationText(today.pauseMinutes)} · **${durationText(net)} Arbeitszeit**`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await panelReply(interaction, {
      content: 'ℹ️ Für dich läuft aktuell keine Arbeitszeit. Falls ein vergangener Tag offen ist, nutze **Arbeitszeiten korrigieren** im Zeiterfassungs-Channel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const start = parseIso(session.startAt);
  const now = nowBerlin();
  if (forgottenEnd(start, now)) {
    await panelReply(interaction, {
      content:
        `⚠️ Deine offene Arbeitszeit läuft seit **${start.toFormat('dd.MM.yyyy')} um ${start.toFormat('HH:mm')} Uhr**, also über ${MAX_LIVE_HOURS} Stunden. ` +
        'Wahrscheinlich wurde **Ende** vergessen. Trage das tatsächliche Ende bitte über **Arbeitszeiten korrigieren** im Zeiterfassungs-Channel ein.',
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
  await panelReply(interaction, {
    content:
      `🔴 **Arbeitstag beendet: ${now.toFormat('HH:mm')} Uhr.**\n` +
      `${timeRangeText(session)} Uhr · Pause ${durationText(session.pauseMinutes)} · **${durationText(net)} Arbeitszeit**`,
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
        : 'Ende fehlt · bitte über „Arbeitszeiten korrigieren“ eintragen';
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
    `**Arbeitszeiten korrigieren** · Tag wählen und Zeit, Pause oder Unterbrechungen ändern, auch für fehlende Tage oder den laufenden Tag\n\n` +
    `_Alle Klicks werden nur dir privat bestätigt. Der Channel selbst bleibt sauber._`;

  if (existing) {
    await existing.edit({ content, components: [timePanelRow()] });
  } else {
    await raw.send({ content, components: [timePanelRow()] });
  }

  for (const duplicate of botMessages.values()) {
    if (duplicate.id !== existing?.id) await duplicate.delete().catch(() => undefined);
  }
  // Liegengebliebene Nachtabfragen wegräumen. Meist ist das die Frage von gestern Abend: Der Server fährt
  // um 23:00 herunter, oft bevor der Bot sie nach den 10 Minuten löschen kann. Beim Start um 08:00 geht sie weg.
  // Behalten wird nur eine Frage, auf die gerade noch geantwortet werden kann.
  const night = readNight();
  const stillOpen =
    night && night.waiting.length > 0 && nowBerlin() < parseIso(night.askedAt).plus({ minutes: NIGHT_ANSWER_MINUTES });
  const currentNight = stillOpen ? night.messageId : undefined;
  for (const message of recent.values()) {
    if (message.author.id === client.user?.id && message.content.includes('**Arbeitest du noch?**') && message.id !== currentNight) {
      await message.delete().catch(() => undefined);
    }
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
        `Start war um **${start.toFormat('HH:mm')} Uhr**. Bitte trage das Ende über **Arbeitszeiten korrigieren** im Zeiterfassungs-Channel nach: ` +
        `Tag wählen und bei der Arbeitszeit das Ende ergänzen. Ein Ende nach Mitternacht (z. B. \`01:15\`) gilt als Folgetag.`,
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
    .setDescription('Eigene Arbeitszeiten der Woche anzeigen')
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
    '_Bei Dailies aus der Zeit vor der Arbeitszeiterfassung werden keine Arbeitszeiten erfunden. Nachträge über „Arbeitszeiten korrigieren“ können als genau oder geschätzt gekennzeichnet werden._'
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
        await fixStart(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'work:fix:pick') {
        if (!isTeamMember(interaction.user.id)) return;
        await fixPick(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('work:fix:save:')) {
        if (!isTeamMember(interaction.user.id)) return;
        await fixSave(interaction, interaction.customId.slice('work:fix:save:'.length));
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
