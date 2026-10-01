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

replaceOnce(
  "    const chunks = splitDiscordText(\n        buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds)\n    );",
  "    const report = buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);\n    const chunks = splitDiscordText(report);\n    const attachments = await weeklyReportAttachments(report);",
  'Wochenbericht Dateien erzeugen'
);

replaceOnce(
  "        message: { content: chunks[0] },",
  "        message: { content: chunks[0], files: attachments },",
  'Markdown und PDF an Wochenbericht anhängen'
);

replaceOnce(
  "            await interaction.editReply({\n                content: '📄 Wochenbericht als Markdown-Datei:',\n                files: [weeklyMarkdownAttachment(report)]\n            });",
  "            const attachments = await weeklyReportAttachments(report);\n            await interaction.editReply({\n                content: '📄 Wochenbericht als **Markdown und PDF**:',\n                files: attachments\n            });",
  'Export als Markdown und PDF'
);

source = source
  .replaceAll('Mit `/wochenbericht export` lässt sich derselbe Bericht als **Markdown-Datei** herunterladen.', 'Mit `/wochenbericht export` lässt sich derselbe Bericht als **Markdown- und PDF-Datei** herunterladen.')
  .replaceAll('Markdown-Datei herunterladen', 'Markdown- und PDF-Datei herunterladen');

await writeFile(file, source, 'utf8');
console.log('[bib-weekly patch] bib-Wochenbericht mit Markdown und PDF wurde in dist/index.js integriert.');
