process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-only-secret-that-is-at-least-32-characters-long";
process.env.APP_ORIGIN = "http://localhost:5173";
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const User = require("../src/controllers/Users");
const Session = require("../src/controllers/Sessions");
const Product = require("../src/models/Product");
const Bid = require("../src/models/Bid");

const mongoUri = process.env.MONGO_TEST_URI || "mongodb://127.0.0.1:27017/bidding_app_test";
const databaseName = new URL(mongoUri).pathname.slice(1).split("?")[0];
if (!databaseName.toLowerCase().endsWith("_test")) {
  throw new Error("MONGO_TEST_URI database name must end in _test; refusing to clear it");
}
let server;
let baseUrl;

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
}

async function createVerifiedAccount(label) {
  const email = `${label}-${Date.now()}-${Math.random()}@example.test`;
  const password = "Correct-Horse-Blue-42!";
  const registration = await request("/api/auth/register", {
    method: "POST", body: JSON.stringify({ name: label, email, password })
  });
  assert.equal(registration.status, 201);
  const { verificationToken } = await registration.json();
  const verification = await request("/api/auth/verify-email", {
    method: "POST", body: JSON.stringify({ token: verificationToken })
  });
  assert.equal(verification.status, 200);
  const user = await User.findOne({ email });
  return { user, email, password };
}

async function login(email, password) {
  const response = await request("/api/auth/login", {
    method: "POST", body: JSON.stringify({ email, password })
  });
  return { response, body: await response.json() };
}

test.before(async () => {
  await mongoose.connect(mongoUri);
  await Promise.all([User.deleteMany({}), Session.deleteMany({}), Product.deleteMany({}), Bid.deleteMany({})]);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("rejects a wrong password", async () => {
  const account = await createVerifiedAccount("wrong-password");
  const result = await login(account.email, "wrong password");
  assert.equal(result.response.status, 401);
  assert.equal(result.body.message, "Invalid email or password");
});

test("rejects an expired signed token", async () => {
  const expired = jwt.sign(
    { userId: new mongoose.Types.ObjectId().toString(), sessionId: new mongoose.Types.ObjectId().toString() },
    process.env.JWT_SECRET,
    { expiresIn: "-1s", issuer: "bidding-app", audience: "bidding-app-users" }
  );
  const response = await request("/api/auth/me", { headers: { cookie: `token=${expired}` } });
  assert.equal(response.status, 401);
});

test("logout revokes the server session, even if the old cookie is copied", async () => {
  const account = await createVerifiedAccount("logout");
  const result = await login(account.email, account.password);
  const cookie = result.response.headers.get("set-cookie").split(";")[0];
  const rejectedLogout = await request("/api/auth/logout", { method: "POST", headers: { cookie } });
  assert.equal(rejectedLogout.status, 403);
  const logout = await request("/api/auth/logout", {
    method: "POST",
    headers: { cookie, "x-csrf-token": result.body.csrfToken }
  });
  assert.equal(logout.status, 200);
  const afterLogout = await request("/api/auth/me", { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
});

test("blocks one user from reading another user's profile", async () => {
  const owner = await createVerifiedAccount("profile-owner");
  const other = await createVerifiedAccount("profile-other");
  const result = await login(owner.email, owner.password);
  const cookie = result.response.headers.get("set-cookie").split(";")[0];
  const response = await request(`/api/auth/users/${other.user.id}`, { headers: { cookie } });
  assert.equal(response.status, 403);
});

test("listing view and bid workflow reads an auction, enforces access, and updates the price and history", async () => {
  const owner = await createVerifiedAccount("auction-owner");
  const bidder = await createVerifiedAccount("auction-bidder");
  const product = await Product.create({
    title: "Test auction item",
    description: "A carefully described auction item for integration testing. ".repeat(8),
    images: [{ url: "https://example.test/item-one.png" }, { url: "https://example.test/item-two.png" }],
    startingPrice: 50,
    currentPrice: 50,
    adminId: owner.user._id,
    endsAt: new Date(Date.now() + 60 * 60 * 1000)
  });

  const detail = await request(`/api/biddings/${product.id}`);
  assert.equal(detail.status, 200);
  const initialDetailBody = await detail.json();
  assert.equal(initialDetailBody.product.currentPrice, 50);
  assert.match(initialDetailBody.product.description, /integration testing/);

  const unauthenticatedBid = await request(`/api/biddings/${product.id}/bid`, {
    method: "POST", body: JSON.stringify({ amount: 60 })
  });
  assert.equal(unauthenticatedBid.status, 401);

  const ownerSession = await login(owner.email, owner.password);
  const ownerCookie = ownerSession.response.headers.get("set-cookie").split(";")[0];
  const selfBid = await request(`/api/biddings/${product.id}/bid`, {
    method: "POST",
    headers: { cookie: ownerCookie, "x-csrf-token": ownerSession.body.csrfToken },
    body: JSON.stringify({ amount: 60 })
  });
  assert.equal(selfBid.status, 403);

  const bidderSession = await login(bidder.email, bidder.password);
  const bidderCookie = bidderSession.response.headers.get("set-cookie").split(";")[0];
  const missingCsrf = await request(`/api/biddings/${product.id}/bid`, {
    method: "POST", headers: { cookie: bidderCookie }, body: JSON.stringify({ amount: 60 })
  });
  assert.equal(missingCsrf.status, 403);

  const placedBid = await request(`/api/biddings/${product.id}/bid`, {
    method: "POST",
    headers: { cookie: bidderCookie, "x-csrf-token": bidderSession.body.csrfToken },
    body: JSON.stringify({ amount: 60 })
  });
  assert.equal(placedBid.status, 201);
  assert.equal((await placedBid.json()).currentPrice, 60);

  const updatedDetail = await request(`/api/biddings/${product.id}`);
  const detailBody = await updatedDetail.json();
  assert.equal(detailBody.product.currentPrice, 60);
  assert.equal(detailBody.product.bidCount, 1);
  assert.equal(detailBody.recentBids[0].amount, 60);

  const history = await request(`/api/biddings/${product.id}/bids`);
  assert.equal(history.status, 200);
  assert.equal((await history.json()).bids[0].amount, 60);
});

test("password reset never exposes or accepts a development-only reset token", async () => {
  const account = await createVerifiedAccount("reset-email-required");
  const response = await request("/api/auth/forgot-password", {
    method: "POST", body: JSON.stringify({ email: account.email })
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.message, /RESEND_API_KEY and EMAIL_FROM/);
  assert.equal(body.resetToken, undefined);

  const storedUser = await User.findById(account.user.id).select("+passwordResetTokenHash +passwordResetExpires");
  assert.equal(storedUser.passwordResetTokenHash, undefined);
  assert.equal(storedUser.passwordResetExpires, undefined);
});

test("configured password reset sends a Resend email with a working app reset link", async () => {
  const account = await createVerifiedAccount("reset-email-sent");
  const originalFetch = global.fetch;
  let sentEmail;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Bidroom <no-reply@example.test>";
  process.env.FRONTEND_URL = "http://127.0.0.1:5500/client/index.html";
  global.fetch = async (input, options) => {
    if (input === "https://api.resend.com/emails") {
      sentEmail = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: "test-email-id" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return originalFetch(input, options);
  };

  try {
    const response = await request("/api/auth/forgot-password", {
      method: "POST", body: JSON.stringify({ email: account.email })
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.resetToken, undefined);
    assert.equal(sentEmail.from, "Bidroom <no-reply@example.test>");
    assert.deepEqual(sentEmail.to, [account.email]);
    assert.match(sentEmail.text, /index\.html#\/reset-password\?token=/);
  } finally {
    global.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.FRONTEND_URL;
  }
});

test("limits repeated login attempts", async () => {
  const statuses = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await request("/api/auth/login", {
      method: "POST", body: JSON.stringify({ email: "nobody@example.test", password: "wrong" })
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 response, got ${statuses.join(", ")}`);
});




