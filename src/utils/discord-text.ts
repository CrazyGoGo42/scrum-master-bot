// Discord erlaubt höchstens 2000 Zeichen pro Nachricht; 1900 lassen Luft für Formatierung.
export const DISCORD_TEXT_LIMIT = 1900;

/** Zerlegt eine zu lange Zeile möglichst an Leerzeichen, damit kein Text verloren geht. */
function splitLongLine(line: string, maxLength: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > maxLength) {
    const space = rest.lastIndexOf(' ', maxLength);
    const cut = space > 0 ? space : maxLength;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Teilt Text in Nachrichten von höchstens `maxLength` Zeichen: bevorzugt an Leerzeilen, sonst an
 * Zeilenumbrüchen, notfalls an Leerzeichen. Es wird nichts abgeschnitten.
 */
export function splitDiscordText(text: string, maxLength = DISCORD_TEXT_LIMIT): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const block of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${block}` : block;

    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);

    if (block.length <= maxLength) {
      current = block;
      continue;
    }

    current = '';
    for (const line of block.split('\n')) {
      const lineCandidate = current ? `${current}\n${line}` : line;
      if (lineCandidate.length <= maxLength) {
        current = lineCandidate;
        continue;
      }
      if (current) chunks.push(current);
      const parts = splitLongLine(line, maxLength);
      current = parts.pop() ?? '';
      chunks.push(...parts);
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
