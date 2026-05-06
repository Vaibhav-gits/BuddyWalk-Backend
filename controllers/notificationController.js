const admin = require("../config/firebaseAdmin");
const db = require("../config/db");
const { sendPushNotification } = require("../services/notificationService");

exports.sendNotification = (req, res) => {
  const { userId, title, body } = req.body;

  db.query(
    "SELECT token FROM device_tokens WHERE user_id = ?",
    [userId],
    (err, results) => {
      if (err) {
        console.error("FCM send error:", err.message || err);
        return res.status(500).json({ error: err.message || err });
      }

      if (!results.length)
        return res.status(404).json({ message: "Token not found" });

      const tokens = [...new Set(results.map((r) => r.token).filter(Boolean))];

      sendPushNotification(tokens, title, body, (error) => {
        if (error) {
          console.error("FCM send error:", error.message || error);
          return res.status(500).json({ error: error.message || error });
        }
        return res.json({ message: "Notification sent successfully" });
      });
    },
  );
};

exports.saveToken = (req, res) => {
  const userId = req.user && req.user.id;
  const { token } = req.body;

  if (!userId) return res.status(401).json({ message: "Unauthorized" });
  if (!token) return res.status(400).json({ message: "Token is required" });

  db.query(
    "SELECT id, token FROM device_tokens WHERE user_id = ?",
    [userId],
    (err, byUser) => {
      if (err) {
        console.error("saveToken error:", err.message);
        return res.status(500).json({ error: err.message });
      }

      if (byUser.length > 0) {
        db.query(
          "UPDATE device_tokens SET token = ? WHERE user_id = ?",
          [token, userId],
          (err2) => {
            if (err2) {
              console.error("saveToken update error:", err2.message);
              return res.status(500).json({ error: err2.message });
            }
            return res.json({ message: "Token updated" });
          },
        );
        return;
      }

      db.query(
        "SELECT id, user_id FROM device_tokens WHERE token = ?",
        [token],
        (err3, byToken) => {
          if (err3) {
            console.error("saveToken error:", err3.message);
            return res.status(500).json({ error: err3.message });
          }

          if (byToken.length > 0) {
            db.query(
              "UPDATE device_tokens SET user_id = ? WHERE token = ?",
              [userId, token],
              (err4) => {
                if (err4) {
                  console.error("saveToken reassign error:", err4.message);
                  return res.status(500).json({ error: err4.message });
                }
                return res.json({ message: "Token reassigned to user" });
              },
            );
            return;
          }

          db.query(
            "INSERT INTO device_tokens (user_id, token) VALUES (?, ?)",
            [userId, token],
            (err5) => {
              if (err5) {
                if (err5.code === "ER_DUP_ENTRY") {
                  db.query(
                    "UPDATE device_tokens SET user_id = ? WHERE token = ?",
                    [userId, token],
                    (err6) => {
                      if (err6) {
                        console.error(
                          "saveToken dup update error:",
                          err6.message,
                        );
                        return res.status(500).json({ error: err6.message });
                      }
                      return res.json({
                        message: "Token reassigned after duplicate insert",
                      });
                    },
                  );
                  return;
                }
                console.error("saveToken insert error:", err5.message);
                return res.status(500).json({ error: err5.message });
              }
              return res.json({ message: "Token saved" });
            },
          );
        },
      );
    },
  );
};

exports.goalMilestone = (req, res) => {
  const userId = req.user && req.user.id;
  const { type } = req.body;

  if (!userId) return res.status(401).json({ message: "Unauthorized" });

  db.query(
    "SELECT token FROM device_tokens WHERE user_id = ?",
    [userId],
    (err, results) => {
      if (err) {
        console.error("Goal notification error:", err.message || err);
        return res.status(500).json({ error: err.message || err });
      }

      if (!results.length)
        return res.status(404).json({ message: "Token not found" });

      const tokens = [...new Set(results.map((r) => r.token).filter(Boolean))];

      let title = "";
      let body = "";

      if (type === "half") {
        title = "Half Goal Reached!";
        body = "Great! You reached 50% of your step goal.";
      }

      if (type === "full") {
        title = "Goal Completed!";
        body = "Congratulations! You reached your daily step goal.";
      }

      sendPushNotification(tokens, title, body, { type }, (error) => {
        if (error) {
          console.error("Goal notification error:", error.message || error);
          return res.status(500).json({ error: error.message || error });
        }
        return res.json({ message: "Goal notification sent" });
      });
    },
  );
};
