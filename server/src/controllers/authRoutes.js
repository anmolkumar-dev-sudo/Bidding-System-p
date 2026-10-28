const express = require("express");
const controller = require("./authController");
const { requireAuth, requireCsrf, requireRole, requireSelfOrAdmin } = require("../middleware/authMiddleware");
const router = express.Router();

router.post("/register", controller.registerUser);
router.post("/verify-email", controller.verifyEmail);
router.post("/resend-verification", controller.resendVerification);
router.post("/login", controller.loginUser);
router.post("/forgot-password", controller.requestPasswordReset);
router.post("/reset-password", controller.resetPassword);
router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));
router.get("/csrf", requireAuth, (req, res) => res.json({ csrfToken: req.authSession.csrfToken }));
router.post("/logout", requireAuth, requireCsrf, controller.logoutUser);
router.post("/change-password", requireAuth, requireCsrf, controller.changePassword);
router.patch("/users/:userId/status", requireAuth, requireCsrf, requireRole("admin"), controller.setAccountStatus);
router.patch("/users/:userId/role", requireAuth, requireCsrf, requireRole("admin"), controller.setUserRole);
router.get("/users/:userId", requireAuth, requireSelfOrAdmin, controller.getUserProfile);

module.exports = router;
