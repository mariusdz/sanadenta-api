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

const closedCalls = new Set();
const menuCalls = new Set();
const actionAfterSay = new Map(); // callId -> 'hangup' | 'connectAdmin'

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
  // TESTUI gali laikinai palikti true
  return true;

  // Realus variantas:
  // const now = DateTime.now().setZone(TIME_ZONE);
  // const weekday = now.weekday;
  // const hour = now.hour;
  // return weekday >= 1 && weekday <= 5 && hour >= 8 && hour < 17;
}

async function answerCall(callId, apiBaseUrl) {
  return getInfobipClient(apiBaseUrl).post(`/calls/1/calls/${callId}/answer`, {});
}

async function sayText(callId, text, apiBaseUrl) {
  const payload = {
    text,
    language: 'en',
  };

  console.log('SAY PAYLOAD:', JSON.stringify(payload));

  return getInfobipClient(apiBaseUrl).post(`/calls/1/calls/${callId}/say`, payload);
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

  console.log('DTMF PAYLOAD:', JSON.stringify(payload));

  return getInfobipClient(apiBaseUrl).post(`/calls/1/calls/${callId}/capture/dtmf`, payload);
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
    console.log(`📌 Event type: ${type}, callId: ${callId}`);
    console.log('📡 Using Calls API base URL:', apiBaseUrl);

    if (!callId || !type) {
      console.warn('Voice event missing type or callId');
      return;
    }

    if (type === 'CALL_RECEIVED') {
      await answerCall(callId, apiBaseUrl);

      if (!isWorkingHours()) {
        closedCalls.add(callId);

        await sayText(
          callId,
          `Hello, this is Sanadenta. We are currently closed. ` +
            `Please register online at ${PUBLIC_WEB_URL}. Thank you for your call.`,
          apiBaseUrl
        );

        return;
      }

      return;
    }

    if (type === 'CALL_ESTABLISHED') {
      if (closedCalls.has(callId)) {
        console.log(`ℹ️ Closed-hours call established: ${callId}`);
        return;
      }

      menuCalls.add(callId);

      await sayText(
        callId,
        'Hello, this is Sanadenta. ' +
          'If you want us to call you back for appointment registration, press 1. ' +
          'If you want to be connected to the administrator, press 2.',
        apiBaseUrl
      );

      return;
    }

    if (type === 'SAY_FINISHED') {
      if (closedCalls.has(callId)) {
        console.log(`ℹ️ Closing call after closed-hours message: ${callId}`);
        await hangupCall(callId, apiBaseUrl);
        return;
      }

      const nextAction = actionAfterSay.get(callId);

      if (nextAction === 'hangup') {
        console.log(`ℹ️ Hanging up after confirmation message: ${callId}`);
        actionAfterSay.delete(callId);
        menuCalls.delete(callId);
        await hangupCall(callId, apiBaseUrl);
        return;
      }

      if (nextAction === 'connectAdmin') {
        console.log(`ℹ️ Connecting to admin after announcement: ${callId}`);
        actionAfterSay.delete(callId);
        menuCalls.delete(callId);
        await createDialogToAdmin(callId, apiBaseUrl);
        return;
      }

      if (menuCalls.has(callId)) {
        console.log(`ℹ️ Starting DTMF capture after menu prompt: ${callId}`);
        await captureDtmf(
          callId,
          {
            maxLength: 1,
            timeout: 8,
            terminator: '#',
          },
          apiBaseUrl
        );
        return;
      }

      return;
    }

    if (type === 'DTMF_CAPTURED') {
      console.log('DTMF HANDLER:', { pressed, timedOut, rawDigits: digits });
      const pressed = String(digits || '').trim();
      const timedOut = Boolean(event?.properties?.timeout);

      if (timedOut || !pressed) {
        await sayText(
          callId,
          `No option was selected. Please register online at ${PUBLIC_WEB_URL}. Thank you.`,
          apiBaseUrl
        );
        menuCalls.delete(callId);
        actionAfterSay.set(callId, 'hangup');
        return;
      }

      if (pressed === '1') {
        const safeFrom = normalizePhone(from || '');

        await notifyAdminAboutCallback(safeFrom || 'Unknown number');

        await sayText(
          callId,
          'Thank you. We have recorded your callback request. We will call you back during working hours.',
          apiBaseUrl
        );

        actionAfterSay.set(callId, 'hangup');
        return;
      }

      if (pressed === '2') {
        await sayText(
          callId,
          'Connecting you to the administrator. Please wait.',
          apiBaseUrl
        );

        actionAfterSay.set(callId, 'connectAdmin');
        return;
      }

      await sayText(
        callId,
        `Invalid selection. Please visit ${PUBLIC_WEB_URL} to register online.`,
        apiBaseUrl
      );

      actionAfterSay.set(callId, 'hangup');
      return;
    }

    if (type === 'DTMF_CAPTURE_FAILED') {
      await sayText(
        callId,
        `No option was selected. Please register online at ${PUBLIC_WEB_URL}. Thank you.`,
        apiBaseUrl
      );

      menuCalls.delete(callId);
      actionAfterSay.set(callId, 'hangup');
      return;
    }

    if (type === 'CALL_FAILED') {
      console.warn('CALL_FAILED:', JSON.stringify(event, null, 2));
      closedCalls.delete(callId);
      menuCalls.delete(callId);
      actionAfterSay.delete(callId);
      return;
    }

    if (type === 'CALL_FINISHED') {
      console.log('CALL_FINISHED:', callId);
      closedCalls.delete(callId);
      menuCalls.delete(callId);
      actionAfterSay.delete(callId);
      return;
    }

    if (type === 'PLAY_FINISHED') {
      console.log('PLAY_FINISHED:', callId);
      return;
    }

    if (
      type === 'APPLICATION_TRANSFER_FAILED' ||
      type === 'APPLICATION_TRANSFER_FINISHED' ||
      type === 'DIALOG_FAILED' ||
      type === 'DIALOG_FINISHED' ||
      type === 'PARTICIPANT_JOIN_FAILED'
    ) {
      console.warn(`${type}:`, JSON.stringify(event, null, 2));
      return;
    }
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data || {};

    console.error(
      '❌ Voice webhook error:',
      status,
      JSON.stringify(data, null, 2) || error.message
    );

    if (status === 404) {
      console.warn('ℹ️ Call no longer exists, skipping hangup.');
      return;
    }

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