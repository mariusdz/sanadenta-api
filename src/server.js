require("dotenv").config();

const app = require("./app");
const {
  TIME_ZONE,
  CALENDAR_ID,
  API_KEY,
  ADMIN_PHONE,
  FREE_SLOTS_CACHE_MS,
  GOOGLE_SERVICE_ACCOUNT_JSON,
} = require("./config");

const { canSendSms } = require("./services/sms");
const { startReminderJob } = require("./services/reminder");

const PORT = process.env.PORT || 3000;

let parsedServiceAccount = {};

try {
  parsedServiceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
} catch (err) {
  console.error("❌ GOOGLE_SERVICE_ACCOUNT_JSON parse klaida:", err.message);
}

console.log("RENDER PORT:", PORT);
console.log("RENDER SERVICE ACCOUNT:", parsedServiceAccount.client_email || "NOT SET");
console.log("RENDER CALENDAR_ID:", CALENDAR_ID || "NOT SET");
console.log("EMAIL:", parsedServiceAccount.client_email || "NOT SET");
console.log("KEY EXISTS:", !!parsedServiceAccount.private_key);
console.log("CALENDAR:", CALENDAR_ID || "NOT SET");

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Sanadenta API running on port ${PORT}`);
  console.log(`📍 Timezone: ${TIME_ZONE}`);
  console.log(`📅 Calendar ID: ${CALENDAR_ID ? `${CALENDAR_ID.substring(0, 20)}...` : "NOT SET"}`);
  console.log(`🔑 API Key protection: ${API_KEY ? "ON" : "OFF"}`);
  console.log(`📩 SMS configured: ${typeof canSendSms === "function" ? (canSendSms() ? "YES" : "NO") : "UNKNOWN"}`);
  console.log(`👩‍💼 Admin phone configured: ${ADMIN_PHONE ? "YES" : "NO"}`);
  console.log(`⚡ Free slots cache TTL: ${FREE_SLOTS_CACHE_MS} ms`);

  console.log(`\n📋 Endpoints:`);
  console.log(`   GET  /`);
  console.log(`   GET  /health`);
  console.log(`   GET  /free-slots`);
  console.log(`   POST /create-booking`);
  console.log(`   POST /infobip/call-received`);
  console.log(`   POST /infobip/inbound-sms`);
  console.log(`   POST /run-reminders-now`);
  console.log(`   GET  /test-calendar`);

  console.log(`\n✅ Server ready\n`);

  try {
    if (typeof startReminderJob === "function") {
      startReminderJob();
    }
  } catch (err) {
    console.error("❌ startReminderJob klaida:", err.message);
  }
});