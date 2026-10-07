// Aufzählungen in Freitext (Daily, Blocker, Meeting-Protokoll).
//
// Ein neuer Punkt beginnt nur mit einem Spiegelstrich am Zeilenanfang, gefolgt von einem Leerzeichen:
// "- ", "* ", "• ", "– " oder "— ". Zeilen ohne Spiegelstrich gehören zum Punkt darüber, auch nach
// einer Leerzeile. Bindestriche im Satz ("very-well-designed", "Blocker - Test") trennen nichts.
// Text ohne jeden Spiegelstrich ist genau ein Punkt.

const BULLET = /^\s*[-*•–—]\s+/;

/**
 * Zerlegt Freitext in Punkte. Zeilenumbrüche innerhalb eines Punkts bleiben erhalten, Leerzeilen nicht.
 * `onePerLine` liest Texte aus der Zeit, als jede Zeile ein eigener Punkt war (ältere Meeting-Protokolle).
 */
export function parseItems(value: string | undefined, onePerLine = false): string[] {
  if (!value?.trim()) return [];
  const lines = value.replace(/\r\n?/g, '\n').split('\n');

  if (onePerLine) {
    return lines.map((line) => line.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);
  }

  const items: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^\s*[-*•–—]\s*$/.test(line)) continue; // nur ein Strich: leer, z. B. „-“ für „nichts“
    if (BULLET.test(line)) {
      current = [line.replace(BULLET, '').trim()];
      items.push(current);
    } else if (line.trim()) {
      if (!current) {
        current = [];
        items.push(current);
      }
      current.push(line.trim());
    }
  }
  return items.map((item) => item.filter(Boolean).join('\n')).filter(Boolean);
}

/** Punkte als Markdown-Liste. Folgezeilen eines Punkts sind eingerückt, damit sie zum Punkt gehören. */
export function bulletList(items: string[]): string {
  return items.map((item) => `- ${item.split('\n').join('\n  ')}`).join('\n');
}

export function itemsAsBullets(value: string, empty = ''): string {
  const items = parseItems(value);
  return items.length ? bulletList(items) : empty;
}

/** Text fürs Bearbeiten-Formular: mehrere Punkte mit Spiegelstrich, ein einzelner Punkt ohne. */
export function itemsForEditing(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return items.map((item) => `- ${item}`).join('\n');
}

/** Ein Punkt in einer Zeile, z. B. für die Blocker-Liste. */
export function singleLine(item: string): string {
  return item.replace(/\s*\n\s*/g, ' ').trim();
}
