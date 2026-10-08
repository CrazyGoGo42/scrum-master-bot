import { ActionRowBuilder, ButtonBuilder, ForumChannel, Message, ThreadChannel } from 'discord.js';
import { splitDiscordText } from './utils/discord-text.js';

// Ein Daily kann länger sein als eine Discord-Nachricht (2000 Zeichen). Dann steht es in mehreren Teilen:
// Teil 1 ist der Startbeitrag des Threads, die weiteren Teile sind Nachrichten des Bots im selben Thread.
// Jeder Teil endet mit der Fußzeile „-# Daily · Teil i/n“. Wochenbericht, /daily-bearbeiten und Push-Status
// setzen die Teile darüber wieder zum vollständigen Daily zusammen.

type Buttons = ActionRowBuilder<ButtonBuilder>[];

const PART_FOOTER = /\n-# Daily · Teil (\d+)\/(\d+)$/;

/** Teilt ein Daily in Nachrichten auf, die Discord annimmt (Fußzeile nur, wenn es mehr als ein Teil ist). */
export function dailyParts(content: string): string[] {
  const chunks = splitDiscordText(content);
  if (chunks.length === 1) return chunks;
  return chunks.map((chunk, index) => `${chunk}\n-# Daily · Teil ${index + 1}/${chunks.length}`);
}

function partOf(content: string): { index: number; total: number; text: string } | undefined {
  const match = content.match(PART_FOOTER);
  if (!match || match.index === undefined) return undefined;
  return { index: Number(match[1]), total: Number(match[2]), text: content.slice(0, match.index) };
}

// Teile beginnen meist an einer Leerzeile vor einer Überschrift. Liegt die Grenze mitten in einer Aufzählung,
// ändert die zusätzliche Leerzeile nichts: Leerzeilen werden beim Zerlegen in Punkte ignoriert.
export function joinDailyParts(contents: string[]): string {
  return contents.map((content) => partOf(content)?.text ?? content).join('\n\n');
}

export type DailyPost = { messages: Message[]; content: string };

/**
 * Liest ein Daily vollständig: Startbeitrag und alle weiteren Teile in der richtigen Reihenfolge.
 * Fehlt ein Teil, wird ein Fehler geworfen, damit der Wochenbericht das Daily nicht unvollständig übernimmt.
 */
export async function readDaily(thread: ThreadChannel, starter: Message): Promise<DailyPost> {
  const first = partOf(starter.content);
  if (!first || first.total < 2) return { messages: [starter], content: starter.content };

  const botId = thread.client.user?.id;
  const parts = new Map<number, Message>([[1, starter]]);
  const collect = (batch: Iterable<Message>): void => {
    for (const message of batch) {
      if (message.id === starter.id || message.author.id !== botId) continue;
      const part = partOf(message.content);
      if (part && part.total === first.total && part.index > 1 && !parts.has(part.index)) parts.set(part.index, message);
    }
  };
  // Teile stehen direkt nach dem Startbeitrag; nach /daily-bearbeiten kann ein neuer Teil auch weiter unten stehen.
  collect((await thread.messages.fetch({ after: starter.id, limit: 100 })).values());
  if (parts.size < first.total) collect((await thread.messages.fetch({ limit: 100 })).values());

  const messages: Message[] = [];
  for (let index = 1; index <= first.total; index++) {
    const message = parts.get(index);
    if (!message) throw new Error(`Daily-Thread ${thread.id}: Teil ${index}/${first.total} wurde nicht gefunden.`);
    messages.push(message);
  }
  return { messages, content: joinDailyParts(messages.map((message) => message.content)) };
}

/** Legt den Daily-Thread an. Scheitert ein weiterer Teil, wird der Thread gelöscht, damit kein halbes Daily stehen bleibt. */
export async function createDailyThread(
  forum: ForumChannel,
  name: string,
  content: string,
  components: Buttons,
  reason: string
): Promise<ThreadChannel> {
  const [first, ...rest] = dailyParts(content);
  const thread = await forum.threads.create({
    name,
    message: { content: first, components, allowedMentions: { parse: [] } },
    reason
  });

  try {
    for (const part of rest) await thread.send({ content: part, allowedMentions: { parse: [] } });
  } catch (error) {
    await thread
      .delete('Daily konnte nicht vollständig veröffentlicht werden')
      .catch((deleteError) => console.error(`[Daily] Unvollständiges Daily ${thread.id} konnte nicht gelöscht werden.`, deleteError));
    throw error;
  }
  return thread;
}

/**
 * Schreibt ein bestehendes Daily neu. Zusätzliche Teile werden zuerst gesendet, dann die vorhandenen bearbeitet
 * (Startbeitrag zuletzt) und überzählige gelöscht. So bleibt das alte Daily lesbar, falls das Senden scheitert.
 */
export async function rewriteDaily(thread: ThreadChannel, post: DailyPost, content: string, components: Buttons): Promise<void> {
  const parts = dailyParts(content);
  for (const part of parts.slice(post.messages.length)) await thread.send({ content: part, allowedMentions: { parse: [] } });
  for (let index = Math.min(parts.length, post.messages.length) - 1; index >= 1; index--) {
    await post.messages[index].edit({ content: parts[index] });
  }
  await post.messages[0].edit({ content: parts[0], components });
  for (const message of post.messages.slice(parts.length)) await message.delete();
}
