const { createClient } = require("redis");

const CACHE_PREFIX = "bidroom:v1";
let client;
let connectionPromise;
let redisReady = false;

function getRedisClient() {
  if (client) return client;
  if (!process.env.REDIS_URL) return null;

  client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (error) => {
    redisReady = false;
    console.error("Redis connection error:", error.message);
  });
  client.on("ready", () => {
    redisReady = true;
    console.log("Redis connected");
  });
  client.on("end", () => { redisReady = false; });
  return client;
}

async function connectRedis() {
  const redis = getRedisClient();
  if (!redis) {
    console.log("Redis cache disabled (REDIS_URL is not set)");
    return false;
  }
  if (redis.isReady) return true;
  if (connectionPromise) return connectionPromise;

  connectionPromise = redis.connect()
    .then(() => true)
    .catch((error) => {
      console.error("Redis unavailable; continuing without cache:", error.message);
      return false;
    })
    .finally(() => { connectionPromise = null; });
  return connectionPromise;
}

function isRedisReady() {
  return Boolean(redisReady && client?.isReady);
}

async function getJson(key) {
  if (!isRedisReady()) return null;
  try {
    const value = await client.get(`${CACHE_PREFIX}:${key}`);
    return value === null ? null : JSON.parse(value);
  } catch (error) {
    console.error("Redis cache read failed:", error.message);
    return null;
  }
}

async function setJson(key, value, ttlSeconds) {
  if (!isRedisReady()) return;
  try {
    await client.set(`${CACHE_PREFIX}:${key}`, JSON.stringify(value), { EX: ttlSeconds });
  } catch (error) {
    console.error("Redis cache write failed:", error.message);
  }
}

async function getListingCacheVersion() {
  if (!isRedisReady()) return "uncached";
  try {
    return (await client.get(`${CACHE_PREFIX}:listings:version`)) || "0";
  } catch (error) {
    console.error("Redis cache version read failed:", error.message);
    return "uncached";
  }
}

async function invalidateListingCache() {
  if (!isRedisReady()) return;
  try {
    await client.incr(`${CACHE_PREFIX}:listings:version`);
  } catch (error) {
    console.error("Redis cache invalidation failed:", error.message);
  }
}

async function closeRedis() {
  if (client?.isOpen) await client.quit();
  redisReady = false;
}

module.exports = {
  connectRedis,
  closeRedis,
  getJson,
  setJson,
  getListingCacheVersion,
  invalidateListingCache
};
