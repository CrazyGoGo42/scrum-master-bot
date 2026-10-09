import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config } from './config.js';
import { bulletList, parseItems } from './text-items.js';
import { keepUnreadableFile } from './utils/state-files.js';

type StoredMeeting = {
  messageId: string;
  title: string;
  startAt: string;
  endAt: string;
  agenda?: string;
  venueKind: 'discord' | 'alfaview' | 'external';
  venueLabel: string;
  venueUrl?: string;
  creatorId: string;
  participantIds?: string[];
  scheduledEventUrl?: string;
  createdAt: string;
  // Über „Bearbeiten“ am Meeting-Post: abgesagt bzw. ursprünglicher Termin vor einer Verschiebung.
  status?: 'cancelled';
  rescheduledFrom?: string;
};

type MeetingHistory = {
  meetings: StoredMeeting[];
};

type ProjectTask = {
  id: string;
  title: string;
  ownerId: string;
  source?: string;
  createdAt: string;
};

type ProjectDecision = {
  id: string;
  title: string;
  decision: string;
  reason?: string;
  authorId: string;
  source?: string;
  createdAt: string;
};

type MeetingNote = {
  id: string;
  messageId: string;
  authorId: string;
  discussed: string;
  decisions?: string;
  tasks?: string;
  listStyle?: 'dash';
  createdAt: string;
};

type ProjectStateView = {
  tasks?: ProjectTask[];
  decisions?: ProjectDecision[];
  meetingNotes?: MeetingNote[];
};

export type MeetingRecordInput = {
  messageId: string;
  title: string;
  start: DateTime;
  end: DateTime;
  agenda: string;
  venue: {
    kind: 'discord' | 'alfaview' | 'external';
    label: string;
    url: string;
  };
  creatorId: string;
  scheduledEventUrl?: string;
};

const statePath = process.env.PROJECT_STATE_FILE || path.join(process.cwd(), 'data', 'project-state.json');
const meetingHistoryPath = process.env.MEETING_HISTORY_FILE || path.join(process.cwd(), 'data', 'meeting-history.json');
let meetingWriteQueue = Promise.resolve();

function memberName(id: string): string {
  return config.members.find((member) => member.discordId === id)?.name ?? id;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    console.error(`[Weekly] Datei konnte nicht gelesen werden: ${filePath}`, error);
    keepUnreadableFile(filePath);
    return fallback;
  }
}

async function writeMeetingHistory(history: MeetingHistory): Promise<void> {
  // Ein fehlgeschlagener Schreibvorgang darf spätere Speicherungen nicht blockieren.
  meetingWriteQueue = meetingWriteQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(meetingHistoryPath), { recursive: true });
    const temporary = `${meetingHistoryPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, meetingHistoryPath);
  });
  await meetingWriteQueue;
}

export type MeetingChange = { title: string; start: DateTime; end: DateTime; venueLabel: string };

export function findMeeting(messageId: string): StoredMeeting | undefined {
  return readJson<MeetingHistory>(meetingHistoryPath, { meetings: [] }).meetings.find((meeting) => meeting.messageId === messageId);
}

// Änderungen laufen über dieselbe Warteschlange wie das Speichern, damit sich zwei Klicks nicht überschreiben.
async function changeMeetingHistory(change: (history: MeetingHistory) => boolean): Promise<boolean> {
  let changed = false;
  const run = meetingWriteQueue.catch(() => undefined).then(async () => {
    const history = readJson<MeetingHistory>(meetingHistoryPath, { meetings: [] });
    changed = change(history);
    if (!changed) return;
    await fs.mkdir(path.dirname(meetingHistoryPath), { recursive: true });
    const temporary = `${meetingHistoryPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, meetingHistoryPath);
  });
  meetingWriteQueue = run;
  await run;
  return changed;
}

/** Ändert Titel, Zeit oder Ort. Bei neuer Startzeit bleibt der allererste Termin als „verschoben von“ erhalten. */
export async function updateMeeting(messageId: string, update: MeetingChange): Promise<StoredMeeting | undefined> {
  let result: StoredMeeting | undefined;
  await changeMeetingHistory((history) => {
    const meeting = history.meetings.find((entry) => entry.messageId === messageId);
    if (!meeting) return false;
    const startAt = update.start.toISO() ?? update.start.toJSDate().toISOString();
    const moved = DateTime.fromISO(meeting.startAt).toMillis() !== update.start.toMillis();
    if (moved) meeting.rescheduledFrom ??= meeting.startAt;
    if (meeting.rescheduledFrom && DateTime.fromISO(meeting.rescheduledFrom).toMillis() === update.start.toMillis()) {
      meeting.rescheduledFrom = undefined;
    }
    meeting.title = update.title.trim();
    meeting.startAt = startAt;
    meeting.endAt = update.end.toISO() ?? update.end.toJSDate().toISOString();
    meeting.venueLabel = update.venueLabel.trim();
    result = { ...meeting };
    return true;
  });
  return result;
}

export async function setMeetingCancelled(messageId: string, cancelled: boolean): Promise<StoredMeeting | undefined> {
  let result: StoredMeeting | undefined;
  await changeMeetingHistory((history) => {
    const meeting = history.meetings.find((entry) => entry.messageId === messageId);
    if (!meeting) return false;
    meeting.status = cancelled ? 'cancelled' : undefined;
    result = { ...meeting };
    return true;
  });
  return result;
}

/** Entfernt das Meeting aus der Historie; es erscheint dann in keinem Wochenbericht. */
export async function deleteMeeting(messageId: string): Promise<boolean> {
  return changeMeetingHistory((history) => {
    const before = history.meetings.length;
    history.meetings = history.meetings.filter((entry) => entry.messageId !== messageId);
    return history.meetings.length !== before;
  });
}

export async function recordMeeting(input: MeetingRecordInput): Promise<void> {
  const history = readJson<MeetingHistory>(meetingHistoryPath, { meetings: [] });
  const participantIds = input.venue.kind === 'discord' ? undefined : config.members.map((member) => member.discordId);
  const entry: StoredMeeting = {
    messageId: input.messageId,
    title: input.title.trim(),
    startAt: input.start.toISO() ?? input.start.toJSDate().toISOString(),
    endAt: input.end.toISO() ?? input.end.toJSDate().toISOString(),
    agenda: input.agenda.trim() || undefined,
    venueKind: input.venue.kind,
    venueLabel: input.venue.label,
    venueUrl: input.venue.url || undefined,
    creatorId: input.creatorId,
    participantIds,
    scheduledEventUrl: input.scheduledEventUrl,
    createdAt: DateTime.now().setZone(config.timezone).toISO() ?? new Date().toISOString()
  };

  const index = history.meetings.findIndex((meeting) => meeting.messageId === input.messageId);
  if (index >= 0) history.meetings[index] = entry;
  else history.meetings.push(entry);
  await writeMeetingHistory(history);
}

function inRange(value: string, start: DateTime, end: DateTime): boolean {
  const date = DateTime.fromISO(value, { zone: config.timezone });
  return date.isValid && date >= start && date <= end;
}

// Ältere Protokolle (ohne listStyle) hatten einen Punkt pro Zeile.
function noteItems(value: string | undefined, note: MeetingNote): string[] {
  return parseItems(value, note.listStyle !== 'dash');
}

function currentReportRange(): { start: DateTime; end: DateTime } {
  const now = DateTime.now().setZone(config.timezone);
  const start = now.startOf('week').startOf('day');
  return { start, end: start.plus({ days: 4 }).endOf('day') };
}

export function weeklyProjectReportSection(): string {
  const { start, end } = currentReportRange();
  const history = readJson<MeetingHistory>(meetingHistoryPath, { meetings: [] });
  const state = readJson<ProjectStateView>(statePath, {});

  const meetings = (history.meetings ?? [])
    .filter((meeting) => inRange(meeting.startAt, start, end))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const notes = (state.meetingNotes ?? []).filter((note) => inRange(note.createdAt, start, end));
  const meetingTasks = (state.tasks ?? []).filter(
    (task) => task.source === 'meeting' && inRange(task.createdAt, start, end)
  );
  const meetingDecisions = (state.decisions ?? []).filter(
    (decision) => decision.source === 'meeting' && inRange(decision.createdAt, start, end)
  );

  if (meetings.length === 0 && notes.length === 0 && meetingTasks.length === 0 && meetingDecisions.length === 0) {
    return '';
  }

  const out: string[] = ['', '', '## Meetings'];

  for (const meeting of meetings) {
    const startAt = DateTime.fromISO(meeting.startAt, { zone: config.timezone });
    out.push(
      '',
      `### ${meeting.title} · ${startAt.toFormat('dd.MM.yyyy')} · ${startAt.toFormat('HH:mm')} Uhr`,
      `**Ort:** ${meeting.venueLabel}`
    );

    if (meeting.participantIds?.length) {
      out.push(`**Teilnehmer:** ${meeting.participantIds.map(memberName).join(', ')}`);
    } else {
      out.push(`**Team eingeladen:** ${config.members.map((member) => member.name).join(', ')}`);
    }

    if (meeting.agenda) out.push(`**Agenda:** ${meeting.agenda}`);

    const matchingNotes = notes.filter((note) => note.messageId === meeting.messageId);
    for (const note of matchingNotes) {
      out.push('', `**Protokoll ${note.id}:** ${note.discussed}`);
      const noteDecisions = noteItems(note.decisions, note);
      if (noteDecisions.length > 0) {
        out.push('**Entscheidungen im Protokoll:**', bulletList(noteDecisions));
      }
      const noteTasks = noteItems(note.tasks, note);
      if (noteTasks.length > 0) {
        out.push('**Aufgaben im Protokoll:**', bulletList(noteTasks));
      }
    }
  }

  const knownMeetingIds = new Set(meetings.map((meeting) => meeting.messageId));
  const unmatchedNotes = notes.filter((note) => !knownMeetingIds.has(note.messageId));
  if (unmatchedNotes.length > 0) {
    out.push('', '### Weitere Meeting-Protokolle');
    for (const note of unmatchedNotes) {
      out.push(`- **${note.id}:** ${note.discussed}`);
      const noteDecisions = noteItems(note.decisions, note);
      if (noteDecisions.length > 0) out.push(...noteDecisions.map((entry) => `  - Entscheidung: ${entry.split('\n').join('\n    ')}`));
      const noteTasks = noteItems(note.tasks, note);
      if (noteTasks.length > 0) out.push(...noteTasks.map((entry) => `  - Aufgabe: ${entry.split('\n').join('\n    ')}`));
    }
  }

  if (meetingTasks.length > 0) {
    out.push('', '### Aufgaben aus Meetings');
    out.push(...meetingTasks.map((task) => `- **${task.id} · ${memberName(task.ownerId)}:** ${task.title}`));
  }

  if (meetingDecisions.length > 0) {
    out.push('', '### Entscheidungen aus Meetings');
    out.push(
      ...meetingDecisions.map(
        (decision) =>
          `- **${decision.id} · ${decision.title}:** ${decision.decision}` +
          (decision.reason ? ` · Begründung: ${decision.reason}` : '')
      )
    );
  }

  return out.join('\n');
}
