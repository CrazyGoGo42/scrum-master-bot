// Entscheidet für scripts/night-shutdown.sh, ob der Server jetzt herunterfahren darf.
// Gibt "shutdown" oder "wait" aus (plus Grund). Liest nur die Dateien des Bots, ändert nichts.
//
// Regeln (Nachtabfrage um 22:50, siehe work-tracking.ts):
// - Vor 23:00 nur herunterfahren, wenn jemand mit „Nein, Feierabend“ geantwortet hat und niemand mehr arbeitet.
// - Wer noch nicht geantwortet hat: bis 10 Minuten nach der Frage warten.
// - Wer „Ja“ gesagt hat: warten, bis seine Arbeitszeit mit Ende/Stop beendet ist.
// - Hat der Bot nicht gefragt (z. B. lief er nicht): warten, solange eine Arbeitszeit offen ist.
// Spätestens um 04:00 fährt night-shutdown.sh ohne diese Prüfung herunter.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = process.argv[2] || path.join(process.cwd(), 'data');
const read = (file, fallback) => {
  const full = path.join(dataDir, file);
  try {
    return existsSync(full) ? JSON.parse(readFileSync(full, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};

const now = process.env.NIGHT_NOW ? Date.parse(process.env.NIGHT_NOW) : Date.now(); // NIGHT_NOW nur zum Testen
const sessions = read('work-sessions.json', {}).sessions ?? [];
// Wie im Bot: länger als 16 Stunden offen = vergessenes Ende, hält den Server nicht wach.
const working = new Set(
  sessions.filter((s) => !s.endAt && now - Date.parse(s.startAt) <= 16 * 3600 * 1000).map((s) => s.userId)
);

let night = read('night-shutdown.json', undefined);
if (night && now - Date.parse(night.askedAt) > 12 * 3600 * 1000) night = undefined;

const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Berlin' }).format(now));
const beforeEleven = hour === 22;

function decide() {
  if (!night) return working.size > 0 ? ['wait', 'Arbeitszeit offen, keine Nachtabfrage'] : beforeEleven ? ['wait', 'vor 23:00'] : ['shutdown', 'niemand arbeitet'];
  const staying = night.staying.filter((id) => working.has(id));
  if (staying.length > 0) return ['wait', `arbeitet noch: ${staying.join(', ')}`];
  const unanswered = night.waiting.filter((id) => working.has(id));
  const deadline = Date.parse(night.askedAt) + 10 * 60 * 1000;
  if (unanswered.length > 0 && now < deadline) return ['wait', `wartet auf Antwort: ${unanswered.join(', ')}`];
  if (beforeEleven && night.declined.length === 0 && unanswered.length === 0) return ['wait', 'vor 23:00'];
  return ['shutdown', unanswered.length > 0 ? 'keine Antwort in 10 Minuten' : 'niemand arbeitet mehr'];
}

const [decision, reason] = decide();
console.log(`${decision} ${reason}`);
