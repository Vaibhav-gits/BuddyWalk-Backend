const cron = require("node-cron");
const db = require("../config/db");
const { sendPushNotification } = require("../utils/sendPushNotification");
const { canSendNotification } = require("../helpers/notificationLog");
const moment = require("moment-timezone");

cron.schedule("*/10 * * * *", () => {
  db.query(
    `SELECT DISTINCT u.id AS user_id, COALESCE(u.timezone, 'Asia/Kolkata') AS timezone
     FROM users u
     INNER JOIN device_tokens dt ON dt.user_id = u.id`,
    (err, users) => {
      if (err) return console.error("Cron Error (fetch users):", err);
      if (!users.length) return console.log("No users found.");

      const eligibleUsers = users.filter((user) => {
        const userNow = moment.tz(user.timezone);
        return userNow.hour() === 6;
      });

      if (!eligibleUsers.length) return;

      let i = 0;

      function processNext() {
        if (i >= eligibleUsers.length) return;

        const user = eligibleUsers[i++];
        const userId = user.user_id;
        const tz = user.timezone;

        const userNow = moment.tz(tz);
        const yesterday = userNow
          .clone()
          .subtract(1, "day")
          .format("YYYY-MM-DD");

        canSendNotification(
          userId,
          0,
          "yesterday_steps_summary",
          (err1, shouldSend) => {
            if (err1) {
              console.error(`Cron Error (canSend for user ${userId}):`, err1);
              return processNext();
            }

            if (!shouldSend) {
              console.log(`⏭ Already sent to user ${userId} today`);
              return processNext();
            }

            db.query(
              "SELECT step_count FROM steps WHERE user_id = ? AND step_date = ? LIMIT 1",
              [userId, yesterday],
              (err2, stepsRes) => {
                if (err2) {
                  console.error(`Cron Error (steps for user ${userId}):`, err2);
                  return processNext();
                }

                const steps = stepsRes.length
                  ? Number(stepsRes[0].step_count) || 0
                  : 0;

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

                db.query(
                  "SELECT token FROM device_tokens WHERE user_id = ?",
                  [userId],
                  (err3, tokensRes) => {
                    if (err3) {
                      console.error(
                        `Cron Error (tokens for user ${userId}):`,
                        err3,
                      );
                      return processNext();
                    }

                    const tokens = [
                      ...new Set(tokensRes.map((t) => t.token).filter(Boolean)),
                    ];

                    if (!tokens.length) return processNext();

                    sendPushNotification(
                      tokens,
                      "Yesterday's Steps 🚶",
                      message,
                      { ttl: 24 * 60 * 60 * 1000 },
                      (err4) => {
                        if (err4) {
                          console.error(
                            `Cron Error (push for user ${userId}):`,
                            err4,
                          );
                        } else {
                          console.log(
                            ` Sent to user ${userId} [${tz}] - ${steps} steps on ${yesterday}`,
                          );
                        }
                        processNext();
                      },
                    );
                  },
                );
              },
            );
          },
        );
      }

      processNext();
    },
  );
});
