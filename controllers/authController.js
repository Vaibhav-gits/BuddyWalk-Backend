const db = require("../config/db");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── All user fields returned in every response ───────────────────────────────
// ─── All user fields returned in every response ───────────────────────────────
const USER_SELECT =
  "SELECT id, name, email, country, gender, age, weight, goal_steps, timezone, photo_url FROM users WHERE id = ?";

// ─── Helper: resolve user row → clean object ──────────────────────────────────
const formatUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  country: row.country || "N/A",
  gender: row.gender || null,
  age: row.age || null,
  weight: row.weight || null,
  goal_steps: row.goal_steps || 10000,
  timezone: row.timezone || "UTC",
  photo_url: row.photo_url || null,
});

// ─── Find or create Google user ───────────────────────────────────────────────
const findOrCreateGoogleUser = (
  name,
  email,
  country = "N/A",
  timezone = "UTC",
  photoUrl = null,
) => {
  return new Promise((resolve, reject) => {
    db.query("SELECT * FROM users WHERE email = ?", [email], (err, result) => {
      if (err) return reject(err);

      if (result.length > 0) {
        const user = result[0];

        // Always refresh photo_url; update country/timezone only if missing
        const needsCountry =
          country &&
          country !== "N/A" &&
          (!user.country || user.country === "N/A" || user.country === "");
        const needsTimezone = !user.timezone || user.timezone === "UTC";

        const updates = [];
        const vals = [];

        if (photoUrl) {
          updates.push("photo_url = ?");
          vals.push(photoUrl);
        }
        if (needsCountry) {
          updates.push("country = ?");
          vals.push(country);
        }
        if (needsTimezone) {
          updates.push("timezone = ?");
          vals.push(timezone || "UTC");
        }

        if (updates.length === 0) return resolve(user);

        vals.push(user.id);
        db.query(
          `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
          vals,
          (uErr) => {
            if (uErr) console.error("Failed to update Google user:", uErr);
            // Merge updates into local object before resolving
            if (needsCountry) user.country = country;
            if (needsTimezone) user.timezone = timezone || "UTC";
            if (photoUrl) user.photo_url = photoUrl;
            return resolve(user);
          },
        );
        return;
      }

      // New user — insert (no password column)
      db.query(
        "INSERT INTO users (name, email, country, timezone, photo_url, goal_steps) VALUES (?, ?, ?, ?, ?, ?)",
        [name, email, country || "N/A", timezone || "UTC", photoUrl, 10000],
        (err2, result2) => {
          if (err2) return reject(err2);
          resolve({
            id: result2.insertId,
            name,
            email,
            country: country || "N/A",
            timezone: timezone || "UTC",
            photo_url: photoUrl,
            gender: null,
            age: null,
            weight: null,
            goal_steps: 10000,
         
          });
        },
      );
    });
  });
};

// ─── Google Auth ──────────────────────────────────────────────────────────────
exports.googleAuth = async (req, res) => {
  try {
    const { idToken, timezone, photo_url } = req.body;

    if (!idToken)
      return res.status(400).json({ message: "ID token is required" });

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { name, email } = payload;
    const photoUrl = photo_url || payload.picture || null;

    // Try to detect country from locale
    let detectedCountry = "N/A";
    try {
      const parts = (payload.locale || "").split(/[-_]/);
      const region = parts[1] || parts[0];
      if (region && region.length === 2) {
        try {
          detectedCountry =
            new Intl.DisplayNames(["en"], { type: "region" }).of(
              region.toUpperCase(),
            ) || "N/A";
        } catch {
          detectedCountry = region.toUpperCase();
        }
      }
    } catch {
      detectedCountry = "N/A";
    }

    if (!email)
      return res
        .status(400)
        .json({ message: "Could not retrieve email from Google" });

    const user = await findOrCreateGoogleUser(
      name,
      email,
      detectedCountry,
      timezone || "UTC",
      photoUrl,
    );

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);

    return res.json({
      message: "Google sign-in successful",
      token,
      user: formatUser(user),
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return res.status(401).json({
      message: error?.message || "Invalid or expired Google token",
      details: error?.stack || error,
    });
  }
};

// ─── Complete Profile (after signup / onboarding) ─────────────────────────────
exports.completeProfile = (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const tokenStr = auth.replace(/^Bearer\s+/i, "");
    if (!tokenStr)
      return res.status(401).json({ message: "No token provided" });

    let payload;
    try {
      payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    const userId = payload.id;
    const { gender, age, country, timezone, goal_steps } = req.body;
    let { weight } = req.body;
    // Accept frontend alias `weight_kg` when provided
    if (weight === undefined && req.body.weight_kg !== undefined) {
      weight = req.body.weight_kg;
    }

    // Allow partial profile updates (some screens send only a subset of fields).
    const fields = [];
    const params = [];

    if (gender !== undefined) {
      fields.push("gender = ?");
      params.push(gender);
    }
    if (age !== undefined) {
      fields.push("age = ?");
      params.push(age || null);
    }
    if (weight !== undefined) {
      fields.push("weight = ?");
      params.push(weight || null);
    }
    if (country !== undefined) {
      fields.push("country = ?");
      params.push(country);
    }
    if (timezone !== undefined) {
      fields.push("timezone = ?");
      params.push(timezone || "UTC");
    }
    if (goal_steps !== undefined) {
      fields.push("goal_steps = ?");
      params.push(goal_steps || 10000);
    }

    if (fields.length === 0)
      return res
        .status(400)
        .json({ message: "No profile fields provided to update" });

    params.push(userId);
    db.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      params,
      (err) => {
        if (err) {
          console.error("completeProfile UPDATE error:", err);
          return res
            .status(500)
            .json({ message: "Database error", error: err.message });
        }

        db.query(USER_SELECT, [userId], (err2, rows) => {
          if (err2)
            return res
              .status(500)
              .json({ message: "Database error", error: err2.message });
          if (!rows || rows.length === 0)
            return res.status(404).json({ message: "User not found" });

          return res.json({
            message: "Profile updated",
            user: formatUser(rows[0]),
          });
        });
      },
    );
  } catch (error) {
    console.error("completeProfile error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── Update Profile ───────────────────────────────────────────────────────────
exports.updateProfile = (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const tokenStr = auth.replace(/^Bearer\s+/i, "");
    if (!tokenStr)
      return res.status(401).json({ message: "No token provided" });

    let payload;
    try {
      payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    const userId = payload.id;
    const { name, email, country, gender, age, timezone, goal_steps } =
      req.body;
    let { weight } = req.body;
    // Accept frontend alias `weight_kg` when provided
    if (weight === undefined && req.body.weight_kg !== undefined) {
      weight = req.body.weight_kg;
    }

    // Check email uniqueness before updating
    const checkEmail = (cb) => {
      if (!email) return cb(null);
      db.query(
        "SELECT id FROM users WHERE email = ? AND id <> ?",
        [email, userId],
        (err, rows) => {
          if (err) return cb(err);
          if (rows && rows.length > 0)
            return cb(new Error("Email already registered"));
          cb(null);
        },
      );
    };

    checkEmail((err) => {
      if (err) {
        if (err.message === "Email already registered")
          return res.status(400).json({ message: err.message });
        console.error("updateProfile email check error:", err);
        return res.status(500).json({ message: "Database error" });
      }

      const fields = [];
      const params = [];

      if (name !== undefined) {
        fields.push("name = ?");
        params.push(name);
      }
      if (email !== undefined) {
        fields.push("email = ?");
        params.push(email);
      }
      if (country !== undefined) {
        fields.push("country = ?");
        params.push(country);
      }
      if (gender !== undefined) {
        fields.push("gender = ?");
        params.push(gender);
      }
      if (age !== undefined) {
        fields.push("age = ?");
        params.push(age);
      }
      if (weight !== undefined) {
        fields.push("weight = ?");
        params.push(weight);
      }
      if (timezone !== undefined) {
        fields.push("timezone = ?");
        params.push(timezone || "UTC");
      }
      if (goal_steps !== undefined) {
        fields.push("goal_steps = ?");
        params.push(goal_steps || 10000);
      }

      if (fields.length === 0)
        return res
          .status(400)
          .json({ message: "No fields provided to update" });

      params.push(userId);
      db.query(
        `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
        params,
        (uErr) => {
          if (uErr) {
            console.error("updateProfile UPDATE error:", uErr);
            return res.status(500).json({
              message: "Database error",
              error: uErr.message,
              code: uErr.code || null,
            });
          }

          db.query(USER_SELECT, [userId], (err2, rows) => {
            if (err2)
              return res
                .status(500)
                .json({ message: "Database error", error: err2.message });
            if (!rows || rows.length === 0)
              return res.status(404).json({ message: "User not found" });

            return res.json({
              message: "Profile updated",
              user: formatUser(rows[0]),
            });
          });
        },
      );
    });
  } catch (error) {
    console.error("updateProfile error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── Get Profile ──────────────────────────────────────────────────────────────
exports.getProfile = (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const tokenStr = auth.replace(/^Bearer\s+/i, "");
    if (!tokenStr)
      return res.status(401).json({ message: "No token provided" });

    let payload;
    try {
      payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    db.query(USER_SELECT, [payload.id], (err, rows) => {
      if (err) {
        console.error("getProfile SELECT error:", err);
        return res
          .status(500)
          .json({ message: "Database error", error: err.message });
      }
      if (!rows || rows.length === 0)
        return res.status(404).json({ message: "User not found" });

      return res.json({ user: formatUser(rows[0]) });
    });
  } catch (error) {
    console.error("getProfile error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ─── Logout ───────────────────────────────────────────────────────────────────
exports.logout = (req, res) => {
  res.json({ message: "Logged out successfully" });
};

// ─── Delete Account ───────────────────────────────────────────────────────────
exports.deleteAccount = (req, res) => {
  const auth = req.headers.authorization || "";
  const tokenStr = auth.replace(/^Bearer\s+/i, "");
  if (!tokenStr) return res.status(401).json({ message: "No token provided" });

  let payload;
  try {
    payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  const userId = payload.id;

  db.getConnection((cErr, conn) => {
    if (cErr) {
      console.error("DB connection error for deleteAccount:", cErr);
      return res.status(500).json({ message: "Database error" });
    }

    conn.beginTransaction((tErr) => {
      if (tErr) {
        conn.release();
        return res.status(500).json({ message: "Database error" });
      }

      const bail = (err) => {
        console.error("deleteAccount rollback:", err);
        conn.rollback(() => {
          conn.release();
          res.status(500).json({ message: "Failed to delete account" });
        });
      };

      // Delete in dependency order
      conn.query(
        "DELETE FROM device_tokens WHERE user_id = ?",
        [userId],
        (e1) => {
          if (e1) return bail(e1);
          conn.query("DELETE FROM steps WHERE user_id = ?", [userId], (e2) => {
            if (e2) return bail(e2);
            conn.query(
              "DELETE FROM challenge_participants WHERE user_id = ?",
              [userId],
              (e3) => {
                if (e3) return bail(e3);
                conn.query(
                  "DELETE FROM group_members WHERE user_id = ?",
                  [userId],
                  (e4) => {
                    if (e4) return bail(e4);
                    conn.query(
                      "DELETE FROM group_invitations WHERE invited_user_id = ? OR invited_by_user_id = ?",
                      [userId, userId],
                      (e5) => {
                        if (e5) return bail(e5);

                        // Delete challenges created by user
                        conn.query(
                          "SELECT id FROM challenges WHERE created_by = ?",
                          [userId],
                          (e6, challRows) => {
                            if (e6) return bail(e6);
                            const challIds = (challRows || []).map((r) => r.id);

                            const deleteChallenges = (next) => {
                              if (challIds.length === 0) return next();
                              conn.query(
                                "DELETE FROM challenge_participants WHERE challenge_id IN (?)",
                                [challIds],
                                (e7) => {
                                  if (e7) return bail(e7);
                                  conn.query(
                                    "DELETE FROM challenges WHERE id IN (?)",
                                    [challIds],
                                    (e8) => {
                                      if (e8) return bail(e8);
                                      next();
                                    },
                                  );
                                },
                              );
                            };

                            // Delete groups created by user
                            conn.query(
                              "SELECT id FROM grp WHERE created_by = ?",
                              [userId],
                              (e9, grpRows) => {
                                if (e9) return bail(e9);
                                const grpIds = (grpRows || []).map((r) => r.id);

                                const deleteGroups = (done) => {
                                  if (grpIds.length === 0) return done();
                                  conn.query(
                                    "DELETE FROM group_members WHERE group_id IN (?)",
                                    [grpIds],
                                    (g1) => {
                                      if (g1) return bail(g1);
                                      conn.query(
                                        "DELETE FROM group_invitations WHERE group_id IN (?)",
                                        [grpIds],
                                        (g2) => {
                                          if (g2) return bail(g2);
                                          conn.query(
                                            "SELECT id FROM challenges WHERE group_id IN (?)",
                                            [grpIds],
                                            (g3, gc) => {
                                              if (g3) return bail(g3);
                                              const gcIds = (gc || []).map(
                                                (r) => r.id,
                                              );
                                              const deleteGrpChallenges = (
                                                fin,
                                              ) => {
                                                if (gcIds.length === 0)
                                                  return fin();
                                                conn.query(
                                                  "DELETE FROM challenge_participants WHERE challenge_id IN (?)",
                                                  [gcIds],
                                                  (g4) => {
                                                    if (g4) return bail(g4);
                                                    conn.query(
                                                      "DELETE FROM challenges WHERE id IN (?)",
                                                      [gcIds],
                                                      (g5) => {
                                                        if (g5) return bail(g5);
                                                        fin();
                                                      },
                                                    );
                                                  },
                                                );
                                              };
                                              deleteGrpChallenges(() => {
                                                conn.query(
                                                  "DELETE FROM grp WHERE id IN (?)",
                                                  [grpIds],
                                                  (g6) => {
                                                    if (g6) return bail(g6);
                                                    done();
                                                  },
                                                );
                                              });
                                            },
                                          );
                                        },
                                      );
                                    },
                                  );
                                };

                                deleteChallenges(() => {
                                  deleteGroups(() => {
                                    conn.query(
                                      "DELETE FROM users WHERE id = ?",
                                      [userId],
                                      (uErr) => {
                                        if (uErr) return bail(uErr);
                                        conn.commit((cmtErr) => {
                                          if (cmtErr) return bail(cmtErr);
                                          conn.release();
                                          return res.json({
                                            message:
                                              "Account deleted successfully",
                                          });
                                        });
                                      },
                                    );
                                  });
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
          });
        },
      );
    });
  });
};
