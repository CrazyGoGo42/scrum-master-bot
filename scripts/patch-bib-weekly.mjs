import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
let source = await readFile(file, 'utf8');

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`[bib-weekly patch] Marker fehlt: ${label}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[bib-weekly patch] Marker ist nicht eindeutig: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

function patchCreateWeeklyReport() {
  const startMarker = 'async function createWeeklyReport() {';
  const endMarker = '\nasync function weeklyReportJob(';
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error('[bib-weekly patch] Marker fehlt: createWeeklyReport Start');
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error('[bib-weekly patch] Marker fehlt: createWeeklyReport Ende');

  let block = source.slice(start, end);

  const chunksRegex = /const chunks = splitDiscordText\(\s*buildWeeklyReport\(\s*scans\.daily\.entries\s*,\s*scans\.absence\.entries\s*,\s*scans\.unavailableMemberIds\s*\)\s*\);/;
  if (!chunksRegex.test(block)) {
    throw new Error('[bib-weekly patch] Marker fehlt: Wochenbericht Dateien erzeugen');
  }
  block = block.replace(
    chunksRegex,
    "const report = buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);\n    const chunks = splitDiscordText(report);\n    const attachments = await weeklyReportAttachments(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);"
  );

  const messageRegex = /message:\s*\{\s*content:\s*chunks\[0\]\s*\},/;
  if (!messageRegex.test(block)) {
    throw new Error('[bib-weekly patch] Marker fehlt: Markdown und PDF an Wochenbericht anhängen');
  }
  block = block.replace(messageRegex, 'message: { content: chunks[0], files: attachments },');

  source = source.slice(0, start) + block + source.slice(end);
}

replaceOnce(
  "import { config } from './config.js';\n",
  "import { config } from './config.js';\nimport { buildBibWeeklyReport, weeklyReportAttachments } from './weekly-bib.js';\n",
  'Imports'
);

replaceOnce(
  "return report.join('\\n') + weeklyWorkTrackingSection(entries, date) + weeklyProjectReportSection();",
  "return buildBibWeeklyReport(entries, absences, unavailableMemberIds, date);",
  'Bib-Wochenbericht als zentrale Ausgabe'
);

patchCreateWeeklyReport();

replaceOnce(
  "            const report = buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);\n            await interaction.editReply({\n                content: '📄 Wochenbericht als Markdown-Datei:',\n                files: [weeklyMarkdownAttachment(report)]\n            });",
  "            const attachments = await weeklyReportAttachments(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);\n            await interaction.editReply({\n                content: '📄 Aktueller Wochenbericht (nur für dich sichtbar):',\n                files: attachments\n            });",
  'Vorschau als Markdown und PDF'
);

source = source
  .replaceAll('Mit `/wochenbericht export` lässt sich derselbe Bericht als **Markdown-Datei** herunterladen.', 'Mit `/wochenbericht export` lässt sich derselbe Bericht als **Markdown- und PDF-Datei** herunterladen.')
  .replaceAll('Markdown-Datei herunterladen', 'Markdown- und PDF-Datei herunterladen');

await writeFile(file, source, 'utf8');
console.log('[bib-weekly patch] Strukturierter bib-Wochenbericht mit Markdown/PDF wurde in dist/index.js integriert.');
