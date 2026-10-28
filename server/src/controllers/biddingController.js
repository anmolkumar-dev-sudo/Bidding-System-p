const Product = require("../models/Product");
const Bid = require("../models/Bid");
const User = require("./Users");
const { removeUploadedFiles, removeStoredImages, hasValidImageSignature } = require("../middleware/imageUpload");
const { getCloudinaryConfig, uploadImage, deleteImages } = require("../services/cloudinaryStorage");
const { settleAuctions } = require("../services/auctionSettlement");
const liveStream = require("../services/liveStream");
const {
  getJson,
  setJson,
  getListingCacheVersion,
  invalidateListingCache
} = require("../services/redisCache");

/**
 * BiddingController
 *
 * Every mutation re-checks business rules inside the controller (defense in
 * depth) — never trust that route middleware caught everything.
 *
 * In local development, uploaded image files can use server/uploads. In
 * production, uploaded images are sent to Cloudinary and MongoDB stores their
 * durable URLs and provider IDs.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wordCount(text) {
  if (!text || typeof text !== "string") return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function futureDate(date) {
  if (!date) return false;
  const d = new Date(date);
  return !isNaN(d.getTime()) && d > new Date();
}

// ---------------------------------------------------------------------------
// POST /api/biddings — Create (authenticated user)
// ---------------------------------------------------------------------------

async function create(req, res) {
  const files = Array.isArray(req.files) ? req.files : [];
  const uploadedCloudinaryIds = [];
  let productCreated = false;
  const reject = async (status, message) => {
    await removeUploadedFiles(files);
    await deleteImages(uploadedCloudinaryIds);
    return res.status(status).json({ message });
  };

  try {
    const {
      title,
      description,
      images: suppliedImages,
      startingPrice,
      endsAt
    } = req.body;

    // ---- Field presence ----
    if (!title || typeof title !== "string") {
      return reject(400, "title is required");
    }
    if (!description || typeof description !== "string") {
      return reject(400, "description is required");
    }
    const numericStartingPrice = typeof startingPrice === "number"
      ? startingPrice
      : typeof startingPrice === "string" && startingPrice.trim() !== ""
        ? Number(startingPrice)
        : NaN;
    if (!Number.isFinite(numericStartingPrice)) {
      return reject(400, "startingPrice must be a valid number");
    }
    if (!futureDate(endsAt)) {
      return reject(400, "endsAt must be a future date");
    }

    // Accept local file uploads and keep the existing JSON URL format usable
    // for API clients that don't send multipart form data.
    if (!files.length && !Array.isArray(suppliedImages)) {
      return reject(400, "Choose 2 or 3 images to upload");
    }
    const imageInputs = files.length ? files : suppliedImages;

    if (imageInputs.length < 2) {
      return reject(400, "Choose at least 2 images");
    }
    if (imageInputs.length > 3) {
      return reject(400, "Choose no more than 3 images");
    }

    let normalizedImages;
    if (files.length) {
      const validSignatures = await Promise.all(files.map(hasValidImageSignature));
      if (validSignatures.some((valid) => !valid)) {
        return reject(400, "One or more files are not valid JPG, PNG, or WebP images");
      }

      const cloudinary = getCloudinaryConfig();
      if (process.env.NODE_ENV === "production" && !cloudinary) {
        return reject(503, "Image storage is not configured yet. Please try again later.");
      }

      if (cloudinary) {
        normalizedImages = [];
        for (const file of files) {
          const uploaded = await uploadImage(file);
          uploadedCloudinaryIds.push(uploaded.cloudinaryId);
          normalizedImages.push({ ...uploaded, storageKey: null, alt: "" });
        }
        await removeUploadedFiles(files);
      } else {
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        normalizedImages = files.map((file) => ({
          url: `${baseUrl}/uploads/${encodeURIComponent(file.filename)}`,
          cloudinaryId: null,
          storageKey: file.filename,
          alt: ""
        }));
      }
    } else {
      normalizedImages = suppliedImages.map((img, index) => {
        if (typeof img === "string") {
          return { url: img, cloudinaryId: null, storageKey: null, alt: "" };
        }
        if (img && typeof img.url === "string") {
          return {
            url: img.url,
            cloudinaryId: img.cloudinaryId || null,
            storageKey: img.storageKey || null,
            alt: typeof img.alt === "string" ? img.alt.trim() : ""
          };
        }
        throw new Error(`image at index ${index} is invalid`);
      });
    }

    // ---- Description word count: minimum 50 words ----
    if (wordCount(description) < 50) {
      return reject(400, "Description must be at least 50 words");
    }

    // ---- Starting price: must be > 0 ----
    if (numericStartingPrice <= 0) {
      return reject(400, "startingPrice must be greater than 0");
    }

    // ---- Persist ----
    const product = await Product.create({
      title: title.trim(),
      description: description.trim(),
      images: normalizedImages,
      startingPrice: numericStartingPrice,
      currentPrice: numericStartingPrice,
      adminId: req.user.id,
      endsAt: new Date(endsAt)
    });
    productCreated = true;
    await invalidateListingCache();

    return res.status(201).json({
      message: "Bidding item created",
      product: toPublicProduct(product)
    });
  } catch (error) {
    if (!productCreated) {
      await removeUploadedFiles(files);
      await deleteImages(uploadedCloudinaryIds);
    }
    console.error("create bidding error:", error.message);
    return res.status(500).json({ message: "Could not create bidding item" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/biddings — List (public)
// ---------------------------------------------------------------------------

async function list(req, res) {
  try {
    const { status, limit, page, q, sort } = req.query;
    const filter = {};

    if (status) {
      if (!["active", "awaiting_payment", "ended", "sold", "cancelled"].includes(status)) {
        return res.status(400).json({ message: "invalid status filter" });
      }
      filter.status = status;
    }

    const query = typeof q === "string" ? q.trim().slice(0, 100) : "";
    const sortOptions = {
      ending: { endsAt: 1 },
      newest: { createdAt: -1 },
      "price-low": { currentPrice: 1 },
      "price-high": { currentPrice: -1 },
      "most-bids": { bidCount: -1 }
    };
    const sortBy = { ...(sortOptions[sort] || sortOptions.ending), _id: 1 };

    const limitN = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const pageN = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageN - 1) * limitN;
    const cacheVersion = await getListingCacheVersion();
    const cacheKey = `list:${cacheVersion}:${JSON.stringify({
      status: status || "all",
      query,
      sort: sort || "ending",
      page: pageN,
      limit: limitN
    })}`;
    const cached = await getJson(cacheKey);
    if (cached) {
      console.info("[redis-cache] HIT listings");
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }
    console.info("[redis-cache] MISS listings");
    res.setHeader("X-Cache", "MISS");

    if (query) {
      if (query.length < 2) {
        return res.status(400).json({ message: "Search must be at least 2 characters" });
      }
      const searchIndex = process.env.MONGODB_SEARCH_INDEX || "listing_autocomplete";
      const searchStage = {
        $search: {
          index: searchIndex,
          compound: {
            should: ["title", "description"].map((path) => ({
              autocomplete: {
                query,
                path,
                fuzzy: { maxEdits: 1, prefixLength: 1 }
              }
            })),
            minimumShouldMatch: 1
          }
        }
      };
      const [result] = await Product.aggregate([
        searchStage,
        ...(status ? [{ $match: filter }] : []),
        {
          $facet: {
            items: [
              ...(sort === "relevance" ? [{ $set: { __searchScore: { $meta: "searchScore" } } }, { $sort: { __searchScore: -1, _id: 1 } }] : [{ $sort: sortBy }]),
              { $skip: skip },
              { $limit: limitN }
            ],
            metadata: [{ $count: "total" }]
          }
        }
      ]);
      const total = result?.metadata?.[0]?.total || 0;
      const response = {
        items: (result?.items || []).map(toPublicProduct),
        total,
        page: pageN,
        limit: limitN,
        pages: Math.ceil(total / limitN)
      };
      await setJson(cacheKey, response, 10);
      return res.json(response);
    }

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort(sortBy)
        .skip(skip)
        .limit(limitN)
        .lean(),
      Product.countDocuments(filter)
    ]);

    const response = {
      items: items.map(toPublicProduct),
      total,
      page: pageN,
      limit: limitN,
      pages: Math.ceil(total / limitN)
    };
    await setJson(cacheKey, response, 10);
    return res.json(response);
  } catch (error) {
    console.error("list bidding error:", error.message);
    return res.status(500).json({ message: "Could not load bidding items" });
  }
}

// GET /api/biddings/suggestions?q=car — Search-as-you-type suggestions (public)
async function suggestions(req, res) {
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (query.length < 2) return res.json({ items: [] });

  try {
    const normalizedQuery = query.toLocaleLowerCase();
    const cacheVersion = await getListingCacheVersion();
    const cacheKey = `suggestions:${cacheVersion}:${normalizedQuery}`;
    const cached = await getJson(cacheKey);
    if (cached) {
      console.info("[redis-cache] HIT suggestions");
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }
    console.info("[redis-cache] MISS suggestions");
    res.setHeader("X-Cache", "MISS");
    const searchIndex = process.env.MONGODB_SEARCH_INDEX || "listing_autocomplete";
    const items = await Product.aggregate([
      {
        $search: {
          index: searchIndex,
          compound: {
            should: ["title", "description"].map((path) => ({
              autocomplete: {
                query,
                path,
                fuzzy: { maxEdits: 1, prefixLength: 1 }
              }
            })),
            minimumShouldMatch: 1
          }
        }
      },
      { $limit: 7 },
      { $project: { title: 1, currentPrice: 1, images: 1, status: 1, endsAt: 1 } }
    ]);
    const response = { items: items.map(toPublicProduct) };
    await setJson(cacheKey, response, 15);
    return res.json(response);
  } catch (error) {
    console.error("MongoDB Search suggestions error:", error.message);
    return res.status(503).json({
      message: "MongoDB Search is unavailable. Configure a MongoDB Search index named listing_autocomplete (or set MONGODB_SEARCH_INDEX) for the products collection."
    });
  }
}

// ---------------------------------------------------------------------------
// GET /api/biddings/:id — Read one (public)
// ---------------------------------------------------------------------------

async function readOne(req, res) {
  try {
    await settleAuctions();
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: "Bidding item not found" });

    // Attach recent bids so the frontend can show bid history
    const recentBids = await Bid.find({ productId: product._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return res.json({
      product: toPublicProduct(product),
      recentBids: recentBids.map((b) => ({
        id: b._id,
        amount: b.amount,
        createdAt: b.createdAt
      }))
    });
  } catch (error) {
    console.error("read bidding error:", error.message);
    return res.status(500).json({ message: "Could not load bidding item" });
  }
}

// POST /api/biddings/:id/demo-payment — complete the demo winner flow.
async function confirmDemoPayment(req, res) {
  try {
    await settleAuctions();
    const now = new Date();
    const product = await Product.findOneAndUpdate(
      {
        _id: req.params.id,
        status: "awaiting_payment",
        winnerId: req.user.id,
        paymentDeadline: { $gt: now }
      },
      { $set: { status: "sold", demoPaymentConfirmedAt: now, paymentDeadline: null } },
      { new: true }
    );
    if (!product) {
      const current = await Product.findById(req.params.id).lean();
      if (!current) return res.status(404).json({ message: "Bidding item not found" });
      if (current.status === "awaiting_payment" && String(current.winnerId) !== req.user.id) {
        return res.status(403).json({ message: "Only the current winning bidder can confirm this demo step" });
      }
      return res.status(409).json({ message: "There is no active demo payment window for your account" });
    }
    await invalidateListingCache();
    return res.json({
      message: "Demo payment confirmed. No real payment was processed.",
      product: toPublicProduct(product)
    });
  } catch (error) {
    console.error("demo payment confirmation error:", error.message);
    return res.status(500).json({ message: "Could not confirm the demo payment" });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/biddings/:id — Update (owner or admin)
// ---------------------------------------------------------------------------

async function update(req, res) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Bidding item not found" });
    if (product.adminId.toString() !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ message: "You can edit only your own listings" });
    }

    const { title, description, startingPrice, endsAt, status, images } = req.body;
    const updates = {};

    if (title !== undefined) {
      if (typeof title !== "string" || title.trim().length < 3) {
        return res.status(400).json({ message: "invalid title" });
      }
      updates.title = title.trim();
    }

    if (description !== undefined) {
      if (typeof description !== "string" || wordCount(description) < 50) {
        return res.status(400).json({ message: "description must be at least 50 words" });
      }
      updates.description = description.trim();
    }

    if (startingPrice !== undefined) {
      if (typeof startingPrice !== "number" || startingPrice <= 0) {
        return res.status(400).json({ message: "invalid startingPrice" });
      }
      updates.startingPrice = startingPrice;
      // If this is the first bid ever, reset currentPrice to startingPrice
      if (product.bidCount === 0) {
        updates.currentPrice = startingPrice;
      }
    }

    if (endsAt !== undefined && !futureDate(endsAt)) {
      return res.status(400).json({ message: "endsAt must be a future date" });
    }
    if (endsAt !== undefined) updates.endsAt = new Date(endsAt);

    if (status !== undefined) {
      if (status !== "cancelled" || product.status !== "active") {
        return res.status(400).json({ message: "Auction status is managed automatically; only an active auction can be cancelled" });
      }
      updates.status = status;
    }

    if (images !== undefined) {
      if (!Array.isArray(images) || images.length < 2 || images.length > 3) {
        return res.status(400).json({ message: "images must be between 2 and 3" });
      }
      updates.images = images.map((img) =>
        typeof img === "string" ? { url: img, cloudinaryId: null, alt: "" } : img
      );
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true
    }).lean();
    await invalidateListingCache();

    return res.json({
      message: "Bidding item updated",
      product: toPublicProduct(updated)
    });
  } catch (error) {
    console.error("update bidding error:", error.message);
    return res.status(500).json({ message: "Could not update bidding item" });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/biddings/:id — Delete (owner or admin)
// ---------------------------------------------------------------------------

async function remove(req, res) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Bidding item not found" });
    if (product.adminId.toString() !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ message: "You can delete only your own listings" });
    }

    await Product.deleteOne({ _id: req.params.id });
    await Bid.deleteMany({ productId: req.params.id });
    await removeStoredImages(product.images || []);
    await invalidateListingCache();

    return res.json({ message: "Bidding item deleted" });
  } catch (error) {
    console.error("delete bidding error:", error.message);
    return res.status(500).json({ message: "Could not delete bidding item" });
  }
}

// ---------------------------------------------------------------------------
// POST /api/biddings/:id/bid — Place a bid (authenticated user)
// ---------------------------------------------------------------------------

async function placeBid(req, res) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Bidding item not found" });

    // ---- Auction must be active and not ended ----
    if (product.status !== "active") {
      return res.status(400).json({ message: "Auction is not active" });
    }
    if (product.endsAt <= new Date()) {
      // Auto-expire if someone tries to bid after endsAt
      product.status = "ended";
      await product.save();
      return res.status(400).json({ message: "Auction has ended" });
    }

    // ---- Cannot bid on your own item ----
    if (product.adminId.toString() === req.user.id) {
      return res.status(403).json({ message: "You cannot bid on your own item" });
    }

    const { amount } = req.body;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return res.status(400).json({ message: "amount must be a valid number" });
    }

    // ---- Must beat current price ----
    if (amount <= product.currentPrice) {
      return res.status(400).json({
        message: `Bid must be higher than current price (₹${product.currentPrice})`
      });
    }

    // Record the bid, then atomically advance the product price. This works
    // with a standalone local MongoDB server as well as replica-set deployments.
    const bid = await Bid.create({
      productId: product._id,
      userId: req.user.id,
      amount
    });

    try {
      const result = await Product.updateOne(
        {
          _id: product._id,
          status: "active",
          endsAt: { $gt: new Date() },
          currentPrice: { $lt: amount }
        },
        { $set: { currentPrice: amount }, $inc: { bidCount: 1 } }
      );

      if (!result.modifiedCount) {
        await Bid.deleteOne({ _id: bid._id });
        const latest = await Product.findById(product._id).lean();
        if (!latest) return res.status(404).json({ message: "Bidding item not found" });
        if (latest.status !== "active") return res.status(400).json({ message: "Auction is not active" });
        if (latest.endsAt <= new Date()) return res.status(400).json({ message: "Auction has ended" });
        return res.status(409).json({
          message: `Bid must be higher than current price (Rs ${latest.currentPrice})`
        });
      }

      await invalidateListingCache();

      // Broadcast real-time bid to all live listeners
      liveStream.broadcast(product._id, "bid_placed", {
        productId: product._id,
        currentPrice: amount,
        bidCount: product.bidCount + 1,
        endsAt: product.endsAt,
        bid: {
          id: bid._id,
          amount: bid.amount,
          createdAt: bid.createdAt,
          userId: req.user.id,
          bidderName: req.user.name || "Anonymous bidder"
        }
      });

      return res.status(201).json({
        message: "Bid placed successfully",
        currentPrice: amount,
        bidId: bid._id
      });
    } catch (error) {
      await Bid.deleteOne({ _id: bid._id }).catch(() => {});
      throw error;
    }
  } catch (error) {
    console.error("place bid error:", error.message);
    return res.status(500).json({ message: "Could not place bid" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/biddings/:id/bids — Bid history (public)
// ---------------------------------------------------------------------------

async function getBids(req, res) {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: "Bidding item not found" });

    const bids = await Bid.find({ productId: product._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({
      bids: bids.map((b) => ({
        id: b._id,
        amount: b.amount,
        createdAt: b.createdAt,
        userId: b.userId
      }))
    });
  } catch (error) {
    console.error("get bids error:", error.message);
    return res.status(500).json({ message: "Could not load bids" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/biddings/:id/live — Real-time event stream (SSE)
// ---------------------------------------------------------------------------

function streamLiveAuction(req, res) {
  liveStream.subscribe(req.params.id, req, res);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toPublicProduct(doc) {
  const p = doc.toObject ? doc.toObject() : doc;
  return {
    id: p._id,
    title: p.title,
    description: p.description,
    images: p.images || [],
    startingPrice: p.startingPrice,
    currentPrice: p.currentPrice,
    adminId: p.adminId,
    status: p.status,
    endsAt: p.endsAt,
    winnerId: p.winnerId,
    winnerBidAmount: p.winnerBidAmount,
    paymentDeadline: p.paymentDeadline,
    demoPaymentConfirmedAt: p.demoPaymentConfirmedAt,
    bidCount: p.bidCount,
    isOpen: p.isOpen,
    createdAt: p.createdAt
  };
}

module.exports = {
  create,
  list,
  suggestions,
  readOne,
  update,
  remove,
  placeBid,
  getBids,
  confirmDemoPayment,
  streamLiveAuction
};
