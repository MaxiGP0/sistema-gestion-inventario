/**
 * Rango del día local para los KPIs del panel.
 *
 * El servidor puede correr en UTC, pero "hoy" significa el día comercial de la
 * distribuidora (Argentina). Se calcula el inicio y el fin en UTC a partir del
 * calendario de `America/Argentina/Buenos_Aires`, sin depender de la zona
 * horaria del proceso.
 */

export const DASHBOARD_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export interface DayRange {
  start: Date;
  end: Date;
}

/** Fecha del calendario local (sin hora) en una zona horaria. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function partsInTimeZone(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }

  return parts;
}

/** Diferencia (ms) entre la hora local de la zona y UTC en ese instante. */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = partsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour === 24 ? 0 : parts.hour!,
    parts.minute!,
    parts.second!,
  );

  return asUtc - date.getTime();
}

/** Convierte una fecha/hora del calendario local a su instante UTC. */
function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = utcGuess;

  // El offset depende del instante (DST); dos iteraciones alcanzan para las
  // zonas con cambios de una hora y para Argentina, que no tiene DST.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(candidate), timeZone);
    const next = utcGuess - offset;
    if (next === candidate) break;
    candidate = next;
  }

  return new Date(candidate);
}

/** Día del calendario local al que pertenece `date`. */
export function getCalendarDate(date: Date, timeZone: string = DASHBOARD_TIME_ZONE): CalendarDate {
  const parts = partsInTimeZone(date, timeZone);

  return { year: parts.year!, month: parts.month!, day: parts.day! };
}

/** Fecha del calendario local desplazada N días (puede ser negativa). */
export function shiftCalendarDate(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Inicio y fin (exclusivo) del día local indicado por el calendario.
 *
 * El fin se calcula con el día siguiente del calendario, no sumando 24 h: así
 * una transición de horario de verano no corre el límite.
 */
export function getCalendarDayRange(
  date: CalendarDate,
  timeZone: string = DASHBOARD_TIME_ZONE,
): DayRange {
  const start = zonedDateTimeToUtc(date.year, date.month, date.day, 0, 0, 0, timeZone);
  const nextCalendarDay = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  const end = zonedDateTimeToUtc(
    nextCalendarDay.getUTCFullYear(),
    nextCalendarDay.getUTCMonth() + 1,
    nextCalendarDay.getUTCDate(),
    0,
    0,
    0,
    timeZone,
  );

  return { start, end };
}

/** Inicio y fin (exclusivo) del día local que contiene `now`. */
export function getDayRange(now: Date, timeZone: string = DASHBOARD_TIME_ZONE): DayRange {
  return getCalendarDayRange(getCalendarDate(now, timeZone), timeZone);
}
