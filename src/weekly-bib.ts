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
  provenance?: 'daily' | 'clock' | 'manual-exact' | 'manual-estimated';
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

const projectStatePath = process.env.PROJECT_STATE_FILE || path.join(process.cwd(), 'data', 'project-state.json');
const meetingHistoryPath = process.env.MEETING_HISTORY_FILE || path.join(process.cwd(), 'data', 'meeting-history.json');
const workStatePath = process.env.WORK_TRACKING_FILE || path.join(process.cwd(), 'data', 'work-sessions.json');
const logoPath = process.env.WEEKLY_REPORT_LOGO_PATH || path.join(process.cwd(), 'assets', 'BIB_Logo_4c1.jpg');

const PAGE_LEFT = 54;
const PAGE_RIGHT = 54;
const PAGE_TOP = 60;
const PAGE_BOTTOM = 62;
const TEXT_DARK = '#171717';
const TEXT_MUTED = '#666666';
const RULE = '#D5D5D5';
const PANEL = '#F2F2F2';

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

function workText(session: WorkSession | undefined, hasDaily: boolean, day: DateTime): string {
  if (!session) {
    if (day.weekday === 5) return 'Nicht übermittelt';
    return hasDaily ? 'Nicht erfasst (Altbestand vor Arbeitszeiterfassung)' : 'Keine Arbeitszeit erfasst';
  }

  const start = DateTime.fromISO(session.startAt, { zone: config.timezone });
  const end = session.endAt ? DateTime.fromISO(session.endAt, { zone: config.timezone }) : undefined;
  if (!end?.isValid) {
    if (day.weekday === 5) return 'Nicht übermittelt';
    return `${start.toFormat('HH:mm')} Uhr - noch nicht abgeschlossen`;
  }

  const gross = Math.round(end.diff(start, 'minutes').minutes);
  const net = Math.max(0, gross - Math.max(0, session.pauseMinutes ?? 0));
  const qualifier = session.provenance === 'manual-estimated'
    ? ' · nachgetragen, geschätzt'
    : session.provenance === 'manual-exact'
      ? ' · nachgetragen'
      : '';
  const nextDay = end.toISODate() !== start.toISODate() ? ' (+1 Tag)' : '';
  return `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}${nextDay} Uhr · Pause ${session.pauseMinutes ?? 0} min · ${durationText(net)}${qualifier}`;
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

export function buildBibWeeklyReport(
  entries: DailyLike[],
  absences: AbsenceLike[],
  unavailableMemberIds = new Set<string>(),
  date = DateTime.now().setZone(config.timezone)
): string {
  const { start, end } = weekRange(date);
  const work = readJson<WorkState>(workStatePath, {});
  const history = readJson<MeetingHistory>(meetingHistoryPath, {});
  const project = readJson<ProjectState>(projectStatePath, {});

  const weekEntries = entries.filter((entry) => entry.createdAt >= start && entry.createdAt <= end);
  const weekAbsences = absences.filter((entry) => entry.createdAt >= start && entry.createdAt <= end);
  const weekSessions = (work.sessions ?? []).filter((session) => inRange(`${session.date}T12:00:00`, start, end));
  const weekMeetings = (history.meetings ?? [])
    .filter((meeting) => inRange(meeting.startAt, start, end))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const weekNotes = (project.meetingNotes ?? []).filter((note) => inRange(note.createdAt, start, end));
  const weekTasks = (project.tasks ?? []).filter((task) => task.source === 'meeting' && inRange(task.createdAt, start, end));
  const weekDecisions = (project.decisions ?? []).filter((decision) => inRange(decision.createdAt, start, end));
  const weekProjectBlockers = (project.blockers ?? []).filter(
    (blocker) => inRange(blocker.createdAt, start, end) || inRange(blocker.resolvedAt, start, end)
  );

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
    `In dieser Woche wurden ${weekEntries.length} Daily Scrum${weekEntries.length === 1 ? '' : 's'}, ${weekAbsences.length} Abmeldung${weekAbsences.length === 1 ? '' : 'en'} und ${weekMeetings.length} Meeting${weekMeetings.length === 1 ? '' : 's'} dokumentiert.`,
    '',
    '## 2. Tätigkeiten und Arbeitszeiten'
  ];

  for (const member of config.members) {
    out.push('', `### ${member.name}`, `**Standard-Branch:** ${standardBranch(member.name)}`);

    if (unavailableMemberIds.has(member.discordId)) {
      out.push('- Das Daily-Forum konnte beim Erstellen des Berichts nicht gelesen werden.');
      continue;
    }

    for (let offset = 0; offset < 5; offset++) {
      const day = start.plus({ days: offset });
      const dateKey = day.toISODate();
      const daily = weekEntries.find((entry) => entry.ownerId === member.discordId && entry.createdAt.toISODate() === dateKey);
      const absence = weekAbsences.find((entry) => entry.ownerId === member.discordId && entry.createdAt.toISODate() === dateKey);
      const session = weekSessions.find((entry) => entry.userId === member.discordId && entry.date === dateKey);

      out.push('', `#### ${weekdayName(day)}, ${formatDate(day)}`);

      if (absence && !daily) {
        out.push(`**Status:** Abgemeldet · ${absenceLabel(absence)}`);
        continue;
      }

      if (!daily) {
        const isFutureWithinPreview = day.startOf('day') > date.startOf('day');
        out.push(isFutureWithinPreview ? '**Status:** Noch nicht erreicht.' : '**Status:** Keine Daily-Dokumentation vorhanden.');
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
  if (weekMeetings.length === 0) {
    out.push('- Keine Meetings dokumentiert.');
  } else {
    for (const meeting of weekMeetings) {
      const meetingStart = DateTime.fromISO(meeting.startAt, { zone: config.timezone });
      const participants = meeting.participantIds?.length
        ? meeting.participantIds.map(memberName).join(', ')
        : config.members.map((member) => member.name).join(', ');
      out.push('', `### ${meeting.title}`);
      out.push(`**Datum / Uhrzeit:** ${formatDate(meetingStart)} · ${meetingStart.toFormat('HH:mm')} Uhr`);
      out.push(`**Ort:** ${meeting.venueLabel}`);
      out.push(`**Teilnehmer / eingeladenes Team:** ${participants}`);
      if (meeting.agenda?.trim()) out.push(`**Agenda:** ${meeting.agenda.trim()}`);

      const notes = weekNotes.filter((note) => note.messageId === meeting.messageId);
      for (const note of notes) {
        if (note.discussed.trim()) out.push('**Protokoll:**', note.discussed.trim());
        const decisions = cleanLines(note.decisions);
        if (decisions.length > 0) out.push('**Entscheidungen im Protokoll:**', ...markdownBullets(decisions));
        const tasks = cleanLines(note.tasks);
        if (tasks.length > 0) out.push('**Aufgaben im Protokoll:**', ...markdownBullets(tasks));
      }
    }

    if (weekTasks.length > 0) {
      out.push('', '### Aufgaben aus Meetings');
      out.push(...weekTasks.map((task) => `- **${task.id} · ${memberName(task.ownerId)}:** ${task.title}`));
    }
  }

  out.push('', '## 4. Projektentscheidungen');
  if (weekDecisions.length === 0) {
    out.push('- Keine Projektentscheidungen dokumentiert.');
  } else {
    for (const decision of weekDecisions) {
      out.push(`- **${decision.title}:** ${decision.decision}${decision.reason ? ` · Begründung: ${decision.reason}` : ''}`);
    }
  }

  const dailyBlockers = weekEntries.flatMap((entry) => {
    const blockers = section(entry.content, ['Blocker']);
    return isRealBlocker(blockers) ? blockers.map((text) => ({ ownerId: entry.ownerId, text })) : [];
  });

  out.push('', '## 5. Probleme und Blocker');
  if (dailyBlockers.length === 0 && weekProjectBlockers.length === 0) {
    out.push('- Keine Blocker dokumentiert.');
  } else {
    const seen = new Set<string>();
    for (const blocker of dailyBlockers) {
      const key = `${blocker.ownerId}:${blocker.text.toLocaleLowerCase('de-DE')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`- **${memberName(blocker.ownerId)}:** ${blocker.text}`);
    }
    for (const blocker of weekProjectBlockers) {
      const key = `${blocker.ownerId}:${blocker.text.toLocaleLowerCase('de-DE')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`- **${memberName(blocker.ownerId)} · ${blocker.status === 'resolved' ? 'gelöst' : 'offen'}:** ${blocker.text}`);
    }
  }

  out.push('', '## 6. Abwesenheiten und Abweichungen');
  if (weekAbsences.length === 0) {
    out.push('- Keine Abwesenheiten dokumentiert.');
  } else {
    for (const absence of weekAbsences) {
      out.push(`- **${absence.ownerName} · ${formatDate(absence.createdAt)}:** ${absenceLabel(absence)}`);
    }
  }

  const missing: string[] = [];
  for (const member of config.members) {
    if (unavailableMemberIds.has(member.discordId)) continue;
    for (let offset = 0; offset < 5; offset++) {
      const day = start.plus({ days: offset });
      if (day.startOf('day') > date.startOf('day')) continue;
      const key = day.toISODate();
      const hasDaily = weekEntries.some((entry) => entry.ownerId === member.discordId && entry.createdAt.toISODate() === key);
      const hasAbsence = weekAbsences.some((entry) => entry.ownerId === member.discordId && entry.createdAt.toISODate() === key);
      if (!hasDaily && !hasAbsence) missing.push(`${member.name}: ${formatDate(day)}`);
    }
  }

  out.push('', '## 7. Dokumentationsstatus');
  if (missing.length === 0) out.push('- Für alle bisher fälligen regulären Projekttage liegt ein Daily oder eine Abmeldung vor.');
  else out.push(...missing.map((entry) => `- Fehlend: **${entry}**`));

  out.push('', '## 8. Stand zum Ende der Woche / nächste Schritte');
  for (const member of config.members) {
    const latest = weekEntries
      .filter((entry) => entry.ownerId === member.discordId)
      .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0];
    const next = latest ? section(latest.content, ['Heute']) : [];
    out.push(`### ${member.name}`, ...markdownBullets(next, 'Keine nächsten Schritte dokumentiert.'));
  }

  return out.join('\n');
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/, '• ')
    .replace(/^_([^_]+)_$/, '$1');
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const limit = doc.page.height - PAGE_BOTTOM;
  if (doc.y + needed > limit) doc.addPage();
}

function labelValue(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  options?: { x?: number; width?: number; fontSize?: number; muted?: boolean }
): void {
  const x = options?.x ?? PAGE_LEFT;
  const width = options?.width ?? doc.page.width - PAGE_LEFT - PAGE_RIGHT;
  const size = options?.fontSize ?? 9.2;
  ensureSpace(doc, 24);
  doc.fillColor(options?.muted ? TEXT_MUTED : TEXT_DARK);
  doc.font('Helvetica-Bold').fontSize(size).text(`${label}: `, x, doc.y, { continued: true, width });
  doc.font('Helvetica').fontSize(size).text(value, { width });
  doc.fillColor(TEXT_DARK);
  doc.moveDown(0.15);
}

function drawBullet(doc: PDFKit.PDFDocument, text: string, x = PAGE_LEFT, width?: number): void {
  const available = width ?? doc.page.width - PAGE_LEFT - PAGE_RIGHT;
  ensureSpace(doc, 26);
  const y = doc.y;
  doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(9.2).text('•', x + 3, y, { width: 10, lineBreak: false });
  doc.font('Helvetica').fontSize(9.2).text(stripMarkdown(text), x + 17, y, {
    width: available - 17,
    lineGap: 1.2,
    paragraphGap: 2
  });
  doc.moveDown(0.08);
}

function drawMainSection(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 54);
  doc.moveDown(0.45);
  const y = doc.y;
  doc.fillColor(TEXT_DARK).font('Helvetica-Bold').fontSize(15).text(title, PAGE_LEFT, y, {
    width: doc.page.width - PAGE_LEFT - PAGE_RIGHT
  });
  doc.moveTo(PAGE_LEFT, doc.y + 4)
    .lineTo(doc.page.width - PAGE_RIGHT, doc.y + 4)
    .lineWidth(0.7)
    .strokeColor(RULE)
    .stroke();
  doc.moveDown(0.5);
}

function drawPanelHeading(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 42);
  doc.moveDown(0.35);
  const y = doc.y;
  const width = doc.page.width - PAGE_LEFT - PAGE_RIGHT;
  doc.roundedRect(PAGE_LEFT, y, width, 24, 3).fill(PANEL);
  doc.fillColor(TEXT_DARK).font('Helvetica-Bold').fontSize(12).text(title, PAGE_LEFT + 9, y + 6, {
    width: width - 18,
    lineBreak: false
  });
  doc.y = y + 30;
}

function drawDayHeading(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 42);
  doc.moveDown(0.32);
  const y = doc.y;
  const width = doc.page.width - PAGE_LEFT - PAGE_RIGHT;
  doc.moveTo(PAGE_LEFT, y)
    .lineTo(PAGE_LEFT + width, y)
    .lineWidth(0.55)
    .strokeColor(RULE)
    .stroke();
  doc.fillColor(TEXT_DARK).font('Helvetica-Bold').fontSize(10.7).text(title, PAGE_LEFT, y + 6, { width });
  doc.moveDown(0.15);
}

async function markdownToPdf(markdown: string, date: DateTime): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE_TOP, bottom: PAGE_BOTTOM, left: PAGE_LEFT, right: PAGE_RIGHT },
    bufferPages: true,
    info: { Title: `Wochenbericht KW ${date.weekNumber}` }
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  if (existsSync(logoPath)) {
    try {
      const logoWidth = 250;
      const x = (doc.page.width - logoWidth) / 2;
      doc.image(logoPath, x, 40, { width: logoWidth });
      doc.y = 40 + 95 + 74;
    } catch (error) {
      console.warn(`[Weekly PDF] Logo konnte nicht eingebettet werden: ${logoPath}`, error);
      doc.y = 90;
    }
  } else {
    console.warn(`[Weekly PDF] Logo fehlt: ${logoPath}`);
    doc.y = 90;
  }

  let onCover = true;
  const lines = markdown.split('\n');

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line) {
      doc.moveDown(onCover ? 0.32 : 0.2);
      continue;
    }

    if (line === '## 1. Wochenüberblick' && onCover) {
      doc.addPage();
      onCover = false;
      drawMainSection(doc, '1. Wochenüberblick');
      continue;
    }

    if (line.startsWith('# ')) {
      doc.fillColor(TEXT_DARK)
        .font('Helvetica-Bold')
        .fontSize(21)
        .text(stripMarkdown(line.slice(2)), PAGE_LEFT, doc.y, {
          width: doc.page.width - PAGE_LEFT - PAGE_RIGHT,
          align: 'center'
        });
      doc.moveDown(1.15);
      continue;
    }

    if (onCover && line === '## Inhaltsverzeichnis') {
      doc.moveDown(0.85);
      doc.fillColor(TEXT_DARK).font('Helvetica-Bold').fontSize(12.5).text('Inhaltsverzeichnis', PAGE_LEFT + 54, doc.y, {
        width: doc.page.width - (PAGE_LEFT + 54) * 2
      });
      doc.moveDown(0.4);
      continue;
    }

    if (line.startsWith('## ')) {
      drawMainSection(doc, stripMarkdown(line.slice(3)));
      continue;
    }

    if (line.startsWith('### ')) {
      drawPanelHeading(doc, stripMarkdown(line.slice(4)));
      continue;
    }

    if (line.startsWith('#### ')) {
      drawDayHeading(doc, stripMarkdown(line.slice(5)));
      continue;
    }

    const labelMatch = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    if (labelMatch) {
      if (onCover) {
        const coverX = PAGE_LEFT + 54;
        const coverWidth = doc.page.width - (PAGE_LEFT + 54) * 2;
        labelValue(doc, labelMatch[1], stripMarkdown(labelMatch[2]), {
          x: coverX,
          width: coverWidth,
          fontSize: 10
        });
      } else {
        const muted = ['Daily', 'Standard-Branch', 'Abweichender Branch', 'Datum / Uhrzeit', 'Ort', 'Teilnehmer / eingeladenes Team'].includes(labelMatch[1]);
        labelValue(doc, labelMatch[1], stripMarkdown(labelMatch[2]), { fontSize: muted ? 8.9 : 9.2, muted });
      }
      continue;
    }

    if (line.startsWith('- ')) {
      if (onCover) {
        const x = PAGE_LEFT + 62;
        drawBullet(doc, line.slice(2), x, doc.page.width - x - (PAGE_RIGHT + 54));
      } else {
        drawBullet(doc, line.slice(2));
      }
      continue;
    }

    ensureSpace(doc, 30);
    doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(onCover ? 10 : 9.35).text(stripMarkdown(line), onCover ? PAGE_LEFT + 54 : PAGE_LEFT, doc.y, {
      width: onCover ? doc.page.width - (PAGE_LEFT + 54) * 2 : doc.page.width - PAGE_LEFT - PAGE_RIGHT,
      lineGap: 1.35,
      paragraphGap: 3
    });
    doc.moveDown(0.12);
  }

  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let index = 0; index < totalPages; index++) {
    doc.switchToPage(range.start + index);
    const width = doc.page.width - PAGE_LEFT - PAGE_RIGHT;

    if (index > 0) {
      doc.fillColor(TEXT_MUTED).font('Helvetica').fontSize(8.2).text(
        `Wochenbericht Hauptprojekt · KW ${date.weekNumber} / ${date.weekYear}`,
        PAGE_LEFT,
        28,
        { width, align: 'left', lineBreak: false }
      );
      doc.moveTo(PAGE_LEFT, 43)
        .lineTo(doc.page.width - PAGE_RIGHT, 43)
        .lineWidth(0.45)
        .strokeColor(RULE)
        .stroke();
    }

    doc.fillColor(TEXT_MUTED).font('Helvetica').fontSize(8).text(
      `Hauptprojekt · Wochenbericht · Seite ${index + 1} von ${totalPages}`,
      PAGE_LEFT,
      doc.page.height - 30,
      { width, align: 'center', lineBreak: false }
    );
  }

  doc.end();
  return done;
}

export async function weeklyReportAttachments(
  markdown: string,
  date = DateTime.now().setZone(config.timezone)
): Promise<AttachmentBuilder[]> {
  const week = String(date.weekNumber).padStart(2, '0');
  const stem = `Wochenbericht_KW${week}_${date.weekYear}`;
  const pdf = await markdownToPdf(markdown, date);
  return [
    new AttachmentBuilder(Buffer.from(markdown, 'utf8'), { name: `${stem}.md` }),
    new AttachmentBuilder(pdf, { name: `${stem}.pdf` })
  ];
}
