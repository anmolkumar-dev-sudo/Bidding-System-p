const express = require("express");
const controller = require("./biddingController");
const { requireAuth, requireCsrf } = require("../middleware/authMiddleware");
const { uploadImages } = require("../middleware/imageUpload");
const { requireIdempotency } = require("../middleware/idempotency");
const router = express.Router();

/**
 * Bidding routes
 *
 * Auth model:
 *  - Public: list, read one, get bid history
 *  - Authenticated (logged-in user): place a bid
 *  - Authenticated users: create and manage their own listings
 *  - Admins: manage any listing
 *
 * CSRF is required on all state-changing routes (create/update/delete/bid)
 * because these are cookie-authenticated endpoints and we must prevent
 * cross-site request forgery.
 */

// ---- Authenticated user: create ----
router.post(
  "/",
  requireAuth,
  requireCsrf,
  requireIdempotency(),
  uploadImages,
  controller.create
);

// ---- Public: list ----
router.get("/", controller.list);

// ---- Public: live search suggestions (keep before /:id) ----
router.get("/suggestions", controller.suggestions);

// ---- Public: real-time live event stream (SSE) ----
router.get("/:id/live", controller.streamLiveAuction);

// ---- Public: read one ----
router.get("/:id", controller.readOne);

// ---- Owner or admin: update ----
router.patch(
  "/:id",
  requireAuth,
  requireCsrf,
  controller.update
);

// ---- Demo-only winner confirmation; no real payment is processed ----
router.post(
  "/:id/demo-payment",
  requireAuth,
  requireCsrf,
  controller.confirmDemoPayment
);

// ---- Owner or admin: delete ----
router.delete(
  "/:id",
  requireAuth,
  requireCsrf,
  controller.remove
);

// ---- Authenticated user: place bid ----
router.post(
  "/:id/bid",
  requireAuth,
  requireCsrf,
  requireIdempotency(),
  controller.placeBid
);

// ---- Public: bid history ----
router.get("/:id/bids", controller.getBids);

module.exports = router;
