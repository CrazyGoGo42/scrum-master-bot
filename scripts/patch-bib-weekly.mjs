import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
const weeklyBibFile = new URL('../dist/weekly-bib.js', import.meta.url);
let source = await readFile(file, 'utf8');
let weeklyBibSource = await readFile(weeklyBibFile, 'utf8');

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`[bib-weekly patch] Marker fehlt: ${label}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[bib-weekly patch] Marker ist nicht eindeutig: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

function replaceWeeklyBibRegex(regex, replacement, label) {
  const matches = [...weeklyBibSource.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`[bib-weekly patch] Erwartet genau einen Marker in weekly-bib.js für ${label}, gefunden: ${matches.length}`);
  }
  weeklyBibSource = weeklyBibSource.replace(regex, replacement);
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
    "const report = buildWeeklyReport(scans.daily.entries, scans.absence.entries, scans.unavailableMemberIds);\n    const chunks = splitDiscordText(report);\n    const attachments = await weeklyReportAttachments(report);"
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
  "            await interaction.editReply({\n                content: '📄 Wochenbericht als Markdown-Datei:',\n                files: [weeklyMarkdownAttachment(report)]\n            });",
  "            const attachments = await weeklyReportAttachments(report);\n            await interaction.editReply({\n                content: '📄 Wochenbericht als **Markdown und PDF**:',\n                files: attachments\n            });",
  'Export als Markdown und PDF'
);

source = source
  .replaceAll('Mit `/wochenbericht export` lässt sich derselbe Bericht als **Markdown-Datei** herunterladen.', 'Mit `/wochenbericht export` lässt sich derselbe Bericht als **Markdown- und PDF-Datei** herunterladen.')
  .replaceAll('Markdown-Datei herunterladen', 'Markdown- und PDF-Datei herunterladen');

replaceWeeklyBibRegex(
  /function workText\(session, hasDaily\)\s*\{/,
  'function workText(session, hasDaily, day) {',
  'workText Signatur'
);

replaceWeeklyBibRegex(
  /if \(!session\)\s*return hasDaily \? 'Nicht erfasst \(Altbestand vor Arbeitszeiterfassung\)' : 'Keine Arbeitszeit erfasst';/,
  "if (!session) {\n        if (day?.weekday === 5) return 'Nicht übermittelt';\n        return hasDaily ? 'Nicht erfasst (Altbestand vor Arbeitszeiterfassung)' : 'Keine Arbeitszeit erfasst';\n    }",
  'fehlende Freitags-Arbeitszeit'
);

replaceWeeklyBibRegex(
  /if \(!end\?\.isValid\)\s*return `\$\{start\.toFormat\('HH:mm'\)\} Uhr - noch nicht abgeschlossen`;/,
  "if (!end?.isValid) {\n        if (day?.weekday === 5) return 'Nicht übermittelt';\n        return `${start.toFormat('HH:mm')} Uhr - noch nicht abgeschlossen`;\n    }",
  'offene Freitags-Arbeitszeit'
);

weeklyBibSource = weeklyBibSource
  .replaceAll('workText(session, false)', 'workText(session, false, day)')
  .replaceAll('workText(session, true)', 'workText(session, true, day)');

replaceWeeklyBibRegex(
  /const doc = new PDFDocument\(\{ size: 'A4', margins:/,
  "const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins:",
  'PDF-Seiten puffern'
);

replaceWeeklyBibRegex(
  /\s*let page = 1;\s*const footer = \(\) => \{[\s\S]*?\};\s*doc\.on\('pageAdded', \(\) => \{[\s\S]*?\}\);/,
  '',
  'rekursiven PDF-Footer entfernen'
);

replaceWeeklyBibRegex(
  /\s*footer\(\);\s*doc\.end\(\);/,
  `\n    const pageRange = doc.bufferedPageRange();\n    for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {\n        doc.switchToPage(pageIndex);\n        const previousBottomMargin = doc.page.margins.bottom;\n        doc.page.margins.bottom = 0;\n        doc\n          .font('Helvetica')\n          .fontSize(8)\n          .text(\`Hauptprojekt · Wochenbericht · Seite \${pageIndex - pageRange.start + 1} von \${pageRange.count}\`, 54, doc.page.height - 34, {\n            width: 487,\n            align: 'center',\n            lineBreak: false\n          });\n        doc.page.margins.bottom = previousBottomMargin;\n    }\n\n    doc.end();`,
  'PDF-Footer nachträglich auf alle Seiten schreiben'
);

await writeFile(weeklyBibFile, weeklyBibSource, 'utf8');
await writeFile(file, source, 'utf8');
console.log('[bib-weekly patch] bib-Wochenbericht mit Markdown/PDF, Freitag-Nicht-übermittelt und sicherem Footer wurde in dist integriert.');
