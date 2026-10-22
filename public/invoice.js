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
function invDate(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

/* Returns full printable invoice HTML. Uses window.t for labels. */
function renderInvoice(inv) {
  const t = window.t, b = inv.business;
  const rate = Number(inv.gst_rate) || 0;
  const rows = inv.lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(l.name)}<br><small>${esc(l.variant_label || "")}</small></td>
      <td>${esc(l.hsn || "—")}</td>
      <td class="r">${l.qty} ${esc(l.unit || "")}</td>
      <td class="r">${inr(l.price)}</td>
      <td class="r">${inr(l.line_total)}</td>
    </tr>`).join("");
  const custAddr = [inv.customer.address, inv.customer.city, inv.customer.pincode].filter(Boolean).join(", ")
    || (inv.fulfillment === "pickup" ? "Shop pickup" : "");
  return `
  <div class="inv">
    <div class="inv-head">
      <div class="inv-brand">C</div>
      <h2>${esc(b.invoice_name || b.name)}</h2>
      <div>${esc(b.address)}</div>
      <div>Ph: ${b.phones.map(esc).join(" · ")}</div>
      <div>${t("inv_gstin")}: ${esc(b.gstin || "—")}</div>
      <div class="inv-title">${t("inv_title")}</div>
    </div>
    <div class="inv-meta">
      <div><strong>${t("inv_no")}:</strong> ${esc(inv.invoice_no)}</div>
      <div><strong>${t("inv_date")}:</strong> ${invDate(inv.date)}</div>
      <div><strong>${t("inv_bill_to")}:</strong> ${esc(inv.customer.name)}, ${esc(inv.customer.phone)}<br>${esc(custAddr)}</div>
      <div><strong>${t("fulfillment_col")}:</strong> ${inv.fulfillment === "pickup" ? t("pickup") : t("delivery_opt")}</div>
    </div>
    <table class="inv-table">
      <thead><tr>
        <th>#</th><th>${t("inv_item")}</th><th>${t("inv_hsn")}</th>
        <th class="r">${t("inv_qty")}</th><th class="r">${t("inv_rate")}</th><th class="r">${t("inv_amount")}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="inv-totals">
      <tr><td>${t("inv_taxable")}</td><td class="r">${inr(inv.taxable)}</td></tr>
      <tr><td>${t("inv_cgst")} @ ${(rate / 2)}%</td><td class="r">${inr(inv.cgst)}</td></tr>
      <tr><td>${t("inv_sgst")} @ ${(rate / 2)}%</td><td class="r">${inr(inv.sgst)}</td></tr>
      <tr><td>${t("inv_delivery")}</td><td class="r">${inr(inv.delivery)}</td></tr>
      <tr class="grand"><td>${t("inv_grand")}</td><td class="r">${inr(inv.grand_total)}</td></tr>
    </table>
    <div class="inv-words"><strong>${t("inv_words")}:</strong> ${numToWordsIN(inv.grand_total)}</div>
    <div class="inv-note">${t("inv_note")}</div>
    <div class="inv-sign">For ${esc(b.name)}<br><br><br>Authorised Signatory</div>
  </div>`;
}
