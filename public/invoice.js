/* Shared GST invoice renderer (storefront + admin).
   buildInvoice() on the server returns the data shape consumed here. */
"use strict";

/* Number → words, Indian numbering (lakh / crore). */
function numToWordsIN(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return "Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x) => x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? " " + ones[x % 10] : "");
  const three = (x) => (Math.floor(x / 100) ? ones[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " : "") : "") + (x % 100 ? two(x % 100) : "");
  let out = "";
  const cr = Math.floor(n / 1e7); n %= 1e7;
  const lk = Math.floor(n / 1e5); n %= 1e5;
  const th = Math.floor(n / 1e3); n %= 1e3;
  if (cr) out += three(cr) + " Crore ";
  if (lk) out += two(lk) + " Lakh ";
  if (th) out += two(th) + " Thousand ";
  if (n) out += three(n);
  return (out.trim() + " Rupees Only").replace(/\s+/g, " ");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function inr(n) { return "₹" + Number(n).toLocaleString("en-IN"); }
function inr2(n) { return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function invDate(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}
function invDateSlash(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/* Returns full printable invoice HTML — classic tax-invoice layout
   (format approved by Payal from a reference bill, 2026-10-29).
   Brand position = business.name (Choudhary Packaging);
   legal-name position = business.invoice_name (LaxmiPati Packaging);
   the number shown is the ORDER number (server sends it as invoice_no).
   Styles are embedded and scoped under .kinv so both the storefront
   and admin print flows render identically. Uses window.t for labels. */
function renderInvoice(inv) {
  const t = window.t, b = inv.business;
  const rate = Number(inv.gst_rate) || 0;
  const half = rate / 2;
  const r2 = (x) => Math.round(x * 100) / 100;

  const rows = inv.lines.map((l, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(l.sku || "—")}</td>
      <td>${esc(l.name)}${l.variant_label ? " / " + esc(l.variant_label) : ""}${l.pack_size ? `<br><small>1 ${esc(l.unit)} = ${l.pack_size} ${esc(l.pack_unit || "pcs")}</small>` : ""}</td>
      <td class="c">${esc(l.hsn || "—")}</td>
      <td class="c">${l.qty} ${esc(l.unit || "")}</td>
      <td class="r">${inr2(l.price)}</td>
      <td class="r">${inr2(l.line_total)}</td>
    </tr>`).join("");

  /* HSN-wise GST summary (uniform rate; totals row uses the server's
     authoritative taxable/CGST/SGST so it always matches the bill total). */
  const groups = {};
  inv.lines.forEach((l) => {
    const k = l.hsn || "—";
    groups[k] = (groups[k] || 0) + (Number(l.line_total) || 0);
  });
  const sumRows = Object.keys(groups).map((h) => {
    const tx = r2(groups[h]);
    const halfAmt = r2(tx * half / 100);
    return `<tr>
      <td>${esc(h)}</td><td class="r">${rate.toFixed(2)} %</td><td class="r">${inr2(tx)}</td>
      <td class="r">${half.toFixed(2)}</td><td class="r">${inr2(halfAmt)}</td>
      <td class="r">${half.toFixed(2)}</td><td class="r">${inr2(halfAmt)}</td>
      <td class="r">0.00</td><td class="r">${inr2(0)}</td>
    </tr>`;
  }).join("");

  const custAddr = [inv.customer.address, inv.customer.city, inv.customer.pincode].filter(Boolean).join(", ")
    || (inv.fulfillment === "pickup" ? "Shop pickup" : "");
  const paid = String(inv.payment_status || "").toUpperCase() === "PAID";

  return `
  <div class="kinv">
    <style>
      .kinv{font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;max-width:860px;margin:0 auto;border:1.6px solid #111;font-size:13px;line-height:1.45}
      .kinv table{width:100%;border-collapse:collapse}
      .kinv .r{text-align:right}.kinv .c{text-align:center}
      .kinv .kh td{vertical-align:top;padding:10px 12px}
      .kinv .kh-logo{font-family:'Anton',Impact,Arial,sans-serif;font-size:29px;letter-spacing:.5px;line-height:1.1}
      .kinv .kh-addr{margin-top:5px;font-size:12.5px}
      .kinv .kh-legal{font-weight:800;font-size:16.5px;text-align:center;padding-top:16px;white-space:nowrap}
      .kinv .kh-box{border-left:1.2px solid #111;padding:0;width:31%}
      .kinv .kh-row{padding:5px 10px;border-bottom:1.2px solid #111;font-size:12.5px}
      .kinv .kh-row:last-child{border-bottom:none}
      .kinv .kh-tax{font-weight:800;font-size:15px;letter-spacing:.4px}
      .kinv .kh-row b{font-size:13.5px}
      .kinv .kb{border-top:1.6px solid #111}
      .kinv .kb td{padding:4px 12px;vertical-align:top}
      .kinv .kb .kl{width:128px;white-space:nowrap}
      .kinv .kb .kv{text-transform:uppercase}
      .kinv .ki{border-top:1.6px solid #111}
      .kinv .ki th,.kinv .ki td{border:1px solid #111;padding:6px 8px;vertical-align:top}
      .kinv .ki th{font-size:12.5px;text-align:left}
      .kinv .ks{border-top:1.6px solid #111}
      .kinv .ks>tbody>tr>td{vertical-align:top;padding:0}
      .kinv .kg th,.kinv .kg td{border:1px solid #111;padding:4px 6px;font-size:11.8px}
      .kinv .kg th{text-align:center}
      .kinv .kg .tot td{font-weight:700}
      .kinv .kt{padding:10px 14px}
      .kinv .kt table td{padding:3px 0}
      .kinv .kt .bt{font-weight:800;font-size:15px}
      .kinv .kt .pay{text-align:right}
      .kinv .kw{border-top:1.2px solid #111;padding:7px 12px;font-size:12.5px}
      .kinv .kf{border-top:1.6px solid #111}
      .kinv .kf td{vertical-align:top;padding:9px 12px}
      .kinv .kf .terms{font-size:12px;width:62%}
      .kinv .kf .eoe{text-align:right;margin-top:10px}
      .kinv .kf .thanks{font-weight:800;font-size:14.5px;margin-top:12px}
      .kinv .kf .sign{text-align:right}
      .kinv .kf .sign .for{font-weight:700;text-transform:uppercase}
      .kinv .kf .sign .space{height:52px}
    </style>
    <table class="kh"><tr>
      <td>
        <div class="kh-logo">${esc(b.name)}</div>
        ${b.address ? `<div class="kh-addr">${esc(b.address)}</div>` : ""}
        <div class="kh-addr">Ph: ${b.phones.map(esc).join(" · ")}</div>
      </td>
      <td class="kh-legal">${esc(b.invoice_name || b.name)}</td>
      <td class="kh-box">
        <div class="kh-row">${t("inv_gstin")} No. : ${esc(b.gstin || "—")}</div>
        <div class="kh-row kh-tax">${t("inv_title")}</div>
        <div class="kh-row">${t("inv_no")}: &nbsp;<b>${esc(inv.invoice_no)}</b></div>
        <div class="kh-row">${t("inv_date")} : &nbsp;<b>${invDateSlash(inv.date)}</b></div>
      </td>
    </tr></table>
    <table class="kb">
      <tr><td class="kl">${t("inv_name_lab")} :</td><td class="kv"><b>${esc(inv.customer.name)}</b> ,${esc(inv.customer.phone)}</td></tr>
      <tr><td class="kl">${t("inv_place")} :</td><td class="kv">${esc(custAddr)}</td></tr>
      ${inv.customer.gstin ? `<tr><td class="kl">${t("inv_gstin")} :</td><td>${esc(inv.customer.gstin)}</td></tr>` : ""}
    </table>
    <table class="ki">
      <thead><tr>
        <th style="width:34px">No.</th><th>${t("inv_code")}</th><th>${t("inv_desc")}</th>
        <th class="c">${t("inv_hsn")} Code</th><th class="c">${t("inv_qty")}</th>
        <th class="r">${t("inv_rate")}</th><th class="r">${t("inv_amount")}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="ks"><tr>
      <td style="width:63%">
        <table class="kg">
          <thead>
            <tr>
              <th rowspan="2">${t("inv_hsn")}</th><th rowspan="2">GST Rate</th><th rowspan="2">${t("inv_taxable")}</th>
              <th colspan="2">${t("inv_sgst")}</th><th colspan="2">${t("inv_cgst")}</th><th colspan="2">IGST</th>
            </tr>
            <tr><th>Tax %</th><th>${t("inv_amount")}</th><th>Tax %</th><th>${t("inv_amount")}</th><th>Tax %</th><th>${t("inv_amount")}</th></tr>
          </thead>
          <tbody>
            ${sumRows}
            <tr class="tot">
              <td colspan="2" class="r">Total :</td><td class="r">${inr2(inv.taxable)}</td>
              <td></td><td class="r">${inr2(inv.sgst)}</td>
              <td></td><td class="r">${inr2(inv.cgst)}</td>
              <td></td><td class="r">${inr2(0)}</td>
            </tr>
          </tbody>
        </table>
      </td>
      <td>
        <div class="kt">
          <table>
            ${Number(inv.delivery) ? `<tr><td>${t("inv_delivery")} :</td><td class="r">${inr2(inv.delivery)}</td></tr>` : ""}
            <tr><td class="bt">${t("inv_billtotal")} :</td><td class="r bt">${inr2(inv.grand_total)}</td></tr>
            <tr><td class="pay" colspan="2">${paid ? t("inv_paid_online") : t("inv_topay")} : &nbsp;${inr2(inv.grand_total)}</td></tr>
          </table>
        </div>
      </td>
    </tr></table>
    <div class="kw"><strong>${t("inv_words")}:</strong> ${numToWordsIN(inv.grand_total)}</div>
    <table class="kf"><tr>
      <td class="terms">
        <div>* ${t("inv_note")}</div>
        <div>* ${t("inv_jurisdiction")}</div>
        <div class="eoe">E. &amp; O.E.</div>
        <div class="thanks">* ${t("inv_thanks")}</div>
      </td>
      <td class="sign">
        <div class="for">For, ${esc(b.invoice_name || b.name)}</div>
        <div class="space"></div>
        <div>(Authorised Signatory)</div>
      </td>
    </tr></table>
  </div>`;
}
