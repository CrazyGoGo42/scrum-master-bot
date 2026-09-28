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
      .setCustomId('meeting:venue:alfaview')
      .setLabel('Alfaview')
      .setEmoji('🟠')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('meeting:venue:external')
      .setLabel('Anderer Link')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Secondary)
  );
}

export function externalMeetingLinkModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('meeting:venue-external')
    .setTitle('Externer Meeting-Link')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('link')
          .setLabel('Teams- oder anderer Meeting-Link')
          .setPlaceholder('https://...')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
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

export function selectMeetingVenue(userId: string, kind: string, customUrl?: string | null): string | undefined {
  if (kind === 'discord') {
    pendingVenues.set(userId, {
      kind: 'discord',
      label: 'Discord Meeting-Voice',
      buttonLabel: 'Zum Voice-Channel',
      url: `https://discord.com/channels/${config.guildId}/${config.meetingVoiceChannelId}`
    });
    return undefined;
  }

  if (kind === 'alfaview') {
    const url = process.env.ALFAVIEW_MEETING_URL?.trim();
    if (!url) return 'Für Alfaview fehlt `ALFAVIEW_MEETING_URL` in der `.env` des Bots.';
    if (!validHttpUrl(url)) return '`ALFAVIEW_MEETING_URL` ist keine gültige http/https-URL.';

    pendingVenues.set(userId, {
      kind: 'alfaview',
      label: 'Alfaview',
      buttonLabel: 'Alfaview öffnen',
      url
    });
    return undefined;
  }

  if (kind === 'external') {
    const url = customUrl?.trim();
    if (!url) return 'Bitte gib einen Teams- oder anderen http/https-Meeting-Link ein.';
    if (!validHttpUrl(url)) return 'Der angegebene Meeting-Link ist keine gültige http/https-URL.';

    const labels = externalVenueLabel(url);
    pendingVenues.set(userId, {
      kind: 'external',
      label: labels.label,
      buttonLabel: labels.buttonLabel,
      url
    });
    return undefined;
  }

  return 'Unbekannter Meeting-Ort. Bitte Discord Voice, Alfaview oder Anderer Link auswählen.';
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
      channel: null,
      reason: 'Externes Meeting über den Scrum-Master-Bot erstellt'
    });
    return event.url;
  } catch (error) {
    console.warn('[Meeting] Discord Scheduled Event konnte nicht erstellt werden. Das Meeting selbst bleibt bestehen.', error);
    return undefined;
  }
}
