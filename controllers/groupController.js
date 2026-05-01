const db = require("../config/db");
const moment = require("moment-timezone");
const { sendPushNotification } = require("../utils/sendPushNotification");

function generateInviteCode() {
  return "GRP-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function getUserTimezone(userId) {
  const [rows] = await db.query(
    "SELECT timezone FROM users WHERE id=? LIMIT 1",
    [userId],
  );
  return rows.length ? rows[0].timezone || "UTC" : "UTC";
}

exports.createGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name || !name.trim())
      return res.status(400).json({ message: "Group name is required." });

    const inviteCode = generateInviteCode();

    const [result] = await db.query(
      `INSERT INTO grp (name, invite_code, created_by) VALUES (?, ?, ?)`,
      [name.trim(), inviteCode, userId],
    );

    const groupId = result.insertId;

    await db.query(
      "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
      [groupId, userId],
    );

    return res.json({
      message: "Group created",
      invite_code: inviteCode,
      group: { id: groupId, name: name.trim(), invite_code: inviteCode },
    });
  } catch (err) {
    console.error("createGroup error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.joinGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const invite_code = (req.body.code || req.body.invite_code || "")
      .trim()
      .toUpperCase();

    if (!invite_code)
      return res.status(400).json({ message: "Invite code is required." });

    const [result] = await db.query("SELECT * FROM grp WHERE invite_code = ?", [
      invite_code,
    ]);
    if (!result.length)
      return res
        .status(404)
        .json({ message: "Invalid invite code. Please check and try again." });

    const group = result[0];

    const [existing] = await db.query(
      "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
      [group.id, userId],
    );
    if (existing.length > 0)
      return res
        .status(400)
        .json({ message: "You are already a member of this group." });

    await db.query(
      "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
      [group.id, userId],
    );

    db.query(
      `SELECT u.name AS joiner_name, dt.token AS creator_token
       FROM users u
       JOIN grp g ON g.id = ?
       LEFT JOIN device_tokens dt ON dt.user_id = g.created_by
       WHERE u.id = ?`,
      [group.id, userId],
    )
      .then(async ([notifData]) => {
        if (notifData.length > 0) {
          const tokens = [
            ...new Set(notifData.map((r) => r.creator_token).filter(Boolean)),
          ];
          if (tokens.length > 0) {
            await sendPushNotification(
              tokens,
              "New Group Member!",
              `${notifData[0].joiner_name} joined your group "${group.name}"`,
            );
          }
        }
      })
      .catch(console.error);

    return res.json({
      message: "Joined group successfully",
      group: { id: group.id, name: group.name, invite_code: group.invite_code },
    });
  } catch (err) {
    console.error("joinGroup error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.inviteByEmail = async (req, res) => {
  try {
    const invitedByUserId = req.user.id;
    const groupId = req.params.id;
    const { email } = req.body;

    if (!email || !email.includes("@"))
      return res.status(400).json({ message: "Valid email is required." });

    const cleanEmail = email.trim().toLowerCase();

    const [gRes] = await db.query("SELECT name FROM grp WHERE id = ? LIMIT 1", [
      groupId,
    ]);
    if (!gRes.length)
      return res.status(404).json({ message: "Group not found." });

    const groupName = gRes[0].name;

    const [memberCheck] = await db.query(
      "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
      [groupId, invitedByUserId],
    );
    if (!memberCheck.length)
      return res
        .status(403)
        .json({ message: "You are not a member of this group." });

    const [userResult] = await db.query(
      "SELECT id, name, email FROM users WHERE email = ?",
      [cleanEmail],
    );
    if (!userResult.length)
      return res.status(404).json({
        message:
          "No account found with this email. They need to sign up first.",
      });

    const invitedUser = userResult[0];

    const [alreadyMember] = await db.query(
      "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
      [groupId, invitedUser.id],
    );
    if (alreadyMember.length > 0)
      return res
        .status(400)
        .json({ message: "This person is already in the group." });

    const [alreadyInvited] = await db.query(
      "SELECT * FROM group_invitations WHERE group_id = ? AND invited_user_id = ?",
      [groupId, invitedUser.id],
    );

    if (alreadyInvited.length > 0) {
      if (alreadyInvited[0].status === "pending")
        return res
          .status(400)
          .json({ message: "This person already has a pending invite." });

      await db.query(
        "UPDATE group_invitations SET status='pending', invited_by_user_id=? WHERE group_id=? AND invited_user_id=?",
        [invitedByUserId, groupId, invitedUser.id],
      );

      return res.json({ message: `Invitation sent to ${invitedUser.name}.` });
    }

    await db.query(
      `INSERT INTO group_invitations (group_id, invited_user_id, invited_by_user_id, status)
       VALUES (?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE status='pending', invited_by_user_id=VALUES(invited_by_user_id), created_at=NOW()`,
      [groupId, invitedUser.id, invitedByUserId],
    );

    db.query("SELECT name FROM users WHERE id = ? LIMIT 1", [invitedByUserId])
      .then(async ([invRes]) => {
        const inviterName = invRes.length ? invRes[0].name : "Someone";
        const [tRes] = await db.query(
          "SELECT token FROM device_tokens WHERE user_id = ?",
          [invitedUser.id],
        );
        if (tRes.length > 0) {
          const tokens = [...new Set(tRes.map((r) => r.token).filter(Boolean))];
          if (tokens.length > 0) {
            await sendPushNotification(
              tokens,
              "Group Invitation",
              `${inviterName} invited you to join "${groupName}"`,
            );
          }
        }
      })
      .catch((e) => console.error("Invite push error:", e?.message || e));

    return res.json({ message: `Invitation sent to ${invitedUser.name}.` });
  } catch (err) {
    console.error("inviteByEmail error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.getMyInvitations = async (req, res) => {
  try {
    const userId = req.user.id;

    const [result] = await db.query(
      `SELECT gi.id, g.name AS group_name, g.invite_code,
              u.name AS invited_by_name, gi.created_at,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
       FROM group_invitations gi
       JOIN grp g ON gi.group_id = g.id
       JOIN users u ON gi.invited_by_user_id = u.id
       WHERE gi.invited_user_id = ? AND gi.status = 'pending'
       ORDER BY gi.created_at DESC`,
      [userId],
    );

    return res.json({ invitations: result });
  } catch (err) {
    console.error("getMyInvitations error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.acceptInvitation = async (req, res) => {
  try {
    const userId = req.user.id;
    const invitationId = req.params.id;

    const [result] = await db.query(
      "SELECT * FROM group_invitations WHERE id = ? AND invited_user_id = ? AND status = 'pending'",
      [invitationId, userId],
    );
    if (!result.length)
      return res
        .status(404)
        .json({ message: "Invitation not found or already handled." });

    const invitation = result[0];

    const [existing] = await db.query(
      "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?",
      [invitation.group_id, userId],
    );

    if (existing.length > 0) {
      await db.query(
        "UPDATE group_invitations SET status = 'accepted' WHERE id = ?",
        [invitationId],
      );
      return res.json({ message: "Already a member of this group." });
    }

    await db.query(
      "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
      [invitation.group_id, userId],
    );

    await db.query(
      "UPDATE group_invitations SET status = 'accepted' WHERE id = ?",
      [invitationId],
    );

    db.query(
      `SELECT u.name AS accepter_name, g.name AS group_name, dt.token AS inviter_token
       FROM users u
       JOIN grp g ON g.id = ?
       LEFT JOIN device_tokens dt ON dt.user_id = ?
       WHERE u.id = ?`,
      [invitation.group_id, invitation.invited_by_user_id, userId],
    )
      .then(async ([notifData]) => {
        if (notifData.length > 0) {
          const tokens = [
            ...new Set(notifData.map((r) => r.inviter_token).filter(Boolean)),
          ];
          if (tokens.length > 0) {
            await sendPushNotification(
              tokens,
              "Invitation Accepted! 🎉",
              `${notifData[0].accepter_name} accepted your invite to "${notifData[0].group_name}"`,
            );
          }
        }
      })
      .catch(console.error);

    return res.json({ message: "Successfully joined the group!" });
  } catch (err) {
    console.error("acceptInvitation error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.declineInvitation = async (req, res) => {
  try {
    const userId = req.user.id;
    const invitationId = req.params.id;

    const [result] = await db.query(
      "UPDATE group_invitations SET status = 'declined' WHERE id = ? AND invited_user_id = ? AND status = 'pending'",
      [invitationId, userId],
    );

    if (result.affectedRows === 0)
      return res
        .status(404)
        .json({ message: "Invitation not found or already handled." });

    return res.json({ message: "Invitation declined." });
  } catch (err) {
    console.error("declineInvitation error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.leaveGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const groupId = req.params.id;

    const [metaRes] = await db.query(
      `SELECT u.name AS leaver_name, g.name AS group_name FROM users u JOIN grp g WHERE u.id = ? AND g.id = ? LIMIT 1`,
      [userId, groupId],
    );

    const leaverName = metaRes.length ? metaRes[0].leaver_name : "A member";
    const groupName = metaRes.length ? metaRes[0].group_name : "the group";

    const [result] = await db.query(
      "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
      [groupId, userId],
    );

    if (result.affectedRows === 0)
      return res
        .status(404)
        .json({ message: "You are not a member of this group." });

    db.query(
      `SELECT dt.token FROM group_members gm
       JOIN device_tokens dt ON dt.user_id = gm.user_id
       WHERE gm.group_id = ? AND gm.user_id != ?`,
      [groupId, userId],
    )
      .then(async ([tRes]) => {
        if (tRes.length > 0) {
          const tokens = [...new Set(tRes.map((r) => r.token).filter(Boolean))];
          if (tokens.length > 0) {
            await sendPushNotification(
              tokens,
              "Member Left Group",
              `${leaverName} left "${groupName}"`,
            );
          }
        }
      })
      .catch((e) => console.error("Leave group push error:", e?.message || e));

    return res.json({ message: "Left the group successfully." });
  } catch (err) {
    console.error("leaveGroup error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.getUserGroups = async (req, res) => {
  try {
    const userId = req.user.id;

    const [result] = await db.query(
      `SELECT g.id, g.name, g.invite_code, g.created_by
       FROM grp g
       JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.user_id = ?
       ORDER BY g.created_at DESC`,
      [userId],
    );

    return res.json({ groups: result });
  } catch (err) {
    console.error("getUserGroups error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.getGroupLeaderboard = async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const today = moment.tz("Asia/Kolkata").format("YYYY-MM-DD");

    const [result] = await db.query(
      `SELECT u.id AS user_id, u.name, u.photo_url, COALESCE(s.step_count, 0) AS steps
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       LEFT JOIN steps s ON s.user_id = u.id AND s.step_date = ?
       WHERE gm.group_id = ?
       ORDER BY steps DESC`,
      [today, groupId],
    );

    return res.json({ leaderboard: result });
  } catch (err) {
    console.error("getGroupLeaderboard error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.getGroupSettings = async (req, res) => {
  try {
    const userId = req.user.id;
    const groupId = req.query.group_id;

    if (!groupId)
      return res.status(400).json({ message: "group_id is required" });

    const [result] = await db.query(
      `SELECT notify_leader_change, notify_overtake_me, notify_i_overtake, set_goal
       FROM group_notification_settings
       WHERE group_id = ? AND user_id = ? LIMIT 1`,
      [groupId, userId],
    );

    if (!result.length) {
      return res.json({
        notify_leader_change: true,
        notify_overtake_me: true,
        notify_i_overtake: true,
        group_goal_enabled: false,
        group_goal_steps: null,
      });
    }

    const s = result[0];
    return res.json({
      notify_leader_change: s.notify_leader_change === 1,
      notify_overtake_me: s.notify_overtake_me === 1,
      notify_i_overtake: s.notify_i_overtake === 1,
      group_goal_enabled: s.set_goal !== null && s.set_goal > 0,
      group_goal_steps: s.set_goal || null,
    });
  } catch (err) {
    console.error("getGroupSettings error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.saveGroupSettings = async (req, res) => {
  try {
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

    await db.query(
      `INSERT INTO group_notification_settings
         (group_id, user_id, notify_leader_change, notify_overtake_me, notify_i_overtake, set_goal)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         notify_leader_change = VALUES(notify_leader_change),
         notify_overtake_me   = VALUES(notify_overtake_me),
         notify_i_overtake    = VALUES(notify_i_overtake),
         set_goal             = VALUES(set_goal)`,
      [
        group_id,
        userId,
        notify_leader_change ? 1 : 0,
        notify_overtake_me ? 1 : 0,
        notify_i_overtake ? 1 : 0,
        setGoalValue,
      ],
    );

    return res.json({ message: "Settings saved" });
  } catch (err) {
    console.error("saveGroupSettings error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.deleteGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const groupId = req.params.groupId;

    const [result] = await db.query(
      "SELECT id, name, created_by FROM grp WHERE id = ? LIMIT 1",
      [groupId],
    );
    if (!result.length)
      return res.status(404).json({ message: "Group not found." });

    const group = result[0];
    if (group.created_by !== userId)
      return res
        .status(403)
        .json({ message: "Only the group admin can delete this group." });

    await db.query(
      "DELETE FROM group_notification_settings WHERE group_id = ?",
      [groupId],
    );
    await db.query("DELETE FROM group_invitations WHERE group_id = ?", [
      groupId,
    ]);
    await db.query("DELETE FROM group_members WHERE group_id = ?", [groupId]);
    await db.query("DELETE FROM grp WHERE id = ?", [groupId]);

    return res.json({ message: `Group "${group.name}" deleted successfully.` });
  } catch (err) {
    console.error("deleteGroup error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.renameGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const groupId = req.params.groupId;
    const { name } = req.body;

    if (!name || !name.trim())
      return res.status(400).json({ message: "Group name is required." });

    const [result] = await db.query(
      "SELECT id, created_by FROM grp WHERE id = ? LIMIT 1",
      [groupId],
    );
    if (!result.length)
      return res.status(404).json({ message: "Group not found." });
    if (result[0].created_by !== userId)
      return res
        .status(403)
        .json({ message: "Only the group admin can rename this group." });

    await db.query("UPDATE grp SET name = ? WHERE id = ?", [
      name.trim(),
      groupId,
    ]);

    return res.json({
      message: "Group renamed successfully.",
      name: name.trim(),
    });
  } catch (err) {
    console.error("renameGroup error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};

exports.removeMember = async (req, res) => {
  try {
    const requesterId = req.user.id;
    const { groupId, userId } = req.params;

    if (String(requesterId) === String(userId))
      return res
        .status(400)
        .json({ message: "Use the leave group option to remove yourself." });

    const [result] = await db.query(
      "SELECT id, created_by FROM grp WHERE id = ? LIMIT 1",
      [groupId],
    );
    if (!result.length)
      return res.status(404).json({ message: "Group not found." });
    if (result[0].created_by !== requesterId)
      return res
        .status(403)
        .json({ message: "Only the group admin can remove members." });

    const [deleteResult] = await db.query(
      "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
      [groupId, userId],
    );

    if (deleteResult.affectedRows === 0)
      return res
        .status(404)
        .json({ message: "Member not found in this group." });

    return res.json({ message: "Member removed successfully." });
  } catch (err) {
    console.error("removeMember error:", err);
    return res.status(500).json({ message: "DB error", error: err });
  }
};
