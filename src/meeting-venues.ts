import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { DateTime } from 'luxon';
import { config } from './config.js';

export type MeetingVenue = {
  kind: 'discord' | 'alfaview' | 'external';
  label: string;
  buttonLabel: string;
  url: string;
};

const pendingVenues = new Map<string, MeetingVenue>();
// Ziel des Buttons, wenn ein WhatsApp-Meeting keinen eigenen Link hat.
export const WHATSAPP_WEB = 'https://web.whatsapp.com/';

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function externalVenueLabel(value: string): { label: string; buttonLabel: string } {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname.includes('teams.microsoft.com') || hostname.includes('teams.live.com')) {
      return { label: 'Microsoft Teams', buttonLabel: 'Teams öffnen' };
    }
    if (hostname.includes('alfaview.com')) {
      return { label: 'Alfaview', buttonLabel: 'Alfaview öffnen' };
    }
    if (hostname.includes('whatsapp.com') || hostname === 'wa.me') {
      return { label: 'WhatsApp', buttonLabel: 'WhatsApp öffnen' };
    }
    if (hostname.includes('zoom.us')) {
      return { label: 'Zoom', buttonLabel: 'Zoom öffnen' };
    }
    if (hostname === 'meet.google.com') {
      return { label: 'Google Meet', buttonLabel: 'Google Meet öffnen' };
    }
  } catch {
    // URL wurde vorher validiert. Fallback bleibt trotzdem defensiv.
  }
  return { label: 'Externer Meeting-Link', buttonLabel: 'Meeting öffnen' };
}

export function meetingVenueChoiceRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('meeting:venue:discord')
      .setLabel('Discord Voice')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('meeting:venue:whatsapp')
      .setLabel('WhatsApp')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('meeting:venue:external')
      .setLabel('Teams / anderer Link')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Secondary)
  );
}

// WhatsApp: Link optional, oft wird einfach in der Gruppe angerufen.
export function externalMeetingLinkModal(kind: 'external' | 'whatsapp' = 'external'): ModalBuilder {
  const whatsapp = kind === 'whatsapp';
  return new ModalBuilder()
    .setCustomId(whatsapp ? 'meeting:venue-whatsapp' : 'meeting:venue-external')
    .setTitle(whatsapp ? 'WhatsApp-Meeting' : 'Externer Meeting-Link')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('link')
          .setLabel(whatsapp ? 'Anruf- oder Gruppenlink (optional)' : 'Teams- oder anderer Meeting-Link')
          .setPlaceholder(whatsapp ? 'https://call.whatsapp.com/… oder leer lassen' : 'https://...')
          .setStyle(TextInputStyle.Short)
          .setRequired(!whatsapp)
          .setMaxLength(1000)
      )
    );
}

export function meetingVenueContinueRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('meeting:venue:continue')
      .setLabel('Meetingdetails ausfüllen')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Primary)
  );
}

/** Baut einen Meeting-Ort. Liefert bei ungültiger Eingabe einen Fehlertext. */
export function buildMeetingVenue(kind: string, customUrl?: string | null): MeetingVenue | string {
  if (kind === 'discord') {
    return {
      kind: 'discord',
      label: 'Discord Meeting-Voice',
      buttonLabel: 'Zum Voice-Channel',
      url: `https://discord.com/channels/${config.guildId}/${config.meetingVoiceChannelId}`
    };
  }

  if (kind === 'whatsapp') {
    const url = customUrl?.trim();
    if (!url) return { kind: 'external', label: 'WhatsApp', buttonLabel: 'WhatsApp öffnen', url: WHATSAPP_WEB };
    if (!validHttpUrl(url)) return 'Der angegebene WhatsApp-Link ist keine gültige http/https-URL.';
    return { kind: 'external', label: 'WhatsApp', buttonLabel: 'WhatsApp öffnen', url };
  }

  if (kind === 'external') {
    const url = customUrl?.trim();
    if (!url) return 'Bitte gib einen Teams-, WhatsApp- oder anderen http/https-Meeting-Link ein.';
    if (!validHttpUrl(url)) return 'Der angegebene Meeting-Link ist keine gültige http/https-URL.';
    return { kind: 'external', ...externalVenueLabel(url), url };
  }

  return 'Unbekannter Meeting-Ort. Bitte Discord Voice, WhatsApp oder Teams / anderer Link auswählen.';
}

/** Freitext aus „Meeting ändern“: „Discord“, „WhatsApp“ oder ein Link. */
export function venueFromInput(input: string): MeetingVenue | string {
  const value = input.trim();
  if (/^discord/i.test(value)) return buildMeetingVenue('discord');
  if (/^whatsapp$/i.test(value)) return buildMeetingVenue('whatsapp');
  if (/^https?:\/\//i.test(value)) return buildMeetingVenue('external', value);
  return 'Beim Ort bitte **Discord**, **WhatsApp** oder einen Link (https://…) angeben, z. B. den Teams- oder WhatsApp-Link.';
}

/** Ort eines gespeicherten Meetings, z. B. für den Link-Button am Meeting-Post. */
export function storedVenue(meeting: { venueKind: MeetingVenue['kind']; venueLabel: string; venueUrl?: string }): MeetingVenue | undefined {
  if (meeting.venueKind === 'discord') {
    const built = buildMeetingVenue('discord');
    return typeof built === 'string' ? undefined : built;
  }
  if (!meeting.venueUrl) return undefined;
  const buttonLabel = meeting.venueKind === 'alfaview' ? 'Alfaview öffnen' : externalVenueLabel(meeting.venueUrl).buttonLabel;
  return { kind: meeting.venueKind, label: meeting.venueLabel, buttonLabel, url: meeting.venueUrl };
}

export function selectMeetingVenue(userId: string, kind: string, customUrl?: string | null): string | undefined {
  const venue = buildMeetingVenue(kind, customUrl);
  if (typeof venue === 'string') return venue;
  pendingVenues.set(userId, venue);
  return undefined;
}

export function hasMeetingVenue(userId: string): boolean {
  return pendingVenues.has(userId);
}

export function consumeMeetingVenue(userId: string): MeetingVenue | undefined {
  const venue = pendingVenues.get(userId);
  if (venue) pendingVenues.delete(userId);
  return venue;
}

export function meetingVenueText(venue: MeetingVenue): string {
  if (venue.kind === 'discord') return `<#${config.meetingVoiceChannelId}>`;
  return `[${venue.label}](${venue.url})`;
}

export function meetingLocationRow(venue: MeetingVenue): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(venue.buttonLabel)
      .setEmoji(venue.kind === 'discord' ? '🔊' : '🔗')
      .setStyle(ButtonStyle.Link)
      .setURL(venue.url)
  );
}

export async function createScheduledMeeting(
  client: Client,
  title: string,
  start: DateTime,
  end: DateTime,
  agenda: string,
  venue: MeetingVenue
): Promise<string | undefined> {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const description =
      venue.kind === 'discord'
        ? (agenda || 'Teammeeting').slice(0, 1000)
        : `${agenda || 'Teammeeting'}\n\nMeeting-Link: ${venue.url}`.slice(0, 1000);

    if (venue.kind === 'discord') {
      const event = await guild.scheduledEvents.create({
        name: title.slice(0, 100),
        description,
        scheduledStartTime: start.toJSDate(),
        scheduledEndTime: end.toJSDate(),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.Voice,
        channel: config.meetingVoiceChannelId,
        reason: 'Meeting über den Scrum-Master-Bot erstellt'
      });
      return event.url;
    }

    const event = await guild.scheduledEvents.create({
      name: title.slice(0, 100),
      description,
      scheduledStartTime: start.toJSDate(),
      scheduledEndTime: end.toJSDate(),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: venue.label.slice(0, 100) },
      reason: 'Externes Meeting über den Scrum-Master-Bot erstellt'
    });
    return event.url;
  } catch (error) {
    console.warn('[Meeting] Discord Scheduled Event konnte nicht erstellt werden. Das Meeting selbst bleibt bestehen.', error);
    return undefined;
  }
}
