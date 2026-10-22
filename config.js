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
    // PLACEHOLDER — replace with the business's LIVE Razorpay credentials
    // from the Razorpay Dashboard (Settings → API Keys) before going live.
    key_id: "rzp_test_PLACEHOLDER",
    key_secret: "PLACEHOLDER_SECRET",

    // When true, the backend creates MOCK Razorpay orders (order_mock_...)
    // and the checkout page shows a simulated test-payment dialog instead of
    // the real Razorpay Checkout.js. Set to false AND fill in real keys above
    // to accept real payments. Going live = key swap + mock: false. Nothing else changes.
    mock: true,
  },

  admin: {
    // PLACEHOLDER — change this before going live. The admin panel
    // ( /admin.html ) asks for this password; it is checked server-side.
    password: "changeme123",
  },

  server: {
    port: process.env.PORT || 3000,
    dbFile: process.env.DB_FILE || "./data/app.db",
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
