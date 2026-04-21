const cron = require("node-cron");
const db = require("../config/db");
const { sendPushNotification } = require("../utils/sendPushNotification");
const { canSendNotification } = require("../helpers/notificationLog");
const moment = require("moment-timezone");

const query = (sql, params) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });

cron.schedule("*/10 * * * *", async () => {
  try {
    const users = await query(
      `SELECT DISTINCT u.id AS user_id, COALESCE(u.timezone, 'Asia/Kolkata') AS timezone
       FROM users u
       INNER JOIN device_tokens dt ON dt.user_id = u.id`,
    );

    if (!users.length) return console.log("No users found.");

    for (const user of users) {
      const userId = user.user_id;
      const tz = user.timezone;

      const userNow = moment.tz(tz);

      if (userNow.hour() !== 6) continue;

      const shouldSend = await canSendNotification(
        userId,
        0,
        "yesterday_steps_summary",
      );
      if (!shouldSend) continue;

      const yesterday = userNow.clone().subtract(1, "day").format("YYYY-MM-DD");

      const stepsRes = await query(
        `SELECT step_count FROM steps WHERE user_id = ? AND step_date = ? LIMIT 1`,
        [userId, yesterday],
      );

      const steps = stepsRes.length ? Number(stepsRes[0].step_count) || 0 : 0;

      let message = "";
      if (steps === 0) {
        message = `You didn't walk yesterday. Let's start fresh today! 💪`;
      } else if (steps < 5000) {
        message = `You walked ${steps.toLocaleString()} steps yesterday. Let's move more today! 💪`;
      } else if (steps < 10000) {
        message = `Great! You walked ${steps.toLocaleString()} steps yesterday. Almost at the goal! 🔥`;
      } else {
        message = `Amazing! You walked ${steps.toLocaleString()} steps yesterday. Goal smashed! 🏆`;
      }

      const tokensRes = await query(
        `SELECT token FROM device_tokens WHERE user_id = ?`,
        [userId],
      );

      const tokens = [
        ...new Set(tokensRes.map((t) => t.token).filter(Boolean)),
      ];
      if (!tokens.length) continue;

      await sendPushNotification(tokens, "Yesterday's Steps 🚶", message, {
        ttl: 24 * 60 * 60 * 1000, // 24 hours in ms
      });

      console.log(
        ` Sent to user ${userId} [${tz}] - ${steps} steps on ${yesterday}`,
      );
    }
  } catch (err) {
    console.error("Cron Error:", err);
  }
});
