/**
 * Choudhary Paper Tube & Packaging — backend
 * Node.js + Express + SQLite (node:sqlite, built into Node 22.5+).
 * All data lives in one SQLite file (see config.server.dbFile).
 *
 * Pricing rule: the SERVER is the price authority. The client sends only
 * { sku, qty }; every price is re-looked-up from products.json here.
 * (Quote-converted draft orders are the only exception: their line price
 * comes from the admin-approved quote stored server-side.)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

const app = express();
app.use(express.json({ limit: "256kb" }));

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
/* Two backends, same synchronous API:
 * - Turso cloud (libsql package) when TURSO_DATABASE_URL +
 *   TURSO_AUTH_TOKEN are set — data survives Render free-tier restarts.
 * - Local file via node:sqlite otherwise (unchanged original behaviour).
 * The libsql sync API mirrors node:sqlite (prepare/get/all/run/exec,
 * { changes, lastInsertRowid } from run()) with ONE difference: rows
 * carry an extra `_metadata` field. The thin wrapper below strips it so
 * every response stays identical to the local-file path. */
let db;
if (config.turso && config.turso.url && config.turso.authToken) {
  const LibsqlDatabase = require("libsql");
  const rawDb = new LibsqlDatabase(config.turso.url, { authToken: config.turso.authToken });
  const stripMeta = (row) => {
    if (row && typeof row === "object") delete row._metadata;
    return row;
  };
  db = {
    exec: (sql) => rawDb.exec(sql),
    prepare: (sql) => {
      const stmt = rawDb.prepare(sql);
      return {
        get: (...args) => stripMeta(stmt.get(...args)),
        all: (...args) => stmt.all(...args).map(stripMeta),
        run: (...args) => stmt.run(...args),
      };
    },
  };
  console.log("Database: Turso cloud (persistent across restarts).");
} else {
  const dbFile = path.resolve(__dirname, config.server.dbFile);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new DatabaseSync(dbFile);
  console.log(`Database: local file ${dbFile}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS visitors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    entered_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    current_page TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number       TEXT UNIQUE NOT NULL,
    visitor_id         INTEGER,
    name               TEXT NOT NULL,
    phone              TEXT NOT NULL,
    address            TEXT NOT NULL,
    city               TEXT NOT NULL,
    pincode            TEXT NOT NULL,
    fulfillment        TEXT NOT NULL DEFAULT 'delivery',
    items_json         TEXT NOT NULL,
    subtotal           REAL NOT NULL,
    delivery           REAL NOT NULL,
    total              REAL NOT NULL,
    status             TEXT NOT NULL DEFAULT 'New',
    payment_status     TEXT NOT NULL DEFAULT 'pending',
    razorpay_order_id  TEXT,
    razorpay_payment_id TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quote_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_number TEXT UNIQUE NOT NULL,
    visitor_id   INTEGER,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    product_type TEXT NOT NULL,
    dimensions   TEXT NOT NULL,
    quantity     TEXT NOT NULL,
    notes        TEXT DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'New',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draft_orders (
    token      TEXT PRIMARY KEY,
    quote_id   INTEGER,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    item_label TEXT NOT NULL,
    price      REAL NOT NULL,
    qty        INTEGER NOT NULL DEFAULT 1,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocks (
    phone      TEXT PRIMARY KEY,
    reason     TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL DEFAULT '',
    email         TEXT UNIQUE NOT NULL,
    phone         TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_visitors_seen ON visitors(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
`);
// Migration for DBs created before the fulfillment column existed.
try { db.exec("ALTER TABLE orders ADD COLUMN fulfillment TEXT NOT NULL DEFAULT 'delivery'"); } catch (e) { /* already there */ }
// Migration: optional email on the entry gate.
try { db.exec("ALTER TABLE visitors ADD COLUMN email TEXT DEFAULT ''"); } catch (e) { /* already there */ }
// Migration: GST amount stored per order (2026-10-27). Orders placed before
// this fix have gst_amount = 0; buildInvoice falls back to the legacy
// computation for those so their invoices stay as originally issued.
try { db.exec("ALTER TABLE orders ADD COLUMN gst_amount REAL NOT NULL DEFAULT 0"); } catch (e) { /* already there */ }

const nowIso = () => new Date().toISOString();
const PHONE_RE = /^[6-9]\d{9}$/; // 10-digit Indian mobile
const ORDER_STATUSES = ["New", "Confirmed", "Packed", "Dispatched", "Delivered", "Cancelled"];
const QUOTE_STATUSES = ["New", "Quoted", "Converted", "Rejected"];

/* ------------------------------------------------------------------ */
/* Catalog (data-driven from products.json — single source of truth)   */
/* ------------------------------------------------------------------ */
const CATALOG_PATH = path.join(__dirname, "products.json");
function loadCatalog() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  const bySku = new Map();
  for (const p of catalog.products) {
    for (const v of p.variants) bySku.set(v.sku, { product: p, variant: v });
  }
  return { catalog, bySku };
}
function saveCatalog(catalog) {
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}

/** GST on a subtotal: catalog prices are GST-exclusive, GST is added on top. */
function gstOn(subtotal) {
  const rate = Number(config.business.gst_rate) || 0;
  return Math.round(subtotal * rate / 100 * 100) / 100;
}

/** Recompute an order's lines + totals from SKUs only. Throws on bad input. */
function priceOrder(items, fulfillment) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("Cart is empty.");
  if (items.length > 100) throw new Error("Too many line items.");
  if (!["pickup", "delivery"].includes(fulfillment)) throw new Error("Bad fulfillment method.");
  const { bySku } = loadCatalog();
  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    const qty = Number(it.qty);
    if (!it.sku || !bySku.has(it.sku)) throw new Error(`Unknown item: ${it.sku}`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new Error(`Bad quantity for ${it.sku}`);
    const { product, variant } = bySku.get(it.sku);
    const lineTotal = Math.round(variant.price * qty * 100) / 100;
    subtotal += lineTotal;
    lines.push({
      sku: variant.sku, name: product.name, variant_label: variant.label,
      unit: variant.unit, price: variant.price, qty, line_total: lineTotal,
    });
  }
  subtotal = Math.round(subtotal * 100) / 100;
  // Delivery rule: pickup is always free; delivery costs config charge below free_above.
  const delivery = fulfillment === "pickup" ? 0
    : (subtotal >= config.delivery.free_above ? 0 : config.delivery.charge);
  // GST is charged on the subtotal and included in the payable total, so the
  // amount collected via Razorpay always matches the invoice grand total.
  const gst = gstOn(subtotal);
  const total = Math.round((subtotal + gst + delivery) * 100) / 100;
  return { lines, subtotal, gst, delivery, total };
}

/** Decrement stock for purchased SKUs (best-effort, after successful payment). */
function decrementStock(lines) {
  try {
    const catalog = loadCatalog().catalog;
    let changed = false;
    for (const line of lines) {
      if (!line.sku) continue; // draft/quote lines have no sku
      for (const p of catalog.products) {
        const v = p.variants.find((x) => x.sku === line.sku);
        if (v && typeof v.stock === "number") {
          v.stock = Math.max(0, v.stock - line.qty);
          changed = true;
        }
      }
    }
    if (changed) saveCatalog(catalog);
  } catch (e) { console.error("stock decrement failed:", e.message); }
}

/* ------------------------------------------------------------------ */
/* Razorpay (real flow; mock mode when config.razorpay.mock is true)    */
/* ------------------------------------------------------------------ */
const rzpMock = () => config.razorpay.mock === true;
function mockId(prefix) {
  return `${prefix}_mock_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
async function createRazorpayOrder(amountInr, receipt) {
  if (rzpMock()) {
    return { id: mockId("order"), amount: Math.round(amountInr * 100), currency: "INR", mock: true };
  }
  const auth = Buffer.from(`${config.razorpay.key_id}:${config.razorpay.key_secret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Math.round(amountInr * 100),
      currency: "INR",
      receipt: receipt.slice(0, 40),
      notes: { store: config.business.name },
    }),
  });
  if (!res.ok) throw new Error(`Razorpay order failed (${res.status}): ${await res.text()}`);
  return await res.json();
}
function verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  if (rzpMock()) {
    return (
      typeof razorpayOrderId === "string" && razorpayOrderId.startsWith("order_mock_") &&
      typeof razorpayPaymentId === "string" && razorpayPaymentId.startsWith("pay_mock_") &&
      razorpaySignature === "mock"
    );
  }
  const expected = crypto.createHmac("sha256", config.razorpay.key_secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(String(razorpaySignature || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
app.get("/api/config-public", (req, res) => {
  res.json({
    business: config.business,
    razorpay: { key_id: config.razorpay.key_id, mock: rzpMock() },
    delivery: config.delivery,
  });
});

/* Transient-failure retry for the announcement settings read.
 * Turso/libsql hiccups are usually momentary, so before degrading to
 * the empty banner we try up to 3 times (backoff ~150ms, then ~400ms).
 * Scope: this is the only settings read in the codebase, and every
 * other route calls db.prepare ad hoc with its own call shape — there
 * is no shared read helper to extend without changing behaviour
 * elsewhere, so the retry lives here only. */
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readAnnouncementValue() {
  const delays = [150, 400]; // wait before retry 1 and retry 2
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'announcement'").get();
      if (attempt > 0) console.log(`announcement recovered on retry ${attempt}`);
      return row ? row.value : undefined;
    } catch (e) {
      lastErr = e;
      if (attempt < delays.length) await sleepMs(delays[attempt]);
    }
  }
  throw lastErr;
}

app.get("/api/announcement", async (req, res) => {
  // Never 500: the storefront loads this at boot, so any failure here
  // (DB hiccup included) must degrade to "no announcement", not an error.
  // The read retries briefly first (see readAnnouncementValue above).
  try {
    const value = await readAnnouncementValue();
    if (value === undefined) return res.json({ en: "", hi: "" });
    try { res.json(JSON.parse(value)); }
    catch (e) {
      console.error("GET /api/announcement: stored value is not valid JSON, serving empty banner:", e.message);
      res.json({ en: "", hi: "" });
    }
  } catch (e) {
    console.error("GET /api/announcement failed, serving empty banner:", e && e.message ? e.message : e);
    res.json({ en: "", hi: "" });
  }
});

app.get("/api/products", (req, res) => {
  try { res.json(loadCatalog().catalog); }
  catch (e) { res.status(500).json({ error: "Could not load catalog." }); }
});

function isBlocked(phone) {
  return !!db.prepare("SELECT 1 FROM blocks WHERE phone = ?").get(phone);
}

/* ------------------------------------------------------------------ */
/* Login OTP (compulsory since 2026-10-23). In-memory store: fine for  */
/* a single-instance shop server. config.otp.mode "demo" shows the    */
/* code on the login screen (no SMS); "live" sends via MSG91.          */
/* ------------------------------------------------------------------ */
const otpStore = new Map(); // phone -> { code, expiresAt, tries, lastSentAt, sends[], pass, passExpiresAt }
const OTP_TTL_MS = 5 * 60 * 1000, OTP_RESEND_MS = 30 * 1000, OTP_MAX_SENDS = 4, OTP_WINDOW_MS = 15 * 60 * 1000;

async function sendOtpSms(phone, code) {
  const m = (config.otp && config.otp.msg91) || {};
  if (!m.authKey || !m.templateId) throw new Error("MSG91 is not configured.");
  const url = "https://control.msg91.com/api/v5/otp?template_id=" + encodeURIComponent(m.templateId)
    + "&mobile=91" + phone + "&otp=" + code + (m.senderId ? "&sender=" + encodeURIComponent(m.senderId) : "");
  const r = await fetch(url, { method: "POST", headers: { authkey: m.authKey, "Content-Type": "application/json" }, body: JSON.stringify({}) });
  if (!r.ok) throw new Error("SMS gateway error " + r.status);
}

app.post("/api/otp/send", async (req, res) => {
  if (!config.otp || config.otp.enabled === false) return res.status(400).json({ error: "otp_off", message: "OTP login is off." });
  const phone = String(req.body.phone || "").trim().replace(/[\s-]/g, "");
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: "phone", message: "Enter a valid 10-digit mobile number." });
  if (isBlocked(phone)) return res.status(403).json({ error: "blocked", message: "Please contact the shop directly." });
  const now = Date.now();
  let rec = otpStore.get(phone);
  if (!rec) { rec = { sends: [] }; otpStore.set(phone, rec); }
  rec.sends = (rec.sends || []).filter((t) => now - t < OTP_WINDOW_MS);
  if (rec.lastSentAt && now - rec.lastSentAt < OTP_RESEND_MS) return res.status(429).json({ error: "wait", message: "Thoda ruko — OTP abhi bheja tha. 30 second baad dobara try karo." });
  if (rec.sends.length >= OTP_MAX_SENDS) return res.status(429).json({ error: "limit", message: "Bahut baar OTP maang liya. Kuch der baad try karo." });
  const code = String(crypto.randomInt(100000, 1000000));
  const live = config.otp.mode === "live";
  if (live) { try { await sendOtpSms(phone, code); } catch (e) { return res.status(502).json({ error: "sms", message: "OTP SMS nahi ja paya. Dobara try karo." }); } }
  rec.code = code; rec.expiresAt = now + OTP_TTL_MS; rec.tries = 0; rec.lastSentAt = now; rec.sends.push(now); rec.pass = ""; rec.passExpiresAt = 0;
  res.json(live ? { ok: true, demo: false } : { ok: true, demo: true, otp: code });
});

app.post("/api/otp/verify", (req, res) => {
  const phone = String(req.body.phone || "").trim().replace(/[\s-]/g, "");
  const otp = String(req.body.otp || "").trim();
  const rec = otpStore.get(phone);
  if (!rec || !rec.code) return res.status(400).json({ error: "no_otp", message: "Pehle OTP bhejo." });
  if (Date.now() > rec.expiresAt) { rec.code = ""; return res.status(400).json({ error: "expired", message: "OTP expire ho gaya. Naya OTP bhejo." }); }
  rec.tries = (rec.tries || 0) + 1;
  if (rec.tries > 5) { rec.code = ""; return res.status(400).json({ error: "tries", message: "Bahut galat koshish. Naya OTP bhejo." }); }
  if (otp !== rec.code) return res.status(400).json({ error: "wrong", message: "OTP galat hai. Dobara check karo." });
  rec.code = "";
  rec.pass = crypto.randomBytes(16).toString("hex");
  rec.passExpiresAt = Date.now() + 10 * 60 * 1000;
  res.json({ ok: true, pass: rec.pass });
});

// Entry gate: name + 10-digit mobile + verified OTP pass. One row per entry (visitor register).
app.post("/api/gate", (req, res) => {
  const name = String(req.body.name || "").trim();
  const phone = String(req.body.phone || "").trim().replace(/[\s-]/g, "");
  const email = String(req.body.email || "").trim().slice(0, 120);
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "name", message: "Please enter your name." });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: "phone", message: "Enter a valid 10-digit mobile number." });
  if (config.otp && config.otp.enabled !== false) {
    const rec = otpStore.get(phone);
    const pass = String(req.body.pass || "");
    if (!rec || !rec.pass || pass !== rec.pass || Date.now() > rec.passExpiresAt) {
      return res.status(403).json({ error: "otp", message: "Please verify the OTP sent to your mobile first." });
    }
    rec.pass = ""; rec.passExpiresAt = 0; // one-time use
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "email", message: "Please enter a valid email address." });
  if (isBlocked(phone)) {
    return res.status(403).json({
      error: "blocked",
      message: "Please contact the shop directly.",
      message_hi: "कृपया सीधे दुकान से संपर्क करें।",
    });
  }
  const t = nowIso();
  const r = db.prepare(
    "INSERT INTO visitors (name, phone, email, entered_at, last_seen_at, current_page) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(name, phone, email, t, t, "gate");
  res.json({ visitor_id: r.lastInsertRowid, name, phone, email });
});

/* ------------------------------------------------------------------ */
/* Optional customer accounts (email + password). Login is OPTIONAL:   */
/* guests (name+phone gate) and full skips can shop and check out too. */
/* Passwords are stored only as scrypt hashes, never in plain text.    */
/* ------------------------------------------------------------------ */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, nowIso());
  return token;
}
function userFromToken(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const row = db.prepare(
    "SELECT u.id, u.name, u.email, u.phone FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
  ).get(token);
  return row || null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/api/auth/register", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const phone = String(req.body.phone || "").trim().replace(/[\s-]/g, "");
  const password = String(req.body.password || "");
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (name && name.length < 2) return res.status(400).json({ error: "Please enter your name." });
  if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
  if (isBlocked(phone)) return res.status(403).json({ error: "Please contact the shop directly." });
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    return res.status(409).json({ error: "This email is already registered. Please login." });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const r = db.prepare("INSERT INTO users (name, email, phone, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, email, phone, hashPassword(password, salt), salt, nowIso());
  const user = { id: r.lastInsertRowid, name, email, phone };
  res.json({ ok: true, token: createSession(user.id), user });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!row) return res.status(401).json({ error: "No account found for this email. Please create an account first." });
  const candidate = Buffer.from(hashPassword(password, row.salt), "hex");
  const stored = Buffer.from(row.password_hash, "hex");
  if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) {
    return res.status(401).json({ error: "Wrong password. Please try again." });
  }
  const user = { id: row.id, name: row.name, email: row.email, phone: row.phone };
  res.json({ ok: true, token: createSession(user.id), user });
});

app.get("/api/auth/me", (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  res.json({ ok: true, user });
});

app.post("/api/auth/logout", (req, res) => {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.json({ ok: true });
});

app.post("/api/heartbeat", (req, res) => {
  const visitorId = Number(req.body.visitor_id);
  const page = String(req.body.page || "").slice(0, 120);
  if (!Number.isInteger(visitorId) || visitorId < 1) return res.status(400).json({ error: "Bad visitor_id." });
  const r = db.prepare("UPDATE visitors SET last_seen_at = ?, current_page = ? WHERE id = ?").run(nowIso(), page, visitorId);
  if (r.changes === 0) return res.status(404).json({ error: "Visitor not found." });
  res.json({ ok: true });
});

function makeOrderNumber() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `CPT-${ymd}-${Math.floor(1000 + Math.random() * 9000)}`;
}
function makeQuoteNumber() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `Q-${ymd}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Create order: validates input, prices server-side, creates Razorpay order.
app.post("/api/orders", async (req, res) => {
  try {
    const { visitor_id, name, phone, address, city, pincode, items, fulfillment, draft_token } = req.body;
    const cleanName = String(name || "").trim();
    const cleanPhone = String(phone || "").trim().replace(/[\s-]/g, "");
    const ff = fulfillment === "pickup" ? "pickup" : "delivery";
    if (cleanName.length < 2 || cleanName.length > 80) throw new Error("Please enter your name.");
    if (!PHONE_RE.test(cleanPhone)) throw new Error("Enter a valid 10-digit mobile number.");
    if (isBlocked(cleanPhone)) throw new Error("Please contact the shop directly.");

    let lines, subtotal, gst, delivery, total, draftRow = null;

    if (draft_token) {
      // Quote-converted draft order: line comes from the admin-approved quote.
      draftRow = db.prepare("SELECT * FROM draft_orders WHERE token = ?").get(String(draft_token));
      if (!draftRow) throw new Error("This order link is invalid.");
      if (draftRow.used) throw new Error("This order link has already been used.");
      const qty = Math.max(1, Math.min(10000, Number(draftRow.qty) || 1));
      const lineTotal = Math.round(draftRow.price * qty * 100) / 100;
      lines = [{ sku: null, name: draftRow.item_label, variant_label: "Custom quote", unit: "lot", price: draftRow.price, qty, line_total: lineTotal }];
      subtotal = lineTotal;
      delivery = ff === "pickup" ? 0 : (subtotal >= config.delivery.free_above ? 0 : config.delivery.charge);
      gst = gstOn(subtotal);
      total = Math.round((subtotal + gst + delivery) * 100) / 100;
    } else {
      ({ lines, subtotal, gst, delivery, total } = priceOrder(items, ff));
    }

    // Address only needed for delivery; pickup shows the shop address instead.
    const cleanAddr = String(address || "").trim();
    const cleanCity = String(city || "").trim();
    const cleanPin = String(pincode || "").trim().replace(/[\s-]/g, "");
    if (ff === "delivery") {
      if (cleanAddr.length < 8) throw new Error("Please enter your full delivery address.");
      if (cleanCity.length < 2) throw new Error("Please enter your city.");
      if (!/^\d{6}$/.test(cleanPin)) throw new Error("Enter a valid 6-digit pincode.");
    }

    const orderNumber = makeOrderNumber(); // UNIQUE constraint guards collisions
    const rzpOrder = await createRazorpayOrder(total, orderNumber);
    const t = nowIso();
    let orderId;
    try {
      const r = db.prepare(`INSERT INTO orders
        (order_number, visitor_id, name, phone, address, city, pincode, fulfillment, items_json,
         subtotal, gst_amount, delivery, total, status, payment_status, razorpay_order_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', 'pending', ?, ?, ?)`)
        .run(orderNumber, Number(visitor_id) || null, cleanName, cleanPhone,
             ff === "pickup" ? "Shop pickup" : cleanAddr,
             ff === "pickup" ? "" : cleanCity, ff === "pickup" ? "" : cleanPin,
             ff, JSON.stringify(lines), subtotal, gst, delivery, total, rzpOrder.id, t, t);
      orderId = r.lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Order number collision, please retry." });
      throw e;
    }
    if (draftRow) db.prepare("UPDATE draft_orders SET used = 1 WHERE token = ?").run(draftRow.token);

    res.json({
      order_id: orderId, order_number: orderNumber, amount: total, currency: "INR",
      subtotal, gst, delivery,
      razorpay_order_id: rzpOrder.id, razorpay_key_id: config.razorpay.key_id,
      mock: rzpMock(), business: config.business.name,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "Could not create order." });
  }
});

app.post("/api/orders/:id/verify", (req, res) => {
  const id = Number(req.params.id);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.payment_status === "paid") return res.json({ ok: true, order_number: order.order_number, already: true });
  if (order.razorpay_order_id !== razorpay_order_id) return res.status(400).json({ error: "Order id mismatch." });
  const valid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  const t = nowIso();
  if (valid) {
    db.prepare("UPDATE orders SET payment_status = 'paid', razorpay_payment_id = ?, updated_at = ? WHERE id = ?")
      .run(String(razorpay_payment_id), t, id);
    decrementStock(JSON.parse(order.items_json));
    res.json({ ok: true, order_number: order.order_number });
  } else {
    db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ?").run(t, id);
    res.status(400).json({ ok: false, error: "Payment verification failed." });
  }
});

app.post("/api/orders/:id/payment-failed", (req, res) => {
  const id = Number(req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.payment_status === "pending") {
    db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), id);
  }
  res.json({ ok: true });
});

// Order lookup / tracking: phone required, order number optional filter.
app.get("/api/orders/lookup", (req, res) => {
  const phone = String(req.query.phone || "").trim().replace(/[\s-]/g, "");
  const orderId = String(req.query.order_id || "").trim().toUpperCase();
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
  let rows;
  if (orderId) {
    rows = db.prepare("SELECT * FROM orders WHERE phone = ? AND order_number = ?").all(phone, orderId);
  } else {
    rows = db.prepare("SELECT * FROM orders WHERE phone = ? ORDER BY id DESC LIMIT 50").all(phone);
  }
  res.json(rows.map((o) => ({ ...o, items: JSON.parse(o.items_json) })));
});

// Quote request (custom sizes): no payment involved.
app.post("/api/quotes", (req, res) => {
  try {
    const { visitor_id, name, phone, product_type, dimensions, quantity, notes } = req.body;
    const cleanName = String(name || "").trim();
    const cleanPhone = String(phone || "").trim().replace(/[\s-]/g, "");
    const cleanType = String(product_type || "").trim();
    const cleanDim = String(dimensions || "").trim();
    const cleanQty = String(quantity || "").trim();
    if (cleanName.length < 2) throw new Error("Please enter your name.");
    if (!PHONE_RE.test(cleanPhone)) throw new Error("Enter a valid 10-digit mobile number.");
    if (isBlocked(cleanPhone)) throw new Error("Please contact the shop directly.");
    if (!cleanType) throw new Error("Please choose a product type.");
    if (cleanDim.length < 2) throw new Error("Please describe the size / dimensions.");
    if (!cleanQty) throw new Error("Please enter the quantity.");
    const t = nowIso();
    const r = db.prepare(`INSERT INTO quote_requests
      (quote_number, visitor_id, name, phone, product_type, dimensions, quantity, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?)`)
      .run(makeQuoteNumber(), Number(visitor_id) || null, cleanName, cleanPhone, cleanType,
           cleanDim, cleanQty, String(notes || "").trim().slice(0, 1000), t, t);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message || "Could not save quote request." });
  }
});

// Draft order for quote conversion: shareable /order/<token> link.
app.get("/api/draft-order/:token", (req, res) => {
  const d = db.prepare("SELECT * FROM draft_orders WHERE token = ?").get(String(req.params.token));
  if (!d) return res.status(404).json({ error: "Invalid or expired order link." });
  if (d.used) return res.status(410).json({ error: "This order link has already been used." });
  res.json({ token: d.token, name: d.name, phone: d.phone, item_label: d.item_label, price: d.price, qty: d.qty });
});

// Customer invoice data: phone must match the order (simple ownership check).
function buildInvoice(order) {
  const items = JSON.parse(order.items_json);
  const { bySku } = loadCatalog();
  const rate = Number(config.business.gst_rate) || 0;
  const lines = items.map((l) => {
    let hsn = "";
    if (l.sku && bySku.has(l.sku)) hsn = bySku.get(l.sku).product.hsn || "";
    return { ...l, hsn };
  });
  const taxable = Math.round(order.subtotal * 100) / 100;
  let cgst, sgst;
  if (order.gst_amount) {
    // GST stored at order time: split it so CGST + SGST always equals the
    // stored GST exactly, and grand_total equals the amount actually paid.
    cgst = Math.round(order.gst_amount / 2 * 100) / 100;
    sgst = Math.round((order.gst_amount - cgst) * 100) / 100;
  } else {
    // Orders placed before the GST fix have no stored GST — keep the legacy
    // computation so their invoices stay as originally issued.
    cgst = Math.round(taxable * (rate / 2) / 100 * 100) / 100;
    sgst = cgst;
  }
  const grand = Math.round((taxable + cgst + sgst + order.delivery) * 100) / 100;
  return {
    business: config.business,
    gst_rate: rate,
    invoice_no: "INV-" + order.order_number,
    date: order.created_at,
    fulfillment: order.fulfillment || "delivery",
    customer: { name: order.name, phone: order.phone, address: order.address, city: order.city, pincode: order.pincode },
    lines, taxable, gst_amount: Math.round((cgst + sgst) * 100) / 100, cgst, sgst, delivery: order.delivery, grand_total: grand,
    payment_status: order.payment_status,
    note: "Prices exclusive of GST. GST charged extra as applicable. Goods once sold will not be taken back.",
  };
}
app.get("/api/invoice/:orderId", (req, res) => {
  const id = Number(req.params.orderId);
  const phone = String(req.query.phone || "").trim().replace(/[\s-]/g, "");
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.phone !== phone) return res.status(403).json({ error: "Phone number does not match this order." });
  res.json(buildInvoice(order));
});

/* ------------------------------------------------------------------ */
/* Admin API (simple shared-password gate, checked server-side)        */
/* ------------------------------------------------------------------ */
function adminAuth(req, res, next) {
  if (req.headers["x-admin-password"] === config.admin.password) return next();
  res.status(401).json({ error: "Unauthorized." });
}

app.get("/api/admin/orders", adminAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 500").all();
  res.json(rows.map((o) => ({ ...o, items: JSON.parse(o.items_json) })));
});
app.patch("/api/admin/orders/:id", adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "");
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: "Bad status." });
  const r = db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  if (r.changes === 0) return res.status(404).json({ error: "Order not found." });
  res.json({ ok: true });
});
app.get("/api/admin/orders/:id/invoice", adminAuth, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(buildInvoice(order));
});

/* Quote requests */
app.get("/api/admin/quotes", adminAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM quote_requests ORDER BY id DESC LIMIT 500").all());
});
app.patch("/api/admin/quotes/:id", adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "");
  if (!QUOTE_STATUSES.includes(status)) return res.status(400).json({ error: "Bad status." });
  const r = db.prepare("UPDATE quote_requests SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  if (r.changes === 0) return res.status(404).json({ error: "Quote not found." });
  res.json({ ok: true });
});
// Convert a quote to a shareable draft order link.
app.post("/api/admin/quotes/:id/convert", adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare("SELECT * FROM quote_requests WHERE id = ?").get(id);
  if (!q) return res.status(404).json({ error: "Quote not found." });
  const price = Number(req.body.price);
  const qty = Math.max(1, Math.min(10000, Number(req.body.qty) || 1));
  const itemLabel = String(req.body.item_label || `${q.product_type} — ${q.dimensions}`).slice(0, 200);
  if (!(price > 0)) return res.status(400).json({ error: "Enter the quoted price." });
  const token = crypto.randomBytes(16).toString("hex");
  db.prepare(`INSERT INTO draft_orders (token, quote_id, name, phone, item_label, price, qty, used, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(token, id, q.name, q.phone, itemLabel, Math.round(price * 100) / 100, qty, nowIso());
  const t = nowIso();
  db.prepare("UPDATE quote_requests SET status = 'Converted', updated_at = ? WHERE id = ?").run(t, id);
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({ ok: true, token, link: `${base}/order/${token}` });
});

/* Product management — writes back to products.json (single source of truth) */
app.get("/api/admin/products", adminAuth, (req, res) => {
  try { res.json(loadCatalog().catalog); }
  catch (e) { res.status(500).json({ error: "Could not load catalog." }); }
});
app.post("/api/admin/products", adminAuth, (req, res) => {
  try {
    const { name, category, description, hsn } = req.body;
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: "Product name required." });
    const catalog = loadCatalog().catalog;
    let id = slugify(name), n = 1;
    while (catalog.products.some((p) => p.id === id)) id = `${slugify(name)}-${++n}`;
    const cat = String(category || "").trim() || "General";
    if (!catalog.categories.includes(cat)) catalog.categories.push(cat);
    catalog.products.push({
      id, name: String(name).trim(), category: cat,
      description: String(description || "").trim(), hsn: String(hsn || "").trim(),
      sample: false, variants: [],
    });
    saveCatalog(catalog);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: "Could not save catalog." }); }
});
app.put("/api/admin/products/:id", adminAuth, (req, res) => {
  try {
    const catalog = loadCatalog().catalog;
    const p = catalog.products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "Product not found." });
    const { name, category, description, hsn } = req.body;
    if (name !== undefined) p.name = String(name).trim();
    if (category !== undefined) {
      const cat = String(category).trim() || p.category;
      if (!catalog.categories.includes(cat)) catalog.categories.push(cat);
      p.category = cat;
    }
    if (description !== undefined) p.description = String(description).trim();
    if (hsn !== undefined) p.hsn = String(hsn).trim();
    saveCatalog(catalog);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not save catalog." }); }
});
app.delete("/api/admin/products/:id", adminAuth, (req, res) => {
  try {
    const catalog = loadCatalog().catalog;
    const i = catalog.products.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: "Product not found." });
    catalog.products.splice(i, 1);
    saveCatalog(catalog);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not save catalog." }); }
});
app.post("/api/admin/products/:id/variants", adminAuth, (req, res) => {
  try {
    const { label, unit, price, stock, sku } = req.body;
    const catalog = loadCatalog().catalog;
    const p = catalog.products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "Product not found." });
    const cleanSku = String(sku || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "") || `${slugify(p.name).toUpperCase().slice(0, 12)}-${Date.now().toString(36).toUpperCase()}`;
    if (catalog.products.some((x) => x.variants.some((v) => v.sku === cleanSku))) {
      return res.status(400).json({ error: "SKU already exists." });
    }
    const pr = Number(price);
    if (!label || !(pr >= 0)) return res.status(400).json({ error: "Label and price required." });
    p.variants.push({
      sku: cleanSku, label: String(label).trim(), unit: String(unit || "pc").trim(),
      price: Math.round(pr * 100) / 100, stock: Math.max(0, Number(stock) || 0),
    });
    saveCatalog(catalog);
    res.json({ ok: true, sku: cleanSku });
  } catch (e) { res.status(500).json({ error: "Could not save catalog." }); }
});
app.put("/api/admin/products/:id/variants/:sku", adminAuth, (req, res) => {
  try {
    const catalog = loadCatalog().catalog;
    const p = catalog.products.find((x) => x.id === req.params.id);
    const v = p && p.variants.find((x) => x.sku === req.params.sku);
    if (!v) return res.status(404).json({ error: "Variant not found." });
    const { label, unit, price, stock } = req.body;
    if (label !== undefined) v.label = String(label).trim();
    if (unit !== undefined) v.unit = String(unit).trim();
    if (price !== undefined) v.price = Math.round(Number(price) * 100) / 100;
    if (stock !== undefined) v.stock = Math.max(0, Math.floor(Number(stock) || 0));
    saveCatalog(catalog);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not save catalog." }); }
});
app.delete("/api/admin/products/:id/variants/:sku", adminAuth, (req, res) => {
  try {
    const catalog = loadCatalog().catalog;
    const p = catalog.products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "Product not found." });
    const i = p.variants.findIndex((x) => x.sku === req.params.sku);
    if (i < 0) return res.status(404).json({ error: "Variant not found." });
    p.variants.splice(i, 1);
    saveCatalog(catalog);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not save catalog." }); }
});

/* Visitors / customers / live */
app.get("/api/admin/visitors", adminAuth, (req, res) => {
  res.json(db.prepare("SELECT id, name, phone, email, entered_at, last_seen_at, current_page FROM visitors ORDER BY id DESC LIMIT 500").all());
});
app.get("/api/admin/customers", adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT phone, MAX(name) AS name, COUNT(*) AS order_count,
           SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END) AS total_spent,
           MAX(created_at) AS last_order_at
    FROM orders GROUP BY phone ORDER BY total_spent DESC`).all();
  res.json(rows.map((c) => {
    const history = db.prepare(
      "SELECT id, order_number, total, status, payment_status, fulfillment, created_at FROM orders WHERE phone = ? ORDER BY id DESC"
    ).all(c.phone);
    const emailRow = db.prepare(
      "SELECT email FROM visitors WHERE phone = ? AND email != '' ORDER BY id DESC LIMIT 1"
    ).get(c.phone);
    return {
      phone: c.phone, name: c.name, email: (emailRow && emailRow.email) || "",
      order_count: c.order_count,
      paid_order_count: history.filter((h) => h.payment_status === "paid").length,
      total_spent: Math.round((c.total_spent || 0) * 100) / 100,
      repeat_buyer: c.order_count > 1, last_order_at: c.last_order_at, orders: history,
    };
  }));
});
app.get("/api/admin/live", adminAuth, (req, res) => {
  const cutoff = new Date(Date.now() - config.live.staleAfterSec * 1000).toISOString();
  const rows = db.prepare(
    "SELECT id, name, phone, email, entered_at, last_seen_at, current_page FROM visitors WHERE last_seen_at >= ? ORDER BY last_seen_at DESC"
  ).all(cutoff);
  const now = Date.now();
  res.json(rows.map((v) => ({
    ...v,
    seconds_on_site: Math.max(0, Math.round((now - new Date(v.entered_at).getTime()) / 1000)),
    seconds_since_seen: Math.max(0, Math.round((now - new Date(v.last_seen_at).getTime()) / 1000)),
  })));
});

/* Daily sales summary */
function summaryFor(dateStr) {
  // dateStr: YYYY-MM-DD in server-local time
  const start = `${dateStr}T00:00:00`, end = `${dateStr}T23:59:59`;
  const rows = db.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN payment_status='paid' AND status != 'Cancelled' THEN total ELSE 0 END) AS rev, SUM(CASE WHEN payment_status='paid' AND status != 'Cancelled' THEN 1 ELSE 0 END) AS paid_n FROM orders WHERE created_at >= ? AND created_at <= ?"
  ).get(start, end);
  const revenue = Math.round((rows.rev || 0) * 100) / 100;
  return { date: dateStr, orders: rows.n || 0, revenue, avg_order_value: rows.paid_n ? Math.round(revenue / rows.paid_n * 100) / 100 : 0 };
}
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
app.get("/api/admin/summary", adminAuth, (req, res) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : dayStr(new Date());
  res.json(summaryFor(d));
});
app.get("/api/admin/summary/week", adminAuth, (req, res) => {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    out.push(summaryFor(dayStr(d)));
  }
  res.json(out);
});

/* Blocked numbers */
app.get("/api/admin/blocks", adminAuth, (req, res) => {
  res.json(db.prepare("SELECT phone, reason, created_at FROM blocks ORDER BY created_at DESC").all());
});
app.post("/api/admin/blocks", adminAuth, (req, res) => {
  const phone = String(req.body.phone || "").trim().replace(/[\s-]/g, "");
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
  db.prepare("INSERT OR REPLACE INTO blocks (phone, reason, created_at) VALUES (?, ?, ?)")
    .run(phone, String(req.body.reason || "").slice(0, 200), nowIso());
  res.json({ ok: true });
});
app.delete("/api/admin/blocks/:phone", adminAuth, (req, res) => {
  db.prepare("DELETE FROM blocks WHERE phone = ?").run(String(req.params.phone));
  res.json({ ok: true });
});

/* Announcement banner */
app.put("/api/admin/announcement", adminAuth, (req, res) => {
  const val = JSON.stringify({ en: String(req.body.en || "").slice(0, 500), hi: String(req.body.hi || "").slice(0, 500) });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('announcement', ?)").run(val);
  res.json({ ok: true });
});

/* Excel exports (order/customer lists, date-range filter) */
function rangeWhere(range) {
  const now = new Date();
  if (range === "today") return [`created_at >= ?`, [`${dayStr(now)}T00:00:00`]];
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 0;
  if (days) {
    const d = new Date(); d.setDate(d.getDate() - (days - 1));
    return [`created_at >= ?`, [`${dayStr(d)}T00:00:00`]];
  }
  return ["1=1", []];
}
app.get("/api/admin/export/orders.xlsx", adminAuth, async (req, res) => {
  const ExcelJS = require("exceljs");
  const [where, params] = rangeWhere(String(req.query.range || "all"));
  const rows = db.prepare(`SELECT * FROM orders WHERE ${where} ORDER BY id DESC`).all(...params);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Orders");
  ws.columns = [
    { header: "Order ID", key: "order_number", width: 20 },
    { header: "Date", key: "date", width: 20 },
    { header: "Customer Name", key: "name", width: 22 },
    { header: "Phone", key: "phone", width: 15 },
    { header: "Items", key: "items", width: 50 },
    { header: "Amount (INR)", key: "total", width: 14 },
    { header: "Payment Status", key: "payment_status", width: 15 },
    { header: "Order Status", key: "status", width: 14 },
    { header: "Fulfillment", key: "fulfillment", width: 12 },
  ];
  rows.forEach((o) => {
    const items = JSON.parse(o.items_json).map((l) => `${l.qty} x ${l.name} (${l.variant_label})`).join("; ");
    ws.addRow({ order_number: o.order_number, date: o.created_at.slice(0, 16).replace("T", " "), name: o.name, phone: o.phone, items, total: o.total, payment_status: o.payment_status, status: o.status, fulfillment: o.fulfillment || "delivery" });
  });
  ws.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=orders-${req.query.range || "all"}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});
app.get("/api/admin/export/customers.xlsx", adminAuth, async (req, res) => {
  const ExcelJS = require("exceljs");
  const [where, params] = rangeWhere(String(req.query.range || "all"));
  const rows = db.prepare(`
    SELECT phone, MAX(name) AS name, COUNT(*) AS order_count,
           SUM(CASE WHEN payment_status='paid' THEN total ELSE 0 END) AS total_spent,
           MAX(created_at) AS last_order_at
    FROM orders WHERE ${where} GROUP BY phone ORDER BY total_spent DESC`).all(...params);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Customers");
  ws.columns = [
    { header: "Phone", key: "phone", width: 15 },
    { header: "Name", key: "name", width: 22 },
    { header: "Orders", key: "order_count", width: 10 },
    { header: "Total Spent (INR)", key: "total_spent", width: 18 },
    { header: "Repeat Buyer", key: "repeat", width: 14 },
    { header: "Last Order", key: "last_order_at", width: 20 },
  ];
  rows.forEach((c) => ws.addRow({
    phone: c.phone, name: c.name, order_count: c.order_count,
    total_spent: Math.round((c.total_spent || 0) * 100) / 100,
    repeat: c.order_count > 1 ? "Yes" : "No",
    last_order_at: (c.last_order_at || "").slice(0, 16).replace("T", " "),
  }));
  ws.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=customers-${req.query.range || "all"}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

/* ------------------------------------------------------------------ */
/* Static frontend                                                     */
/* ------------------------------------------------------------------ */
// Shareable quote-converted order links render the SPA, which picks up the token.
app.get("/order/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.static(path.join(__dirname, "public")));

const port = config.server.port;
app.listen(port, () => {
  console.log(`Choudhary Paper Tube & Packaging — listening on http://localhost:${port}`);
  console.log(`Payments: ${rzpMock() ? "MOCK mode (test)" : "LIVE Razorpay mode"}`);
});
