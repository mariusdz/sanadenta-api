// src/utils/phone.js
const normalizePhone = (phone) => {
  if (!phone) return '';

  let cleaned = String(phone).trim().replace(/[^\d+]/g, '');

  // 00370... -> +370...
  if (cleaned.startsWith('00')) {
    cleaned = `+${cleaned.slice(2)}`;
  }

  // jau tarptautinis formatas
  if (/^\+\d{7,15}$/.test(cleaned)) return cleaned;

  // 3706... -> +3706...
  if (/^370\d{8}$/.test(cleaned)) return `+${cleaned}`;

  // LT vietinis naujas formatas 06... -> +3706...
  if (/^0\d{8}$/.test(cleaned)) {
    return `+37${cleaned}`;
  }

  return cleaned;
};

const normalizeSmsText = (text) => {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
};

const isYesReply = (text) => {
  const t = normalizeSmsText(text);
  return [
    'taip',
    'jo',
    'j',
    't',
    'ok',
    'gerai',
    'tinka',
    'patvirtinu',
    'yes',
    'y',
    'atvyksiu',
    'busiu',
  ].includes(t);
};

const isNoReply = (text) => {
  const t = normalizeSmsText(text);
  return [
    'ne',
    'n',
    'no',
    'negaliu',
    'neatvyksiu',
    'nebusiu',
    'netinka',
    'atsaukiu',
    'atšaukiu',
    'cancel',
  ].includes(t);
};

module.exports = {
  normalizePhone,
  normalizeSmsText,
  isYesReply,
  isNoReply,
};