// src/routes/infobip.js
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');

const { TIME_ZONE } = require('../config');

const {
  getCalendarClient,
  getPatientPhone,
  getReplyStatus,
  getServiceName,
  patchEventPrivateMeta,
  getEventDateTime,
  CALENDAR_ID,
} = require('../services/googleCalendar');

const {
  normalizePhone,
  isYesReply,
  isNoReply,
} = require('../utils/phone');

const { sendAdminCancellationSms } = require('../services/sms');
const { clearFreeSlotsCache } = require('../utils/cache');

// Inbound SMS webhook: pacientas atrašo TAIP / NE
router.post('/inbound-sms', async (req, res) => {
  try {
    console.log('📩 Inbound SMS webhook:', JSON.stringify(req.body, null, 2));

    const messages = req.body?.results || req.body?.messages || [];

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({
        ok: true,
        message: 'No SMS payload',
      });
    }

    const calendar = getCalendarClient();
    const now = DateTime.now().setZone(TIME_ZONE);

    for (const sms of messages) {
      const from = normalizePhone(sms.from || sms.sender || '');
      const text = String(sms.text || sms.message || '').trim();

      if (!from || !text) {
        continue;
      }

      const response = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: now.minus({ days: 2 }).toISO(),
        timeMax: now.plus({ days: 30 }).toISO(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
      });

      const matchingEvents = (response.data.items || []).filter((event) => {
        if (event.status === 'cancelled') return false;
        if (!event.start?.dateTime) return false;

        return getPatientPhone(event) === from;
      });

      if (matchingEvents.length === 0) {
        console.log(`⚠️ No matching event found for phone ${from}`);
        continue;
      }

      const sortedEvents = matchingEvents.sort((a, b) => {
        const aDt = getEventDateTime(a)?.toMillis() || 0;
        const bDt = getEventDateTime(b)?.toMillis() || 0;
        return aDt - bDt;
      });

      const targetEvent =
        sortedEvents.find((event) => {
          const eventDT = getEventDateTime(event);
          if (!eventDT) return false;
          return eventDT >= now.minus({ hours: 12 });
        }) || sortedEvents[0];

      const eventDT = getEventDateTime(targetEvent);
      if (!eventDT) {
        console.log(`⚠️ Could not parse event datetime for event ${targetEvent.id}`);
        continue;
      }

      const currentReplyStatus = getReplyStatus(targetEvent);

      if (currentReplyStatus === 'no') {
        console.log(`ℹ️ Event ${targetEvent.id} already cancelled`);
        continue;
      }

      if (isYesReply(text)) {
        await patchEventPrivateMeta(calendar, targetEvent.id, {
          replyStatus: 'yes',
          replyReceivedAt: now.toISO(),
        });

        console.log(`✅ Patient confirmed event ${targetEvent.id}`);
        continue;
      }

      if (isNoReply(text)) {
        await patchEventPrivateMeta(calendar, targetEvent.id, {
          replyStatus: 'no',
          replyReceivedAt: now.toISO(),
        });

        await calendar.events.delete({
          calendarId: CALENDAR_ID,
          eventId: targetEvent.id,
        });

        clearFreeSlotsCache();

        console.log(`🗑️ Event deleted after patient cancellation: ${targetEvent.id}`);

        try {
          await sendAdminCancellationSms({
            patientPhone: from,
            dateTime: eventDT.toISO ? eventDT.toISO() : String(eventDT),
            service: getServiceName(targetEvent) || targetEvent.summary || 'Vizitas',
          });
        } catch (adminSmsError) {
          console.error('⚠️ Admin SMS failed:', adminSmsError.message);
        }

        continue;
      }

      console.log(`ℹ️ Unknown SMS reply ignored from ${from}: "${text}"`);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Inbound SMS processing error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// Delivery report webhook: matysi galutinį SMS statusą
router.post('/delivery-report', async (req, res) => {
  try {
    console.log('📬 Infobip delivery report:', JSON.stringify(req.body, null, 2));

    const reports = req.body?.results || req.body?.messages || req.body?.reports || [];

    if (!Array.isArray(reports) || reports.length === 0) {
      return res.json({
        ok: true,
        message: 'No delivery report payload',
      });
    }

    for (const report of reports) {
      const messageId = report?.messageId || report?.bulkId || 'unknown';
      const to = report?.to || report?.destination || '';
      const statusName =
        report?.status?.name ||
        report?.status?.groupName ||
        report?.status?.description ||
        'UNKNOWN';
      const statusDescription = report?.status?.description || '';
      const errorGroup =
        report?.error?.groupName ||
        report?.error?.groupId ||
        null;
      const errorName =
        report?.error?.name ||
        report?.error?.description ||
        null;

      console.log('📦 DLR item:', {
        messageId,
        to,
        statusName,
        statusDescription,
        errorGroup,
        errorName,
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Delivery report processing error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

module.exports = router;