const admin = require("../config/firebaseAdmin");
const db = require("../config/db");

exports.sendNotification = async (req, res) => {
  const { userId, title, body } = req.body;
  db.query(
    "SELECT token FROM device_tokens WHERE user_id = ?",
    [userId],
    async (err, results) => {
      if (err || results.length === 0) {
        return res.status(404).json({ message: "Token not found" });
      }

      // Collect unique tokens
      const tokens = [...new Set(results.map((r) => r.token).filter(Boolean))];

      try {
        // Use notification service to send (it handles dedupe)
        const { sendPushNotification } = require("../services/notificationService");
        await sendPushNotification(tokens, title, body);
        res.json({ message: "Notification sent successfully" });
      } catch (error) {
        console.log("FCM send error:", error.message || error);
        res.status(500).json({ error: error.message || error });
      }
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
    (err, results) => {
      if (err) {
        console.log("DB error on select token by user:", err.message);
        return res.status(500).json({ error: err.message });
      }

      if (results && results.length > 0) {
        db.query(
          "UPDATE device_tokens SET token = ? WHERE user_id = ?",
          [token, userId],
          (upErr) => {
            if (upErr) {
              console.log("DB error on update token:", upErr.message);
              return res.status(500).json({ error: upErr.message });
            }

            return res.json({ message: "Token updated" });
          },
        );
      } else {
        db.query(
          "SELECT id, user_id FROM device_tokens WHERE token = ?",
          [token],
          (tErr, tResults) => {
            if (tErr) {
              console.log("DB error on select token by token:", tErr.message);
              return res.status(500).json({ error: tErr.message });
            }

            if (tResults && tResults.length > 0) {
              db.query(
                "UPDATE device_tokens SET user_id = ? WHERE token = ?",
                [userId, token],
                (reErr) => {
                  if (reErr) {
                    console.log("DB error on reassign token:", reErr.message);
                    return res.status(500).json({ error: reErr.message });
                  }

                  return res.json({ message: "Token reassigned to user" });
                },
              );
            } else {
              db.query(
                "INSERT INTO device_tokens (user_id, token) VALUES (?, ?)",
                [userId, token],
                (inErr) => {
                  if (inErr) {
                    if (inErr.code === "ER_DUP_ENTRY") {
                      db.query(
                        "UPDATE device_tokens SET user_id = ? WHERE token = ?",
                        [userId, token],
                        (updErr) => {
                          if (updErr) {
                            console.log(
                              "DB error on update after duplicate insert:",
                              updErr.message,
                            );
                            return res
                              .status(500)
                              .json({ error: updErr.message });
                          }

                          return res.json({
                            message: "Token reassigned after duplicate insert",
                          });
                        },
                      );
                    } else {
                      console.log("DB error on insert token:", inErr.message);
                      return res.status(500).json({ error: inErr.message });
                    }
                  } else {
                    return res.json({ message: "Token saved" });
                  }
                },
              );
            }
          },
        );
      }
    },
  );
};
