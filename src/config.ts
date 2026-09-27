import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return value;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  guildId: required('DISCORD_GUILD_ID'),
  dailyForumId: required('DAILY_SCRUM_FORUM_ID'),
  weeklyForumId: required('WEEKLY_REPORT_FORUM_ID'),
  scrumChannelId: required('SCRUM_MASTER_CHANNEL_ID'),
  timezone: process.env.TIMEZONE || 'Europe/Berlin',
  cron: {
    dailyOpen: process.env.DAILY_OPEN_CRON || '0 9 * * 1-5',
    dailyReminder: process.env.DAILY_REMINDER_CRON || '0 11 * * 1-5',
    dailyFinalReminder: process.env.DAILY_FINAL_REMINDER_CRON || '45 11 * * 1-5',
    dailyDeadline: process.env.DAILY_DEADLINE_CRON || '0 12 * * 1-5',
    gitReminder: process.env.GIT_REMINDER_CRON || '30 16 * * 1-5',
    weeklyReport: process.env.WEEKLY_REPORT_CRON || '0 15 * * 5'
  },
  members: [
    { name: 'Joline', discordId: required('JOLINE_DISCORD_ID') },
    { name: 'David', discordId: required('DAVID_DISCORD_ID') },
    { name: 'Duy', discordId: required('DUY_DISCORD_ID') }
  ]
} as const;
