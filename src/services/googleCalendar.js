// src/services/googleCalendar.js
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const {
  CALENDAR_ID,
  TIME_ZONE,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  WORK_HOURS,
  SERVICE_DURATIONS,
} = require('../config');

let cachedAuth = null;
let cachedCalendar = null;

const getAuthInfo = () => {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable');
  }

  try {
    return JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    try {
      const decoded = Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString();
      return JSON.parse(decoded);
    } catch (e2) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64');
    }
  }
};

const getAuth = () => {
  if (cachedAuth) return cachedAuth;

  const creds = getAuthInfo();

  if (!creds.client_email) {
    throw new Error('Service account JSON missing client_email');
  }

  if (!creds.private_key) {
    throw new Error('Service account JSON missing private_key');
  }

  let privateKey = creds.private_key;

  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  cachedAuth = new google.auth.JWT({
    email: creds.client_email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });

  return cachedAuth;
};

const getCalendarClient = () => {
  if (cachedCalendar) return cachedCalendar;

  const auth = getAuth();
  cachedCalendar = google.calendar({
    version: 'v3',
    auth,
  });

  return cachedCalendar;
};

const testCalendarAccess = async () => {
  const calendar = getCalendarClient();

  const result = await calendar.calendars.get({
    calendarId: CALENDAR_ID,
  });

  return {
    id: result.data.id,
    summary: result.data.summary,
    timeZone: result.data.timeZone,
  };
};

const getBusySlots = async (calendar, timeMin, timeMax) => {
  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });

  const items = response.data.items || [];

  return items
    .filter((event) => {
      if (event.status === 'cancelled') return false;
      if (event.transparency === 'transparent') return false;
      if (!event.start?.dateTime || !event.end?.dateTime) return false;
      return true;
    })
    .map((event) => ({
      id: event.id,
      summary: event.summary || '',
      start: new Date(event.start.dateTime),
      end: new Date(event.end.dateTime),
    }));
};

const rangesOverlap = (aStart, aEnd, bStart, bEnd) => {
  return aStart < bEnd && bStart < aEnd;
};

const getServiceDuration = (serviceName) => {
  return SERVICE_DURATIONS?.[serviceName] || 60;
};

const getFreeSlots = async ({ date, serviceName = 'Vizitas' }) => {
  const calendar = getCalendarClient();
  const durationMinutes = getServiceDuration(serviceName);

  const dayStart = DateTime.fromISO(`${date}T00:00:00`, { zone: TIME_ZONE });
  const dayEnd = dayStart.endOf('day');

  const busyEvents = await getBusySlots(calendar, dayStart.toISO(), dayEnd.toISO());

  const workStart = DateTime.fromISO(`${date}T${WORK_HOURS.start}:00`, { zone: TIME_ZONE });
  const workEnd = DateTime.fromISO(`${date}T${WORK_HOURS.end}:00`, { zone: TIME_ZONE });

  const stepMinutes = WORK_HOURS.stepMinutes || 15;
  const slots = [];

  let cursor = workStart;

  while (cursor.plus({ minutes: durationMinutes }) <= workEnd) {
    const slotStart = cursor;
    const slotEnd = cursor.plus({ minutes: durationMinutes });

    const overlapsBusy = busyEvents.some((busy) =>
      rangesOverlap(
        slotStart.toJSDate(),
        slotEnd.toJSDate(),
        busy.start,
        busy.end
      )
    );

    if (!overlapsBusy) {
      slots.push({
        start: slotStart.toISO(),
        end: slotEnd.toISO(),
        label: slotStart.toFormat('HH:mm'),
      });
    }

    cursor = cursor.plus({ minutes: stepMinutes });
  }

  return slots;
};

const createBookingEvent = async ({
  patientName,
  patientPhone,
  serviceName,
  startISO,
  durationMinutes = 60,
  notes = '',
}) => {
  const calendar = getCalendarClient();

  const start = DateTime.fromISO(startISO, { zone: TIME_ZONE });
  if (!start.isValid) {
    throw new Error('Invalid start date/time');
  }

  const end = start.plus({ minutes: Number(durationMinutes) });

  const busyEvents = await getBusySlots(
    calendar,
    start.startOf('day').toISO(),
    start.endOf('day').toISO()
  );

  const hasConflict = busyEvents.some((busy) =>
    rangesOverlap(
      start.toJSDate(),
      end.toJSDate(),
      busy.start,
      busy.end
    )
  );

  if (hasConflict) {
    throw new Error('Selected slot is already busy');
  }

  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `${serviceName} - ${patientName}`,
      description: [
        `Pacientas: ${patientName}`,
        `Telefonas: ${patientPhone}`,
        `Paslauga: ${serviceName}`,
        notes ? `Pastabos: ${notes}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      start: {
        dateTime: start.toISO(),
        timeZone: TIME_ZONE,
      },
      end: {
        dateTime: end.toISO(),
        timeZone: TIME_ZONE,
      },
      extendedProperties: {
        private: {
          createdBy: 'sanadenta-api',
          patientName,
          patientPhone,
          service: serviceName,
          replyStatus: 'pending',
        },
      },
    },
  });

  return response.data;
};

const patchEventPrivateMeta = async (calendar, eventId, patch) => {
  const existing = await calendar.events.get({
    calendarId: CALENDAR_ID,
    eventId,
  });

  const currentPrivate = existing.data.extendedProperties?.private || {};

  const updatedPrivate = {
    ...currentPrivate,
    ...patch,
  };

  const response = await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: {
      extendedProperties: {
        private: updatedPrivate,
      },
    },
  });

  return response.data;
};

const getUpcomingManagedEvents = async (calendar, daysAhead = 3) => {
  const now = DateTime.now().setZone(TIME_ZONE);
  const until = now.plus({ days: daysAhead });

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.minus({ days: 1 }).toISO(),
    timeMax: until.toISO(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });

  const items = response.data.items || [];

  return items.filter((event) => {
    if (event.status === 'cancelled') return false;
    if (!event.start?.dateTime) return false;

    const meta = event.extendedProperties?.private || {};
    return meta.createdBy === 'sanadenta-api' && meta.patientPhone;
  });
};

const toPrivateMeta = (event) => event?.extendedProperties?.private || {};
const getReplyStatus = (event) => toPrivateMeta(event).replyStatus || 'pending';
const getPatientPhone = (event) => toPrivateMeta(event).patientPhone || '';
const getServiceName = (event) => toPrivateMeta(event).service || '';

const getEventDateTime = (event) => {
  const iso = event?.start?.dateTime;
  if (!iso) return null;

  const dt = DateTime.fromISO(iso, { zone: TIME_ZONE });
  return dt.isValid ? dt : null;
};

module.exports = {
  getAuthInfo,
  getAuth,
  getCalendarClient,
  testCalendarAccess,
  getBusySlots,
  getFreeSlots,
  createBookingEvent,
  patchEventPrivateMeta,
  getUpcomingManagedEvents,
  toPrivateMeta,
  getReplyStatus,
  getPatientPhone,
  getServiceName,
  getEventDateTime,
  CALENDAR_ID,
};