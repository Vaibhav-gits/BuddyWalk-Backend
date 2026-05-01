const db = require("../config/db");
const { sendPushNotification } = require("../utils/sendPushNotification");

exports.getChallenges = async (req, res) => {
  try {
    const userId = req.user.id;

    const [result] = await db.query(
      `SELECT c.*,
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
      ORDER BY c.start_date DESC`,
      [userId],
    );

    return res.json({ challenges: result });
  } catch (err) {
    console.error("getChallenges error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.createChallenge = async (req, res) => {
  try {
    const { title, description, target_steps, start_date, end_date, group_id } =
      req.body;

    if (!title || !target_steps || !start_date || !end_date)
      return res
        .status(400)
        .json({ message: "Title, target steps, start and end date required" });

    const [result] = await db.query(
      `INSERT INTO challenges (title, description, target_steps, start_date, end_date, created_by, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        description || "",
        target_steps,
        start_date,
        end_date,
        req.user.id,
        group_id || null,
      ],
    );

    return res.json({
      message: "Challenge created",
      challenge_id: result.insertId,
    });
  } catch (err) {
    console.error("createChallenge error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.joinChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const { challenge_id } = req.body;

    const [existing] = await db.query(
      `SELECT id FROM challenge_participants WHERE challenge_id = ? AND user_id = ?`,
      [challenge_id, userId],
    );

    if (existing.length > 0)
      return res.status(400).json({ message: "Already joined this challenge" });

    await db.query(
      `INSERT INTO challenge_participants (challenge_id, user_id) VALUES (?, ?)`,
      [challenge_id, userId],
    );

    db.query(
      `SELECT u.name AS joiner_name, c.title AS challenge_title, dt.token AS creator_token
       FROM users u
       JOIN challenges c ON c.id = ?
       LEFT JOIN device_tokens dt ON dt.user_id = c.created_by
       WHERE u.id = ?`,
      [challenge_id, userId],
    )
      .then(async ([notifData]) => {
        if (notifData.length > 0) {
          const tokens = [
            ...new Set(notifData.map((r) => r.creator_token).filter(Boolean)),
          ];
          if (tokens.length > 0) {
            await sendPushNotification(
              tokens,
              "New Challenge Participant!",
              `${notifData[0].joiner_name} joined your challenge "${notifData[0].challenge_title}"`,
            );
          }
        }
      })
      .catch(console.error);

    return res.json({ message: "Joined Challenge" });
  } catch (err) {
    console.error("joinChallenge error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.challengeLeaderboard = async (req, res) => {
  try {
    const challengeId = req.params.id;

    const [result] = await db.query(
      `SELECT u.id AS user_id, u.name, COALESCE(SUM(s.step_count), 0) AS total_steps
       FROM challenge_participants cp
       JOIN users u ON cp.user_id = u.id
       LEFT JOIN steps s ON s.user_id = cp.user_id
       WHERE cp.challenge_id = ?
       GROUP BY cp.user_id, u.name
       ORDER BY total_steps DESC`,
      [challengeId],
    );

    return res.json({ leaderboard: result });
  } catch (err) {
    console.error("challengeLeaderboard error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getUserGroups = async (req, res) => {
  try {
    const userId = req.user.id;

    const [result] = await db.query(
      `SELECT g.id, g.name
       FROM grp g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = ?
       ORDER BY g.name ASC`,
      [userId],
    );

    return res.json({ groups: result });
  } catch (err) {
    console.error("getUserGroups error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};
