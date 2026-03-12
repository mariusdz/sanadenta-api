// src/services/reminder.js
const { DateTime } = require('luxon');
const { TIME_ZONE, REMINDER_CHECK_INTERVAL_MS } = require('../config');
const {
  getCalendarClient,
  getUpcomingManagedEvents,
  patchEventPrivateMeta,
  toPrivateMeta,
  getEventDateTime,
} = require('./googleCalendar');
const { normalizePhone } = require('../utils/phone');
const { sendReminderQuestionSms } = require('./sms');

const buildReminderSendTime = (appointmentDT) => {
  const hour = appointmentDT.hour;

  // 08:00 / 09:00 / 10:00 -> iš vakaro 18:00
  if ([8, 9, 10].includes(hour)) {
    return appointmentDT.minus({ days: 1 }).set({
      hour: 18,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }

  // kitu atveju -> 3 valandos iki vizito
  return appointmentDT.minus({ hours: 3 });
};

const isMorningAppointment = (appointmentDT) => [8, 9, 10].includes(appointmentDT.hour);

const processDueReminders = async () => {
  try {
    const calendar = getCalendarClient();
    const now = DateTime.now().setZone(TIME_ZONE);

    const events = await getUpcomingManagedEvents(calendar, 3);

    for (const event of events) {
      const eventDT = getEventDateTime(event);
      if (!eventDT) continue;
      if (eventDT <= now) continue;

      const meta = toPrivateMeta(event);
      const patientPhone = normalizePhone(meta.patientPhone || '');
      const reminderAtIso = meta.reminderAt || '';
      const reminderSentAt = meta.reminderSentAt || '';
      const replyStatus = meta.replyStatus || 'pending';
      const service = meta.service || '';

      if (!patientPhone) continue;
      if (!reminderAtIso) continue;

      // jei priminimas jau išsiųstas – praleidžiam
      if (reminderSentAt) continue;

      // jei pacientas jau atsakė – priminimo nebereikia
      if (replyStatus !== 'pending') continue;

      const reminderAt = DateTime.fromISO(reminderAtIso, { zone: TIME_ZONE });
      if (!reminderAt.isValid) continue;

      if (reminderAt <= now) {
        console.log(`📨 Sending reminder for event ${event.id} at ${eventDT.toISO()}`);

        await sendReminderQuestionSms({
          phone: patientPhone,
          dateTime: eventDT,
          service,
        });

        await patchEventPrivateMeta(calendar, event.id, {
          reminderSentAt: now.toISO(),
        });

        console.log(`✅ Reminder sent for event ${event.id}`);
      }
    }
  } catch (error) {
    console.error('❌ Reminder processor error:', error.message);
  }
};

let reminderJobStarted = false;

const startReminderJob = () => {
  if (reminderJobStarted) return;

  reminderJobStarted = true;

  console.log(`⏰ Reminder job started. Interval: ${REMINDER_CHECK_INTERVAL_MS} ms`);

  setInterval(async () => {
    await processDueReminders();
  }, REMINDER_CHECK_INTERVAL_MS);
};

module.exports = {
  buildReminderSendTime,
  isMorningAppointment,
  getEventDateTime,
  processDueReminders,
  startReminderJob,
};