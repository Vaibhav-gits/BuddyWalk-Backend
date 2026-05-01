const cron = require("node-cron");
const { generate } = require("random-words");
const admin = require("firebase-admin");
const moment = require("moment-timezone");
const db = require("../config/db");

let isRunning = false;

const acquireLock = () => {
  if (isRunning) {
    return false;
  }
  isRunning = true;
  return true;
};

const releaseLock = () => {
  isRunning = false;
};

const SENSITIVE_WORDS = [
  // Self-harm related
  "suicide",
  "kill",
  "death",
  "dead",
  "die",
  "dying",
  "harm",
  "hurt",
  "pain",
  "suffer",
  "suffering",
  "torture",
  "abuse",
  "abusive",
  // Violent words
  "violence",
  "violent",
  "murder",
  "attack",
  "fight",
  "fighting",
  "war",
  "weapon",
  "gun",
  "bomb",
  "explosion",
  // Hate/Discriminatory
  "hate",
  "racist",
  "racism",
  "sexist",
  "sexism",
  "discrimination",
  "discriminate",
  // Substance abuse
  "drug",
  "drugs",
  "heroin",
  "cocaine",
  "methamphetamine",
  "addiction",
  // Offensive language
  "damn",
  "hell",
  "crap",
  "ass",
  "bitch",
  "bastard",
  "fuck",
  "shit",
  "piss",
  "dick",
  // Adult content
  "porn",
  "sex",
  "sexual",
  "naked",
  // Other offensive words
  "stupid",
  "idiot",
  "retard",
  "retarded",
  "loser",
  "dumb",
];

const containsSensitiveWords = (message) => {
  const lowerMessage = message.toLowerCase();
  return SENSITIVE_WORDS.some((word) => {
    const regex = new RegExp(`\\b${word}\\b`, "i");
    return regex.test(lowerMessage);
  });
};

const generateMessage = (retryCount = 0, maxRetries = 3) => {
  const wordCount = Math.floor(Math.random() * 8) + 7;
  const words = generate({ exactly: wordCount });

  let sentence = words.join(" ");
  sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  sentence += ".";

  if (containsSensitiveWords(sentence)) {
    if (retryCount < maxRetries) {
      return generateMessage(retryCount + 1, maxRetries);
    }
    console.warn(
      `⚠️ Could not generate clean message after ${maxRetries} attempts`,
    );
    return "Keep up the great work today.";
  }

  return sentence;
};

const isWithinNotificationWindow = (timezone) => {
  let userTime;

  try {
    if (!timezone || !moment.tz.zone(timezone)) {
      console.warn(`⚠️ Invalid timezone: ${timezone}, using UTC`);
      userTime = moment.utc();
    } else {
      userTime = moment.tz(timezone);
    }

    const userHour = userTime.hour();
    return userHour >= 6 && userHour < 18;
  } catch (err) {
    console.error(`Error checking timezone ${timezone}:`, err.message);
    return false;
  }
};

const hasAlreadySentToday = (userId, callback) => {
  const today = moment.utc().startOf("day").format("YYYY-MM-DD HH:mm:ss");

  db.query(
    "SELECT COUNT(*) as count FROM user_messages WHERE user_id = ? AND sent_at >= ?",
    [userId, today],
    (err, results) => {
      if (err) {
        console.error(
          `❌ Error checking sent status for user ${userId}:`,
          err.message,
        );
        callback(true);
        return;
      }

      const alreadySent = results && results[0] && results[0].count > 0;
      callback(alreadySent);
    },
  );
};

const insertMessageWithRetry = (userId, callback) => {
  let retryCount = 0;
  let callbackExecuted = false;

  const executeCallback = (result) => {
    if (!callbackExecuted) {
      callbackExecuted = true;
      callback(result);
    }
  };

  const tryInsert = () => {
    const message = generateMessage();

    db.query(
      "INSERT INTO user_messages (user_id, message) VALUES (?, ?)",
      [userId, message],
      (err) => {
        if (err) {
          if (err.code === "ER_DUP_ENTRY" && retryCount < 5) {
            retryCount++;
            console.log(
              `⚠️ Duplicate message for user ${userId}, retrying (${retryCount}/5)`,
            );
            tryInsert(); // Retry with new message
          } else if (err.code === "ER_DUP_ENTRY") {
            console.error(
              `❌ Max retries exceeded for user ${userId} - all recent messages are duplicates`,
            );
            executeCallback(null);
          } else {
            console.error(`❌ DB Error for user ${userId}:`, err.message);
            executeCallback(null);
          }
        } else {
          executeCallback(message);
        }
      },
    );
  };

  tryInsert();
};

const sendFCMNotification = (user, message, callback) => {
  if (!user.fcmToken || !message) {
    callback(false);
    return;
  }

  admin
    .messaging()
    .send({
      token: user.fcmToken,
      notification: {
        title: "G-O-D Message",
        body: message,
      },
    })
    .then(() => {
      console.log(`✅ Sent to ${user.email} (ID: ${user.id}) - "${message}"`);
      callback(true);
    })
    .catch((error) => {
      console.error(`❌ FCM Error for ${user.email}:`, error.message);
      callback(false);
    });
};

const processUser = (user, callback) => {
  if (!user || !user.id) {
    callback();
    return;
  }

  if (!user.fcmToken) {
    console.log(`⚠️ Skipping ${user.email} - No FCM token`);
    callback();
    return;
  }

  // Check timezone window
  if (!isWithinNotificationWindow(user.timezone)) {
    callback();
    return;
  }

  // Check if already sent today (idempotency)
  hasAlreadySentToday(user.id, (alreadySent) => {
    if (alreadySent) {
      console.log(`⏭️ Already sent to ${user.email} today`);
      callback();
      return;
    }

    // Try to insert message
    insertMessageWithRetry(user.id, (message) => {
      if (!message) {
        console.log(`⚠️ Failed to insert message for user ${user.id}`);
        callback();
        return;
      }

      // Send FCM notification
      sendFCMNotification(user, message, (success) => {
        callback();
      });
    });
  });
};

const processBatch = (users, index, stats, callback) => {
  // Base case: all users processed
  if (index >= users.length) {
    callback(stats);
    return;
  }

  const user = users[index];

  // Process current user
  processUser(user, () => {
    stats.processed++;

    // Move to next user
    processBatch(users, index + 1, stats, callback);
  });
};

const fetchNextBatch = (callback) => {
  const BATCH_SIZE = 20;

  db.query(
    `SELECT u.id, u.email, u.name, u.timezone, dt.token AS fcmToken 
     FROM users u
     LEFT JOIN device_tokens dt ON u.id = dt.user_id
     WHERE dt.token IS NOT NULL
     ORDER BY u.id ASC
     LIMIT ?`,
    [BATCH_SIZE],
    (err, users) => {
      if (err) {
        console.error("❌ DB Query Error:", err.message);
        callback([]);
        return;
      }

      if (!users || !users.length) {
        console.log("⚠️ No users with valid FCM tokens found");
        callback([]);
        return;
      }

      callback(users);
    },
  );
};

cron.schedule("*/2 * * * *", () => {
  if (!acquireLock()) {
    console.log("⏸️ Previous cron run still in progress, skipping this run");
    return;
  }

  try {
    const startTime = new Date();

    fetchNextBatch((users) => {
      if (!users.length) {
        releaseLock();
        return;
      }

      const stats = {
        processed: 0,
        total: users.length,
      };

      // Process users sequentially with callbacks
      processBatch(users, 0, stats, (finalStats) => {
        const endTime = new Date();
        const duration = endTime - startTime;

        releaseLock();
      });
    });
  } catch (err) {
    console.error("🚨 Cron Error:", err.message);
    releaseLock();
  }
});

process.on("SIGTERM", () => {
  const maxWait = 30000; // 30 second timeout
  const startWait = Date.now();

  const checkAndExit = () => {
    if (!isRunning) {
      process.exit(0);
    } else if (Date.now() - startWait > maxWait) {
      console.warn("⚠️ Timeout waiting for cron, forcing exit");
      process.exit(1);
    } else {
      setTimeout(checkAndExit, 100);
    }
  };

  checkAndExit();
});
