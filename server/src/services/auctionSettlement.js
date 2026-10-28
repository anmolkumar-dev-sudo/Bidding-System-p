const Product = require("../models/Product");
const Bid = require("../models/Bid");
const User = require("../controllers/Users");
const { sendAccountEmail } = require("../controllers/emailService");
const liveStream = require("./liveStream");
const { invalidateListingCache } = require("./redisCache");

const CLAIM_WINDOW_MS = 72 * 60 * 60 * 1000;

async function highestEligibleBid(productId, excludedIds = [], sellerId) {
  const excluded = new Set(excludedIds.map(String));
  const cursor = Bid.find({ productId })
    .sort({ amount: -1, createdAt: 1, _id: 1 })
    .lean()
    .cursor();
  const seenBidders = new Set();
  for await (const bid of cursor) {
    const userId = String(bid.userId);
    if (userId === String(sellerId) || excluded.has(userId) || seenBidders.has(userId)) continue;
    seenBidders.add(userId);
    return bid;
  }
  return null;
}

async function closeExpiredAuctions(now = new Date()) {
  const expired = await Product.find({ status: "active", endsAt: { $lte: now } })
    .select("_id adminId")
    .limit(100)
    .lean();

  for (const product of expired) {
    const topBid = await highestEligibleBid(product._id, [], product.adminId);
    const update = topBid
      ? {
          status: "awaiting_payment",
          winnerId: topBid.userId,
          winnerBidAmount: topBid.amount,
          currentPrice: topBid.amount,
          paymentDeadline: new Date(now.getTime() + CLAIM_WINDOW_MS),
          demoPaymentConfirmedAt: null
        }
      : { status: "ended", winnerId: null, winnerBidAmount: null, paymentDeadline: null };

    const result = await Product.updateOne({ _id: product._id, status: "active", endsAt: { $lte: now } }, { $set: update });
    if (result.modifiedCount > 0) {
      await invalidateListingCache();
      liveStream.broadcast(product._id, "auction_settled", {
        productId: product._id,
        status: update.status,
        winnerId: update.winnerId,
        currentPrice: update.currentPrice
      });

      if (topBid) {
        User.findById(topBid.userId).select("name email").lean().then((winner) => {
          if (winner && winner.email) {
            sendAccountEmail({
              to: winner.email,
              subject: `You won the auction!`,
              text: `Congratulations ${winner.name}!\n\nYou placed the winning bid of ₹${topBid.amount}.\nPlease log in to complete your payment before the claim deadline.`
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    }
  }
}

async function advanceExpiredClaims(now = new Date()) {
  const expired = await Product.find({
    status: "awaiting_payment",
    paymentDeadline: { $lte: now },
    winnerId: { $ne: null }
  }).select("_id adminId winnerId defaultedBidderIds paymentDeadline").limit(100).lean();

  for (const product of expired) {
    const previousWinner = product.winnerId;
    const defaulted = [...(product.defaultedBidderIds || []), previousWinner];
    const nextBid = await highestEligibleBid(product._id, defaulted, product.adminId);
    const update = nextBid
      ? {
          status: "awaiting_payment",
          winnerId: nextBid.userId,
          winnerBidAmount: nextBid.amount,
          currentPrice: nextBid.amount,
          paymentDeadline: new Date(now.getTime() + CLAIM_WINDOW_MS),
          defaultedBidderIds: defaulted,
          demoPaymentConfirmedAt: null
        }
      : {
          status: "ended",
          winnerId: null,
          winnerBidAmount: null,
          paymentDeadline: null,
          defaultedBidderIds: defaulted
        };

    // Compare-and-set prevents two server ticks from advancing the same winner.
    const result = await Product.updateOne(
      {
        _id: product._id,
        status: "awaiting_payment",
        winnerId: previousWinner,
        paymentDeadline: { $eq: product.paymentDeadline, $lte: now }
      },
      { $set: update }
    );

    if (result.modifiedCount > 0) {
      await invalidateListingCache();
      liveStream.broadcast(product._id, "winner_advanced", {
        productId: product._id,
        status: update.status,
        winnerId: update.winnerId,
        currentPrice: update.currentPrice
      });
    }
  }
}

async function settleAuctions(now = new Date()) {
  await closeExpiredAuctions(now);
  await advanceExpiredClaims(now);
}

module.exports = { CLAIM_WINDOW_MS, settleAuctions };
