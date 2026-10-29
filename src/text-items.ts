// Aufzählungen in Freitext (Daily, Blocker, Meeting-Protokoll).
//
// Ein neuer Punkt beginnt nur mit einem Spiegelstrich am Zeilenanfang, gefolgt von einem Leerzeichen:
// "- ", "* ", "• ", "– " oder "— ". Zeilen ohne Spiegelstrich gehören zum Punkt darüber, auch nach
// einer Leerzeile. Weiter eingerückte Spiegelstriche sind Unterpunkte des Punkts darüber.
// Bindestriche im Satz ("very-well-designed", "Blocker - Test") trennen nichts.
// Text ohne jeden Spiegelstrich ist genau ein Punkt.

const BULLET = /^\s*[-*•–—]\s+/;

// Einrückung einer Zeile; ein Tab zählt wie vier Leerzeichen.
function indentOf(line: string): number {
  return (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;
}

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
  let currentIndent = 0;
  for (const line of lines) {
    if (/^\s*[-*•–—]\s*$/.test(line)) continue; // nur ein Strich: leer, z. B. „-“ für „nichts“
    if (current && BULLET.test(line) && indentOf(line) >= currentIndent + 2) {
      // Weiter eingerückt als der Punkt darüber: Unterpunkt, kein neuer Punkt.
      current.push(line.trim());
    } else if (BULLET.test(line)) {
      currentIndent = indentOf(line);
      current = [line.replace(BULLET, '').trim()];
      items.push(current);
    } else if (line.trim()) {
      if (!current) {
        currentIndent = indentOf(line);
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
  // Unterpunkte bleiben eingerückt, sonst würden sie beim Speichern zu eigenen Punkten.
  const indentSubItems = (item: string): string =>
    item.split('\n').map((line, index) => (index > 0 && BULLET.test(line) ? `  ${line}` : line)).join('\n');
  if (items.length <= 1) return indentSubItems(items[0] ?? '');
  return items.map((item) => `- ${indentSubItems(item)}`).join('\n');
}

/** Ein Punkt in einer Zeile, z. B. für die Blocker-Liste. */
export function singleLine(item: string): string {
  return item.replace(/\s*\n\s*/g, ' ').trim();
}
