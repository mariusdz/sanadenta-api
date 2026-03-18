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
  TIME_ZONE,
} = require('../config');

const { normalizePhone } = require('../utils/phone');
const { sendInfobipSms } = require('../services/sms');
const { synthesizeTextToPublicFile } = require('../services/googleTts');

const closedCalls = new Set();
const menuCalls = new Set();
const actionAfterPlay = new Map(); // callId -> 'hangup' | 'connectAdmin'
const pendingAdminDialogs = new Map(); // dialogId -> parentCallId

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
  return true;

  // Realus variantas:
  // const now = DateTime.now().setZone(TIME_ZONE);
  // const weekday = now.weekday; // 1=Mon ... 7=Sun
  // const hour = now.hour;
  // return weekday >= 1 && weekday <= 5 && hour >= 8 && hour < 17;
}

async function answerCall(callId, apiBaseUrl) {
  const response = await getInfobipClient(apiBaseUrl).post(
    `/calls/1/calls/${callId}/answer`,
    {}
  );

  console.log('ANSWER RESPONSE STATUS:', response.status);
  console.log('ANSWER RESPONSE DATA:', JSON.stringify(response.data || {}, null, 2));

  return response;
}

async function playAudioFromUrl(callId, fileUrl, apiBaseUrl) {
  const payload = {
    loopCount: 1,
    content: {
      type: 'URL',
      fileUrl,
    },
  };

  console.log('PLAY URL:', `${apiBaseUrl || INFOBIP_BASE_URL}/calls/1/calls/${callId}/play`);
  console.log('PLAY PAYLOAD:', JSON.stringify(payload, null, 2));

  const response = await getInfobipClient(apiBaseUrl).post(
    `/calls/1/calls/${callId}/play`,
    payload
  );

  console.log('PLAY RESPONSE STATUS:', response.status);
  console.log('PLAY RESPONSE DATA:', JSON.stringify(response.data || {}, null, 2));

  return response;
}

async function playLithuanianText(callId, text, cacheKey, apiBaseUrl) {
  const { publicUrl, cached } = await synthesizeTextToPublicFile(text, cacheKey);

  console.log('AUDIO READY:', {
    cacheKey,
    publicUrl,
    cached,
  });

  return playAudioFromUrl(callId, publicUrl, apiBaseUrl);
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
  const payload = {
    maxLength,
    timeout,
    terminator,
  };

  console.log('DTMF URL:', `${apiBaseUrl || INFOBIP_BASE_URL}/calls/1/calls/${callId}/capture/dtmf`);
  console.log('DTMF PAYLOAD:', JSON.stringify(payload, null, 2));

  const response = await getInfobipClient(apiBaseUrl).post(
    `/calls/1/calls/${callId}/capture/dtmf`,
    payload
  );

  console.log('DTMF RESPONSE STATUS:', response.status);
  console.log('DTMF RESPONSE DATA:', JSON.stringify(response.data || {}, null, 2));

  return response;
}

async function hangupCall(callId, apiBaseUrl) {
  const response = await getInfobipClient(apiBaseUrl).post(
    `/calls/1/calls/${callId}/hangup`,
    {}
  );

  console.log('HANGUP RESPONSE STATUS:', response.status);
  console.log('HANGUP RESPONSE DATA:', JSON.stringify(response.data || {}, null, 2));

  return response;
}

async function createDialogToAdmin(parentCallId, apiBaseUrl) {
  if (!ADMIN_PHONE) {
    throw new Error('ADMIN_PHONE is not configured');
  }

  if (!INFOBIP_VOICE_FROM) {
    throw new Error('INFOBIP_VOICE_FROM is not configured');
  }

  const payload = {
    parentCallId,
    childCallRequest: {
      endpoint: {
        type: 'PHONE',
        phoneNumber: normalizePhone(ADMIN_PHONE),
      },
      from: INFOBIP_VOICE_FROM,
      applicationId: INFOBIP_CALLS_APPLICATION_ID,
      connectTimeout: 40,
    },
  };

  console.log('DIALOG URL:', `${apiBaseUrl || INFOBIP_BASE_URL}/calls/1/dialogs`);
  console.log('DIALOG PAYLOAD:', JSON.stringify(payload, null, 2));

  const response = await getInfobipClient(apiBaseUrl).post('/calls/1/dialogs', payload);

  console.log('DIALOG RESPONSE STATUS:', response.status);
  console.log('DIALOG RESPONSE DATA:', JSON.stringify(response.data || {}, null, 2));

  const dialogId = response?.data?.id || response?.data?.dialogId;
  if (dialogId) {
    pendingAdminDialogs.set(dialogId, parentCallId);
  }

  return response;
}

async function notifyAdminAboutCallback(fromNumber) {
  if (!ADMIN_PHONE) {
    console.warn('ADMIN_PHONE not set, callback SMS skipped');
    return { skipped: true, reason: 'Missing ADMIN_PHONE' };
  }

  const text =
    `Sanadenta VOICE MVP: perskambinti klientui ${fromNumber}. ` +
    `Jis pasirinko perskambinimą per voice meniu.`;

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

function cleanupCall(callId) {
  if (!callId) return;
  closedCalls.delete(callId);
  menuCalls.delete(callId);
  actionAfterPlay.delete(callId);
}

router.post('/call-received', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body || {};
    const type = event.type;
    const callId = event.callId;
    const from = extractFromPhone(event);
    const digits = extractDigits(event);

    const apiBaseUrl = INFOBIP_BASE_URL;

    console.log('📞 Infobip voice event:', JSON.stringify(event, null, 2));
    console.log(`📌 Event type: ${type}, callId: ${callId}`);
    console.log('📡 Using Calls API base URL:', apiBaseUrl);

    if (!type) {
      console.warn('Voice event missing type');
      return;
    }

    if (type === 'CALL_RECEIVED') {
      if (!callId) return;

      await answerCall(callId, apiBaseUrl);

      if (!isWorkingHours()) {
        closedCalls.add(callId);

        await playLithuanianText(
          callId,
          'Sveiki, čia Sanadenta. Šiuo metu nedirbame. Užsiregistruoti galite mūsų interneto svetainėje. Ačiū už jūsų skambutį.',
          'closed-hours',
          apiBaseUrl
        );

        return;
      }

      return;
    }

    if (type === 'CALL_ESTABLISHED') {
      if (!callId) return;

      console.log('CALL_ESTABLISHED received for:', callId);

      if (closedCalls.has(callId)) {
        console.log(`ℹ️ Skambutis ne darbo metu prijungtas: ${callId}`);
        return;
      }

      menuCalls.add(callId);

      await playLithuanianText(
        callId,
        'Sveiki, čia Sanadenta. Jeigu norite, kad perskambintume dėl vizito registracijos, spauskite 1. Jeigu norite būti sujungti su administratore, spauskite 2.',
        'main-menu',
        apiBaseUrl
      );

      return;
    }

    if (type === 'PLAY_FINISHED') {
      if (!callId) return;

      console.log('PLAY_FINISHED for:', callId);

      if (closedCalls.has(callId)) {
        await hangupCall(callId, apiBaseUrl);
        return;
      }

      const nextAction = actionAfterPlay.get(callId);

      if (nextAction === 'hangup') {
        actionAfterPlay.delete(callId);
        menuCalls.delete(callId);
        await hangupCall(callId, apiBaseUrl);
        return;
      }

      if (nextAction === 'connectAdmin') {
        actionAfterPlay.delete(callId);
        menuCalls.delete(callId);
        await createDialogToAdmin(callId, apiBaseUrl);
        return;
      }

      if (menuCalls.has(callId)) {
        await captureDtmf(
          callId,
          {
            maxLength: 1,
            timeout: 10,
            terminator: '#',
          },
          apiBaseUrl
        );
        return;
      }

      return;
    }

    if (type === 'DTMF_COLLECTED' || type === 'DTMF_CAPTURED') {
      if (!callId) return;

      const pressed = String(digits || '').trim();
      const timedOut = Boolean(
        event?.properties?.timeout ||
        event?.timeout
      );

      console.log('DTMF HANDLER:', {
        pressed,
        timedOut,
        rawDigits: digits,
        from,
        callId,
      });

      if (timedOut || !pressed) {
        await playLithuanianText(
          callId,
          'Nepasirinkote jokio varianto. Ačiū.',
          'no-selection',
          apiBaseUrl
        );

        actionAfterPlay.set(callId, 'hangup');
        menuCalls.delete(callId);
        return;
      }

      if (pressed === '1') {
        const safeFrom = normalizePhone(from || '');

        await notifyAdminAboutCallback(safeFrom || 'Nežinomas numeris');

        await playLithuanianText(
          callId,
          'Ačiū. Jūsų prašymas perskambinti užregistruotas. Susisieksime su jumis darbo metu.',
          'callback-confirmation',
          apiBaseUrl
        );

        actionAfterPlay.set(callId, 'hangup');
        return;
      }

      if (pressed === '2') {
        await playLithuanianText(
          callId,
          'Jungiame su administratore. Prašome palaukti.',
          'connect-admin',
          apiBaseUrl
        );

        actionAfterPlay.set(callId, 'connectAdmin');
        return;
      }

      await playLithuanianText(
        callId,
        'Neteisingas pasirinkimas.',
        'invalid-selection',
        apiBaseUrl
      );

      actionAfterPlay.set(callId, 'hangup');
      return;
    }

    if (
      type === 'DTMF_CAPTURE_FAILED' ||
      type === 'DTMF_COLLECTION_FAILED'
    ) {
      if (!callId) return;

      await playLithuanianText(
        callId,
        'Nepasirinkote jokio varianto. Ačiū.',
        'dtmf-failed',
        apiBaseUrl
      );

      actionAfterPlay.set(callId, 'hangup');
      menuCalls.delete(callId);
      return;
    }

    if (type === 'DIALOG_FAILED') {
      console.warn('📟 DIALOG_FAILED:', JSON.stringify(event, null, 2));

      const dialogId = event?.dialogId || event?.properties?.dialog?.id;
      const parentCallId =
        pendingAdminDialogs.get(dialogId) ||
        event?.properties?.dialog?.parentCall?.id;

      const errorName = event?.properties?.errorCode?.name;

      if (parentCallId && errorName === 'NO_ANSWER') {
        await playLithuanianText(
          parentCallId,
          'Administratorė šiuo metu neatsiliepia. Mes jums perskambinsime darbo metu.',
          'admin-no-answer',
          apiBaseUrl
        );

        const parentFrom =
          event?.properties?.dialog?.parentCall?.from ||
          event?.properties?.dialog?.parentCall?.endpoint?.phoneNumber ||
          '';

        const safeFrom = normalizePhone(parentFrom || '');
        await notifyAdminAboutCallback(safeFrom || 'Nežinomas numeris');

        actionAfterPlay.set(parentCallId, 'hangup');
      }

      if (dialogId) {
        pendingAdminDialogs.delete(dialogId);
      }

      return;
    }

    if (
      type === 'DIALOG_CREATED' ||
      type === 'DIALOG_ESTABLISHED' ||
      type === 'DIALOG_FINISHED' ||
      type === 'PARTICIPANT_JOINING' ||
      type === 'PARTICIPANT_JOINED' ||
      type === 'PARTICIPANT_JOIN_FAILED'
    ) {
      console.log(`📟 ${type}:`, JSON.stringify(event, null, 2));
      return;
    }

    if (
      type === 'APPLICATION_TRANSFER_FAILED' ||
      type === 'APPLICATION_TRANSFER_FINISHED'
    ) {
      console.warn(`${type}:`, JSON.stringify(event, null, 2));
      return;
    }

    if (type === 'CALL_FAILED') {
      console.warn('CALL_FAILED:', JSON.stringify(event, null, 2));
      cleanupCall(callId);
      return;
    }

    if (type === 'CALL_FINISHED') {
      console.log('CALL_FINISHED:', callId);
      cleanupCall(callId);
      return;
    }

    console.log(`ℹ️ Neapdorotas event tipas: ${type}`);
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data || {};

    console.error('❌ Voice webhook raw error object:', error);
    console.error('❌ Voice webhook error message:', error?.message);
    console.error('❌ Voice webhook error stack:', error?.stack);
    console.error(
      '❌ Voice webhook error response:',
      status,
      JSON.stringify(data, null, 2)
    );

    return;
  }
});

module.exports = router;