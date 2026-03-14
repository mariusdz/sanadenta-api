const express = require('express');
const axios = require('axios');
const { DateTime } = require('luxon');

const router = express.Router();

const {
  INFOBIP_API_KEY,
  INFOBIP_BASE_URL,
  INFOBIP_CALLS_APPLICATION_ID,
  INFOBIP_VOICE_FROM,
  INFOBIP_SMS_FROM,
  INFOBIP_CONFIRMATION_FROM,
  ADMIN_PHONE,
  PUBLIC_WEB_URL,
  TIME_ZONE,
} = require('../config');

const { normalizePhone } = require('../utils/phone');
const { sendInfobipSms } = require('../services/sms');

function getInfobipClient(baseURL) {
  return axios.create({
    baseURL: baseURL || INFOBIP_BASE_URL,
    headers: {
      Authorization: `App ${INFOBIP_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 15000,
  });
}

function isWorkingHours() {
  const now = DateTime.now().setZone(TIME_ZONE);
  const weekday = now.weekday;
  const hour = now.hour;

  return weekday >= 1 && weekday <= 5 && hour >= 8 && hour < 17;
}

async function answerCall(callId, apiBaseUrl) {
  return getInfobipClient(apiBaseUrl).post(`/calls/1/calls/${callId}/answer`, {});
}

// SVARBU: jokio language lauko
async function sayText(callId, text, apiBaseUrl) {
  return getInfobipClient(apiBaseUrl).post(`/calls/1/calls/${callId}/say`, {
    text,
    language: 'en',
  });
}

async function captureDtmf(
  callId,
  {
    maxLength = 1,
    timeout = 10,
    terminator = '#',
  } = {},
  apiBaseUrl
) {
  return getInfobipClient(apiBaseUrl).post(`/calls/1/calls/${callId}/capture/dtmf`, {
    maxLength,
    timeout,
    terminator,
  });
}

async function hangupCall(callId, apiBaseUrl) {
  return getInfobipClient(apiBaseUrl).post(`/calls/1/calls/${callId}/hangup`, {});
}

async function createDialogToAdmin(parentCallId, apiBaseUrl) {
  if (!ADMIN_PHONE) {
    throw new Error('ADMIN_PHONE is not configured');
  }

  if (!INFOBIP_VOICE_FROM) {
    throw new Error('INFOBIP_VOICE_FROM is not configured');
  }

  return getInfobipClient(apiBaseUrl).post('/calls/1/dialogs', {
    parentCallId,
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

async function notifyAdminAboutCallback(fromNumber) {
  if (!ADMIN_PHONE) {
    console.warn('ADMIN_PHONE not set, callback SMS skipped');
    return { skipped: true, reason: 'Missing ADMIN_PHONE' };
  }

  const text =
    `Sanadenta VOICE MVP: perskambinti klientui ${fromNumber}. ` +
    `Jis pasirinko callback per voice meniu.`;

  return sendInfobipSms({
    from: INFOBIP_CONFIRMATION_FROM || INFOBIP_SMS_FROM,
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
    event?.properties?.call?.from ||
    event?.properties?.call?.endpoint?.phoneNumber ||
    ''
  );
}

async function playMainMenu(callId, apiBaseUrl) {
  const text =
    'Sveiki, čia Sanadenta. ' +
    'Jei norite, kad jums perskambintume dėl registracijos, spauskite 1. ' +
    'Jei norite būti sujungti su administratore, spauskite 2.';

  await sayText(callId, text, apiBaseUrl);
  await captureDtmf(
    callId,
    {
      maxLength: 1,
      timeout: 8,
      terminator: '#',
    },
    apiBaseUrl
  );
}

router.post('/call-received', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body || {};
    const type = event.type;
    const callId = event.callId;
    const from = extractFromPhone(event);
    const digits = extractDigits(event);
    const apiBaseUrl =
      event?.properties?.apiBaseUrl ||
      event?.properties?.call?.apiBaseUrl ||
      INFOBIP_BASE_URL;

    console.log('📞 Infobip voice event:', JSON.stringify(event, null, 2));
    console.log('📡 Using Calls API base URL:', apiBaseUrl);

    if (!callId || !type) {
      console.warn('Voice event missing type or callId');
      return;
    }

    if (type === 'CALL_RECEIVED') {
      await answerCall(callId, apiBaseUrl);

      if (!isWorkingHours()) {
        await sayText(
          callId,
          `Sveiki, čia Sanadenta. Šiuo metu klinika nedirba. ` +
            `Registracijai internetu apsilankykite ${PUBLIC_WEB_URL}. ` +
            `Ačiū už skambutį.`,
          apiBaseUrl
        );

        await hangupCall(callId, apiBaseUrl);
        return;
      }

      return;
    }

    if (type === 'CALL_ESTABLISHED') {
      await playMainMenu(callId, apiBaseUrl);
      return;
    }

    if (type === 'DTMF_COLLECTED' || type === 'DTFM_CAPTURED') {
      const pressed = String(digits || '').trim();

      if (pressed === '1') {
        const safeFrom = normalizePhone(from || '');

        await notifyAdminAboutCallback(safeFrom || 'Nežinomas numeris');

        await sayText(
          callId,
          'Ačiū. Užfiksavome jūsų prašymą. Darbo metu jums perskambinsime.',
          apiBaseUrl
        );

        await hangupCall(callId, apiBaseUrl);
        return;
      }

      if (pressed === '2') {
        await sayText(
          callId,
          'Jungiame su administratore. Prašome palaukti.',
          apiBaseUrl
        );

        await createDialogToAdmin(callId, apiBaseUrl);
        return;
      }

      await sayText(
        callId,
        `Neteisingas pasirinkimas. ` +
          `Registracijai internetu apsilankykite ${PUBLIC_WEB_URL}. ` +
          `Jei reikia, paskambinkite dar kartą.`,
        apiBaseUrl
      );

      await hangupCall(callId, apiBaseUrl);
      return;
    }

    if (type === 'DTMF_CAPTURE_FAILED') {
      await sayText(
        callId,
        `Nepasirinkote jokio varianto. ` +
          `Registracijai internetu apsilankykite ${PUBLIC_WEB_URL}. Ačiū.`,
        apiBaseUrl
      );

      await hangupCall(callId, apiBaseUrl);
      return;
    }

    if (type === 'CALL_FAILED') {
      console.warn('CALL_FAILED:', JSON.stringify(event, null, 2));
      return;
    }

    if (type === 'CALL_FINISHED') {
      console.log('CALL_FINISHED:', callId);
      return;
    }

    if (type === 'APPLICATION_TRANSFER_FAILED' || type === 'PARTICIPANT_JOINED_FAILED') {
      console.warn('Transfer/join failed:', JSON.stringify(event, null, 2));
      return;
    }
  } catch (error) {
    console.error(
      '❌ Voice webhook error:',
      error?.response?.status,
      JSON.stringify(error?.response?.data || {}, null, 2) || error.message
    );

    const event = req.body || {};
    const callId = event.callId;
    const apiBaseUrl =
      event?.properties?.apiBaseUrl ||
      event?.properties?.call?.apiBaseUrl ||
      INFOBIP_BASE_URL;

    if (callId) {
      try {
        await hangupCall(callId, apiBaseUrl);
      } catch (hangupError) {
        console.error('❌ Hangup after error failed:', hangupError.message);
      }
    }
  }
});

module.exports = router;