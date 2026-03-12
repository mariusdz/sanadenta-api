const express = require('express');
const axios = require('axios');

const router = express.Router();

const {
  INFOBIP_API_KEY,
  INFOBIP_BASE_URL,
  INFOBIP_CALLS_APPLICATION_ID,
  INFOBIP_VOICE_FROM,
  ADMIN_PHONE,
  PUBLIC_WEB_URL,
} = require('../config');

const { normalizePhone } = require('../utils/phone');

// Jei jau turi SMS siuntimą adminui – naudok savo esamą funkciją.
// Pvz.:
const { sendInfobipSms } = require('../services/sms'); // jei eksportuota
// Jei neeksportuota – pakeisk savo admin alert funkcija.

const infobip = axios.create({
  baseURL: INFOBIP_BASE_URL,
  headers: {
    Authorization: `App ${INFOBIP_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 15000,
});

function isWorkingHours(date = new Date()) {
  // Lietuvos laiku pas tave galima vėliau padaryti tiksliau per TZ biblioteką.
  const day = date.getDay(); // 0=sekm, 1=pirm...
  const hour = date.getHours();

  const isWeekday = day >= 1 && day <= 5;
  return isWeekday && hour >= 9 && hour < 18;
}

async function answerCall(callId) {
  return infobip.post(`/calls/1/calls/${callId}/answer`, {});
}

async function sayText(callId, text, language = 'lt-LT') {
  return infobip.post(`/calls/1/calls/${callId}/say`, {
    text,
    language,
  });
}

async function captureDtmf(callId, {
  maxLength = 1,
  timeout = 10,
  terminator = '#',
} = {}) {
  return infobip.post(`/calls/1/calls/${callId}/capture/dtmf`, {
    maxLength,
    timeout,
    terminator,
  });
}

async function hangupCall(callId) {
  return infobip.post(`/calls/1/calls/${callId}/hangup`, {});
}

async function createDialogToAdmin(parentCallId) {
  return infobip.post('/calls/1/dialogs', {
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
  const text =
    `Sanadenta VOICE MVP: perskambinti klientui ${fromNumber}. ` +
    `Jis pasirinko callback per voice meniu.`;

  // Jei tavo sendInfobipSms nėra eksportuota – čia pakeisk į savo funkciją.
  return sendInfobipSms({
    from: INFOBIP_VOICE_FROM,
    to: normalizePhone(ADMIN_PHONE),
    text,
  });
}

async function playMainMenu(callId) {
  const text =
    'Sveiki, čia Sanadenta. ' +
    'Jei norite, kad jums perskambintume dėl registracijos, spauskite 1. ' +
    'Jei norite būti sujungti su administratore, spauskite 2.';

  await sayText(callId, text, 'lt-LT');
  await captureDtmf(callId, {
    maxLength: 1,
    timeout: 8,
    terminator: '#',
  });
}

router.post('/call-received', async (req, res) => {
  // Infobip turi gauti 200 kuo greičiau
  res.sendStatus(200);

  try {
    const event = req.body || {};
    const type = event.type;
    const callId = event.callId;
    const from = event.from?.phoneNumber || event.from || event.source?.phoneNumber;
    const digits =
      event.properties?.dtmf ||
      event.properties?.capturedDtmf ||
      event.properties?.digits ||
      event.dtmf;

    console.log('VOICE EVENT:', JSON.stringify(event, null, 2));

    if (!callId || !type) return;

    if (type === 'CALL_RECEIVED') {
      if (!isWorkingHours()) {
        await answerCall(callId);
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

      await answerCall(callId);
      return;
    }

    if (type === 'CALL_ESTABLISHED') {
      // Inbound call established -> paleidžiam pagrindinį meniu
      await playMainMenu(callId);
      return;
    }

    if (type === 'DTMF_COLLECTED' || type === 'SAY_FINISHED' || type === 'PLAY_FINISHED') {
      // Jei naudosi captureDTMF, svarbiausias bus DTMF_COLLECTED
      const pressed = String(digits || '').trim();

      if (pressed === '1') {
        const safeFrom = normalizePhone(from || '');
        await notifyAdminAboutCallback(safeFrom);

        await sayText(
          callId,
          'Ačiū. Užfiksavome jūsų prašymą. Darbo metu jums perskambinsime.',
          'lt-LT'
        );

        await hangupCall(callId);
        return;
      }

      if (pressed === '2') {
        // Peradresuojam admin
        await createDialogToAdmin(callId);
        return;
      }

      // Nieko neįvedė arba neteisingas simbolis
      await sayText(
        callId,
        `Neteisingas pasirinkimas. ` +
          `Registracijai internetu apsilankykite ${PUBLIC_WEB_URL}. ` +
          `Jei reikia, paskambinkite dar kartą.`,
        'lt-LT'
      );
      await hangupCall(callId);
      return;
    }

    if (type === 'CALL_FAILED') {
      console.warn('CALL_FAILED:', event);
      return;
    }

    if (type === 'CALL_FINISHED') {
      console.log('CALL_FINISHED:', callId);
      return;
    }

    if (type === 'APPLICATION_TRANSFER_FAILED' || type === 'PARTICIPANT_JOINED_FAILED') {
      // Jei vėliau pereisi į conference/connect variantą
      console.warn('Transfer/join failed:', event);
      return;
    }
  } catch (error) {
    console.error(
      'VOICE WEBHOOK ERROR:',
      error?.response?.status,
      error?.response?.data || error.message
    );
  }
});

module.exports = router;