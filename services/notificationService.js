const admin = require("../config/firebase");

// In-memory recent-send cache to avoid sending the same notification
// repeatedly in a short window. Keyed by `${token}|${title}|${body}`.
const recentSends = new Map();
const DEDUPE_WINDOW_MS = 30 * 1000; // 30 seconds

function shouldSend(token, title, body) {
  try {
    const key = `${token}|${title}|${body}`;
    const now = Date.now();
    const last = recentSends.get(key) || 0;
    if (now - last < DEDUPE_WINDOW_MS) return false;
    recentSends.set(key, now);

    // Cleanup old entries occasionally to avoid memory growth
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

async function sendPushNotification(tokenOrTokens, title, body) {
  const tokens = Array.isArray(tokenOrTokens)
    ? tokenOrTokens
    : [tokenOrTokens];

  // Send to unique, non-empty tokens only
  const uniqueTokens = [...new Set(tokens.filter((t) => !!t))];

  const results = [];

  for (const token of uniqueTokens) {
    if (!shouldSend(token, title, body)) {
      // Skip duplicate within window
      results.push({ token, skipped: true });
      continue;
    }

    const message = {
      token: token,
      notification: {
        title: title,
        body: body,
      },
      android: { notification: { channelId: "default", sound: "default" } },
    };

    try {
      const response = await admin.messaging().send(message);
      results.push({ token, response });
    } catch (error) {
      console.error("Notification error for token", token, error.message || error);
      results.push({ token, error: error.message || error });
    }
  }

  return results;
}

module.exports = {
  sendPushNotification,
};
