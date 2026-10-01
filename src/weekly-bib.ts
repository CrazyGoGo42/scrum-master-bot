import { AttachmentBuilder } from 'discord.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import { config } from './config.js';

type DailyLike = {
  ownerId: string;
  ownerName: string;
  createdAt: DateTime;
  content: string;
};

type AbsenceLike = {
  ownerId: string;
  ownerName: string;
  createdAt: DateTime;
  kind: string;
  detail?: string;
};

type WorkSession = {
  userId: string;
  date: string;
  startAt: string;
  endAt?: string;
  pauseMinutes: number;
};

type StoredMeeting = {
  messageId: string;
  title: string;
  startAt: string;
  endAt: string;
  agenda?: string;
  venueLabel: string;
  participantIds?: string[];
};

type MeetingNote = {
  id: string;
  messageId: string;
  authorId: string;
  discussed: string;
  decisions?: string;
  tasks?: string;
  createdAt: string;
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

type ProjectBlocker = {
  id: string;
  text: string;
  ownerId: string;
  status: 'open' | 'resolved';
  source?: string;
  createdAt: string;
  resolvedAt?: string;
};

type ProjectState = {
  tasks?: ProjectTask[];
  decisions?: ProjectDecision[];
  blockers?: ProjectBlocker[];
  meetingNotes?: MeetingNote[];
};

type MeetingHistory = { meetings?: StoredMeeting[] };
type WorkState = { sessions?: WorkSession[] };

type WeekData = {
  date: DateTime;
  start: DateTime;
  end: DateTime;
  unavailableMemberIds: Set<string>;
  entries: DailyLike[];
  absences: AbsenceLike[];
  sessions: WorkSession[];
  meetings: StoredMeeting[];
  notes: MeetingNote[];
  tasks: ProjectTask[];
  decisions: ProjectDecision[];
  projectBlockers: ProjectBlocker[];
  allProjectBlockers: ProjectBlocker[];
};

type DayRecord = {
  day: DateTime;
  daily?: DailyLike;
  absence?: AbsenceLike;
  session?: WorkSession;
  isFuture: boolean;
};

const projectStatePath = process.env.PROJECT_STATE_FILE || path.join(process.cwd(), 'data', 'project-state.json');
const meetingHistoryPath = process.env.MEETING_HISTORY_FILE || path.join(process.cwd(), 'data', 'meeting-history.json');
const workStatePath = process.env.WORK_TRACKING_FILE || path.join(process.cwd(), 'data', 'work-sessions.json');
const logoPath = process.env.WEEKLY_REPORT_LOGO_PATH || path.join(process.cwd(), 'assets', 'BIB_Logo_4c1.jpg');

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    console.error(`[Weekly PDF] Datei konnte nicht gelesen werden: ${filePath}`, error);
    return fallback;
  }
}

function formatDate(date: DateTime): string {
  return date.toFormat('dd.MM.yyyy');
}

function section(content: string, names: string[]): string[] {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = content.match(new RegExp(`(?:^|\\n)#{1,3}\\s*(?:${escaped})\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`, 'i'));
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function cleanLines(value?: string): string[] {
  if (!value?.trim()) return [];
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function memberName(userId: string): string {
  return config.members.find((member) => member.discordId === userId)?.name ?? userId;
}

function standardBranch(name: string): string {
  if (name === 'Joline') return 'joline';
  if (name === 'David') return 'David';
  if (name === 'Duy') return 'Duy-Anh';
  return name;
}

function normalizedBranch(value: string): string {
  return value
    .trim()
    .replace(/^immowelt-apps\//i, '')
    .replace(/^innowelt-apps\//i, '')
    .toLocaleLowerCase('de-DE');
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
}

function inRange(value: string | undefined, start: DateTime, end: DateTime): boolean {
  if (!value) return false;
  const date = DateTime.fromISO(value, { zone: config.timezone });
  return date.isValid && date >= start && date <= end;
}

function absenceLabel(entry: AbsenceLike): string {
  if (entry.kind === 'Krankheit') return 'Krankheit (entschuldigt)';
  if (entry.detail?.trim()) return `${entry.kind}: ${entry.detail.trim()}`;
  return entry.kind;
}

function isRealBlocker(lines: string[]): boolean {
  if (lines.length === 0) return false;
  const normalized = lines.join(' ').trim().toLocaleLowerCase('de-DE');
  return !['keine', 'keine blocker', 'nichts', 'aktuell keine', '-'].includes(normalized);
}

function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

function sessionTimes(session: WorkSession): { start: DateTime; end?: DateTime; netMinutes: number } {
  const start = DateTime.fromISO(session.startAt, { zone: config.timezone });
  const end = session.endAt ? DateTime.fromISO(session.endAt, { zone: config.timezone }) : undefined;
  if (!end?.isValid) return { start, netMinutes: 0 };
  const gross = Math.round(end.diff(start, 'minutes').minutes);
  return { start, end, netMinutes: Math.max(0, gross - Math.max(0, session.pauseMinutes ?? 0)) };
}

function workText(session: WorkSession | undefined, hasDaily: boolean, day: DateTime): string {
  if (!session) {
    if (day.weekday === 5) return 'Nicht übermittelt';
    return hasDaily ? 'Nicht erfasst (Altbestand vor Arbeitszeiterfassung)' : 'Keine Arbeitszeit erfasst';
  }

  const { start, end, netMinutes } = sessionTimes(session);
  if (!end) {
    if (day.weekday === 5) return 'Nicht übermittelt';
    return `${start.toFormat('HH:mm')} Uhr - noch nicht abgeschlossen`;
  }

  const nextDay = end.toISODate() !== start.toISODate() ? ' (+1 Tag)' : '';
  return `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}${nextDay} Uhr · Pause ${session.pauseMinutes ?? 0} min · ${durationText(netMinutes)}`;
}

function weekRange(date: DateTime): { start: DateTime; end: DateTime } {
  const start = date.startOf('week').startOf('day');
  return { start, end: start.plus({ days: 4 }).endOf('day') };
}

function weekdayName(date: DateTime): string {
  return date.setLocale('de').toFormat('cccc');
}

function markdownBullets(items: string[], fallback?: string): string[] {
  if (items.length === 0) return fallback ? [`- ${fallback}`] : [];
  return items.map((item) => `- ${item}`);
}

function collectWeek(
  entries: DailyLike[],
  absences: AbsenceLike[],
  unavailableMemberIds: Set<string>,
  date: DateTime
): WeekData {
  const { start, end } = weekRange(date);
  const work = readJson<WorkState>(workStatePath, {});
  const history = readJson<MeetingHistory>(meetingHistoryPath, {});
  const project = readJson<ProjectState>(projectStatePath, {});

  const weekEntries = entries
    .filter((entry) => entry.createdAt >= start && entry.createdAt <= end)
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  // Ein später eingereichtes Daily hebt die Abmeldung desselben Tages auf.
  const weekAbsences = absences.filter(
    (entry) =>
      entry.createdAt >= start &&
      entry.createdAt <= end &&
      !weekEntries.some((daily) => daily.ownerId === entry.ownerId && daily.createdAt.toISODate() === entry.createdAt.toISODate())
  );

  return {
    date,
    start,
    end,
    unavailableMemberIds,
    entries: weekEntries,
    absences: weekAbsences,
    sessions: (work.sessions ?? []).filter((session) => inRange(`${session.date}T12:00:00`, start, end)),
    meetings: (history.meetings ?? [])
      .filter((meeting) => inRange(meeting.startAt, start, end))
      .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    notes: (project.meetingNotes ?? []).filter((note) => inRange(note.createdAt, start, end)),
    tasks: (project.tasks ?? []).filter((task) => task.source === 'meeting' && inRange(task.createdAt, start, end)),
    decisions: (project.decisions ?? []).filter((decision) => inRange(decision.createdAt, start, end)),
    projectBlockers: (project.blockers ?? []).filter(
      (blocker) => inRange(blocker.createdAt, start, end) || inRange(blocker.resolvedAt, start, end)
    ),
    allProjectBlockers: project.blockers ?? []
  };
}

function weekDays(week: WeekData): DateTime[] {
  return [0, 1, 2, 3, 4].map((offset) => week.start.plus({ days: offset }));
}

function dayRecord(week: WeekData, memberId: string, day: DateTime): DayRecord {
  const key = day.toISODate();
  return {
    day,
    daily: week.entries.find((entry) => entry.ownerId === memberId && entry.createdAt.toISODate() === key),
    absence: week.absences.find((entry) => entry.ownerId === memberId && entry.createdAt.toISODate() === key),
    session: week.sessions.find((entry) => entry.userId === memberId && entry.date === key),
    isFuture: day.startOf('day') > week.date.startOf('day')
  };
}

function missingDocumentation(week: WeekData): { name: string; day: DateTime }[] {
  const missing: { name: string; day: DateTime }[] = [];
  for (const member of config.members) {
    if (week.unavailableMemberIds.has(member.discordId)) continue;
    for (const day of weekDays(week)) {
      const record = dayRecord(week, member.discordId, day);
      if (!record.isFuture && !record.daily && !record.absence) missing.push({ name: member.name, day });
    }
  }
  return missing;
}

function renderMarkdown(week: WeekData): string {
  const { date, start, end } = week;

  const out: string[] = [
    '# Wochenbericht Hauptprojekt',
    '',
    `**Kalenderwoche:** KW ${start.weekNumber} / ${start.weekYear}`,
    `**Berichtszeitraum:** ${formatDate(start)} - ${formatDate(end)}`,
    `**Team:** ${config.members.map((member) => member.name).join(', ')}`,
    `**Erstellt:** ${formatDate(date)} · ${date.toFormat('HH:mm')} Uhr`,
    '',
    '## Inhaltsverzeichnis',
    '- 1. Wochenüberblick',
    '- 2. Tätigkeiten und Arbeitszeiten',
    '- 3. Meetings',
    '- 4. Projektentscheidungen',
    '- 5. Probleme und Blocker',
    '- 6. Abwesenheiten und Abweichungen',
    '- 7. Dokumentationsstatus',
    '- 8. Stand zum Ende der Woche / nächste Schritte',
    '',
    '## 1. Wochenüberblick',
    `In dieser Woche wurden ${week.entries.length} Daily Scrum${week.entries.length === 1 ? '' : 's'}, ${week.absences.length} Abmeldung${week.absences.length === 1 ? '' : 'en'} und ${week.meetings.length} Meeting${week.meetings.length === 1 ? '' : 's'} dokumentiert.`,
    '',
    '## 2. Tätigkeiten und Arbeitszeiten'
  ];

  for (const member of config.members) {
    out.push('', `### ${member.name}`, `**Standard-Branch:** ${standardBranch(member.name)}`);

    if (week.unavailableMemberIds.has(member.discordId)) {
      out.push('- Das Daily-Forum konnte beim Erstellen des Berichts nicht gelesen werden.');
      continue;
    }

    for (const day of weekDays(week)) {
      const { daily, absence, session, isFuture } = dayRecord(week, member.discordId, day);

      out.push('', `#### ${weekdayName(day)}, ${formatDate(day)}`);

      if (absence && !daily) {
        out.push(`**Status:** Abgemeldet · ${absenceLabel(absence)}`);
        continue;
      }

      if (!daily) {
        out.push(isFuture ? '**Status:** Noch nicht erreicht.' : '**Status:** Keine Daily-Dokumentation vorhanden.');
        if (session) out.push(`**Arbeitszeit:** ${workText(session, false, day)}`);
        continue;
      }

      const done = section(daily.content, ['Seit dem letzten Daily', 'Gestern']);
      const planned = section(daily.content, ['Heute']);
      const blockers = section(daily.content, ['Blocker']);
      const branch = daily.content.match(/^- Branch:\s*(.+)$/im)?.[1]?.trim();
      const branchDiffers = branch && normalizedBranch(branch) !== normalizedBranch(standardBranch(member.name));

      out.push(`**Daily:** ${daily.createdAt.toFormat('HH:mm')} Uhr`);
      out.push(`**Arbeitszeit:** ${workText(session, true, day)}`);
      if (branchDiffers) out.push(`**Abweichender Branch:** ${branch}`);
      out.push('**Tätigkeiten seit dem letzten Daily:**', ...markdownBullets(done, 'Keine abgeschlossenen Tätigkeiten angegeben.'));
      out.push('**Geplant für diesen Tag:**', ...markdownBullets(planned, 'Keine Planung angegeben.'));
      if (isRealBlocker(blockers)) out.push('**Blocker:**', ...markdownBullets(blockers));
    }
  }

  out.push('', '## 3. Meetings');
  if (week.meetings.length === 0) {
    out.push('- Keine Meetings dokumentiert.');
  } else {
    for (const meeting of week.meetings) {
      const meetingStart = DateTime.fromISO(meeting.startAt, { zone: config.timezone });
      const participants = meeting.participantIds?.length
        ? meeting.participantIds.map(memberName).join(', ')
        : config.members.map((member) => member.name).join(', ');
      out.push('', `### ${meeting.title}`);
      out.push(`**Datum / Uhrzeit:** ${formatDate(meetingStart)} · ${meetingStart.toFormat('HH:mm')} Uhr`);
      out.push(`**Ort:** ${meeting.venueLabel}`);
      out.push(`**Teilnehmer / eingeladenes Team:** ${participants}`);
      if (meeting.agenda?.trim()) out.push(`**Agenda:** ${meeting.agenda.trim()}`);

      const notes = week.notes.filter((note) => note.messageId === meeting.messageId);
      for (const note of notes) {
        if (note.discussed.trim()) out.push('**Protokoll:**', note.discussed.trim());
        const decisions = cleanLines(note.decisions);
        if (decisions.length > 0) out.push('**Entscheidungen im Protokoll:**', ...markdownBullets(decisions));
        const tasks = cleanLines(note.tasks);
        if (tasks.length > 0) out.push('**Aufgaben im Protokoll:**', ...markdownBullets(tasks));
      }
    }

    if (week.tasks.length > 0) {
      out.push('', '### Aufgaben aus Meetings');
      out.push(...week.tasks.map((task) => `- **${task.id} · ${memberName(task.ownerId)}:** ${task.title}`));
    }
  }

  out.push('', '## 4. Projektentscheidungen');
  if (week.decisions.length === 0) {
    out.push('- Keine Projektentscheidungen dokumentiert.');
  } else {
    for (const decision of week.decisions) {
      out.push(`- **${decision.title}:** ${decision.decision}${decision.reason ? ` · Begründung: ${decision.reason}` : ''}`);
    }
  }

  const dailyBlockers = week.entries.flatMap((entry) => {
    const blockers = section(entry.content, ['Blocker']);
    return isRealBlocker(blockers) ? blockers.map((text) => ({ ownerId: entry.ownerId, text })) : [];
  });

  out.push('', '## 5. Probleme und Blocker');
  if (dailyBlockers.length === 0 && week.projectBlockers.length === 0) {
    out.push('- Keine Blocker dokumentiert.');
  } else {
    const seen = new Set<string>();
    for (const blocker of dailyBlockers) {
      const key = `${blocker.ownerId}:${blocker.text.toLocaleLowerCase('de-DE')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`- **${memberName(blocker.ownerId)}:** ${blocker.text}`);
    }
    for (const blocker of week.projectBlockers) {
      const key = `${blocker.ownerId}:${blocker.text.toLocaleLowerCase('de-DE')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`- **${memberName(blocker.ownerId)} · ${blocker.status === 'resolved' ? 'gelöst' : 'offen'}:** ${blocker.text}`);
    }
  }

  out.push('', '## 6. Abwesenheiten und Abweichungen');
  if (week.absences.length === 0) {
    out.push('- Keine Abwesenheiten dokumentiert.');
  } else {
    for (const absence of week.absences) {
      out.push(`- **${absence.ownerName} · ${formatDate(absence.createdAt)}:** ${absenceLabel(absence)}`);
    }
  }

  const missing = missingDocumentation(week).map((entry) => `${entry.name}: ${formatDate(entry.day)}`);

  out.push('', '## 7. Dokumentationsstatus');
  if (missing.length === 0) out.push('- Für alle bisher fälligen regulären Projekttage liegt ein Daily oder eine Abmeldung vor.');
  else out.push(...missing.map((entry) => `- Fehlend: **${entry}**`));

  out.push('', '## 8. Stand zum Ende der Woche / nächste Schritte');
  for (const member of config.members) {
    const latest = week.entries
      .filter((entry) => entry.ownerId === member.discordId)
      .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0];
    const next = latest ? section(latest.content, ['Heute']) : [];
    out.push(`### ${member.name}`, ...markdownBullets(next, 'Keine nächsten Schritte dokumentiert.'));
  }

  return out.join('\n');
}

export function buildBibWeeklyReport(
  entries: DailyLike[],
  absences: AbsenceLike[],
  unavailableMemberIds = new Set<string>(),
  date = DateTime.now().setZone(config.timezone)
): string {
  return renderMarkdown(collectWeek(entries, absences, unavailableMemberIds, date));
}

// ---------------------------------------------------------------------------
// PDF: Layout nach bib-Dokumentationsrichtlinie (DIN A4, Arial/Helvetica,
// Überschriften in bib-Blau, Logo oben rechts, Bundsteg links >= 2 cm).
// ---------------------------------------------------------------------------

const MM = 72 / 25.4;
const MARGIN = { left: 25 * MM, right: 20 * MM, top: 30 * MM, bottom: 22 * MM };

const INK = '#1A1A1A';
const MUTED = '#6B6F76';
const BIB_BLUE = '#4F81BD';
const RULE = '#D3DAE3';
const HEAD_FILL = '#DBE5F1';
const ABSENT_FILL = '#EEF1F5';
const ALERT = '#A3392B';

const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' } as const;
type FontStyle = keyof typeof FONT;

const BODY_SIZE = 9.2;
const SMALL_SIZE = 8;
const TABLE_SIZE = 8.4;

// Raster für Tätigkeiten und Meetings: Datum | Bezeichnung | Inhalt.
const GRID_DATE_WIDTH = 74;
const GRID_LABEL_WIDTH = 72;
const BULLET_INDENT = 10;

const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

type Pdf = {
  doc: PDFKit.PDFDocument;
  // Kapitel, das am Seitenanfang gilt (für die Kopfzeile).
  pageChapters: string[];
  chapter: string;
};

type Run = { text: string; style?: FontStyle; size?: number; color?: string };
type TableCell = { runs: Run[]; fill?: string };
type TableColumn = { title: string; width: number; align?: 'left' | 'center' | 'right' };

const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

// Die PDF-Standardschriften kennen nur WinAnsi. Pfeile werden übersetzt,
// Emojis und andere nicht darstellbare Zeichen entfernt.
function pdfText(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[→⇒➜➔]/g, '->')
    .replace(/[←⇐]/g, '<-')
    .replace(/[‐-‒−]/g, '-')
    .replace(/./gu, (char) => {
      const code = char.codePointAt(0) ?? 0;
      const printable = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(char);
      return printable ? char : '';
    })
    .replace(/ {2,}/g, ' ')
    .replace(/ +([,.;:!?)])/g, '$1')
    .trim();
}

function shortDate(date: DateTime): string {
  return `${WEEKDAY_SHORT[date.weekday - 1]} ${date.toFormat('dd.MM.')}`;
}

function hoursText(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} h`;
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - MARGIN.left - MARGIN.right;
}

function setFont(doc: PDFKit.PDFDocument, style: FontStyle, size: number, color = INK): void {
  doc.font(FONT[style]).fontSize(size).fillColor(color);
}

function ensureSpace(pdf: Pdf, needed: number): void {
  if (pdf.doc.y + needed > pdf.doc.page.height - MARGIN.bottom) pdf.doc.addPage();
}

function atPageTop(doc: PDFKit.PDFDocument): boolean {
  return doc.y <= MARGIN.top + 1;
}

function drawChapter(pdf: Pdf, number: number, title: string): void {
  const { doc } = pdf;
  ensureSpace(pdf, 90);
  if (!atPageTop(doc)) doc.y += 16;

  const label = `${number}  ${title}`;
  if (atPageTop(doc)) pdf.pageChapters[pdf.pageChapters.length - 1] = label;
  pdf.chapter = label;

  const y = doc.y;
  setFont(doc, 'bold', 13, BIB_BLUE);
  doc.text(String(number), MARGIN.left, y, { lineBreak: false });
  doc.text(title, MARGIN.left + 24, y, { width: contentWidth(doc) - 24 });
  doc.y = y + 24;
}

function drawSubheading(pdf: Pdf, number: string, title: string): void {
  const { doc } = pdf;
  ensureSpace(pdf, 70);
  if (!atPageTop(doc)) doc.y += 10;
  const y = doc.y;
  setFont(doc, 'bold', 10.5, BIB_BLUE);
  doc.text(number, MARGIN.left, y, { lineBreak: false });
  doc.text(title, MARGIN.left + 24, y, { width: contentWidth(doc) - 24 });
  doc.y = y + 18;
}

function drawNote(pdf: Pdf, text: string, color = MUTED): void {
  const { doc } = pdf;
  setFont(doc, 'regular', SMALL_SIZE, color);
  const height = doc.heightOfString(text, { width: contentWidth(doc), lineGap: 1 });
  ensureSpace(pdf, height);
  const y = doc.y;
  doc.text(text, MARGIN.left, y, { width: contentWidth(doc), lineGap: 1 });
  doc.y = y + height + 3;
}

function runsHeight(doc: PDFKit.PDFDocument, runs: Run[], width: number): number {
  return runs.reduce((sum, run) => {
    setFont(doc, run.style ?? 'regular', run.size ?? TABLE_SIZE);
    return sum + doc.heightOfString(run.text || ' ', { width, lineGap: 0.6 });
  }, 0);
}

function drawTable(pdf: Pdf, columns: TableColumn[], rows: TableCell[][]): void {
  const { doc } = pdf;
  const padX = 5;
  const padY = 5;
  const headerHeight = 19;
  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const rowHeight = (row: TableCell[]): number =>
    Math.max(...row.map((cell, index) => runsHeight(doc, cell.runs, columns[index].width - padX * 2))) + padY * 2;

  const drawHeader = (): void => {
    const y = doc.y;
    doc.rect(MARGIN.left, y, totalWidth, headerHeight).fill(HEAD_FILL);
    let x = MARGIN.left;
    for (const column of columns) {
      setFont(doc, 'bold', SMALL_SIZE, INK);
      doc.text(column.title, x + padX, y + 6, { width: column.width - padX * 2, align: column.align ?? 'left', lineBreak: false });
      x += column.width;
    }
    doc.y = y + headerHeight;
  };

  ensureSpace(pdf, headerHeight + (rows[0] ? rowHeight(rows[0]) : 0));
  drawHeader();

  for (const row of rows) {
    const height = rowHeight(row);
    if (doc.y + height > doc.page.height - MARGIN.bottom) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    let x = MARGIN.left;
    row.forEach((cell, index) => {
      const column = columns[index];
      const width = column.width - padX * 2;
      if (cell.fill) doc.rect(x + 1, y + 1, column.width - 2, height - 2).fill(cell.fill);
      let textY = y + (height - runsHeight(doc, cell.runs, width)) / 2;
      for (const run of cell.runs) {
        setFont(doc, run.style ?? 'regular', run.size ?? TABLE_SIZE, run.color ?? INK);
        const options = { width, align: column.align ?? 'left', lineGap: 0.6 } as const;
        doc.text(run.text, x + padX, textY, options);
        textY += doc.heightOfString(run.text || ' ', options);
      }
      x += column.width;
    });

    doc.moveTo(MARGIN.left, y + height).lineTo(MARGIN.left + totalWidth, y + height).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.y = y + height;
  }
}

// Zeile im Raster. Der Datumsblock links wird nur in der ersten Zeile eines Eintrags gezeichnet.
function drawGridRow(
  pdf: Pdf,
  label: string,
  content: string | string[],
  options: { labelColor?: string; textColor?: string; bold?: boolean } = {}
): void {
  const { doc } = pdf;
  const x = MARGIN.left + GRID_DATE_WIDTH + GRID_LABEL_WIDTH;
  const width = contentWidth(doc) - GRID_DATE_WIDTH - GRID_LABEL_WIDTH;
  const items = Array.isArray(content) ? content : [content];
  const bullets = Array.isArray(content);

  items.forEach((raw, index) => {
    const text = pdfText(raw) || '–';
    const textX = bullets ? x + BULLET_INDENT : x;
    const textWidth = bullets ? width - BULLET_INDENT : width;
    setFont(doc, options.bold ? 'bold' : 'regular', BODY_SIZE, options.textColor ?? INK);
    const height = doc.heightOfString(text, { width: textWidth, lineGap: 1 });
    if (height < 200) ensureSpace(pdf, height);

    const y = doc.y;
    if (index === 0 && label) {
      setFont(doc, 'bold', SMALL_SIZE, options.labelColor ?? MUTED);
      doc.text(label, MARGIN.left + GRID_DATE_WIDTH, y + 1.2, { width: GRID_LABEL_WIDTH - 6, lineBreak: false });
    }
    setFont(doc, options.bold ? 'bold' : 'regular', BODY_SIZE, options.textColor ?? INK);
    if (bullets) doc.text('•', x, y, { width: BULLET_INDENT, lineBreak: false });
    doc.text(text, textX, y, { width: textWidth, lineGap: 1 });
    doc.y = Math.max(doc.y, y + height) + 2;
  });
}

type GridEntry = { dateBottom: number; page: number };

function startGridEntry(pdf: Pdf, title: string, subtitle: string | undefined, firstHeight: number): GridEntry {
  const { doc } = pdf;
  ensureSpace(pdf, Math.max(firstHeight, 30) + 12);
  const top = doc.y;
  doc.moveTo(MARGIN.left, top).lineTo(MARGIN.left + contentWidth(doc), top).lineWidth(0.5).strokeColor(RULE).stroke();
  const y = top + 7;
  setFont(doc, 'bold', BODY_SIZE, INK);
  doc.text(title, MARGIN.left, y, { width: GRID_DATE_WIDTH - 8, lineBreak: false });
  if (subtitle) {
    setFont(doc, 'regular', SMALL_SIZE, MUTED);
    doc.text(subtitle, MARGIN.left, y + 12.5, { width: GRID_DATE_WIDTH - 8, lineBreak: false });
  }
  doc.y = y;
  return { dateBottom: y + (subtitle ? 24 : 12), page: pdf.pageChapters.length };
}

function endGridEntry(pdf: Pdf, entry: GridEntry): void {
  // Nach einem Seitenumbruch innerhalb des Eintrags gilt die Höhe des Datumsblocks nicht mehr.
  if (pdf.pageChapters.length === entry.page) pdf.doc.y = Math.max(pdf.doc.y, entry.dateBottom);
  pdf.doc.y += 5;
}

function workCell(record: DayRecord): TableCell {
  const { day, absence, daily, session, isFuture } = record;
  if (isFuture) return { runs: [{ text: '–', color: MUTED }] };
  if (absence && !daily) {
    const label = absence.kind === 'Krankheit' || absence.kind === 'Termin' ? absence.kind : 'Abwesend';
    return { runs: [{ text: label, color: MUTED }], fill: ABSENT_FILL };
  }

  if (!session) {
    if (day.weekday === 5) return { runs: [{ text: 'nicht übermittelt', style: 'italic', color: MUTED }] };
    if (!daily) return { runs: [{ text: 'keine Angabe', style: 'italic', color: ALERT }] };
    return { runs: [{ text: 'nicht erfasst', style: 'italic', color: MUTED }] };
  }

  const { start, end, netMinutes } = sessionTimes(session);
  if (!end) {
    return {
      runs: [
        { text: `ab ${start.toFormat('HH:mm')}` },
        { text: day.weekday === 5 ? 'Ende nicht übermittelt' : 'nicht abgeschlossen', style: 'italic', size: 7.2, color: MUTED }
      ]
    };
  }

  const runs: Run[] = [
    { text: `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}` },
    { text: hoursText(netMinutes), style: 'bold' },
    { text: `Pause ${session.pauseMinutes ?? 0} min`, size: 7.2, color: MUTED }
  ];
  if (end.toISODate() !== start.toISODate()) runs.push({ text: 'bis Folgetag', style: 'italic', size: 7.2, color: MUTED });
  return { runs };
}

function netMinutesInWeek(week: WeekData, memberId: string): number {
  return weekDays(week).reduce((sum, day) => {
    const record = dayRecord(week, memberId, day);
    if (!record.session || (record.absence && !record.daily)) return sum;
    return sum + sessionTimes(record.session).netMinutes;
  }, 0);
}

function drawTitleBlock(pdf: Pdf, week: WeekData): void {
  const { doc } = pdf;
  const { start, end, date } = week;
  doc.y = MARGIN.top;

  setFont(doc, 'bold', 24, INK);
  doc.text('Wochenbericht', MARGIN.left, doc.y, { width: contentWidth(doc) });
  doc.y += 2;
  setFont(doc, 'regular', 12, BIB_BLUE);
  doc.text(`Kalenderwoche ${start.weekNumber} · ${start.toFormat('dd.MM.')} – ${end.toFormat('dd.MM.yyyy')}`, MARGIN.left, doc.y, {
    width: contentWidth(doc)
  });
  doc.y += 16;

  const meta: [string, string][] = [
    ['Projekt', 'Hauptprojekt'],
    ['Team', config.members.map((member) => member.name).join(', ')],
    ['Erstellt', `${formatDate(date)}, ${date.toFormat('HH:mm')} Uhr`]
  ];
  for (const [label, value] of meta) {
    const y = doc.y;
    setFont(doc, 'bold', SMALL_SIZE, MUTED);
    doc.text(label, MARGIN.left, y + 1, { width: GRID_DATE_WIDTH, lineBreak: false });
    setFont(doc, 'regular', BODY_SIZE, INK);
    doc.text(value, MARGIN.left + GRID_DATE_WIDTH, y, { width: contentWidth(doc) - GRID_DATE_WIDTH });
    doc.y = y + 14;
  }

  doc.y += 8;
  doc.moveTo(MARGIN.left, doc.y).lineTo(MARGIN.left + contentWidth(doc), doc.y).lineWidth(0.8).strokeColor(BIB_BLUE).stroke();
  doc.y += 6;
}

function drawAttendance(pdf: Pdf, week: WeekData): void {
  const { doc } = pdf;
  drawChapter(pdf, 1, 'Anwesenheit und Arbeitszeiten');

  const days = weekDays(week);
  const sumWidth = 62;
  const dayWidth = (contentWidth(doc) - GRID_DATE_WIDTH - sumWidth) / days.length;
  const columns: TableColumn[] = [
    { title: 'Name', width: GRID_DATE_WIDTH },
    ...days.map((day): TableColumn => ({ title: shortDate(day), width: dayWidth, align: 'center' })),
    { title: 'Summe', width: sumWidth, align: 'right' }
  ];
  const rows = config.members.map((member): TableCell[] => {
    const total = netMinutesInWeek(week, member.discordId);
    return [
      { runs: [{ text: member.name, style: 'bold' }] },
      ...days.map((day) => workCell(dayRecord(week, member.discordId, day))),
      { runs: [{ text: total > 0 ? hoursText(total) : '–', style: 'bold' }] }
    ];
  });
  drawTable(pdf, columns, rows);
  doc.y += 5;
  drawNote(pdf, 'Je Tag: Beginn–Ende, Arbeitszeit netto (nach Abzug der Pause), Pause. Summe = Netto-Arbeitszeit der Woche.');

  doc.y += 6;
  const missing = missingDocumentation(week);
  const unavailable = config.members.filter((member) => week.unavailableMemberIds.has(member.discordId));
  const absences = [...week.absences].sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());

  const lines: { label: string; text: string; color?: string }[] = [
    ...absences.map((absence) => ({
      label: 'Abwesend',
      text: `${absence.ownerName}, ${shortDate(absence.createdAt)}: ${absenceLabel(absence)}`
    })),
    ...missing.map((entry) => ({
      label: 'Ohne Daily',
      text: `${entry.name}, ${shortDate(entry.day)}: weder Daily noch Abmeldung dokumentiert`,
      color: ALERT
    })),
    ...unavailable.map((member) => ({
      label: 'Hinweis',
      text: `Das Daily-Forum von ${member.name} konnte beim Erstellen nicht gelesen werden.`,
      color: ALERT
    }))
  ];
  if (missing.length === 0 && unavailable.length === 0) {
    lines.push({ label: 'Dailies', text: 'Für alle bisher fälligen Projekttage liegt ein Daily oder eine Abmeldung vor.' });
  }

  for (const line of lines) {
    const y = doc.y;
    setFont(doc, 'bold', SMALL_SIZE, MUTED);
    doc.text(line.label, MARGIN.left, y + 0.8, { width: GRID_DATE_WIDTH, lineBreak: false });
    setFont(doc, 'regular', BODY_SIZE - 0.4, line.color ?? INK);
    doc.text(pdfText(line.text), MARGIN.left + GRID_DATE_WIDTH, y, { width: contentWidth(doc) - GRID_DATE_WIDTH, lineGap: 1 });
    doc.y += 3;
  }
}

function drawActivities(pdf: Pdf, week: WeekData): void {
  const { doc } = pdf;
  drawChapter(pdf, 2, 'Tätigkeiten');
  drawNote(pdf, 'Erledigt: seit dem letzten Daily abgeschlossen · Geplant: Vorhaben für den jeweiligen Tag, laut Daily Scrum.');

  config.members.forEach((member, index) => {
    drawSubheading(pdf, `2.${index + 1}`, member.name);

    if (week.unavailableMemberIds.has(member.discordId)) {
      drawNote(pdf, 'Das Daily-Forum konnte beim Erstellen des Berichts nicht gelesen werden.', ALERT);
      return;
    }

    for (const day of weekDays(week)) {
      const { daily, absence, isFuture } = dayRecord(week, member.discordId, day);
      if (isFuture) continue;

      if (absence && !daily) {
        const entry = startGridEntry(pdf, shortDate(day), undefined, 14);
        drawGridRow(pdf, 'Abwesend', absenceLabel(absence), { textColor: MUTED });
        endGridEntry(pdf, entry);
        continue;
      }

      if (!daily) {
        const entry = startGridEntry(pdf, shortDate(day), undefined, 14);
        drawGridRow(pdf, 'Status', 'Weder Daily noch Abmeldung dokumentiert.', { textColor: ALERT });
        endGridEntry(pdf, entry);
        continue;
      }

      const done = section(daily.content, ['Seit dem letzten Daily', 'Gestern']);
      const planned = section(daily.content, ['Heute']);
      const blockers = section(daily.content, ['Blocker']);

      const entry = startGridEntry(pdf, shortDate(day), `Daily ${daily.createdAt.toFormat('HH:mm')}`, 30);
      drawGridRow(pdf, 'Erledigt', done.length > 0 ? done : ['–']);
      doc.y += 4;
      drawGridRow(pdf, 'Geplant', planned.length > 0 ? planned : ['–']);
      if (isRealBlocker(blockers)) {
        doc.y += 4;
        drawGridRow(pdf, 'Blocker', blockers, { labelColor: ALERT });
      }
      endGridEntry(pdf, entry);
    }
  });
}

function drawMeetings(pdf: Pdf, week: WeekData): void {
  const { doc } = pdf;
  drawChapter(pdf, 3, 'Meetings');

  if (week.meetings.length === 0) {
    drawNote(pdf, 'Keine Meetings in dieser Woche.');
    return;
  }

  for (const meeting of week.meetings) {
    const start = DateTime.fromISO(meeting.startAt, { zone: config.timezone });
    const end = DateTime.fromISO(meeting.endAt, { zone: config.timezone });
    const time = end.isValid ? `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}` : start.toFormat('HH:mm');
    const participants = meeting.participantIds?.length
      ? meeting.participantIds.map(memberName).join(', ')
      : config.members.map((member) => member.name).join(', ');

    const entry = startGridEntry(pdf, shortDate(start), time, 30);
    drawGridRow(pdf, 'Thema', meeting.title, { bold: true });
    drawGridRow(pdf, 'Ort', meeting.venueLabel);
    drawGridRow(pdf, 'Teilnehmer', participants);
    if (meeting.agenda?.trim()) drawGridRow(pdf, 'Agenda', meeting.agenda.trim());

    for (const note of week.notes.filter((entry) => entry.messageId === meeting.messageId)) {
      if (note.discussed.trim()) drawGridRow(pdf, 'Protokoll', note.discussed.trim());
      const decisions = cleanLines(note.decisions);
      if (decisions.length > 0) drawGridRow(pdf, 'Entscheidungen', decisions);
      const tasks = cleanLines(note.tasks);
      if (tasks.length > 0) drawGridRow(pdf, 'Aufgaben', tasks);
    }
    endGridEntry(pdf, entry);
  }

  if (week.tasks.length > 0) {
    doc.y += 8;
    ensureSpace(pdf, 60);
    setFont(doc, 'bold', BODY_SIZE, INK);
    doc.text('Aufgaben aus Meetings', MARGIN.left, doc.y, { width: contentWidth(doc) });
    doc.y += 5;
    drawTable(
      pdf,
      [
        { title: 'Person', width: GRID_DATE_WIDTH },
        { title: 'Aufgabe', width: contentWidth(doc) - GRID_DATE_WIDTH }
      ],
      week.tasks.map((task) => [
        { runs: [{ text: memberName(task.ownerId) }] },
        { runs: [{ text: pdfText(task.title) }] }
      ])
    );
  }
}

function drawDecisions(pdf: Pdf, week: WeekData): void {
  const { doc } = pdf;
  drawChapter(pdf, 4, 'Entscheidungen');

  if (week.decisions.length === 0) {
    drawNote(pdf, 'Keine Projektentscheidungen in dieser Woche.');
    return;
  }

  const rest = contentWidth(doc) - GRID_DATE_WIDTH;
  drawTable(
    pdf,
    [
      { title: 'Datum', width: GRID_DATE_WIDTH },
      { title: 'Entscheidung', width: rest * 0.55 },
      { title: 'Begründung', width: rest * 0.45 }
    ],
    week.decisions.map((decision) => [
      { runs: [{ text: shortDate(DateTime.fromISO(decision.createdAt, { zone: config.timezone })) }] },
      { runs: [{ text: pdfText(decision.title), style: 'bold' }, { text: pdfText(decision.decision) }] },
      { runs: [{ text: decision.reason ? pdfText(decision.reason) : '–', color: decision.reason ? INK : MUTED }] }
    ])
  );
}

function drawBlockers(pdf: Pdf, week: WeekData): void {
  const { doc } = pdf;
  drawChapter(pdf, 5, 'Probleme und Blocker');

  type Row = { date: DateTime; ownerId: string; text: string; blocker?: ProjectBlocker };
  const rows: Row[] = [];
  const seen = new Set<string>();
  const add = (row: Row): void => {
    const key = `${row.ownerId}:${normalizedText(row.text)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  // Daily-Blocker werden beim Absenden als Projekt-Blocker gespeichert; der Status kommt von dort.
  const tracked = (ownerId: string, text: string, reportedAt: DateTime): ProjectBlocker | undefined =>
    week.allProjectBlockers
      .filter((blocker) => blocker.ownerId === ownerId && normalizedText(blocker.text) === normalizedText(text))
      .filter((blocker) => DateTime.fromISO(blocker.createdAt, { zone: config.timezone }) <= reportedAt.plus({ hours: 1 }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  for (const entry of week.entries) {
    const blockers = section(entry.content, ['Blocker']);
    if (!isRealBlocker(blockers)) continue;
    for (const text of blockers) {
      add({ date: entry.createdAt, ownerId: entry.ownerId, text, blocker: tracked(entry.ownerId, text, entry.createdAt) });
    }
  }
  for (const blocker of week.projectBlockers) {
    add({ date: DateTime.fromISO(blocker.createdAt, { zone: config.timezone }), ownerId: blocker.ownerId, text: blocker.text, blocker });
  }

  if (rows.length === 0) {
    drawNote(pdf, 'Keine Blocker in dieser Woche.');
    return;
  }

  const statusRun = (blocker?: ProjectBlocker): Run => {
    if (!blocker) return { text: '–', color: MUTED };
    if (blocker.status === 'open') return { text: 'offen', style: 'bold', color: ALERT };
    const resolved = blocker.resolvedAt ? DateTime.fromISO(blocker.resolvedAt, { zone: config.timezone }) : undefined;
    return { text: resolved?.isValid ? `gelöst ${resolved.toFormat('dd.MM.')}` : 'gelöst', color: MUTED };
  };

  const statusWidth = 70;
  drawTable(
    pdf,
    [
      { title: 'Gemeldet', width: GRID_DATE_WIDTH },
      { title: 'Person', width: GRID_LABEL_WIDTH },
      { title: 'Blocker', width: contentWidth(doc) - GRID_DATE_WIDTH - GRID_LABEL_WIDTH - statusWidth },
      { title: 'Status', width: statusWidth }
    ],
    rows
      .sort((a, b) => a.date.toMillis() - b.date.toMillis())
      .map((row) => [
        { runs: [{ text: shortDate(row.date) }] },
        { runs: [{ text: memberName(row.ownerId) }] },
        { runs: [{ text: pdfText(row.text) }] },
        { runs: [statusRun(row.blocker)] }
      ])
  );
}

function drawPageFrame(pdf: Pdf, week: WeekData): void {
  const { doc } = pdf;
  const range = doc.bufferedPageRange();
  const total = range.count;
  const right = doc.page.width - MARGIN.right;
  const logoBox = { width: 96, height: 36, top: 12 * MM };
  let logoAvailable = existsSync(logoPath);
  if (!logoAvailable) console.warn(`[Weekly PDF] Logo fehlt: ${logoPath}`);

  for (let index = 0; index < total; index++) {
    doc.switchToPage(range.start + index);
    // Kopf- und Fußzeile liegen außerhalb des Satzspiegels; ohne Rand gibt es keinen automatischen Seitenumbruch.
    const margins = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

    if (logoAvailable) {
      try {
        doc.image(logoPath, right - logoBox.width, logoBox.top, {
          fit: [logoBox.width, logoBox.height],
          align: 'right',
          valign: 'bottom'
        });
      } catch (error) {
        console.warn(`[Weekly PDF] Logo konnte nicht eingebettet werden: ${logoPath}`, error);
        logoAvailable = false;
      }
    }

    const chapter = pdf.pageChapters[index];
    if (index > 0 && chapter) {
      setFont(doc, 'regular', SMALL_SIZE, MUTED);
      doc.text(chapter, MARGIN.left, logoBox.top + logoBox.height - 9, { width: contentWidth(doc) - logoBox.width - 10, lineBreak: false });
    }

    const footerY = doc.page.height - 14 * MM;
    doc.moveTo(MARGIN.left, footerY - 6).lineTo(right, footerY - 6).lineWidth(0.5).strokeColor(RULE).stroke();
    setFont(doc, 'regular', 7.5, MUTED);
    doc.text(
      `Wochenbericht KW ${week.start.weekNumber} / ${week.start.weekYear} · Team ${config.members.map((member) => member.name).join(', ')}`,
      MARGIN.left,
      footerY,
      { width: contentWidth(doc) - 80, lineBreak: false }
    );
    setFont(doc, 'regular', 8.5, INK);
    doc.text(`Seite ${index + 1} von ${total}`, right - 80, footerY - 1, { width: 80, align: 'right', lineBreak: false });

    doc.page.margins = margins;
  }
}

async function renderPdf(week: WeekData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    lang: 'de-DE',
    displayTitle: true,
    info: {
      Title: `Wochenbericht KW ${week.start.weekNumber} / ${week.start.weekYear}`,
      Author: config.members.map((member) => member.name).join(', '),
      Subject: `Hauptprojekt · ${formatDate(week.start)} - ${formatDate(week.end)}`
    }
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pdf: Pdf = { doc, pageChapters: [''], chapter: '' };
  doc.on('pageAdded', () => pdf.pageChapters.push(pdf.chapter));

  drawTitleBlock(pdf, week);
  drawAttendance(pdf, week);
  drawActivities(pdf, week);
  drawMeetings(pdf, week);
  drawDecisions(pdf, week);
  drawBlockers(pdf, week);
  drawPageFrame(pdf, week);

  doc.end();
  return done;
}

export async function weeklyReportAttachments(
  entries: DailyLike[],
  absences: AbsenceLike[],
  unavailableMemberIds = new Set<string>(),
  date = DateTime.now().setZone(config.timezone)
): Promise<AttachmentBuilder[]> {
  const week = collectWeek(entries, absences, unavailableMemberIds, date);
  const stem = `Wochenbericht_KW${String(week.start.weekNumber).padStart(2, '0')}_${week.start.weekYear}`;
  const pdf = await renderPdf(week);
  return [
    new AttachmentBuilder(Buffer.from(renderMarkdown(week), 'utf8'), { name: `${stem}.md` }),
    new AttachmentBuilder(pdf, { name: `${stem}.pdf` })
  ];
}
