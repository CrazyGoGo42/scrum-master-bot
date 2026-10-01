import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
const infoFile = new URL('../dist/bot-info.js', import.meta.url);
let source = await readFile(file, 'utf8');
let infoSource = await readFile(infoFile, 'utf8');

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`[info-page patch] Marker fehlt: ${label}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`[info-page patch] Marker ist nicht eindeutig: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

replaceOnce(
  "import { config } from './config.js';\n",
  "import { config } from './config.js';\nimport { botInfoPageText } from './bot-info.js';\n",
  'Import'
);

replaceOnce(
  'const chunks = splitDiscordText(`${botInfoText()}\\n\\n${projectInfo}`);',
  'const chunks = splitDiscordText(botInfoPageText());',
  'Info-Inhalt'
);

infoSource = infoSource
  .replaceAll(
    'Der automatische Wochenbericht wird **freitags ab 14:00 Uhr alle 30 Minuten** geprüft.',
    'Der reguläre automatische Wochenbericht wird **freitags ab 14:00 Uhr alle 30 Minuten** geprüft.'
  )
  .replaceAll(
    'Er wird erst erzeugt, wenn der Freitag für alle drei Teammitglieder abgeschlossen dokumentiert ist:',
    'Freitags wird er erst erzeugt, wenn der Freitag für alle drei Teammitglieder abgeschlossen dokumentiert ist:'
  )
  .replaceAll(
    'Wenn eine Freitags-Arbeitszeit wegen Arbeit nach 23:00 Uhr noch offen ist, prüft der Bot **samstags zwischen ungefähr 08:00 und 22:30 Uhr alle 30 Minuten erneut**. Dadurch kann der Wochenbericht nach einem morgendlichen Endzeit-Nachtrag automatisch fertiggestellt werden.',
    'Ist bis Samstag noch kein Wochenbericht entstanden, erstellt der Bot ihn **samstags um 12:00 Uhr in jedem Fall** (Markdown und PDF). Fehlende Dailies, Abmeldungen oder Endzeiten blockieren ihn dann nicht mehr, sondern werden im Bericht als **keine Angabe** bzw. **Nicht übermittelt** gekennzeichnet.'
  );

await writeFile(infoFile, infoSource, 'utf8');
await writeFile(file, source, 'utf8');
console.log('[info-page patch] Strukturierte Info-Seite mit Samstag-Fallback wurde in dist integriert.');
