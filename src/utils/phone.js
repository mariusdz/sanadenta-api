function normalizePhone(input = '') {
  if (!input) return '';

  let phone = String(input).trim().replace(/[^\d+]/g, '');

  if (phone.startsWith('+')) {
    return phone;
  }

  if (phone.startsWith('370') && phone.length === 11) {
    return `+${phone}`;
  }

  if (phone.startsWith('8') && phone.length === 9) {
    return `+370${phone.slice(1)}`;
  }

  if (phone.startsWith('6') && phone.length === 8) {
    return `+370${phone}`;
  }

  return phone;
}

function toDisplayPhone(input = '') {
  return normalizePhone(input);
}

function isYesReply(text = '') {
  const value = String(text).trim().toLowerCase();
  return [
    'taip',
    't',
    'yes',
    'y',
    'ok',
    'gerai',
    'patvirtinu',
    'patvirtinta',
  ].includes(value);
}

function isNoReply(text = '') {
  const value = String(text).trim().toLowerCase();
  return [
    'ne',
    'n',
    'no',
    'cancel',
    'atsaukiu',
    'atšaukiu',
    'atsaukti',
    'atšaukti',
  ].includes(value);
}

module.exports = {
  normalizePhone,
  toDisplayPhone,
  isYesReply,
  isNoReply,
};