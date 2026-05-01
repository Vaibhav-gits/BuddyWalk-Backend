const db = require("../config/db");

async function canSendNotification(userId, groupId, type) {
  const today = new Date().toISOString().slice(0, 10);

  const [result] = await db.query(
    `INSERT IGNORE INTO notification_log (user_id, group_id, notification_type, sent_date)
     VALUES (?, ?, ?, ?)`,
    [userId, groupId, type, today]
  );

  return result.affectedRows === 1;
}

module.exports = { canSendNotification };