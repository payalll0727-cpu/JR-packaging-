# J.R. Paper Tube & Packaging — Order Website

Wholesale packaging-materials shop for **J.R. Paper Tube & Packaging, Surat**
(Prop. Jetharam Choudhary · 98798 90987, 99988 20009, 93776 67750).

Customers enter name + mobile number at the gate (no OTP, no accounts), browse the
catalog, pay online via Razorpay, and track/reorder by phone number. The owner gets
an admin panel with orders, quote requests, product editing, GST invoices, sales
summary, visitor register, live visitors, and Excel exports.

## Run locally

Requires **Node.js 22.5+** (uses the built-in `node:sqlite` module).

```bash
cd jr-paper-tube-website
npm install
npm start
```

- Shop: http://localhost:3000
- Admin: http://localhost:3000/admin.html (password in `config.js`)

## Edit products / prices

**Option A — admin panel:** open `/admin.html` → Products tab → add/edit/delete
products, variants, prices, categories, stock. Changes are written straight back to
`products.json`.

**Option B — edit the file:** `products.json` is the single source of truth
(pretty-printed JSON). Each variant: `{ sku, label, unit, price, stock }`.
Each product can carry an optional `hsn` code for the GST invoice.

> ⚠️ All prices shipped in this repo are **SAMPLE** placeholders (`"sample": true`).
> Replace them with real prices before going live.

## Key config (`config.js`)

| Setting | Meaning |
|---|---|
| `business.whatsapp` | WhatsApp help-button number (digits + country code) |
| `business.gstin` | GSTIN for invoices — **empty placeholder**, shows "—" until filled |
| `business.gst_rate` | GST % on invoices (default 18, confirm with CA) |
| `delivery.charge` / `delivery.free_above` | Delivery fee logic (default charge **₹0 SAMPLE**; free above ₹2,000) |
| `razorpay.key_id` / `key_secret` | **PLACEHOLDERS** — test/live keys from Razorpay Dashboard |
| `razorpay.mock` | `true` = simulated payments (no real money). Set `false` + real keys to go live |
| `admin.password` | **PLACEHOLDER** — change before going live |

## Deploy (Render free tier)

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Add a **persistent disk** mounted at `/opt/render/project/src/data` (or set the
   `DB_FILE` env var to a path on the disk) — otherwise orders vanish on redeploy.
5. Set env `PORT` is automatic on Render. Open the service URL; admin at `/admin.html`.

Any Node host works the same way (Railway, Fly.io, a VPS with `pm2`).

## Go-live checklist

- [ ] Replace `razorpay.key_id` / `key_secret` with **live** keys; set `razorpay.mock: false`
- [ ] Change `admin.password`
- [ ] Replace all SAMPLE prices in `products.json` (or via admin Products tab)
- [ ] Set real `delivery.charge` in `config.js`
- [ ] Fill `business.gstin` (and per-product `hsn` codes if wanted)
- [ ] Confirm `business.gst_rate` with the CA
- [ ] Attach persistent storage for `data/app.db`

## Notes / limitations

- Payments run in **mock mode** until real Razorpay keys are added — the full
  create-order → verify-signature flow is implemented and only needs the key swap.
- Order lookup by phone number is intentionally simple (no OTP); add OTP later if
  order-privacy needs tighten.
- The admin password is a single shared secret sent as a request header — fine for
  a small shop, not for a large team.
- Stock decrements on successful payment; there are no low-stock alerts (skipped by design).
