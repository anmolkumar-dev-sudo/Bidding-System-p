  /* ============================================================
   Bidding App — Frontend (vanilla JS, no build step)
   Talks to the Express backend on localhost:5000.
   ============================================================ */

const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = location.protocol === "file:"
  ? "http://localhost:5000"
  : isLocalDevelopment && location.port !== "5000"
    ? `${location.protocol}//${location.hostname}:5000`
    : location.origin;

// ---------- Tiny DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const html = (el, str) => { el.innerHTML = str; return el; };
const show = (el) => { el.classList.remove("hidden"); };
const hide = (el) => { el.classList.add("hidden"); };

let pendingRequestCount = 0;
let requestLoaderTimer = null;

async function withRequestLoader(request) {
  pendingRequestCount += 1;
  if (pendingRequestCount === 1) {
    requestLoaderTimer = setTimeout(() => {
      const loader = $("#request-loader");
      if (loader && pendingRequestCount > 0) loader.hidden = false;
    }, 350);
  }
  try {
    return await request();
  } finally {
    pendingRequestCount = Math.max(0, pendingRequestCount - 1);
    if (pendingRequestCount === 0) {
      clearTimeout(requestLoaderTimer);
      requestLoaderTimer = null;
      const loader = $("#request-loader");
      if (loader) loader.hidden = true;
    }
  }
}

function friendlyNetworkError(error) {
  if (error instanceof TypeError) {
    return new Error("We couldn’t complete that request. Check your connection and try again.");
  }
  return error;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------- Auth state ----------
let currentUser = null;
let csrfToken = null;
let authNotice = null;
let activeLiveEventSource = null;

// ---------- API wrapper ----------
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  // Attach CSRF token on state-changing requests
  if (["POST", "PATCH", "DELETE", "PUT"].includes(opts.method || "GET") && csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }
  try {
    return await withRequestLoader(async () => {
      const res = await fetch(`${API}${path}`, { ...opts, headers, credentials: "include" });
      let data;
      try { data = await res.json(); } catch { data = {}; }
      if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
      return { status: res.status, data };
    });
  } catch (error) {
    throw friendlyNetworkError(error);
  }
}

async function apiForm(path, formData, method = "POST") {
  const headers = {};
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  try {
    return await withRequestLoader(async () => {
      const res = await fetch(`${API}${path}`, {
        method,
        headers,
        credentials: "include",
        body: formData
      });
      let data;
      try { data = await res.json(); } catch { data = {}; }
      if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
      return { status: res.status, data };
    });
  } catch (error) {
    throw friendlyNetworkError(error);
  }
}

// ---------- Auth ----------
async function initAuth() {
  try {
    const { data } = await api("/api/auth/me");
    currentUser = data.user;
    await refreshCsrf();
  } catch {
    currentUser = null;
  }
}

async function refreshCsrf() {
  try {
    const { data } = await api("/api/auth/csrf");
    csrfToken = data.csrfToken;
  } catch { csrfToken = null; }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $("input[name=email]").value;
  const password = $("input[name=password]").value;
  const loginParams = new URLSearchParams(location.hash.split("?")[1] || "");
  const returnTo = loginParams.get("returnTo");
  try {
    const { data } = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    await initAuth();
    await loadBiddings();
    const safeAuctionRoute = /^#\/biddings\/[a-f\d]{24}(?:\?intent=bid)?$/i.test(returnTo || "");
    render(safeAuctionRoute ? returnTo : "#/biddings");
  } catch (err) {
    showAlert("login-alert", err.message, "error");
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = $("input[name=name]").value;
  const email = $("input[name=email]").value;
  const password = $("input[name=password]").value;
  try {
    const { data } = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password })
    });
    if (data.verificationToken) {
      await api("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token: data.verificationToken })
      });
      showAlert("register-alert", "Account created and verified. You can sign in now.", "success");
    } else {
      showAlert("register-alert", "Account created. Check your email to verify, then sign in.", "success");
    }
    $("form[name=register]").reset();
  } catch (err) {
    showAlert("register-alert", err.message, "error");
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = $("form[name=forgot-password] input[name=email]").value.trim();
  try {
    const { data } = await api("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email })
    });
    if (data.resetToken) {
      location.hash = `#/reset-password?token=${encodeURIComponent(data.resetToken)}`;
      return;
    }
    showAlert("forgot-password-alert", data.message, "success");
  } catch (err) {
    showAlert("forgot-password-alert", err.message, "error");
  }
}

async function handleResetPassword(e) {
  e.preventDefault();
  const form = $("form[name=reset-password]");
  const token = new URLSearchParams(location.hash.split("?")[1] || "").get("token");
  const newPassword = form.elements.newPassword.value;
  try {
    const { data } = await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword })
    });
    authNotice = { message: data.message, type: "success" };
    location.hash = "#/login";
  } catch (err) {
    showAlert("reset-password-alert", err.message, "error");
  }
}

async function handleLogout(e) {
  if (e) e.preventDefault();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {}
  currentUser = null;
  csrfToken = null;
  renderNav();
  render();
}

// ---------- Biddings ----------
let biddings = [];
let listingSearchTerm = "";
let listingSort = "ending";
let listingStatus = "active";
let listingPage = 1;
let listingTotal = 0;
let suggestionTimer;
let suggestionRequest = 0;
let listingQueryRequest = 0;

async function loadBiddings() {
  try {
    listingSearchTerm = "";
    listingSort = "ending";
    listingStatus = "active";
    listingPage = 1;
    const { data } = await api("/api/biddings?status=active&sort=ending&page=1&limit=20");
    biddings = data.items || [];
    listingTotal = data.total || 0;
  } catch (err) {
    biddings = [];
    listingTotal = 0;
  }
}

async function runListingQuery({ query = listingSearchTerm, sort = listingSort, status = listingStatus, page = 1 } = {}) {
  const requestId = ++listingQueryRequest;
  listingSearchTerm = query.trim();
  listingSort = sort;
  listingStatus = status;
  listingPage = page;
  const params = new URLSearchParams({ page: String(page), limit: "20", sort });
  if (status !== "all") params.set("status", status);
  if (listingSearchTerm) params.set("q", listingSearchTerm);
  try {
    const { data } = await api(`/api/biddings?${params}`);
    if (requestId !== listingQueryRequest) return;
    biddings = data.items || [];
    listingTotal = data.total || 0;
    renderBiddingsList();
  } catch (error) {
    if (requestId !== listingQueryRequest) return;
    biddings = [];
    listingTotal = 0;
    renderBiddingsList();
    showAlert("listing-search-alert", error.message, "error");
  }
}

function renderSearchSuggestions(items) {
  const menu = $("#listing-suggestions");
  if (!menu) return;
  if (!items.length) {
    menu.innerHTML = `<div class="search-suggestion-empty">No matching listings</div>`;
    show(menu);
    return;
  }
  menu.innerHTML = items.map((item) => {
    const image = item.images?.[0]?.url;
    return `<button class="search-suggestion" type="button" data-search-title="${escapeHtml(item.title)}">
      ${image ? `<img src="${escapeHtml(image)}" alt="">` : `<span class="search-suggestion-image">B</span>`}
      <span class="search-suggestion-copy"><strong>${escapeHtml(item.title)}</strong><small>${formatCurrency(item.currentPrice)} · ${item.status === "active" ? "Auction open" : "Auction closed"}</small></span>
      <span class="search-suggestion-arrow" aria-hidden="true">↗</span>
    </button>`;
  }).join("");
  show(menu);
}

function bindListingSearch() {
  const form = $("#listing-search-form");
  const input = $("#listing-search-input");
  const sort = $("#listing-sort");
  const status = $("#listing-status");
  if (!form || !input || !sort || !status) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    hide($("#listing-suggestions"));
    runListingQuery({ query: input.value, sort: sort.value, status: status.value, page: 1 });
  });
  sort.addEventListener("change", () => {
    runListingQuery({ query: input.value, sort: sort.value, status: status.value, page: 1 });
  });
  status.addEventListener("change", () => {
    runListingQuery({ query: input.value, sort: sort.value, status: status.value, page: 1 });
  });
  input.addEventListener("input", () => {
    clearTimeout(suggestionTimer);
    const query = input.value.trim();
    if (query.length < 2) {
      hide($("#listing-suggestions"));
      return;
    }
    suggestionTimer = setTimeout(async () => {
      const requestId = ++suggestionRequest;
      try {
        const { data } = await api(`/api/biddings/suggestions?q=${encodeURIComponent(query)}`);
        if (requestId === suggestionRequest && input.value.trim() === query) renderSearchSuggestions(data.items || []);
      } catch {
        if (requestId === suggestionRequest) hide($("#listing-suggestions"));
      }
    }, 250);
  });
  $("#listing-suggestions")?.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-search-title]");
    if (!choice) return;
    input.value = choice.dataset.searchTitle;
    hide($("#listing-suggestions"));
    runListingQuery({ query: input.value, sort: sort.value, status: status.value, page: 1 });
  });
}

async function loadDetail(id) {
  const { data } = await api(`/api/biddings/${id}`);
  return data;
}

async function handleCreateBidding(e) {
  e.preventDefault();
  const form = e.target;
  const files = Array.from(form.elements.images.files || []);
  if (files.length < 2 || files.length > 3) {
    showAlert("create-alert", "Choose 2 or 3 images from your computer.", "error");
    return;
  }
  const oversized = files.find((file) => file.size > 5 * 1024 * 1024);
  if (oversized) {
    showAlert("create-alert", `${escapeHtml(oversized.name)} is larger than 5 MB.`, "error");
    return;
  }

  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Uploading images...";

  try {
    await apiForm("/api/biddings", new FormData(form));
    await loadBiddings();
    form.reset();
    clearImagePreview();
    render("#/biddings");
  } catch (err) {
    showAlert("create-alert", err.message, "error");
  } finally {
    if (submit.isConnected) {
      submit.disabled = false;
      submit.textContent = "List Item";
    }
  }
}

let imagePreviewUrls = [];

function clearImagePreview() {
  imagePreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  imagePreviewUrls = [];
  const preview = $("#image-upload-preview");
  const status = $("#image-upload-status");
  if (preview) preview.innerHTML = "";
  if (status) status.textContent = "Select 2 or 3 images from your computer.";
}

function setupImagePicker() {
  const input = $("#create-images");
  const preview = $("#image-upload-preview");
  const status = $("#image-upload-status");
  if (!input || !preview || !status) return;

  input.addEventListener("change", () => {
    clearImagePreview();
    const files = Array.from(input.files || []);
    status.textContent = `${files.length} of 2–3 images selected`;

    preview.innerHTML = files.map((file) => {
      const url = URL.createObjectURL(file);
      imagePreviewUrls.push(url);
      return `
        <div class="image-upload-item">
          <img src="${url}" alt="Preview of ${escapeHtml(file.name)}">
          <span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <small>${(file.size / (1024 * 1024)).toFixed(2)} MB</small>
        </div>
      `;
    }).join("");

    const invalidType = files.find((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type));
    const oversized = files.find((file) => file.size > 5 * 1024 * 1024);
    if (files.length < 2 || files.length > 3) {
      showAlert("create-alert", "Select 2 or 3 images to continue.", "error");
    } else if (invalidType) {
      showAlert("create-alert", `${escapeHtml(invalidType.name)} is not a JPG, PNG, or WebP image.`, "error");
    } else if (oversized) {
      showAlert("create-alert", `${escapeHtml(oversized.name)} is larger than 5 MB.`, "error");
    } else {
      hide($("#create-alert"));
    }
  });
}

async function handlePlaceBid(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const id = form.elements.bidProductId.value;
  const amount = Number(form.elements.bidAmount.value);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Submitting bid…";

  // Production Idempotency Key: prevents double-bidding on network retries or accidental double clicks
  const idempotencyKey = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const { data } = await api(`/api/biddings/${id}/bid`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ amount })
    });
    await loadBiddings();
    await renderBiddingDetail(id);
    showAlert("bid-alert", `Your bid of ${formatCurrency(data.currentPrice)} is now leading.`, "success");
  } catch (err) {
    if (err.message.includes("higher than current price")) {
      await renderBiddingDetail(id);
    }
    showAlert("bid-alert", err.message, "error");
  } finally {
    if (submit.isConnected) {
      submit.disabled = false;
      submit.textContent = "Place bid";
    }
  }
}

async function loadMyBids() {
  // Public endpoint per architecture; UI shows it anyway.
  try {
    const { data } = await api("/api/biddings");
    return (data.items || []).filter((i) => i.adminId === currentUser.id);
  } catch { return []; }
}

// ---------- Word counter ----------
function setupWordCounter(textareaId, counterId, min = 50) {
  const ta = $(textareaId);
  const counter = document.getElementById(counterId.replace(/^#/, ""));
  if (!ta || !counter) return;
  const update = () => {
    const words = ta.value.trim().split(/\s+/).filter(Boolean).length;
    const remaining = Math.max(0, min - words);
    counter.textContent = remaining
      ? `${remaining} word${remaining === 1 ? "" : "s"} left to minimum`
      : `Minimum reached · ${words} words`;
    counter.className = "word-counter " + (words >= min ? "ok" : "warn");
  };
  ta.addEventListener("input", update);
  update();
}

// ---------- Rendering ----------
function renderNav() {
  const links = $("nav-links");
  if (!links) return;
  if (currentUser) {
    html(links, `
      <a href="#/biddings" class="nav-link" data-route="biddings">Biddings</a>
      <a href="#/mybids" class="nav-link" data-route="mybids">My Listings</a>
    `);
  } else {
    html(links, `
      <a href="#/biddings" class="nav-link" data-route="biddings">Browse auctions</a>
      <a href="#/login" class="nav-link" data-route="login">Log in</a>
    `);
  }
  // Re-mark active after innerHTML swap
  const route = (location.hash.slice(2).split("/")[0] || "login");
  $$(".nav-link").forEach((l) => l.classList.remove("active"));
  const active = $(`.nav-link[data-route="${route}"]`);
  if (active) active.classList.add("active");
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2
  }).format(Number(amount) || 0);
}

function statusBadge(status) {
  const map = {
    active: "active",
    ended: "ended",
    sold: "ended",
    cancelled: "cancelled",
    awaiting_payment: "active"
  };
  const labels = { awaiting_payment: "Awaiting payment", ended: "Ended", sold: "Sold", cancelled: "Cancelled", active: "Active" };
  return `<span class="product-badge ${map[status] || status}">${labels[status] || escapeHtml(status)}</span>`;
}

function timerEl(endsAt, status) {
  if (status === "claim") {
    const diff = new Date(endsAt) - new Date();
    if (diff <= 0) return `<span class="timer ended">Deadline passed</span>`;
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    return `<span class="timer active">${days}d ${hrs}h ${mins}m to pay</span>`;
  }
  if (status !== "active") return `<span class="timer ${status}">${status.toUpperCase()}</span>`;
  const end = new Date(endsAt);
  const now = new Date();
  const diff = end - now;
  if (diff <= 0) return `<span class="timer ended">ENDED</span>`;
  const days = Math.floor(diff / 86400000);
  const hrs = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const cls = diff < 3600000 ? "ending" : "active";
  return `<span class="timer ${cls}">${days}d ${hrs}h ${mins}m left</span>`;
}

function renderPage(hash) {
  const app = $("#root");
  const userChip = $("#user-chip");
  const logoutBtn = $("#btn-logout");

  // Auth UI
  renderNav();
  if (currentUser) {
    show(userChip);
    show(logoutBtn);
    const userName = $("#nav-user-name");
    if (userName) userName.textContent = currentUser.name;
  } else {
    hide(userChip);
    hide(logoutBtn);
  }

  // Route
  const [routePath, queryString = ""] = hash.slice(2).split("?");
  const routeParams = new URLSearchParams(queryString);
  const [route, id] = routePath.split("/");
  document.body.classList.toggle("is-login", ["login", "forgot-password", "reset-password"].includes(route));

  // Disconnect any active real-time SSE stream if navigating away from auction detail
  if (route !== "biddings" || !id) {
    if (activeLiveEventSource) {
      activeLiveEventSource.close();
      activeLiveEventSource = null;
    }
  }

  // Helper: mark nav active
  $$(".nav-link").forEach((l) => l.classList.remove("active"));
  const activeLink = $(`.nav-link[data-route="${route || 'biddings'}"]`);
  if (activeLink) activeLink.classList.add("active");

  if (route === "login") {
    html(app, loginPage());
    setupAuthForm("login", handleLogin);
    if (authNotice) {
      showAlert("login-alert", authNotice.message, authNotice.type);
      authNotice = null;
    }
  } else if (route === "register") {
    html(app, registerPage());
    setupAuthForm("register", handleRegister);
  } else if (route === "forgot-password") {
    html(app, passwordRecoveryPage("forgot"));
    setupAuthForm("forgot-password", handleForgotPassword);
  } else if (route === "reset-password") {
    html(app, passwordRecoveryPage("reset"));
    setupAuthForm("reset-password", handleResetPassword);
  } else if (route === "biddings" && id) {
    renderBiddingDetail(id, routeParams.get("intent") === "bid");
  } else if (route === "biddings") {
    renderBiddingsList();
  } else if (route === "create") {
    if (currentUser) renderCreatePage();
    else html(app, `<div class="page"><div class="empty-state"><h3>Sign in to create a listing</h3><p>Create an account or sign in, then list your item for auction.</p><a href="#/login" class="btn btn-primary">Sign in</a></div></div>`);
  } else if (route === "mybids") {
    if (currentUser) renderMyBidsPage();
    else html(app, `<div class="page"><div class="empty-state"><h3>Sign in to view your listings</h3><a href="#/login" class="btn btn-primary">Sign in</a></div></div>`);
  } else {
    renderBiddingsList();
  }
}

function renderBiddingsList() {
  const app = $("#root");
  const items = biddings.length ? biddings : [];
  const pages = Math.max(1, Math.ceil(listingTotal / 20));
  const statusLabel = listingStatus === "active" ? "active auction" : listingStatus === "sold" ? "sold listing" : "listing";
  const emptyTitle = listingSearchTerm ? `No listings found for “${escapeHtml(listingSearchTerm)}”` : "The marketplace is ready for its first listing";
  const emptyDescription = listingSearchTerm
    ? "Try a different search, or clear it to browse all available listings."
    : "Create an auction listing and it will appear here for everyone to discover and bid on.";

  html(app, `
    <div class="page marketplace-page">
      <div class="page-header marketplace-header">
        <div>
          <div class="marketplace-eyebrow">BIDROOM <span></span> AUCTIONS</div>
          <div class="page-title">Find something worth bidding on.</div>
          <div class="marketplace-count">${listingTotal} ${statusLabel}${listingTotal === 1 ? "" : "s"}</div>
          <div class="page-subtitle">${listingSearchTerm ? `${listingTotal} result${listingTotal === 1 ? "" : "s"} for “${escapeHtml(listingSearchTerm)}”` : "Explore community listings and make your next offer."}</div>
        </div>
        ${currentUser ? `<a href="#/create" class="btn btn-primary marketplace-create"><span aria-hidden="true">+</span> Create listing</a>` : `<a href="#/login" class="btn btn-primary marketplace-create">Sign in to list</a>`}
      </div>

      <form id="listing-search-form" class="listing-search-toolbar" role="search">
        <div class="listing-search-wrap">
          <label class="sr-only" for="listing-search-input">Search listings</label>
          <span class="listing-search-icon" aria-hidden="true">⌕</span>
          <input id="listing-search-input" type="search" value="${escapeHtml(listingSearchTerm)}" placeholder="Search listings, e.g. car" autocomplete="off" minlength="2">
          <div id="listing-suggestions" class="listing-suggestions hidden" role="listbox" aria-label="Listing suggestions"></div>
        </div>
        <button class="btn btn-outline listing-search-submit" type="submit">Search</button>
        <label class="listing-sort-label" for="listing-sort">Sort by</label>
        <select id="listing-sort" class="form-input listing-sort">
          <option value="relevance" ${listingSort === "relevance" ? "selected" : ""}>Most relevant</option>
          <option value="ending" ${listingSort === "ending" ? "selected" : ""}>Ending soon</option>
          <option value="newest" ${listingSort === "newest" ? "selected" : ""}>Newest</option>
          <option value="price-low" ${listingSort === "price-low" ? "selected" : ""}>Price: low to high</option>
          <option value="price-high" ${listingSort === "price-high" ? "selected" : ""}>Price: high to low</option>
          <option value="most-bids" ${listingSort === "most-bids" ? "selected" : ""}>Most bids</option>
        </select>
        <label class="sr-only" for="listing-status">Auction status</label>
        <select id="listing-status" class="form-input listing-status" aria-label="Auction status">
          <option value="active" ${listingStatus === "active" ? "selected" : ""}>Active auctions</option>
          <option value="awaiting_payment" ${listingStatus === "awaiting_payment" ? "selected" : ""}>Awaiting payment</option>
          <option value="sold" ${listingStatus === "sold" ? "selected" : ""}>Sold listings</option>
          <option value="all" ${listingStatus === "all" ? "selected" : ""}>All listings</option>
        </select>
      </form>
      <div id="listing-search-alert" class="alert hidden" role="status"></div>

      <div class="product-grid">
        ${items.length
          ? items.map((p) => productCardHtml(p, currentUser)).join("")
          : `<section class="empty-state marketplace-empty">
              <div class="empty-state-icon" aria-hidden="true">
                ${listingSearchTerm
                  ? `<svg viewBox="0 0 32 32" fill="none"><circle cx="14" cy="14" r="8"/><path d="m20 20 6 6M11 14h6"/></svg>`
                  : `<svg viewBox="0 0 32 32" fill="none"><path d="m7 11 9-5 9 5-9 5-9-5Z"/><path d="M7 11v10l9 5 9-5V11M16 16v10M22 8l4-2"/></svg>`}
              </div>
              <div class="empty-state-kicker">${listingSearchTerm ? "SEARCH RESULTS" : "A NEW MARKETPLACE"}</div>
              <h2>${emptyTitle}</h2>
              <p>${emptyDescription}</p>
              ${listingSearchTerm
                ? `<button class="btn btn-outline" id="clear-listing-search" type="button">Clear search</button>`
                : currentUser
                  ? `<a href="#/create" class="btn btn-primary">Create your first listing</a>`
                  : `<a href="#/login" class="btn btn-primary">Sign in to create a listing</a>`}
            </section>`}
      </div>
      ${listingTotal > 20 ? `<nav class="listing-pagination" aria-label="Auction pages">
        <button type="button" class="btn btn-outline btn-sm" data-listing-page="${listingPage - 1}" ${listingPage <= 1 ? "disabled" : ""}>Previous</button>
        <span>Page ${listingPage} of ${pages}</span>
        <button type="button" class="btn btn-outline btn-sm" data-listing-page="${listingPage + 1}" ${listingPage >= pages ? "disabled" : ""}>Next</button>
      </nav>` : ""}
    </div>
  `);

  bindListingSearch();
  $("#clear-listing-search")?.addEventListener("click", () => {
    const input = $("#listing-search-input");
    if (input) input.value = "";
    runListingQuery({ query: "", sort: listingSort, status: listingStatus, page: 1 });
  });
  $$('[data-listing-page]').forEach((button) => button.addEventListener("click", () => {
    runListingQuery({ query: listingSearchTerm, sort: listingSort, status: listingStatus, page: Number(button.dataset.listingPage) });
  }));

  // Wire clicks
  $$(".product-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return;
      const id = card.dataset.id;
      render(`#/biddings/${id}`);
    });
  });
}

function productCardHtml(p, currentUser) {
  const img = (p.images && p.images[0] && p.images[0].url) || "";
  const owner = currentUser && p.adminId === currentUser.id
    ? `<div class="listing-owner-label">Your listing</div>`
    : `<div class="listing-owner-label">Community listing</div>`;
  return `
    <article class="product-card" data-id="${p.id}">
      <div class="product-image">
        ${img ? `<img src="${img}" alt="${escapeHtml(p.title)}">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-subtle);font-size:12px;">No image</div>`}
        ${statusBadge(p.status)}
      </div>
      <div class="product-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div class="product-title">${escapeHtml(p.title)}</div>
          ${timerEl(p.status === "awaiting_payment" ? p.paymentDeadline : p.endsAt, p.status === "awaiting_payment" ? "claim" : p.status)}
        </div>
        ${owner}
        <div class="product-meta">
          <span class="product-price">${formatCurrency(p.currentPrice)}</span>
          <span>${p.bidCount} bid${p.bidCount !== 1 ? "s" : ""}</span>
        </div>
        <div class="product-actions">
          <a href="#/biddings/${p.id}" class="btn btn-outline btn-sm">View</a>
          ${p.status === "active" && (!currentUser || p.adminId !== currentUser.id) ? `<a href="#/biddings/${p.id}?intent=bid" class="btn btn-primary btn-sm">Bid</a>` : ""}
        </div>
      </div>
    </article>
  `;
}

async function renderBiddingDetail(id, focusBid = false) {
  const app = $("#root");
  try {
    const detail = await loadDetail(id);
    if (!detail?.product) throw new Error("Listing details are unavailable. Please return to the auctions and try again.");
    const p = detail.product;
    const bids = detail.recentBids || [];
    const images = (p.images || []).filter((image) => image && image.url).slice(0, 3);
    const minimumBid = Number((Number(p.currentPrice) + 0.01).toFixed(2));
    const canManage = currentUser && (currentUser.role === "admin" || p.adminId === currentUser.id);
    const isOwner = currentUser && p.adminId === currentUser.id;
    const isOpen = p.status === "active" && new Date(p.endsAt) > new Date();
    const isCurrentWinner = currentUser && p.status === "awaiting_payment" && p.winnerId === currentUser.id;

    html(app, `
      <div class="page auction-page">
        <div class="page-header auction-header">
          <a href="#/biddings" class="btn btn-outline btn-sm">Back to auctions</a>
          <span class="auction-breadcrumb">Auction details</span>
          ${canManage ? `
            <button class="btn btn-danger btn-sm" onclick="deleteItem('${p.id}')">Delete</button>
          ` : ""}
        </div>

        <div class="auction-layout">
          <main class="auction-main">
            <section class="detail-hero">
              <div class="auction-gallery">
                ${images.length
                  ? `<img class="auction-primary-image" id="auction-primary-image" src="${escapeHtml(images[0].url)}" alt="${escapeHtml(images[0].alt || p.title)}">`
                  : `<div class="auction-no-image">No image provided</div>`}
                ${statusBadge(p.status)}
              </div>
              ${images.length > 1 ? `
                <div class="auction-thumbnails" aria-label="Item images">
                  ${images.map((image, index) => `
                    <button class="auction-thumbnail ${index === 0 ? "selected" : ""}" type="button"
                      data-image="${escapeHtml(image.url)}" data-alt="${escapeHtml(image.alt || p.title)}"
                      aria-label="Show image ${index + 1}">
                      <img src="${escapeHtml(image.url)}" alt="">
                    </button>
                  `).join("")}
                </div>
              ` : ""}
              <div class="detail-info">
                <div class="auction-kicker">Listed ${formatDate(p.createdAt)}</div>
                <h1 class="detail-title">${escapeHtml(p.title)}</h1>
                <div class="detail-description">${escapeHtml(p.description)}</div>
                <div class="auction-stat-grid">
                  <div class="auction-stat"><span>Starting price</span><strong>${formatCurrency(p.startingPrice)}</strong></div>
                  <div class="auction-stat"><span>Current bid</span><strong>${formatCurrency(p.currentPrice)}</strong></div>
                  <div class="auction-stat"><span>Offers placed</span><strong>${p.bidCount}</strong></div>
                  <div class="auction-stat"><span>Auction ends</span><strong>${formatDate(p.endsAt)}</strong></div>
                </div>
              </div>
            </section>

            <section class="auction-history card">
              <div class="history-heading">
                <div>
                  <h2>Bid activity</h2>
                  <p>The latest ${bids.length} ${bids.length === 1 ? "offer" : "offers"} on this item</p>
                </div>
                <span class="history-count">${p.bidCount} total</span>
              </div>
              ${bids.length ? `
                <div class="bid-activity-list">
                  ${bids.map((bid) => `
                    <div class="bid-activity-row">
                      <span class="bidder-mark" aria-hidden="true">B</span>
                      <div class="bidder-details"><strong>Anonymous bidder</strong><span>${formatDate(bid.createdAt)}</span></div>
                      <strong class="activity-amount">${formatCurrency(bid.amount)}</strong>
                    </div>
                  `).join("")}
                </div>
              ` : `<div class="history-empty">No bids yet. ${isOpen ? "Be the first to make an offer." : "This auction closed without bids."}</div>`}
            </section>
          </main>

          <aside class="bid-card bid-panel">
            <div class="bid-panel-topline">
              <span class="auction-live-dot ${isOpen ? "is-live" : ""}"></span>
              <span>${isOpen ? "Auction is live" : p.status === "awaiting_payment" ? "Winner payment window" : "Auction closed"}</span>
              <span class="bid-panel-timer">${timerEl(p.status === "awaiting_payment" ? p.paymentDeadline : p.endsAt, p.status === "awaiting_payment" ? "claim" : p.status)}</span>
            </div>
            <div class="bid-price-label">Current bid</div>
            <div class="bid-current auction-price">${formatCurrency(p.currentPrice)}</div>
            <div class="bid-hint">${p.bidCount} ${p.bidCount === 1 ? "offer" : "offers"} · Starting at ${formatCurrency(p.startingPrice)}</div>
            ${p.status === "awaiting_payment" ? `
              <div class="bid-state-note" role="status">
                <strong>${isCurrentWinner ? "You are the current winning bidder." : "The leading bidder has 72 hours to complete this step."}</strong>
                <div>If the payment deadline expires, the next-highest eligible bidder receives a fresh 72-hour window.</div>
                ${!currentUser ? `<a href="#/login?returnTo=${encodeURIComponent(location.hash)}" class="text-link">Sign in to check whether you are the winner</a>` : ""}
                ${isCurrentWinner ? `<button id="demo-payment-confirm" class="btn btn-primary btn-full" type="button">Mark demo payment complete</button><div id="demo-payment-alert" class="alert hidden" role="status"></div>` : ""}
              </div>
            ` : ""}
            ${isOpen && currentUser && !isOwner ? `
              <form id="bid-form" class="bid-form">
                <input type="hidden" name="bidProductId" value="${p.id}">
                <div class="form-group">
                  <label class="form-label" for="bid-amount">Your offer</label>
                  <div class="bid-input-wrap"><span>₹</span><input id="bid-amount" type="number" name="bidAmount" class="form-input" step="0.01" min="${minimumBid.toFixed(2)}" value="${minimumBid.toFixed(2)}" required></div>
                  <div class="bid-minimum">Minimum offer: <strong>${formatCurrency(minimumBid)}</strong></div>
                </div>
                <button class="btn btn-primary btn-full bid-submit" type="submit">Place bid</button>
                <div id="bid-alert" class="alert hidden" role="status"></div>
              </form>
            ` : `
              <div class="bid-state-note">
                ${!currentUser && isOpen ? "Sign in to make an offer on this item." : isOwner && isOpen ? "You listed this item and cannot bid on your own auction." : isOpen ? "This auction is open for offers." : "Bidding has ended for this item."}
              </div>
              ${!currentUser && isOpen ? `<a href="#/login?returnTo=${encodeURIComponent(location.hash)}" class="btn btn-primary btn-full bid-submit">Sign in to bid</a>` : ""}
            `}
            <div class="bid-secure-note">The winning bidder has 72 hours to complete payment. If payment fails or the deadline expires, the second-highest bidder receives a new 72-hour payment window.</div>
          </aside>
        </div>
      </div>
    `);

    $("form#bid-form")?.addEventListener("submit", handlePlaceBid);
    $("#demo-payment-confirm")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "Confirming…";
      try {
        const { data } = await api(`/api/biddings/${p.id}/demo-payment`, { method: "POST", body: "{}" });
        await loadBiddings();
        await renderBiddingDetail(p.id);
      } catch (error) {
        showAlert("demo-payment-alert", error.message, "error");
        button.disabled = false;
        button.textContent = "Mark demo payment complete";
      }
    });
    if (focusBid) {
      const bidInput = $("#bid-amount");
      if (bidInput) {
        bidInput.focus({ preventScroll: true });
        bidInput.select();
      }
    }
    $$(".auction-thumbnail").forEach((thumbnail) => {
      thumbnail.addEventListener("click", () => {
        const mainImage = $("#auction-primary-image");
        if (!mainImage) return;
        mainImage.src = thumbnail.dataset.image;
        mainImage.alt = thumbnail.dataset.alt;
        $$(".auction-thumbnail").forEach((item) => item.classList.remove("selected"));
        thumbnail.classList.add("selected");
      });
    });

    // ---------- Real-Time Live Bidding Stream (SSE) ----------
    if (activeLiveEventSource) {
      activeLiveEventSource.close();
      activeLiveEventSource = null;
    }

    try {
      activeLiveEventSource = new EventSource(`${API}/api/biddings/${p.id}/live`);

      activeLiveEventSource.addEventListener("bid_placed", (event) => {
        try {
          const liveData = JSON.parse(event.data);
          // Flash and update current bid price
          const priceDisplay = $(".bid-current.auction-price");
          if (priceDisplay) {
            priceDisplay.textContent = formatCurrency(liveData.currentPrice);
            priceDisplay.classList.remove("price-flash");
            void priceDisplay.offsetWidth; // Reflow to re-trigger animation
            priceDisplay.classList.add("price-flash");
          }

          // Update offer count text
          const hint = $(".bid-hint");
          if (hint) {
            hint.textContent = `${liveData.bidCount} ${liveData.bidCount === 1 ? "offer" : "offers"} · Starting at ${formatCurrency(p.startingPrice)}`;
          }
          const historyCount = $(".history-count");
          if (historyCount) historyCount.textContent = `${liveData.bidCount} total`;

          // Update minimum offer input if user is about to bid
          const bidInput = $("#bid-amount");
          const nextMinimum = Number((Number(liveData.currentPrice) + 0.01).toFixed(2));
          if (bidInput) {
            bidInput.min = nextMinimum.toFixed(2);
            if (Number(bidInput.value) <= liveData.currentPrice) {
              bidInput.value = nextMinimum.toFixed(2);
            }
          }
          const minDisplay = $(".bid-minimum strong");
          if (minDisplay) minDisplay.textContent = formatCurrency(nextMinimum);

          // Add new row to bid activity list dynamically without reload
          const activityList = $(".bid-activity-list");
          const emptyState = $(".history-empty");
          if (liveData.bid) {
            if (emptyState) emptyState.remove();
            let container = activityList;
            if (!container) {
              const historyCard = $(".auction-history");
              if (historyCard) {
                container = document.createElement("div");
                container.className = "bid-activity-list";
                historyCard.appendChild(container);
              }
            }
            if (container) {
              const row = document.createElement("div");
              row.className = "bid-activity-row live-new-row";
              row.innerHTML = `
                <span class="bidder-mark" aria-hidden="true">B</span>
                <div class="bidder-details"><strong>${escapeHtml(liveData.bid.bidderName || "Anonymous bidder")}</strong><span>${formatDate(liveData.bid.createdAt)}</span></div>
                <strong class="activity-amount">${formatCurrency(liveData.bid.amount)}</strong>
              `;
              container.prepend(row);
            }
          }
        } catch (parseErr) {
          console.error("Live stream parse error:", parseErr);
        }
      });

      activeLiveEventSource.addEventListener("auction_settled", () => {
        renderBiddingDetail(p.id);
      });
      activeLiveEventSource.addEventListener("winner_advanced", () => {
        renderBiddingDetail(p.id);
      });
    } catch (sseErr) {
      console.warn("Could not establish live SSE connection:", sseErr);
    }
  } catch (err) {
    html(app, `<div class="page"><div class="empty-state"><h3>Couldn’t load this listing</h3><p>${escapeHtml(err.message)}</p><button id="retry-listing" class="btn btn-primary" type="button">Try again</button></div></div>`);
    $("#retry-listing")?.addEventListener("click", () => renderBiddingDetail(id, focusBid));
  }
}
function renderCreatePage() {
  const app = $("#root");
  html(app, `
    <div class="page">
      <div class="page-header">
        <a href="#/biddings" class="btn btn-outline btn-sm">← Back</a>
        <div class="page-title">List a Bidding Item</div>
      </div>
      <div class="form-card" style="max-width:720px;">
        <form id="create-form">
          <div class="form-group">
            <label class="form-label">Title</label>
            <input type="text" name="title" class="form-input" placeholder="e.g. Vintage Leather Jacket" required>
          </div>

          <div class="form-group">
            <label class="form-label">Description (min 50 words)</label>
            <textarea name="description" class="form-textarea" required></textarea>
            <span class="word-counter warn" id="create-word-counter" aria-live="polite">50 words left to minimum</span>
          </div>

          <div class="form-group">
            <label class="form-label" for="create-images">Item photos (2–3 images)</label>
            <input id="create-images" type="file" name="images" class="form-input image-file-input" accept="image/jpeg,image/png,image/webp" multiple required>
            <div class="image-input-hint" id="image-upload-status" aria-live="polite">Select 2 or 3 JPG, PNG, or WebP images from your computer. Maximum 5 MB each.</div>
            <div class="image-upload-preview" id="image-upload-preview"></div>
          </div>

          <div class="form-group">
            <label class="form-label">Starting Price (₹)</label>
            <input type="number" name="startingPrice" class="form-input" step="0.01" min="0" required>
          </div>

          <div class="form-group">
            <label class="form-label">Ends At</label>
            <input type="datetime-local" name="endsAt" class="form-input" required>
          </div>

          <div class="form-group mt-16">
            <button class="btn btn-primary btn-full" type="submit">List Item</button>
          </div>
          <div id="create-alert" class="alert hidden"></div>
        </form>
      </div>
    </div>
  `);

  setupWordCounter("textarea[name=description]", "create-word-counter");
  setupImagePicker();
  $("form#create-form")?.addEventListener("submit", handleCreateBidding);
}

async function renderMyBidsPage() {
  const app = $("#root");
  const items = await loadMyBids();
  html(app, `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-title">My Listings</div>
          <div class="page-subtitle">Auctions you have created</div>
        </div>
        <a href="#/create" class="btn btn-primary">Create listing</a>
      </div>
      <div class="product-grid">
        ${items.length ? items.map((p) => productCardHtml(p, currentUser)).join("") : `<div class="empty-state"><h3>No listings yet</h3><p>Your auctions will appear here after you create one.</p><a href="#/create" class="btn btn-primary">Create a listing</a></div>`}
      </div>
    </div>
  `);
}

window.deleteItem = async (id) => {
  if (!confirm("Delete this item and all its bids? This cannot be undone.")) return;
  try {
    await api(`/api/biddings/${id}`, { method: "DELETE" });
    await loadBiddings();
    render("#/biddings");
  } catch (err) {
    alert(err.message);
  }
};

window.editItem = (id) => {
  render(`#/edit/${id}`);
};

// ---------- Auth page helpers ----------
function setupAuthForm(kind, handler) {
  const form = $(`form[name=${kind}]`);
  if (form) form.addEventListener("submit", handler);
}

function showAlert(id, message, type) {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = message;
  el.className = `alert alert-${type}`;
  show(el);
  setTimeout(() => hide(el), 5000);
}

function loginPage() {
  return `
    <main class="login-layout">
      <section class="login-intro">
        <a class="login-brand" href="#/login" aria-label="Bidroom home"><span class="login-logo-image"><img src="../bids.jpg" alt="Bidroom"></span></a>
        <div class="login-copy">
          <div class="eyebrow">A better way to buy and sell</div>
          <h1>Good things find<br>their next owner.</h1>
          <p>Discover considered pieces, follow every offer, and place your bid with confidence.</p>
          <a class="text-link" href="#/biddings">Explore live auctions <span aria-hidden="true">→</span></a>
        </div>
        <div class="login-footnote">A considered marketplace for things worth keeping.</div>
      </section>
      <section class="login-panel">
        <div class="login-panel-inner">
          <div class="auth-context"><span>MEMBER ACCESS</span><span class="auth-context-rule" aria-hidden="true"></span></div>
          <div class="auth-title">Welcome back</div>
          <div class="auth-subtitle">Sign in to place a bid and follow your auctions.</div>
          <form name="login">
            <div class="form-group">
              <label class="form-label" for="login-email">Email address</label>
              <input id="login-email" type="email" name="email" class="form-input" autocomplete="email" required>
            </div>
            <div class="form-group">
              <div class="password-label-row"><label class="form-label" for="login-password">Password</label><a href="#/forgot-password">Forgot password?</a></div>
              <input id="login-password" type="password" name="password" class="form-input" autocomplete="current-password" required>
            </div>
            <button class="btn btn-primary btn-full" type="submit">Sign in</button>
            <div id="login-alert" class="alert hidden" role="status"></div>
          </form>
          <div class="login-register">New to Bidroom? <a href="#/register">Create an account</a></div>
          <a class="login-browse-mobile" href="#/biddings">Browse auctions</a>
      </div>
      </section>
    </main>
  `;
}

function passwordRecoveryPage(mode) {
  const isReset = mode === "reset";
  const formName = isReset ? "reset-password" : "forgot-password";
  return `
    <main class="login-layout recovery-layout">
      <section class="login-intro">
        <a class="login-brand" href="#/login" aria-label="Bidroom home"><span class="login-logo-image"><img src="../bids.jpg" alt="Bidroom"></span></a>
        <div class="login-copy">
          <div class="eyebrow">Account security</div>
          <h1>${isReset ? "Choose a new password." : "Back to the good stuff."}</h1>
          <p>${isReset ? "Set a new password to secure your account and continue bidding." : "We’ll send a secure, one-time link to the email address on your account."}</p>
        </div>
        <div class="login-footnote">Your account stays yours.</div>
      </section>
      <section class="login-panel">
        <div class="login-panel-inner">
          <div class="auth-context"><span>ACCOUNT SECURITY</span><span class="auth-context-rule" aria-hidden="true"></span></div>
          <div class="auth-title">${isReset ? "Reset password" : "Forgot your password?"}</div>
          <div class="auth-subtitle">${isReset ? "Use a password with at least 12 characters." : "Enter your email and we’ll help you get back in."}</div>
          <form name="${formName}">
            ${isReset ? "" : `<div class="form-group"><label class="form-label" for="recovery-email">Email address</label><input id="recovery-email" type="email" name="email" class="form-input" autocomplete="email" required></div>`}
            ${isReset ? `<div class="form-group"><label class="form-label" for="new-password">New password</label><input id="new-password" type="password" name="newPassword" class="form-input" autocomplete="new-password" minlength="12" maxlength="128" required></div>` : ""}
            <button class="btn btn-primary btn-full" type="submit">${isReset ? "Update password" : "Send reset link"}</button>
            <div id="${isReset ? "reset-password" : "forgot-password"}-alert" class="alert hidden" role="status"></div>
          </form>
          <div class="login-register"><a href="#/login">Back to sign in</a></div>
        </div>
      </section>
    </main>
  `;
}

function registerPage() {
  return `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-title">Create account</div>
        <div class="auth-subtitle">Join the bidding platform.</div>
        <form name="register">
          <div class="form-group">
            <label class="form-label">Full Name</label>
            <input type="text" name="name" class="form-input" required>
          </div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input type="email" name="email" class="form-input" required>
          </div>
          <div class="form-group">
            <label class="form-label">Password (12+ chars)</label>
            <input type="password" name="password" class="form-input" required>
          </div>
          <button class="btn btn-primary btn-full mt-16" type="submit">Create account</button>
          <div id="register-alert" class="alert hidden"></div>
        </form>
        <div class="divider"><span>Already have an account?</span></div>
        <a href="#/login" class="btn btn-outline btn-full mt-8">Sign in</a>
      </div>
    </div>
  `;
}

// ---------- Boot ----------
function render(hash) {
  if (hash && location.hash !== hash) {
    location.hash = hash;
  }
  // The initial URL may not contain a hash (for example /client/index.html).
  // Choose a useful landing page after initAuth has restored the saved session.
  // Render immediately after setting it; do not depend on hashchange firing
  // later for programmatic navigation after login or form submission.
  if (!location.hash) {
    location.hash = currentUser ? "#/biddings" : "#/login";
  }
  hash = location.hash;
  renderPage(hash);
}

window.addEventListener("hashchange", () => render());

// Let the existing background grid respond quietly to mouse movement.
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let pointerX = window.innerWidth / 2;
  let pointerY = window.innerHeight * 0.4;
  let pointerFrame = 0;
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (pointerFrame) return;
    pointerFrame = window.requestAnimationFrame(() => {
      document.documentElement.style.setProperty("--pointer-x", `${pointerX}px`);
      document.documentElement.style.setProperty("--pointer-y", `${pointerY}px`);
      pointerFrame = 0;
    });
  }, { passive: true });
}

window.addEventListener("DOMContentLoaded", async () => {
  let verificationNotice = null;
  const pathVerification = location.pathname === "/verify-email";
  const hashVerification = location.hash.startsWith("#/verify-email");
  if (pathVerification || hashVerification) {
    const token = pathVerification
      ? new URLSearchParams(location.search).get("token")
      : new URLSearchParams(location.hash.split("?")[1] || "").get("token");
    try {
      if (!token) throw new Error("Verification link is missing its token.");
      const { data } = await api("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token })
      });
      verificationNotice = { message: data.message, type: "success" };
    } catch (err) {
      verificationNotice = { message: err.message, type: "error" };
    }
    if (pathVerification) history.replaceState(null, "", "/#/login");
    else location.hash = "#/login";
  }
  await initAuth();
  await loadBiddings();
  render();
  if (verificationNotice) {
    showAlert("login-alert", verificationNotice.message, verificationNotice.type);
  }
  // Hook global logout
  $("#btn-logout")?.addEventListener("click", handleLogout);
  // Refresh auction prices, bid activity, and countdowns while a page is open.
  setInterval(async () => {
    if (location.hash === "#/biddings") {
      await runListingQuery({ query: listingSearchTerm, sort: listingSort, status: listingStatus, page: listingPage });
      return;
    }
    if (location.hash === "#/mybids") {
      await loadBiddings();
      render();
      return;
    }
    const detailRoute = location.hash.match(/^#\/biddings\/([^/]+)$/);
    if (detailRoute) await renderBiddingDetail(detailRoute[1]);
  }, 30000);
});
