const db = require("../config/db");
const moment = require("moment-timezone");
const { sendPushNotification } = require("../utils/sendPushNotification");

function generateInviteCode() {
  return "GRP-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getUserTimezone(userId) {
  return new Promise((resolve) => {
    db.query(
      "SELECT timezone FROM users WHERE id=? LIMIT 1",
      [userId],
      (err, res) => {
        if (err || !res.length) return resolve("UTC");
        resolve(res[0].timezone || "UTC");
      },
    );
  });
}

exports.createGroup = (req, res) => {
  const userId = req.user.id;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: "Group name is required." });
  }

  const inviteCode = generateInviteCode();
  const sql = `INSERT INTO grp (name, invite_code, created_by) VALUES (?, ?, ?)`;

  db.query(sql, [name.trim(), inviteCode, userId], (err, result) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });

    const groupId = result.insertId;

    db.query(
      "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
      [groupId, userId],
      (err2) => {
        if (err2)
          return res.status(500).json({ message: "DB error", error: err2 });

        res.json({
          message: "Group created",
          invite_code: inviteCode,
          group: { id: groupId, name: name.trim(), invite_code: inviteCode },
        });
      },
    );
  });
};

exports.joinGroup = (req, res) => {
  const userId = req.user.id;
  const invite_code = (req.body.code || req.body.invite_code || "")
    .trim()
    .toUpperCase();

  if (!invite_code) {
    return res.status(400).json({ message: "Invite code is required." });
  }

  db.query(
    "SELECT * FROM grp WHERE invite_code = ?",
    [invite_code],
    (err, result) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      if (result.length === 0) {
        return res.status(404).json({
          message: "Invalid invite code. Please check and try again.",
        });
      }

      const group = result[0];

      db.query(
        "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
        [group.id, userId],
        (err2, existing) => {
          if (err2)
            return res.status(500).json({ message: "DB error", error: err2 });
          if (existing.length > 0) {
            return res
              .status(400)
              .json({ message: "You are already a member of this group." });
          }

          db.query(
            "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
            [group.id, userId],
            (err3) => {
              if (err3)
                return res
                  .status(500)
                  .json({ message: "DB error", error: err3 });

              db.query(
                `SELECT u.name AS joiner_name,
                        dt.token AS creator_token
                 FROM users u
                 JOIN grp g ON g.id = ?
                 LEFT JOIN device_tokens dt ON dt.user_id = g.created_by
                 WHERE u.id = ?`,
                [group.id, userId],
                async (err4, notifData) => {
                  if (!err4 && notifData.length > 0) {
                    const tokens = [
                      ...new Set(
                        notifData.map((r) => r.creator_token).filter(Boolean),
                      ),
                    ];
                    if (tokens.length > 0) {
                      await sendPushNotification(
                        tokens,
                        "New Group Member!",
                        `${notifData[0].joiner_name} joined your group "${group.name}"`,
                      );
                    }
                  }
                },
              );

              res.json({
                message: "Joined group successfully",
                group: {
                  id: group.id,
                  name: group.name,
                  invite_code: group.invite_code,
                },
              });
            },
          );
        },
      );
    },
  );
};

exports.inviteByEmail = (req, res) => {
  const invitedByUserId = req.user.id;
  const groupId = req.params.id;
  const { email } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "Valid email is required." });
  }

  const cleanEmail = email.trim().toLowerCase();

  db.query(
    "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
    [groupId, invitedByUserId],
    (err, memberCheck) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      if (memberCheck.length === 0) {
        return res
          .status(403)
          .json({ message: "You are not a member of this group." });
      }

      db.query(
        "SELECT id, name, email FROM users WHERE email = ?",
        [cleanEmail],
        (err2, userResult) => {
          if (err2)
            return res.status(500).json({ message: "DB error", error: err2 });
          if (userResult.length === 0) {
            return res.status(404).json({
              message:
                "No account found with this email. They need to sign up first.",
            });
          }

          const invitedUser = userResult[0];

          db.query(
            "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
            [groupId, invitedUser.id],
            (err3, alreadyMember) => {
              if (err3)
                return res
                  .status(500)
                  .json({ message: "DB error", error: err3 });
              if (alreadyMember.length > 0) {
                return res
                  .status(400)
                  .json({ message: "This person is already in the group." });
              }

              db.query(
                "SELECT * FROM group_invitations WHERE group_id = ? AND invited_user_id = ?",
                [groupId, invitedUser.id],
                (err4, alreadyInvited) => {
                  if (err4)
                    return res
                      .status(500)
                      .json({ message: "DB error", error: err4 });

                  if (alreadyInvited.length > 0) {
                    const existing = alreadyInvited[0];

                    if (existing.status === "pending") {
                      return res.status(400).json({
                        message: "This person already has a pending invite.",
                      });
                    }

                    db.query(
                      "UPDATE group_invitations SET status='pending', invited_by_user_id=? WHERE group_id=? AND invited_user_id=?",
                      [invitedByUserId, groupId, invitedUser.id],
                      (err5) => {
                        if (err5)
                          return res
                            .status(500)
                            .json({ message: "DB error", error: err5 });

                        return res.json({
                          message: `Invitation sent to ${invitedUser.name}.`,
                        });
                      },
                    );

                    return;
                  }

                  const query = `
INSERT INTO group_invitations
(group_id, invited_user_id, invited_by_user_id, status)
VALUES (?, ?, ?, 'pending')
ON DUPLICATE KEY UPDATE
status='pending',
invited_by_user_id=VALUES(invited_by_user_id),
created_at=NOW()
`;

                  db.query(
                    query,
                    [groupId, invitedUser.id, invitedByUserId],
                    async (err5) => {
                      if (err5) {
                        return res
                          .status(500)
                          .json({ message: "DB error", error: err5 });
                      }

                      // Notify the invited user (if they have device tokens)
                      try {
                        db.query(
                          "SELECT name FROM users WHERE id = ? LIMIT 1",
                          [invitedByUserId],
                          (invErr, invRes) => {
                            const inviterName =
                              invErr || !invRes.length
                                ? "Someone"
                                : invRes[0].name;

                            db.query(
                              "SELECT token FROM device_tokens WHERE user_id = ?",
                              [invitedUser.id],
                              async (tErr, tRes) => {
                                if (!tErr && tRes && tRes.length > 0) {
                                  const tokens = [
                                    ...new Set(
                                      tRes.map((r) => r.token).filter(Boolean),
                                    ),
                                  ];
                                  if (tokens.length > 0) {
                                    await sendPushNotification(
                                      tokens,
                                      "Group Invitation",
                                      `${inviterName} invited you to join "${group.name}"`,
                                    );
                                  }
                                }
                              },
                            );
                          },
                        );
                      } catch (e) {
                        console.error("Invite push error:", e?.message || e);
                      }

                      return res.json({
                        message: `Invitation sent to ${invitedUser.name}.`,
                      });
                    },
                  );
                },
              );
            },
          );
        },
      );
    },
  );
};

exports.getMyInvitations = (req, res) => {
  const userId = req.user.id;

  const sql = `
    SELECT
      gi.id,
      g.name AS group_name,
      g.invite_code,
      u.name AS invited_by_name,
      gi.created_at,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
    FROM group_invitations gi
    JOIN grp g ON gi.group_id = g.id
    JOIN users u ON gi.invited_by_user_id = u.id
    WHERE gi.invited_user_id = ? AND gi.status = 'pending'
    ORDER BY gi.created_at DESC
  `;

  db.query(sql, [userId], (err, result) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });
    res.json({ invitations: result });
  });
};

exports.acceptInvitation = (req, res) => {
  const userId = req.user.id;
  const invitationId = req.params.id;

  db.query(
    "SELECT * FROM group_invitations WHERE id = ? AND invited_user_id = ? AND status = 'pending'",
    [invitationId, userId],
    (err, result) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      if (result.length === 0) {
        return res
          .status(404)
          .json({ message: "Invitation not found or already handled." });
      }

      const invitation = result[0];

      db.query(
        "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
        [invitation.group_id, userId],
        (err2, existing) => {
          if (err2)
            return res.status(500).json({ message: "DB error", error: err2 });

          if (existing.length > 0) {
            db.query(
              "UPDATE group_invitations SET status = 'accepted' WHERE id = ?",
              [invitationId],
            );
            return res.json({ message: "Already a member of this group." });
          }

          db.query(
            "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
            [invitation.group_id, userId],
            (err3) => {
              if (err3)
                return res
                  .status(500)
                  .json({ message: "DB error", error: err3 });

              db.query(
                "UPDATE group_invitations SET status = 'accepted' WHERE id = ?",
                [invitationId],
                async (err4) => {
                  if (err4)
                    return res
                      .status(500)
                      .json({ message: "DB error", error: err4 });

                  db.query(
                    `SELECT u.name AS accepter_name,
                            g.name AS group_name,
                            dt.token AS inviter_token
                     FROM users u
                     JOIN grp g ON g.id = ?
                     LEFT JOIN device_tokens dt ON dt.user_id = ?
                     WHERE u.id = ?`,
                    [
                      invitation.group_id,
                      invitation.invited_by_user_id,
                      userId,
                    ],
                    async (err5, notifData) => {
                      if (!err5 && notifData.length > 0) {
                        const tokens = [
                          ...new Set(
                            notifData
                              .map((r) => r.inviter_token)
                              .filter(Boolean),
                          ),
                        ];
                        if (tokens.length > 0) {
                          await sendPushNotification(
                            tokens,
                            "Invitation Accepted! 🎉",
                            `${notifData[0].accepter_name} accepted your invite to "${notifData[0].group_name}"`,
                          );
                        }
                      }
                    },
                  );

                  res.json({ message: "Successfully joined the group!" });
                },
              );
            },
          );
        },
      );
    },
  );
};

exports.declineInvitation = (req, res) => {
  const userId = req.user.id;
  const invitationId = req.params.id;

  db.query(
    "UPDATE group_invitations SET status = 'declined' WHERE id = ? AND invited_user_id = ? AND status = 'pending'",
    [invitationId, userId],
    (err, result) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      if (result.affectedRows === 0) {
        return res
          .status(404)
          .json({ message: "Invitation not found or already handled." });
      }
      res.json({ message: "Invitation declined." });
    },
  );
};

exports.leaveGroup = (req, res) => {
  const userId = req.user.id;
  const groupId = req.params.id;

  db.query(
    `SELECT u.name AS leaver_name, g.name AS group_name FROM users u JOIN grp g WHERE u.id = ? AND g.id = ? LIMIT 1`,
    [userId, groupId],
    (metaErr, metaRes) => {
      if (metaErr)
        return res.status(500).json({ message: "DB error", error: metaErr });

      const leaverName =
        metaRes && metaRes.length ? metaRes[0].leaver_name : "A member";
      const groupName =
        metaRes && metaRes.length ? metaRes[0].group_name : "the group";

      db.query(
        "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
        [groupId, userId],
        (err, result) => {
          if (err)
            return res.status(500).json({ message: "DB error", error: err });
          if (result.affectedRows === 0) {
            return res
              .status(404)
              .json({ message: "You are not a member of this group." });
          }

         
          db.query(
            `SELECT dt.token FROM group_members gm JOIN device_tokens dt ON dt.user_id = gm.user_id WHERE gm.group_id = ? AND gm.user_id != ?`,
            [groupId, userId],
            async (tErr, tRes) => {
              if (!tErr && tRes && tRes.length > 0) {
                const tokens = [
                  ...new Set(tRes.map((r) => r.token).filter(Boolean)),
                ];
                if (tokens.length > 0) {
                  try {
                    await sendPushNotification(
                      tokens,
                      "Member Left Group",
                      `${leaverName} left "${groupName}"`,
                    );
                  } catch (e) {
                    console.error("Leave group push error:", e?.message || e);
                  }
                }
              }
            },
          );

          res.json({ message: "Left the group successfully." });
        },
      );
    },
  );
};

exports.getUserGroups = (req, res) => {
  const userId = req.user.id;

  const sql = `
    SELECT g.id, g.name, g.invite_code, g.created_by
    FROM grp g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `;

  db.query(sql, [userId], (err, result) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });
    res.json({ groups: result });
  });
};

exports.getGroupLeaderboard = async (req, res) => {
  const groupId = req.params.groupId;

  const today = moment.tz("Asia/Kolkata").format("YYYY-MM-DD");

  const sql = `
    SELECT
      u.id AS user_id,
      u.name,
      u.photo_url,
      COALESCE(s.step_count, 0) AS steps
    FROM group_members gm
    JOIN users u ON gm.user_id = u.id
    LEFT JOIN steps s ON s.user_id = u.id AND s.step_date = ?
    WHERE gm.group_id = ?
    ORDER BY steps DESC
  `;

  db.query(sql, [today, groupId], (err, result) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });
    res.json({ leaderboard: result });
  });
};

exports.getGroupSettings = (req, res) => {
  const userId = req.user.id;
  const groupId = req.query.group_id;

  if (!groupId) {
    return res.status(400).json({ message: "group_id is required" });
  }

  db.query(
    `SELECT notify_leader_change, notify_overtake_me, notify_i_overtake, set_goal
     FROM group_notification_settings
     WHERE group_id = ? AND user_id = ? LIMIT 1`,
    [groupId, userId],
    (err, result) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });

      if (result.length === 0) {
        return res.json({
          notify_leader_change: true,
          notify_overtake_me: true,
          notify_i_overtake: true,
          group_goal_enabled: false,
          group_goal_steps: null,
        });
      }

      const s = result[0];
      res.json({
        notify_leader_change: s.notify_leader_change === 1,
        notify_overtake_me: s.notify_overtake_me === 1,
        notify_i_overtake: s.notify_i_overtake === 1,
        group_goal_enabled: s.set_goal !== null && s.set_goal > 0,
        group_goal_steps: s.set_goal || null,
      });
    },
  );
};

exports.saveGroupSettings = (req, res) => {
  const userId = req.user.id;
  const {
    group_id,
    notify_leader_change,
    notify_overtake_me,
    notify_i_overtake,
    group_goal_enabled,
    group_goal_steps,
  } = req.body;

  if (!group_id)
    return res.status(400).json({ message: "group_id is required" });

  const setGoalValue =
    group_goal_enabled && group_goal_steps && Number(group_goal_steps) > 0
      ? Number(group_goal_steps)
      : null;

  const sql = `
    INSERT INTO group_notification_settings
      (group_id, user_id, notify_leader_change, notify_overtake_me,
       notify_i_overtake, set_goal)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      notify_leader_change = VALUES(notify_leader_change),
      notify_overtake_me   = VALUES(notify_overtake_me),
      notify_i_overtake    = VALUES(notify_i_overtake),
      set_goal             = VALUES(set_goal)
  `;

  db.query(
    sql,
    [
      group_id,
      userId,
      notify_leader_change ? 1 : 0,
      notify_overtake_me ? 1 : 0,
      notify_i_overtake ? 1 : 0,
      setGoalValue,
    ],
    (err) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      res.json({ message: "Settings saved" });
    },
  );
};
