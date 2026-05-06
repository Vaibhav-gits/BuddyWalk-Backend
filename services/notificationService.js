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

function sendPushNotification(
  tokenOrTokens,
  title,
  body,
  dataOrCallback,
  callback,
) {
  let data = {};
  let cb = callback;

  if (typeof dataOrCallback === "function") {
    cb = dataOrCallback;
  } else {
    data = dataOrCallback || {};
  }

  const tokens = Array.isArray(tokenOrTokens) ? tokenOrTokens : [tokenOrTokens];
  const uniqueTokens = [...new Set(tokens.filter((t) => !!t))];

  const results = [];
  let i = 0;

  function next() {
    if (i >= uniqueTokens.length) return cb(null, results);

    const token = uniqueTokens[i++];

    if (!shouldSend(token, title, body)) {
      results.push({ token, skipped: true });
      return next();
    }

    const message = {
      token,
      notification: { title, body },
      data,
      android: {
        notification: {
          channelId: "default",
          sound: "default",
        },
      },
    };

    admin
      .messaging()
      .send(message)
      .then((response) => {
        results.push({ token, response });
        next();
      })
      .catch((error) => {
        console.error(
          "Notification error for token",
          token,
          error.message || error,
        );
        results.push({ token, error: error.message || error });
        next();
      });
  }

  next();
}

module.exports = { sendPushNotification };
