/**
 * Choudhary Paper Tube & Packaging — site configuration
 * =================================================
 * ⚠️  BEFORE GOING LIVE, replace every value marked PLACEHOLDER below.
 * See README.md "Go-live checklist" for the full list.
 */

module.exports = {
  business: {
    name: "Choudhary Paper Tube & Packaging",
    owner: "Jetharam Choudhary",
    address: "", // No shop address shown anywhere on the site (Payal, 2026-10-21).
    phones: ["98798 90987", "99988 20009", "93776 67750"],
    // WhatsApp help button number, digits only with country code. Clearly marked config value.
    whatsapp: "919879890987",
    // Legal/GST-registered name shown on invoices (must match the GSTIN).
    invoice_name: "LaxmiPati Packaging",
    // Business GSTIN (provided 2026-10-17) — shown on invoices.
    gstin: "24CQUPC0686G1ZO",
    // GST rate (%) applied on invoices. SAMPLE/adjustable — confirm with the owner's CA.
    gst_rate: 18,
  },

  razorpay: {
    // LIVE keys come from Render Environment variables — NEVER write the
    // real Key Secret in this file: the GitHub repo is public.
    // Render → service → Environment: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
    // RAZORPAY_MOCK=false. The placeholders below are only a local fallback.
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_PLACEHOLDER",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "PLACEHOLDER_SECRET",

    // When true, the backend creates MOCK Razorpay orders (order_mock_...)
    // and the checkout page shows a simulated test-payment dialog instead of
    // the real Razorpay Checkout.js. RAZORPAY_MOCK=false + real keys in the
    // environment = real payments. Nothing else changes.
    mock: process.env.RAZORPAY_MOCK ? process.env.RAZORPAY_MOCK === "true" : true,
  },

  admin: {
    // PLACEHOLDER — change this before going live. The admin panel
    // ( /admin.html ) asks for this password; it is checked server-side.
    // Admin password comes from the ADMIN_PASSWORD env var (Render
    // Environment) — NEVER write the real password in this file: the
    // repo is public. The fallback below is only a safety net for local
    // runs; on the live site the env var must be set.
    password: process.env.ADMIN_PASSWORD || "changeme123",
  },

  server: {
    port: process.env.PORT || 3000,
    dbFile: process.env.DB_FILE || "./data/app.db",
  },

  // Turso (free cloud SQLite/libSQL). When BOTH env vars are set
  // (Render → service → Environment: TURSO_DATABASE_URL,
  // TURSO_AUTH_TOKEN), orders/visitors live in the cloud DB and survive
  // Render free-tier restarts/deploys. When unset, the local file above
  // (server.dbFile) is used — fine locally, ephemeral on Render.
  // NEVER write a real auth token in this file: the repo is public.
  turso: {
    url: process.env.TURSO_DATABASE_URL || "",
    authToken: process.env.TURSO_AUTH_TOKEN || "",
  },

  // Login OTP (name + mobile login is compulsory; Sachin/Payal, 2026-10-23).
  // mode "demo": the OTP is shown on the login screen itself (testing only,
  // no SMS goes out). mode "live": OTP is sent by SMS via MSG91 — fill the
  // msg91 keys below (account signup + DLT approval are the owner's job),
  // then flip mode to "live" and redeploy.
  otp: {
    enabled: true,
    mode: "demo", // "demo" | "live"
    msg91: {
      authKey: "",    // MSG91 auth key
      templateId: "", // MSG91 OTP template id (DLT-approved)
      senderId: "",   // MSG91 sender id (optional with template flow)
    },
  },

  delivery: {
    // SAMPLE — delivery charge (INR) applied when the order subtotal is below
    // free_above AND the customer chooses Delivery. Shop Pickup is always free.
    // Default 0 = free delivery until the owner sets a real charge.
    charge: 0,
    free_above: 2000,
  },

  // Heartbeat / live-visitor tuning (seconds)
  live: {
    heartbeatIntervalSec: 15, // frontend pings this often
    staleAfterSec: 45,        // backend treats a visitor as offline after this
  },
};
