// src/routes/infobip.js
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const axios = require('axios');

const {
  TIME_ZONE,
  INFOBIP_API_KEY,
  INFOBIP_BASE_URL,
  INFOBIP_CALLS_APPLICATION_ID,
  INFOBIP_VOICE_FROM,
  ADMIN_PHONE,
  PUBLIC_WEB_URL,
} = require('../config');

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

const {
  sendAdminCancellationSms,
  sendInfobipSms,
} = require('../services/sms');

const { clearFreeSlotsCache } = require('../utils/cache');

const infobipVoiceClient = axios.create({
  baseURL: INFOBIP_BASE_URL,
  headers: {
    Authorization: `App ${INFOBIP_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 15000,
});

function isWorkingHours() {
  const now = DateTime.now().setZone(TIME_ZONE);
  const weekday = now.weekday; // 1 = Monday, 7 = Sunday
  const hour = now.hour;

  const isWeekday = weekday >= 1 && weekday <= 5;
  return isWeekday && hour >= 8 && hour < 17;
}

async function answerCall(callId) {
  return infobipVoiceClient.post(`/calls/1/calls/${callId}/answer`, {});
}

async function sayText(callId, text, language = 'lt-LT') {
  return infobipVoiceClient.post(`/calls/1/calls/${callId}/say`, {
    text,
    language,
  });
}

async function captureDtmf(callId) {
  return infobipVoiceClient.post(`/calls/1/calls/${callId}/capture/dtmf`, {
    maxLength: 1,
    timeout: 8,
    terminator: '#',
  });
}

async function hangupCall(callId) {
  return infobipVoiceClient.post(`/calls/1/calls/${callId}/hangup`, {});
}

async function connectToAdmin(callId) {
  return infobipVoiceClient.post('/calls/1/dialogs', {
    parentCallId: callId,
    childCallRequest: {
      endpoint: {
        type: 'PHONE',
        phoneNumber: normalizePhone(ADMIN_PHONE),
      },
      from: INFOBIP_VOICE_FROM,
      applicationId: INFOBIP_CALLS_APPLICATION_ID,
      connectTimeout: 25,
    },
  });
}

async function notifyAdminCallback(fromNumber) {
  const text =
    `Sanadenta VOICE: klientas paprašė perskambinti. ` +
    `Telefono nr.: ${fromNumber}`;

  return sendInfobipSms({
    from: INFOBIP_VOICE_FROM,
    to: normalizePhone(ADMIN_PHONE),
    text,
  });
}

function extractDigits(event) {
  return (
    event?.properties?.dtmf ||
    event?.properties?.capturedDtmf ||
    event?.properties?.digits ||
    event?.dtmf ||
    event?.digits ||
    ''
  );
}

function extractFromPhone(event) {
  return (
    event?.from?.phoneNumber ||
    event?.from ||
    event?.source?.phoneNumber ||
    event?.caller?.phoneNumber ||
    ''
  );
}

async function playMainMenu(callId) {
  const text =
    'Sveiki, čia Sanadenta. ' +
    'Jei norite, kad jums perskambintume dėl registracijos, spauskite 1. ' +
    'Jei norite būti sujungti su administratore, spauskite 2.';

  await sayText(callId, text, 'lt-LT');
  await captureDtmf(callId);
}

// Voice webhook
router.post('/call-received', async (req, res) => {
  res.sendStatus(200);

  const event = req.body || {};
  const type = event.type;
  const callId = event.callId;

  console.log('📞 Infobip voice event:', JSON.stringify(event, null, 2));

  if (!type || !callId) {
    console.warn('⚠️ Voice event missing type or callId');
    return;
  }

  try {
    if (type === 'CALL_RECEIVED') {
      await answerCall(callId);

      if (!isWorkingHours()) {
        await sayText(
          callId,
          `Sveiki, čia Sanadenta. Šiuo metu klinika nedirba. ` +
            `Registracijai internetu apsilankykite ${PUBLIC_WEB_URL}. ` +
            `Ačiū už skambutį.`,
          'lt-LT'
        );

        await hangupCall(callId);
        return;
      }

      return;
    }

    if (type === 'CALL_ESTABLISHED') {
      await playMainMenu(callId);
      return;
    }

    if (type === 'DTMF_COLLECTED') {
      const digits = String(extractDigits(event)).trim();
      const fromPhone = normalizePhone(extractFromPhone(event) || '');

      if (digits === '1') {
        await notifyAdminCallback(fromPhone || 'Nežinomas numeris');

        await sayText(
          callId,
          'Ačiū. Užfiksavome jūsų prašymą. Darbo metu jums perskambinsime.',
          'lt-LT'
        );

        await hangupCall(callId);
        return;
      }

      if (digits === '2') {
        await sayText(
          callId,
          'Jungiame su administratore. Prašome palaukti.',
          'lt-LT'
        );

        await connectToAdmin(callId);
        return;
      }

      await sayText(
        callId,
        'Neteisingas pasirinkimas. Bandykite dar kartą.',
        'lt-LT'
      );

      await captureDtmf(callId);
      return;
    }

    if (type === 'DTMF_CAPTURE_FAILED') {
      await sayText(
        callId,
        `Nepasirinkote jokio varianto. ` +
          `Registracijai internetu apsilankykite ${PUBLIC_WEB_URL}. Ačiū.`,
        'lt-LT'
      );

      await hangupCall(callId);
      return;
    }

    if (type === 'CALL_FAILED') {
      console.warn('⚠️ Voice call failed:', JSON.stringify(event, null, 2));
      return;
    }

    if (type === 'CALL_FINISHED') {
      console.log(`✅ Voice call finished: ${callId}`);
      return;
    }
  } catch (error) {
    console.error(
      '❌ Voice webhook error:',
      error?.response?.status,
      JSON.stringify(error?.response?.data || {}, null, 2) || error.message
    );

    try {
      await hangupCall(callId);
    } catch (hangupError) {
      console.error('❌ Hangup after error failed:', hangupError.message);
    }
  }
});

// Inbound SMS webhook
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
            dateTime: eventDT,
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

module.exports = router;