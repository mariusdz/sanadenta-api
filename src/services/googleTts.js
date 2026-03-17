const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const textToSpeech = require('@google-cloud/text-to-speech');

const {
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_TTS_VOICE,
  GOOGLE_TTS_LANGUAGE_CODE,
  PUBLIC_WEB_URL,
} = require('../config');

const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');

function ensureAudioDir() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function sanitizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function hashText(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildClient() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured');
  }

  let credentials;
  try {
    credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (error) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  return new textToSpeech.TextToSpeechClient({
    credentials,
  });
}

async function synthesizeTextToPublicFile(text, keyPrefix = 'tts') {
  ensureAudioDir();

  const hash = hashText(`${GOOGLE_TTS_VOICE}__${GOOGLE_TTS_LANGUAGE_CODE}__${text}`);
  const fileName = `${keyPrefix}-${hash}.mp3`;
  const filePath = path.join(AUDIO_DIR, fileName);
  const publicUrl = `${sanitizeBaseUrl(PUBLIC_WEB_URL)}/audio/${fileName}`;

  if (fs.existsSync(filePath)) {
    return {
      fileName,
      filePath,
      publicUrl,
      cached: true,
    };
  }

  const client = buildClient();

  const ssml = `<speak>${escapeSsml(text)}</speak>`;

  const [response] = await client.synthesizeSpeech({
    input: { ssml },
    voice: {
      languageCode: GOOGLE_TTS_LANGUAGE_CODE,
      name: GOOGLE_TTS_VOICE,
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0.0,
    },
  });

  if (!response.audioContent) {
    throw new Error('Google TTS returned empty audioContent');
  }

  fs.writeFileSync(filePath, response.audioContent, 'binary');

  return {
    fileName,
    filePath,
    publicUrl,
    cached: false,
  };
}

module.exports = {
  synthesizeTextToPublicFile,
};