import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return value;
}

function numberValue(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  guildId: required('DISCORD_GUILD_ID'),
  weeklyForumId: required('WEEKLY_REPORT_FORUM_ID'),
  scrumChannelId: required('SCRUM_MASTER_CHANNEL_ID'),
  infoChannelId: required('SCRUM_INFO_CHANNEL_ID'),
  meetingCreateChannelId: required('MEETING_CREATE_CHANNEL_ID'),
  meetingVoiceChannelId: required('MEETING_VOICE_CHANNEL_ID'),
  timeTrackingChannelId: process.env.TIME_TRACKING_CHANNEL_ID || '1555300952527872000',
  timezone: process.env.TIMEZONE || 'Europe/Berlin',
  trackingStartDate: process.env.TRACKING_START_DATE || '2026-09-28',
  pushReminderAfterHours: numberValue('PUSH_REMINDER_AFTER_HOURS', 6),
  cron: {
    dailyOpen: process.env.DAILY_OPEN_CRON || '0 9 * * 1-5',
    dailyReminder: process.env.DAILY_REMINDER_CRON || '0 15 * * 1-5',
    dailyEveningReminder: process.env.DAILY_EVENING_REMINDER_CRON || '0 20 * * 1-5',
    dailyMissingReport: process.env.DAILY_MISSING_REPORT_CRON || '5 8 * * 2-6',
    pushReminderCheck: process.env.PUSH_REMINDER_CHECK_CRON || '*/10 * * * *',
    weeklyReport: process.env.WEEKLY_REPORT_CRON || '*/30 14-22 * * 5'
  },
  members: [
    {
      name: 'Joline',
      discordId: required('JOLINE_DISCORD_ID'),
      dailyForumId: required('JOLINE_DAILY_FORUM_ID')
    },
    {
      name: 'David',
      discordId: required('DAVID_DISCORD_ID'),
      dailyForumId: required('DAVID_DAILY_FORUM_ID')
    },
    {
      name: 'Duy',
      discordId: required('DUY_DISCORD_ID'),
      dailyForumId: required('DUY_DAILY_FORUM_ID')
    }
  ]
} as const;
