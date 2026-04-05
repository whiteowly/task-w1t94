import { validationFailed } from '../../platform/errors/app-error';

const localDateTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (timezone: string) => {
  const existing = formatterCache.get(timezone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });
  formatterCache.set(timezone, formatter);
  return formatter;
};

const parseLocalDateTime = (value: string): LocalDateTimeParts => {
  if (!localDateTimeRegex.test(value)) {
    throw validationFailed('Invalid local datetime format', {
      expected: 'YYYY-MM-DDTHH:mm:ss',
      value
    });
  }

  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map((entry) => Number(entry));
  const [hour, minute, second] = timePart.split(':').map((entry) => Number(entry));

  return { year, month, day, hour, minute, second };
};

const partsToCanonicalString = (parts: LocalDateTimeParts): string => {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${parts.year.toString().padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
};

const epochMsToZonedParts = (epochMs: number, timezone: string): LocalDateTimeParts => {
  const formatted = getFormatter(timezone).formatToParts(new Date(epochMs));

  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = formatted.find((entry) => entry.type === type)?.value;
    return Number(part);
  };

  const hourValue = pick('hour');

  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: hourValue === 24 ? 0 : hourValue,
    minute: pick('minute'),
    second: pick('second')
  };
};

export const localDateTimeToUtcEpoch = (localDateTime: string, timezone: string): number => {
  const target = parseLocalDateTime(localDateTime);
  const targetAsUtcMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);

  let guessMs = targetAsUtcMs;
  for (let i = 0; i < 8; i += 1) {
    const zoned = epochMsToZonedParts(guessMs, timezone);
    const zonedAsUtcMs = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second
    );
    const diffMs = targetAsUtcMs - zonedAsUtcMs;
    guessMs += diffMs;
    if (diffMs === 0) {
      break;
    }
  }

  const resolved = epochMsToZonedParts(guessMs, timezone);
  if (partsToCanonicalString(resolved) !== localDateTime) {
    throw validationFailed('Invalid local datetime for configured facility timezone', {
      localDateTime,
      timezone
    });
  }

  return Math.floor(guessMs / 1000);
};
