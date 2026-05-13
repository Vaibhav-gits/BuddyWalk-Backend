const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const groupController = require("../controllers/groupController");

router.get("/invitations", auth, groupController.getMyInvitations);
router.get("/settings", auth, groupController.getGroupSettings);
router.post("/settings", auth, groupController.saveGroupSettings);
router.post("/invitations/:id/accept", auth, groupController.acceptInvitation);
router.post(
  "/invitations/:id/decline",
  auth,
  groupController.declineInvitation,
);

router.post("/create", auth, groupController.createGroup);
router.post("/join", auth, groupController.joinGroup);
router.get("/", auth, groupController.getUserGroups);

router.get("/leaderboard/:groupId", auth, groupController.getGroupLeaderboard);

router.post("/:id/invite", auth, groupController.inviteByEmail);
router.post("/:id/leave", auth, groupController.leaveGroup);

router.put("/:groupId", auth, groupController.renameGroup);

router.delete("/:groupId/members/:userId", auth, groupController.removeMember);

router.delete("/:groupId", auth, groupController.deleteGroup);

router.post(
  "/:groupId/poke/:targetUserId",
  auth,
  groupController.pokeGroupMember,
);

module.exports = router;
