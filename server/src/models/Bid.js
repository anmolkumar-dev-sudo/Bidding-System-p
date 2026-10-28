const mongoose = require("mongoose");

/**
 * Bid — a user's offer on an active product.
 *
 * Integrity notes:
 *  - `amount` must be strictly greater than the product's currentPrice at
 *    the time of writing (enforced in the controller, not just schema).
 *  - `createdAt` is indexed so we can list recent bids per product quickly.
 *  - We allow multiple bids per user per product (each new bid must beat the
 *    current price), which is standard auction behavior.
 */
const bidSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "productId is required"],
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "userId is required"],
      index: true
    },
    amount: {
      type: Number,
      required: [true, "amount is required"],
      min: [0, "amount must be >= 0"]
    }
  },
  { timestamps: true }
);

// Query all bids for a product newest-first — covered by this index.
bidSchema.index({ productId: 1, createdAt: -1 });

module.exports = mongoose.model("Bid", bidSchema);