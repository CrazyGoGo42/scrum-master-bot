import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/index.js', import.meta.url);
let source = await readFile(file, 'utf8');

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

await writeFile(file, source, 'utf8');
console.log('[info-page patch] Strukturierte Info-Seite wurde in dist/index.js integriert.');
