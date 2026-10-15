/** Minimal moment.js-compatible formatting for the time/date macros. */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const TOKENS =
  /\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|LTS|LT|LL|L|ZZ|Z/g;

/** Formats `date` with moment-style tokens (`YYYY-MM-DD HH:mm`, `LT`, `LL`, `dddd`, ...). Local time. */
export function formatDate(date: Date, format: string): string {
  const y = date.getFullYear();
  const mo = date.getMonth();
  const d = date.getDate();
  const wd = date.getDay();
  const h = date.getHours();
  const mi = date.getMinutes();
  const s = date.getSeconds();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return format.replace(TOKENS, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY':
        return String(y);
      case 'YY':
        return pad(y % 100);
      case 'MMMM':
        return MONTHS[mo]!;
      case 'MMM':
        return MONTHS[mo]!.slice(0, 3);
      case 'MM':
        return pad(mo + 1);
      case 'M':
        return String(mo + 1);
      case 'Do':
        return ordinal(d);
      case 'DD':
        return pad(d);
      case 'D':
        return String(d);
      case 'dddd':
        return WEEKDAYS[wd]!;
      case 'ddd':
        return WEEKDAYS[wd]!.slice(0, 3);
      case 'dd':
        return WEEKDAYS[wd]!.slice(0, 2);
      case 'd':
        return String(wd);
      case 'HH':
        return pad(h);
      case 'H':
        return String(h);
      case 'hh':
        return pad(h12);
      case 'h':
        return String(h12);
      case 'mm':
        return pad(mi);
      case 'm':
        return String(mi);
      case 'ss':
        return pad(s);
      case 's':
        return String(s);
      case 'SSS':
        return pad(date.getMilliseconds(), 3);
      case 'A':
        return h < 12 ? 'AM' : 'PM';
      case 'a':
        return h < 12 ? 'am' : 'pm';
      case 'LT':
        return formatDate(date, 'h:mm A');
      case 'LTS':
        return formatDate(date, 'h:mm:ss A');
      case 'L':
        return formatDate(date, 'MM/DD/YYYY');
      case 'LL':
        return formatDate(date, 'MMMM D, YYYY');
      case 'ZZ':
        return `${sign}${oh}${om}`;
      case 'Z':
        return `${sign}${oh}:${om}`;
      default:
        return token;
    }
  });
}

/** Human-readable duration like moment's `humanize()` ("a few seconds", "5 minutes", "2 days"). */
export function humanizeDuration(ms: number): string {
  const seconds = Math.abs(ms) / 1000;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  const months = days / 30.4375;
  const years = days / 365.25;
  if (seconds < 45) return 'a few seconds';
  if (seconds < 90) return 'a minute';
  if (minutes < 45) return `${Math.round(minutes)} minutes`;
  if (minutes < 90) return 'an hour';
  if (hours < 22) return `${Math.round(hours)} hours`;
  if (hours < 36) return 'a day';
  if (days < 26) return `${Math.round(days)} days`;
  if (days < 45) return 'a month';
  if (days < 320) return `${Math.round(months)} months`;
  if (days < 548) return 'a year';
  return `${Math.round(years)} years`;
}

/** Shifts a date to a UTC offset such as `UTC+2`, `+5:30`, `-3` and returns the shifted wall clock. */
export function shiftToUtcOffset(date: Date, offset: string): Date | null {
  const m = /^(?:UTC)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(offset.trim());
  if (!m) return null;
  const minutes = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * (m[1] === '-' ? -1 : 1);
  const utc = date.getTime() + date.getTimezoneOffset() * 60_000;
  return new Date(utc + minutes * 60_000);
}
