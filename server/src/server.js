require("dotenv").config();
const mongoose = require("mongoose");
const app = require("./app");
const User = require("./controllers/Users");
const { settleAuctions } = require("./services/auctionSettlement");
const { connectRedis } = require("./services/redisCache");
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      throw new Error("JWT_SECRET must be configured with at least 32 characters");
    }
    await mongoose.connect(process.env.MONGO_URI);
    await connectRedis();
    if (process.env.ADMIN_EMAIL) {
      const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
      const result = await User.updateOne({ email, emailVerified: true }, { $set: { role: "admin" } });
      if (!result.matchedCount) console.warn("ADMIN_EMAIL has no verified account yet; verify it, then restart the server");
    }
    console.log("MongoDB connected");
    await settleAuctions().catch((error) => console.error("Auction settlement error:", error.message));
    const settlementTimer = setInterval(() => {
      settleAuctions().catch((error) => console.error("Auction settlement error:", error.message));
    }, 15_000);
    settlementTimer.unref();
    app.listen(PORT, "0.0.0.0", () => console.log(`Server is listening on port ${PORT}`));
  } catch (error) {
    console.error("Could not start server:", error.message);
    process.exit(1);
  }
}

startServer();

