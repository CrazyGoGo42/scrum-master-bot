import { existsSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { keepUnreadableFile } from './utils/state-files.js';

const draftsPath = process.env.DAILY_DRAFTS_FILE || path.join(process.cwd(), 'data', 'daily-drafts.json');
// Nach einem Neustart werden nur Entwürfe wiederhergestellt, an denen innerhalb eines Tages gearbeitet wurde.
const RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StoredDraft<T> = { updatedAt: string; draft: T };

/**
 * Angefangene Dailies. Jede Änderung wird sofort gespeichert, damit Antworten einen Neustart oder Absturz
 * des Bots überstehen. set/delete speichern selbst; nach Änderungen an einem Entwurf `touch` aufrufen.
 */
export class DailyDraftStore<T extends { userId: string }> extends Map<string, T> {
  private readonly updatedAt = new Map<string, string>();
  private writeQueue = Promise.resolve();

  constructor() {
    super();
    for (const { updatedAt, draft } of readStoredDrafts<T>()) {
      if (Date.now() - Date.parse(updatedAt) > RESTORE_MAX_AGE_MS) continue;
      super.set(draft.userId, draft);
      this.updatedAt.set(draft.userId, updatedAt);
    }
  }

  override set(userId: string, draft: T): this {
    super.set(userId, draft);
    void this.touch(userId);
    return this;
  }

  override delete(userId: string): boolean {
    const deleted = super.delete(userId);
    this.updatedAt.delete(userId);
    if (deleted) void this.save();
    return deleted;
  }

  /** Speichert nach einer Änderung am Entwurf. Ein Schreibfehler wird geloggt, der Entwurf bleibt im Speicher. */
  async touch(userId: string): Promise<void> {
    this.updatedAt.set(userId, new Date().toISOString());
    await this.save();
  }

  private save(): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
        const stored: StoredDraft<T>[] = [...this.values()].map((draft) => ({
          updatedAt: this.updatedAt.get(draft.userId) ?? new Date().toISOString(),
          draft
        }));
        await fs.mkdir(path.dirname(draftsPath), { recursive: true });
        const temporary = `${draftsPath}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
        await fs.rename(temporary, draftsPath);
      })
      .catch((error) => console.error('[Daily] Entwürfe konnten nicht gespeichert werden.', error));
    return this.writeQueue;
  }
}

function readStoredDrafts<T>(): StoredDraft<T>[] {
  if (!existsSync(draftsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(draftsPath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredDraft<T>[]).filter((entry) => entry?.draft && entry.updatedAt) : [];
  } catch (error) {
    console.error('[Daily] Entwürfe konnten nicht gelesen werden.', error);
    keepUnreadableFile(draftsPath);
    return [];
  }
}
