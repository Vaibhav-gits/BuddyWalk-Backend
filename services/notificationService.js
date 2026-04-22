const admin = require("../config/firebase");

const recentSends = new Map();
const DEDUPE_WINDOW_MS = 30 * 1000;

function shouldSend(token, title, body) {
  try {
    const key = `${token}|${title}|${body}`;
    const now = Date.now();
    const last = recentSends.get(key) || 0;
    if (now - last < DEDUPE_WINDOW_MS) return false;
    recentSends.set(key, now);

    if (recentSends.size > 5000) {
      const cutoff = now - DEDUPE_WINDOW_MS;
      for (const [k, v] of recentSends) {
        if (v < cutoff) recentSends.delete(k);
      }
    }

    return true;
  } catch (e) {
    return true;
  }
}

async function sendPushNotification(tokenOrTokens, title, body, data = {}) {
  const tokens = Array.isArray(tokenOrTokens) ? tokenOrTokens : [tokenOrTokens];

  const uniqueTokens = [...new Set(tokens.filter((t) => !!t))];

  const results = [];

  for (const token of uniqueTokens) {
    if (!shouldSend(token, title, body)) {
      results.push({ token, skipped: true });
      continue;
    }

    const message = {
      token: token,
      notification: {
        title: title,
        body: body,
      },
      data: data,
      android: {
        notification: {
          channelId: "default",
          sound: "default",
        },
      },
    };
    try {
      const response = await admin.messaging().send(message);
      results.push({ token, response });
    } catch (error) {
      console.error(
        "Notification error for token",
        token,
        error.message || error,
      );
      results.push({ token, error: error.message || error });
    }
  }

  return results;
}

module.exports = {
  sendPushNotification,
};
