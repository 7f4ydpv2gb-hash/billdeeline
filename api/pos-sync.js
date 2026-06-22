// api/pos-sync.js — Receive POS sales and create BillDEE income transactions
// Called by the POS app after each successful sale

import { getConfig, requireServiceKey, rateLimit, sanitize,
         setSecurityHeaders, isValidUUID } from './_lib/config.js';

export default async function handler(req, res) {
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-POS-Token');
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Allow cross-origin from POS app (different domain)
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateLimit(ip + ':pos-sync', 60)) return res.status(429).json({ error: 'Too many requests' });

  const serviceKey = requireServiceKey(res);
  if (!serviceKey) return;

  const { SB_URL, ADMIN_SECRET } = getConfig();

  // Validate POS sync token (reuse ADMIN_SECRET or dedicated POS_SYNC_TOKEN env)
  const POS_TOKEN = process.env.POS_SYNC_TOKEN || ADMIN_SECRET;
  if (!POS_TOKEN) return res.status(500).json({ error: 'POS_SYNC_TOKEN not configured' });

  const providedToken = req.headers['x-pos-token'] || req.body?.sync_token;
  if (providedToken !== POS_TOKEN) return res.status(401).json({ error: 'Invalid sync token' });

  const body = req.body;
  if (!body) return res.status(400).json({ error: 'Invalid body' });

  // Validate required fields
  const { business_id, receipt_no, total, sale_date, items, payment_method, shop_name } = body;

  if (!business_id || !isValidUUID(business_id)) {
    return res.status(400).json({ error: 'Invalid business_id' });
  }
  const amount = parseFloat(total);
  if (isNaN(amount) || amount <= 0 || amount > 10_000_000) {
    return res.status(400).json({ error: 'Invalid total amount' });
  }

  const safeReceipt = sanitize(receipt_no || '', 100);
  const safeShop    = sanitize(shop_name || 'POS', 200);
  const safePayment = sanitize(payment_method || 'cash', 50);
  const txnDate     = sale_date ? sanitize(sale_date, 20) : new Date().toISOString().slice(0, 10);

  // Check duplicate (same receipt_no already synced)
  if (safeReceipt) {
    const dupCheck = await fetch(
      `${SB_URL}/rest/v1/transactions?business_id=eq.${business_id}&doc_no=eq.${encodeURIComponent(safeReceipt)}&source=eq.pos_sync&select=id&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const dupData = dupCheck.ok ? await dupCheck.json() : [];
    if (dupData.length > 0) {
      return res.status(409).json({ error: 'already_synced', message: 'Receipt already synced' });
    }
  }

  // Build item summary for note
  const itemSummary = Array.isArray(items) && items.length > 0
    ? items.slice(0, 5).map(i => `${sanitize(i.product_name || '', 60)} x${i.qty}`).join(', ')
    : '';
  const noteText = [
    `POS: ${safeShop}`,
    safeReceipt ? `#${safeReceipt}` : '',
    safePayment,
    itemSummary,
  ].filter(Boolean).join(' · ');

  const txnRow = {
    business_id,
    kind: 'income',
    type: 'income',
    amount,
    category: 'รายรับจาก POS',
    cat: 'รายรับจาก POS',
    txn_date: txnDate,
    date: txnDate,
    note: noteText.slice(0, 500),
    doc_no: safeReceipt,
    pay_method: safePayment,
    source: 'pos_sync',
    has_vat: body.vat > 0,
  };

  const sbRes = await fetch(`${SB_URL}/rest/v1/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(txnRow),
  });

  if (!sbRes.ok) {
    const errText = await sbRes.text();
    console.error('pos-sync insert error:', errText);
    // If schema cache issue (column doesn't exist), retry without beta cols
    if (errText.includes('schema cache') || errText.includes('column')) {
      const slim = { business_id, kind: 'income', amount, txn_date: txnDate,
                     note: noteText.slice(0, 500), source: 'pos_sync' };
      const retry = await fetch(`${SB_URL}/rest/v1/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' },
        body: JSON.stringify(slim),
      });
      if (!retry.ok) return res.status(500).json({ error: 'Failed to sync' });
      return res.status(200).json({ ok: true, synced: true });
    }
    return res.status(500).json({ error: 'Failed to sync transaction' });
  }

  const [saved] = await sbRes.json().catch(() => [{}]);
  return res.status(200).json({ ok: true, transaction_id: saved?.id });
}
