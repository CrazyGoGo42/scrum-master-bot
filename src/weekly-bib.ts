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
  provenance?: 'daily' | 'manual-exact' | 'manual-estimated';
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

function workText(session: WorkSession | undefined, hasDaily: boolean): string {
  if (!session) return hasDaily ? 'Nicht erfasst (Altbestand vor Arbeitszeiterfassung)' : 'Keine Arbeitszeit erfasst';
  const start = DateTime.fromISO(session.startAt, { zone: config.timezone });
  const end = session.endAt ? DateTime.fromISO(session.endAt, { zone: config.timezone }) : undefined;
  if (!end?.isValid) return `${start.toFormat('HH:mm')} Uhr - noch nicht abgeschlossen`;
  const gross = Math.round(end.diff(start, 'minutes').minutes);
  const net = Math.max(0, gross - Math.max(0, session.pauseMinutes ?? 0));
  const qualifier = session.provenance === 'manual-estimated'
    ? ' · nachgetragen, geschätzt'
    : session.provenance === 'manual-exact'
      ? ' · nachgetragen'
      : '';
  return `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')} Uhr · Pause ${session.pauseMinutes ?? 0} min · ${durationText(net)}${qualifier}`;
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
    '## 1. Wochenüberblick',
    `In dieser Woche wurden ${weekEntries.length} Daily Scrum${weekEntries.length === 1 ? '' : 's'}, ${weekAbsences.length} Abmeldung${weekAbsences.length === 1 ? '' : 'en'} und ${weekMeetings.length} Meeting${weekMeetings.length === 1 ? '' : 's'} dokumentiert.`,
    'Der Bericht basiert ausschließlich auf den im Scrum-Master-Bot dokumentierten Projektinformationen. Fehlende Angaben werden nicht erfunden.',
    '',
    '## 2. Tätigkeiten und Arbeitszeiten'
  ];

  for (const member of config.members) {
    out.push('', `### ${member.name}`);
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
        if (session) out.push(`**Arbeitszeit:** ${workText(session, false)}`);
        continue;
      }

      const done = section(daily.content, ['Seit dem letzten Daily', 'Gestern']);
      const planned = section(daily.content, ['Heute']);
      const blockers = section(daily.content, ['Blocker']);
      const branch = daily.content.match(/^- Branch:\s*(.+)$/im)?.[1]?.trim();

      out.push(`**Daily:** ${daily.createdAt.toFormat('HH:mm')} Uhr`);
      out.push(`**Arbeitszeit:** ${workText(session, true)}`);
      if (branch) out.push(`**Branch:** ${branch}`);
      out.push('**Dokumentierte Tätigkeiten seit dem letzten Daily:**', ...markdownBullets(done, 'Keine abgeschlossenen Tätigkeiten angegeben.'));
      out.push('**Geplant für diesen Tag:**', ...markdownBullets(planned, 'Keine Planung angegeben.'));
      if (isRealBlocker(blockers)) out.push('**Blocker:**', ...markdownBullets(blockers));
    }
  }

  if (weekMeetings.length > 0) {
    out.push('', '## 3. Meetings');
    for (const meeting of weekMeetings) {
      const meetingStart = DateTime.fromISO(meeting.startAt, { zone: config.timezone });
      const participants = meeting.participantIds?.length
        ? meeting.participantIds.map(memberName).join(', ')
        : config.members.map((member) => member.name).join(', ');
      out.push('', `### ${meeting.title} · ${formatDate(meetingStart)} · ${meetingStart.toFormat('HH:mm')} Uhr`);
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

  if (weekDecisions.length > 0) {
    out.push('', '## 4. Projektentscheidungen');
    for (const decision of weekDecisions) {
      out.push(`- **${decision.title}:** ${decision.decision}${decision.reason ? ` · Begründung: ${decision.reason}` : ''}`);
    }
  }

  const dailyBlockers = weekEntries.flatMap((entry) => {
    const blockers = section(entry.content, ['Blocker']);
    return isRealBlocker(blockers) ? blockers.map((text) => ({ ownerId: entry.ownerId, text })) : [];
  });
  if (dailyBlockers.length > 0 || weekProjectBlockers.length > 0) {
    out.push('', '## 5. Probleme und Blocker');
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

  if (weekAbsences.length > 0) {
    out.push('', '## 6. Abwesenheiten und Abweichungen');
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

  out.push(
    '',
    '## 9. Nachweisgrundlage',
    '- Daily-Scrum-Einträge und Abmeldungen aus den persönlichen Discord-Foren',
    '- dokumentierte Arbeitszeiten aus der Arbeitszeiterfassung',
    '- Meeting-Historie sowie tatsächlich eingetragene Protokolle, Aufgaben und Entscheidungen',
    '- dokumentierte Projektentscheidungen und Blocker',
    '',
    '_Automatisch aus den dokumentierten Projektdaten erstellt. Angaben werden nicht ergänzt oder erfunden. Bitte vor der Weitergabe an den projektbetreuenden Dozenten kurz prüfen._'
  );

  return out.join('\n');
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/, '• ')
    .replace(/^_([^_]+)_$/, '$1');
}

async function markdownToPdf(markdown: string, date: DateTime): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 56, left: 54, right: 54 }, info: { Title: `Wochenbericht KW ${date.weekNumber}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  let page = 1;
  const footer = () => {
    const previousY = doc.y;
    doc.font('Helvetica').fontSize(8).text(`Hauptprojekt · Wochenbericht · Seite ${page}`, 54, 805, { width: 487, align: 'center' });
    doc.y = previousY;
  };
  doc.on('pageAdded', () => {
    page += 1;
    footer();
  });

  if (existsSync(logoPath)) {
    try {
      doc.image(logoPath, 54, 42, { fit: [250, 78] });
      doc.moveDown(5.1);
    } catch (error) {
      console.warn(`[Weekly PDF] Logo konnte nicht eingebettet werden: ${logoPath}`, error);
    }
  } else {
    console.warn(`[Weekly PDF] Logo fehlt: ${logoPath}`);
  }

  const lines = markdown.split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      doc.moveDown(0.45);
      continue;
    }

    if (line.startsWith('# ')) {
      doc.font('Helvetica-Bold').fontSize(20).text(stripMarkdown(line.slice(2)), { align: 'left' });
      doc.moveDown(0.4);
      continue;
    }
    if (line.startsWith('## ')) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(14).text(stripMarkdown(line.slice(3)));
      doc.moveDown(0.25);
      continue;
    }
    if (line.startsWith('### ')) {
      doc.moveDown(0.35);
      doc.font('Helvetica-Bold').fontSize(11.5).text(stripMarkdown(line.slice(4)));
      doc.moveDown(0.15);
      continue;
    }
    if (line.startsWith('#### ')) {
      doc.font('Helvetica-Bold').fontSize(10.5).text(stripMarkdown(line.slice(5)));
      continue;
    }
    if (line.startsWith('- ')) {
      doc.font('Helvetica').fontSize(9.7).text(stripMarkdown(line), { indent: 12, paragraphGap: 2 });
      continue;
    }

    const isLabel = /^\*\*[^*]+:\*\*/.test(line);
    doc.font(isLabel ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.7).text(stripMarkdown(line), { paragraphGap: 3, lineGap: 1 });
  }

  footer();
  doc.end();
  return done;
}

export async function weeklyReportAttachments(markdown: string, date = DateTime.now().setZone(config.timezone)): Promise<AttachmentBuilder[]> {
  const week = String(date.weekNumber).padStart(2, '0');
  const stem = `Wochenbericht_KW${week}_${date.weekYear}`;
  const pdf = await markdownToPdf(markdown, date);
  return [
    new AttachmentBuilder(Buffer.from(markdown, 'utf8'), { name: `${stem}.md` }),
    new AttachmentBuilder(pdf, { name: `${stem}.pdf` })
  ];
}
