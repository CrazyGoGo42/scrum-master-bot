import { DateTime } from 'luxon';
import { config } from '../config.js';

export function nowBerlin(): DateTime {
  return DateTime.now().setZone(config.timezone);
}

export function formatDate(date = nowBerlin()): string {
  return date.toFormat('dd.MM.yyyy');
}

export function formatTime(date: DateTime): string {
  return date.toFormat('HH:mm');
}

export function isWorkday(date = nowBerlin()): boolean {
  return date.weekday >= 1 && date.weekday <= 5;
}

export function currentWeekRange(date = nowBerlin()): { start: DateTime; end: DateTime } {
  return {
    start: date.startOf('week'),
    end: date.endOf('week')
  };
}
