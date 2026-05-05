const db = require("../config/db");

// Bulletproof today range: covers full 24h in UTC
const getTodayRange = () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  return {
    start: start.toISOString().slice(0, 19).replace('T', ' '), // "2026-05-04 00:00:00"
    end:   end.toISOString().slice(0, 19).replace('T', ' '),   // "2026-05-04 23:59:59"
  };
};

const getTodayMessage = (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ success: false, message: "userId is required" });

  const { start, end } = getTodayRange();

  const query = `
    SELECT id, user_id, message, sent_at
    FROM user_messages
    WHERE user_id = ?
      AND sent_at >= ?
      AND sent_at <= ?
    ORDER BY sent_at DESC
    LIMIT 1
  `;

  db.query(query, [userId, start, end], (err, results) => {
    if (err) {
      console.error("❌ getTodayMessage DB error:", err.message);
      return res.status(500).json({ success: false, message: "Database error" });
    }
    if (!results || results.length === 0) {
      return res.status(404).json({ success: false, message: "No message found for today" });
    }
    return res.status(200).json({ success: true, data: results[0] });
  });
};

const getMessageHistory = (req, res) => {
  const { userId } = req.params;
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  if (!userId) return res.status(400).json({ success: false, message: "userId is required" });

  const { start } = getTodayRange(); // exclude today and after

  const countQuery = `
    SELECT COUNT(*) as total FROM user_messages
    WHERE user_id = ? AND sent_at < ?
  `;
  const dataQuery = `
    SELECT id, user_id, message, sent_at FROM user_messages
    WHERE user_id = ? AND sent_at < ?
    ORDER BY sent_at DESC
    LIMIT ? OFFSET ?
  `;

  db.query(countQuery, [userId, start], (err, countResult) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });

    const total = countResult[0]?.total || 0;

    db.query(dataQuery, [userId, start, limit, offset], (err, results) => {
      if (err) return res.status(500).json({ success: false, message: "Database error" });

      return res.status(200).json({
        success: true,
        data: results || [],
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit),
          hasMore: offset + limit < total,
        },
      });
    });
  });
};

const generateMessageForNewUser = (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ success: false, message: "userId is required" });

  const { start, end } = getTodayRange();

  db.query(
    "SELECT id, message, sent_at FROM user_messages WHERE user_id = ? AND sent_at >= ? AND sent_at <= ? LIMIT 1",
    [userId, start, end],
    (err, existing) => {
      if (err) return res.status(500).json({ success: false, message: "Database error" });

      if (existing && existing.length > 0) {
        return res.status(200).json({ success: true, data: existing[0], alreadyExisted: true });
      }

      const welcomeMessages = [
        "You are created with purpose and loved beyond measure.",
        "Today is a new beginning — grace walks with you every step.",
        "You were never meant to walk this road alone. I am with you.",
        "Every breath you take is a gift. Live it with joy.",
        "You are seen, known, and deeply loved — always.",
        "My plans for you are good. Trust the journey ahead.",
        "Be still, and know that I am with you today and always.",
      ];
      const message = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];

      db.query(
        "INSERT INTO user_messages (user_id, message) VALUES (?, ?)",
        [userId, message],
        (insertErr, result) => {
          if (insertErr) return res.status(500).json({ success: false, message: "Failed to generate message" });
          return res.status(201).json({
            success: true,
            data: { id: result.insertId, user_id: parseInt(userId), message, sent_at: new Date() },
          });
        }
      );
    }
  );
};

module.exports = { getTodayMessage, getMessageHistory, generateMessageForNewUser };