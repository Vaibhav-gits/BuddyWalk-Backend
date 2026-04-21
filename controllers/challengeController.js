const db = require("../config/db");
const { sendPushNotification } = require("../utils/sendPushNotification");

exports.getChallenges = (req, res) => {
  const userId = req.user.id;

  const sql = `
    SELECT c.*,
      CASE
        WHEN c.start_date = '0000-00-00' OR c.end_date = '0000-00-00' THEN 'active'
        WHEN CURDATE() BETWEEN c.start_date AND c.end_date THEN 'active'
        WHEN CURDATE() > c.end_date THEN 'completed'
        ELSE 'upcoming'
      END AS status,
      g.name AS group_name,
      (SELECT COUNT(*) FROM challenge_participants cp WHERE cp.challenge_id = c.id) AS participants_count,
      (SELECT SUM(s.step_count) FROM challenge_participants cp
       JOIN steps s ON s.user_id = cp.user_id
       WHERE cp.challenge_id = c.id) AS current_steps
    FROM challenges c
    LEFT JOIN grp g ON c.group_id = g.id
    WHERE c.group_id IS NULL
       OR c.group_id IN (
         SELECT group_id FROM group_members WHERE user_id = ?
       )
    ORDER BY c.start_date DESC
  `;

  db.query(sql, [userId], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json({ challenges: result });
  });
};

exports.createChallenge = (req, res) => {
  const { title, description, target_steps, start_date, end_date, group_id } =
    req.body;

  if (!title || !target_steps || !start_date || !end_date) {
    return res
      .status(400)
      .json({ message: "Title, target steps, start and end date required" });
  }

  const sql = `
    INSERT INTO challenges (title, description, target_steps, start_date, end_date, created_by, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    sql,
    [
      title,
      description || "",
      target_steps,
      start_date,
      end_date,
      req.user.id,
      group_id || null,
    ],
    (err, result) => {
      if (err) return res.status(500).json(err);
      res.json({ message: "Challenge created", challenge_id: result.insertId });
    },
  );
};

exports.joinChallenge = (req, res) => {
  const userId = req.user.id;
  const { challenge_id } = req.body;

  const checkSql = `SELECT id FROM challenge_participants WHERE challenge_id = ? AND user_id = ?`;

  db.query(checkSql, [challenge_id, userId], (err, existing) => {
    if (err) return res.status(500).json(err);
    if (existing.length > 0) {
      return res.status(400).json({ message: "Already joined this challenge" });
    }

    const sql = `INSERT INTO challenge_participants (challenge_id, user_id) VALUES (?, ?)`;

    db.query(sql, [challenge_id, userId], (err) => {
      if (err) return res.status(500).json(err);

      db.query(
        `SELECT u.name AS joiner_name,
                c.title AS challenge_title,
                dt.token AS creator_token
         FROM users u
         JOIN challenges c ON c.id = ?
         LEFT JOIN device_tokens dt ON dt.user_id = c.created_by
         WHERE u.id = ?`,
        [challenge_id, userId],
        async (err2, notifData) => {
          if (!err2 && notifData.length > 0) {
            const tokens = [...new Set(notifData.map((r) => r.creator_token).filter(Boolean))];
            if (tokens.length > 0) {
              await sendPushNotification(
                tokens,
                "New Challenge Participant!",
                `${notifData[0].joiner_name} joined your challenge "${notifData[0].challenge_title}"`,
              );
            }
          }
        },
      );

      res.json({ message: "Joined Challenge" });
    });
  });
};

exports.challengeLeaderboard = (req, res) => {
  const challengeId = req.params.id;

  const sql = `
    SELECT
      u.id AS user_id,
      u.name,
      COALESCE(SUM(s.step_count), 0) AS total_steps
    FROM challenge_participants cp
    JOIN users u ON cp.user_id = u.id
    LEFT JOIN steps s ON s.user_id = cp.user_id
    WHERE cp.challenge_id = ?
    GROUP BY cp.user_id, u.name
    ORDER BY total_steps DESC
  `;

  db.query(sql, [challengeId], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json({ leaderboard: result });
  });
};

exports.getUserGroups = (req, res) => {
  const userId = req.user.id;

  const sql = `
    SELECT g.id, g.name
    FROM grp g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
    ORDER BY g.name ASC
  `;

  db.query(sql, [userId], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json({ groups: result });
  });
};
