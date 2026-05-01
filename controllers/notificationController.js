const admin = require("../config/firebaseAdmin");
const db = require("../config/db");
const { sendPushNotification } = require("../services/notificationService");

exports.sendNotification = async (req, res) => {
  try {
    const { userId, title, body } = req.body;

    const [results] = await db.query(
      "SELECT token FROM device_tokens WHERE user_id = ?",
      [userId],
    );

    if (!results.length)
      return res.status(404).json({ message: "Token not found" });

    const tokens = [...new Set(results.map((r) => r.token).filter(Boolean))];

    await sendPushNotification(tokens, title, body);

    return res.json({ message: "Notification sent successfully" });
  } catch (error) {
    console.error("FCM send error:", error.message || error);
    return res.status(500).json({ error: error.message || error });
  }
};

exports.saveToken = async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    const { token } = req.body;

    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!token) return res.status(400).json({ message: "Token is required" });

    const [byUser] = await db.query(
      "SELECT id, token FROM device_tokens WHERE user_id = ?",
      [userId],
    );

    if (byUser.length > 0) {
      await db.query("UPDATE device_tokens SET token = ? WHERE user_id = ?", [
        token,
        userId,
      ]);
      return res.json({ message: "Token updated" });
    }

    const [byToken] = await db.query(
      "SELECT id, user_id FROM device_tokens WHERE token = ?",
      [token],
    );

    if (byToken.length > 0) {
      await db.query("UPDATE device_tokens SET user_id = ? WHERE token = ?", [
        userId,
        token,
      ]);
      return res.json({ message: "Token reassigned to user" });
    }

    try {
      await db.query(
        "INSERT INTO device_tokens (user_id, token) VALUES (?, ?)",
        [userId, token],
      );
      return res.json({ message: "Token saved" });
    } catch (inErr) {
      if (inErr.code === "ER_DUP_ENTRY") {
        await db.query("UPDATE device_tokens SET user_id = ? WHERE token = ?", [
          userId,
          token,
        ]);
        return res.json({ message: "Token reassigned after duplicate insert" });
      }
      throw inErr;
    }
  } catch (err) {
    console.error("saveToken error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.goalMilestone = async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    const { type } = req.body;

    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const [results] = await db.query(
      "SELECT token FROM device_tokens WHERE user_id = ?",
      [userId],
    );

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

    await sendPushNotification(tokens, title, body, { type });

    return res.json({ message: "Goal notification sent" });
  } catch (error) {
    console.error("Goal notification error:", error.message || error);
    return res.status(500).json({ error: error.message || error });
  }
};
