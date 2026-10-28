const mongoose = require("mongoose");

/**
 * Product — a single item put up for bidding by an authenticated seller.
 *
 * Security / integrity notes:
 *  - `adminId` stores the listing owner's user id and is indexed for owner queries.
 *  - `status` is an enum so invalid states can never be written by accident.
 *  - `currentPrice` is the live bid price; `startingPrice` is the floor.
 *  - `winnerId` is set only when the auction closes to a single winner.
 *  - Compound index on (status, endsAt) so "active auctions closing soon"
 *    queries are index-covered instead of scanning the whole collection.
 */
const productSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "title is required"],
      trim: true,
      minlength: [3, "title must be at least 3 characters"],
      maxlength: [120, "title must be at most 120 characters"]
    },
    description: {
      type: String,
      required: [true, "description is required"],
      trim: true,
      // Enforced in the controller (word count), not just schema,
      // because Mongoose cannot count words natively.
      maxlength: [5000, "description must be at most 5000 characters"]
    },
    images: {
      type: [
        {
          url: { type: String, required: true },
          // Public id returned by the storage provider (S3 key / Cloudinary id).
          // Kept so we can delete the asset when the product is removed.
          cloudinaryId: { type: String, default: null },
          storageKey: { type: String, default: null },
          alt: { type: String, trim: true, default: "" }
        }
      ],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length >= 2 && arr.length <= 3;
        },
        message: "images must contain between 2 and 3 entries"
      }
    },
    startingPrice: {
      type: Number,
      required: [true, "startingPrice is required"],
      min: [0, "startingPrice must be >= 0"]
    },
    currentPrice: {
      type: Number,
      required: true,
      min: [0, "currentPrice must be >= 0"]
    },
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "adminId is required"],
      index: true
    },
    status: {
      type: String,
      enum: {
        values: ["active", "awaiting_payment", "ended", "sold", "cancelled"],
        message: "status must be active, awaiting_payment, ended, sold, or cancelled"
      },
      default: "active",
      index: true
    },
    endsAt: {
      type: Date,
      required: [true, "endsAt is required"],
      index: true
    },
    winnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },
    winnerBidAmount: { type: Number, default: null },
    paymentDeadline: { type: Date, default: null, index: true },
    defaultedBidderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    demoPaymentConfirmedAt: { type: Date, default: null },
    bidCount: {
      type: Number,
      default: 0,
      min: [0, "bidCount must be >= 0"]
    },
    // Internal key used only by the rerunnable portfolio demo seeder.
    demoSeedId: { type: String, select: false }
  },
  {
    timestamps: true,
    // Performance: never return revoked/expired docs by default in find().
    toJSON: { virtuals: true }
  }
);

// Compound index: "active auctions ending soon" — covers status + endsAt.
productSchema.index({ status: 1, endsAt: 1 });

// Virtual: is the auction still open right now?
productSchema.virtual("isOpen").get(function () {
  return this.status === "active" && this.endsAt > new Date();
});

module.exports = mongoose.model("Product", productSchema);
