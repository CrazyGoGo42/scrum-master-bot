import { copyFileSync } from 'node:fs';

/**
 * Sichert eine Datendatei, die nicht gelesen werden konnte, bevor der Bot mit leerem Stand weitermacht.
 * Sonst würde die nächste Speicherung die alten Einträge endgültig überschreiben.
 */
export function keepUnreadableFile(filePath: string): void {
  const backup = `${filePath}.unlesbar-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    copyFileSync(filePath, backup);
    console.error(`[Daten] Unlesbare Datei gesichert: ${backup}`);
  } catch (error) {
    console.error(`[Daten] Unlesbare Datei ${filePath} konnte nicht gesichert werden.`, error);
  }
}
