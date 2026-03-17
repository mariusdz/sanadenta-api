const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sdk = require('microsoft-cognitiveservices-speech-sdk');

const {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  AZURE_TTS_VOICE,
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

function buildSsml(text, voiceName) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `
<speak version="1.0" xml:lang="lt-LT">
  <voice name="${voiceName}">
    <prosody rate="0%" pitch="0%">
      ${escaped}
    </prosody>
  </voice>
</speak>`.trim();
}

function createSpeechConfig() {
  if (!AZURE_SPEECH_KEY) {
    throw new Error('AZURE_SPEECH_KEY is not configured');
  }

  if (!AZURE_SPEECH_REGION) {
    throw new Error('AZURE_SPEECH_REGION is not configured');
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    AZURE_SPEECH_KEY,
    AZURE_SPEECH_REGION
  );

  speechConfig.speechSynthesisVoiceName = AZURE_TTS_VOICE;

  // 16kHz mono wav - saugu voice scenarijams
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm;

  return speechConfig;
}

async function synthesizeTextToPublicFile(text, keyPrefix = 'tts') {
  ensureAudioDir();

  const hash = hashText(`${AZURE_TTS_VOICE}__${text}`);
  const fileName = `${keyPrefix}-${hash}.wav`;
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

  const speechConfig = createSpeechConfig();
  const audioConfig = sdk.AudioConfig.fromAudioFileOutput(filePath);
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);
  const ssml = buildSsml(text, AZURE_TTS_VOICE);

  await new Promise((resolve, reject) => {
    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();

        if (
          result.reason === sdk.ResultReason.SynthesizingAudioCompleted
        ) {
          resolve();
          return;
        }

        reject(
          new Error(
            `Azure TTS synthesis failed: ${result.errorDetails || result.reason}`
          )
        );
      },
      (error) => {
        synthesizer.close();
        reject(error);
      }
    );
  });

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