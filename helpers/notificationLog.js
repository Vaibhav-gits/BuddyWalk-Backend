const db = require("../config/db");

function canSendNotification(userId, groupId, type) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().slice(0, 10);

    db.query(
      `INSERT IGNORE INTO notification_log (user_id, group_id, notification_type, sent_date)
       VALUES (?, ?, ?, ?)`,
      [userId, groupId, type, today],
      (err, result) => {
        if (err) return reject(err);
        resolve(result.affectedRows === 1);
      }
    );
  });
}

module.exports = { canSendNotification };