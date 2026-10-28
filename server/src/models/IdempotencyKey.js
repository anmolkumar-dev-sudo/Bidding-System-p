const mongoose = require("mongoose");

/**
 * IdempotencyKey Model
 * 
 * Standard Stripe / Fintech design pattern:
 * Prevents accidental duplicate operations (e.g. double-bidding on slow network or retried clicks).
 * 
 * Features:
 * - Scoped uniquely per user: { key: 1, userId: 1 }
 * - MongoDB TTL index: automatically purged after `expiresAt` (default: 24h)
 * - Captures exact status code and response body for deterministic replay
 */
const idempotencyKeySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    endpoint: {
      type: String,
      required: true
    },
    statusCode: {
      type: Number,
      required: true
    },
    responseBody: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true,
      expires: 0 // TTL Index: MongoDB automatically purges expired records
    }
  },
  { timestamps: true }
);

// Compound unique index ensuring a user cannot re-use the same key for different operations
idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model("IdempotencyKey", idempotencyKeySchema);

