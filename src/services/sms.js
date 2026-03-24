// src/services/sms.js
const {
  INFOBIP_API_KEY,
  INFOBIP_BASE_URL,
  INFOBIP_SMS_FROM,
  INFOBIP_CONFIRMATION_FROM,
  INFOBIP_2WAY_FROM,
  INFOBIP_DELIVERY_REPORT_URL,
  ADMIN_PHONE,
} = require('../config');

const { normalizePhone } = require('../utils/phone');
const { formatHumanDateTime } = require('../utils/dateTime');

const getConfirmationSender = () =>
  INFOBIP_CONFIRMATION_FROM || INFOBIP_SMS_FROM || INFOBIP_2WAY_FROM;

const getReminderSender = () =>
  INFOBIP_2WAY_FROM || INFOBIP_CONFIRMATION_FROM || INFOBIP_SMS_FROM;

const canSendSms = () =>
  Boolean(INFOBIP_API_KEY && INFOBIP_BASE_URL && getConfirmationSender());

const sendInfobipSms = async ({
  from,
  to,
  text,
  meta = {},
}) => {
  if (!INFOBIP_API_KEY || !INFOBIP_BASE_URL) {
    console.warn('⚠️ SMS skipped: INFOBIP env vars missing', {
      hasApiKey: Boolean(INFOBIP_API_KEY),
      hasBaseUrl: Boolean(INFOBIP_BASE_URL),
      meta,
    });

    return {
      skipped: true,
      reason: 'Missing Infobip config',
      messageId: null,
      statusGroup: null,
      statusName: null,
      raw: null,
    };
  }

  const normalizedTo = normalizePhone(to);

  console.log('📞 SMS PHONE NORMALIZATION', {
    originalTo: to,
    normalizedTo,
    meta,
  });

  if (!normalizedTo) {
    throw new Error(`Invalid phone number for SMS: ${to}`);
  }

  if (!from) {
    throw new Error('SMS sender (from) is not configured');
  }

  const url = `${INFOBIP_BASE_URL}/sms/2/text/advanced`;

  const payload = {
    messages: [
      {
        from,
        destinations: [{ to: normalizedTo }],
        text,
        notifyUrl: INFOBIP_DELIVERY_REPORT_URL,
        notifyContentType: 'application/json',
      },
    ],
  };

  console.log('📤 Sending SMS', {
    from,
    to: normalizedTo,
    textLength: text.length,
    notifyUrl: INFOBIP_DELIVERY_REPORT_URL,
    url,
    meta,
  });

  let response;
  let rawText = '';

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `App ${INFOBIP_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    rawText = await response.text();
  } catch (networkError) {
    console.error('❌ Infobip SMS network error', {
      from,
      to: normalizedTo,
      message: networkError.message,
      stack: networkError.stack,
      meta,
    });

    throw networkError;
  }

  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (parseError) {
    console.error('❌ Failed to parse Infobip SMS response as JSON', {
      from,
      to: normalizedTo,
      httpStatus: response.status,
      rawText,
      meta,
    });

    throw new Error('Infobip response is not valid JSON');
  }

  const firstMessage = data?.messages?.[0] || null;

  if (!response.ok) {
    console.error('❌ Infobip SMS error', {
      httpStatus: response.status,
      from,
      to: normalizedTo,
      response: data,
      meta,
    });

    const errorText =
      data?.requestError?.serviceException?.text ||
      data?.requestError?.serviceException?.messageId ||
      data?.requestError?.policyException?.text ||
      data?.requestError?.policyException?.messageId ||
      data?.error?.message ||
      `Infobip SMS failed with status ${response.status}`;

    throw new Error(errorText);
  }

  console.log('✅ SMS sent', {
    from,
    to: normalizedTo,
    messageId: firstMessage?.messageId || null,
    statusGroup: firstMessage?.status?.groupName || null,
    statusName: firstMessage?.status?.name || null,
    statusDescription: firstMessage?.status?.description || null,
    smsCount: firstMessage?.smsCount || null,
    meta,
    raw: data,
  });

  return {
    skipped: false,
    reason: null,
    messageId: firstMessage?.messageId || null,
    statusGroup: firstMessage?.status?.groupName || null,
    statusName: firstMessage?.status?.name || null,
    statusDescription: firstMessage?.status?.description || null,
    to: normalizedTo,
    from,
    raw: data,
  };
};

const sendBookingConfirmationSms = async ({ phone, dateTime, service, meta = {} }) => {
  const text =
    `Sanadenta: Jūsų vizitas patvirtintas ${formatHumanDateTime(dateTime)}. ` +
    `Paslauga: ${service}. Jei negalite atvykti, atsakykite į priminimo SMS arba skambinkite klinikai.`;

  console.log('📝 Building booking confirmation SMS', {
    to: phone,
    service,
    dateTime: dateTime?.toISO?.() || String(dateTime),
    textLength: text.length,
    meta,
  });

  return sendInfobipSms({
    from: getConfirmationSender(),
    to: phone,
    text,
    meta: {
      type: 'booking_confirmation',
      service,
      appointmentAt: dateTime?.toISO?.() || null,
      ...meta,
    },
  });
};

const sendReminderQuestionSms = async ({ phone, dateTime, service, meta = {} }) => {
  const text =
    `Sanadenta: primename apie vizitą ${formatHumanDateTime(dateTime)}` +
    `${service ? `, paslauga: ${service}` : ''}. ` +
    `Ar atvyksite? Atsakykite: TAIP arba NE.`;

  console.log('📝 Building reminder question SMS', {
    to: phone,
    service,
    dateTime: dateTime?.toISO?.() || String(dateTime),
    textLength: text.length,
    meta,
  });

  return sendInfobipSms({
    from: getReminderSender(),
    to: phone,
    text,
    meta: {
      type: 'reminder_question',
      service: service || null,
      appointmentAt: dateTime?.toISO?.() || null,
      ...meta,
    },
  });
};

const sendAdminCancellationSms = async ({ patientPhone, dateTime, service, meta = {} }) => {
  if (!ADMIN_PHONE) {
    console.warn('⚠️ ADMIN_PHONE not set, admin SMS skipped', {
      patientPhone,
      service,
      meta,
    });

    return {
      skipped: true,
      reason: 'Missing ADMIN_PHONE',
      messageId: null,
      statusGroup: null,
      statusName: null,
      raw: null,
    };
  }

  const normalizedPatientPhone = normalizePhone(patientPhone);

  const text =
    `Sanadenta: pacientas ${normalizedPatientPhone} atšaukė vizitą ` +
    `${formatHumanDateTime(dateTime)} (${service || 'Vizitas'}). Laikas atsilaisvino.`;

  console.log('📝 Building admin cancellation SMS', {
    adminPhone: ADMIN_PHONE,
    patientPhone,
    normalizedPatientPhone,
    service,
    dateTime: dateTime?.toISO?.() || String(dateTime),
    textLength: text.length,
    meta,
  });

  return sendInfobipSms({
    from: getConfirmationSender(),
    to: ADMIN_PHONE,
    text,
    meta: {
      type: 'admin_cancellation',
      patientPhone: normalizedPatientPhone,
      service: service || null,
      appointmentAt: dateTime?.toISO?.() || null,
      ...meta,
    },
  });
};

module.exports = {
  canSendSms,
  sendInfobipSms,
  sendBookingConfirmationSms,
  sendReminderQuestionSms,
  sendAdminCancellationSms,
};