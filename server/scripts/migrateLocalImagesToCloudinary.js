require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const mongoose = require("mongoose");
const Product = require("../src/models/Product");
const { uploadDirectory } = require("../src/middleware/imageUpload");
const { getCloudinaryConfig, uploadImage, deleteImages } = require("../src/services/cloudinaryStorage");

const contentTypes = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

async function migrate() {
  if (!process.env.MONGO_URI) throw new Error("Set MONGO_URI in server/.env before running this migration");
  if (!getCloudinaryConfig()) {
    throw new Error("Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in server/.env first");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({ "images.storageKey": { $type: "string", $ne: "" } });
  let migrated = 0;
  let skipped = 0;

  try {
    for (const product of products) {
      const uploadedIds = [];
      const localPaths = [];
      const replacements = [];
      let saved = false;

      try {
        for (const image of product.images) {
          if (!image.storageKey) continue;
          if (!/^[\da-f-]{36}\.(jpg|png|webp)$/i.test(image.storageKey)) {
            throw new Error(`Unexpected local image key on product ${product._id}`);
          }
          const localPath = path.join(uploadDirectory, image.storageKey);
          const extension = path.extname(image.storageKey).slice(1).toLowerCase();
          await fs.access(localPath);
          const result = await uploadImage({
            path: localPath,
            filename: image.storageKey,
            originalname: image.storageKey,
            mimetype: contentTypes[extension]
          });
          uploadedIds.push(result.cloudinaryId);
          localPaths.push(localPath);
          replacements.push({ image, result });
        }

        if (!replacements.length) {
          skipped += 1;
          continue;
        }

        for (const { image, result } of replacements) {
          image.url = result.url;
          image.cloudinaryId = result.cloudinaryId;
          image.storageKey = null;
        }
        await product.save();
        saved = true;
        await Promise.all(localPaths.map((filePath) => fs.rm(filePath, { force: true }).catch((error) => {
          console.warn(`Could not remove migrated local file ${path.basename(filePath)}: ${error.message}`);
        })));
        migrated += replacements.length;
        console.log(`Migrated ${replacements.length} image(s) for listing ${product._id}`);
      } catch (error) {
        if (!saved) await deleteImages(uploadedIds);
        console.error(`Could not migrate listing ${product._id}: ${error.message}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }

  console.log(`Image migration finished. Migrated ${migrated} image(s); skipped ${skipped} listing(s).`);
}

migrate().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
