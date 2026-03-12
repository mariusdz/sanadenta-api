// src/services/sms.js
const {
  INFOBIP_API_KEY,
  INFOBIP_BASE_URL,
  INFOBIP_SMS_FROM,
  INFOBIP_CONFIRMATION_FROM,
  ADMIN_PHONE,
} = require('../config');

const { normalizePhone } = require('../utils/phone');
const { formatHumanDateTime } = require('../utils/dateTime');

const canSendSms = () => Boolean(INFOBIP_API_KEY && INFOBIP_BASE_URL);

const sendInfobipSms = async ({ from, to, text }) => {
  if (!canSendSms()) {
    console.warn('⚠️ SMS skipped: INFOBIP env vars missing');
    return { skipped: true, reason: 'Missing Infobip config' };
  }

  const normalizedTo = normalizePhone(to);

  if (!normalizedTo) {
    throw new Error('Invalid phone number for SMS');
  }

  if (!from) {
    throw new Error('SMS sender (from) is not configured');
  }

  const payload = {
    messages: [
      {
        from,
        destinations: [{ to: normalizedTo }],
        text,
      },
    ],
  };

  const response = await fetch(`${INFOBIP_BASE_URL}/sms/2/text/advanced`, {
    method: 'POST',
    headers: {
      Authorization: `App ${INFOBIP_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('❌ Infobip SMS error:', data);

    const errorText =
      data?.requestError?.serviceException?.text ||
      data?.error?.message ||
      `Infobip SMS failed with status ${response.status}`;

    throw new Error(errorText);
  }

  console.log('✅ SMS sent:', JSON.stringify(data));
  return data;
};

const sendBookingConfirmationSms = async ({ phone, dateTime, service }) => {
  const text =
    `Sanadenta: Jūsų vizitas patvirtintas ${formatHumanDateTime(dateTime)}. ` +
    `Paslauga: ${service}. Jei negalite atvykti, atsakykite į priminimo SMS arba skambinkite klinikai.`;

  return sendInfobipSms({
    from: INFOBIP_CONFIRMATION_FROM || INFOBIP_SMS_FROM,
    to: phone,
    text,
  });
};

const sendReminderQuestionSms = async ({ phone, dateTime, service }) => {
  const text =
    `Sanadenta: primename apie vizitą ${formatHumanDateTime(dateTime)}` +
    `${service ? `, paslauga: ${service}` : ''}. ` +
    `Ar atvyksite? Atsakykite: TAIP arba NE.`;

  return sendInfobipSms({
    from: INFOBIP_SMS_FROM || INFOBIP_CONFIRMATION_FROM,
    to: phone,
    text,
  });
};

const sendAdminCancellationSms = async ({ patientPhone, dateTime, service }) => {
  if (!ADMIN_PHONE) {
    console.warn('⚠️ ADMIN_PHONE not set, admin SMS skipped');
    return { skipped: true, reason: 'Missing ADMIN_PHONE' };
  }

  const text =
    `Sanadenta: pacientas ${normalizePhone(patientPhone)} atšaukė vizitą ` +
    `${formatHumanDateTime(dateTime)} (${service || 'Vizitas'}). Laikas atsilaisvino.`;

  return sendInfobipSms({
    from: INFOBIP_CONFIRMATION_FROM || INFOBIP_SMS_FROM,
    to: ADMIN_PHONE,
    text,
  });
};

module.exports = {
  canSendSms,
  sendInfobipSms,
  sendBookingConfirmationSms,
  sendReminderQuestionSms,
  sendAdminCancellationSms,
};