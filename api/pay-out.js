// /api/pay-out.js
//
// This is what "Approve payout" in admin now actually calls. It does not
// just flip a status — it sends a real Paystack Transfer to the vendor's
// or rider's saved recipient_code, records the transfer reference, and
// sets the ledger entry to 'processing'. It only ever becomes 'paid' once
// Paystack's webhook confirms the transfer actually succeeded — never
// optimistically, so "paid" in the dashboard always means money moved.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ledgerEntryId } = req.body;
  if (!ledgerEntryId) {
    return res.status(400).json({ error: 'Missing ledgerEntryId' });
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // 1. Load the ledger entry via the effective-status view — this is what
    //    actually accounts for the dispute window AND fulfillment confirmation,
    //    not just the raw stored status. This is the real gate; the admin UI
    //    display is just a reflection of the same check.
    const entryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ledger_entries_effective?id=eq.${ledgerEntryId}&select=*`,
      { headers: sbHeaders }
    );
    const entries = await entryRes.json();
    const entry = entries && entries[0];
    if (!entry) return res.status(404).json({ error: 'Ledger entry not found' });
    if (entry.effective_status !== 'available') {
      const reason = entry.effective_status === 'awaiting_fulfillment_confirmation'
        ? 'the order has not been confirmed delivered or picked up yet'
        : `it is '${entry.effective_status}'`;
      return res.status(400).json({ error: `This entry is not ready to pay out — ${reason}.` });
    }

    // 2. Look up the recipient's Paystack recipient_code
    const table = entry.recipient_type === 'vendor' ? 'vendors' : 'riders';
    const recipientId = entry.recipient_type === 'vendor' ? entry.vendor_id : entry.rider_id;
    const recipientRes = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?id=eq.${recipientId}&select=id,name:full_name,paystack_recipient_code,account_verified`,
      { headers: sbHeaders }
    );
    const recipients = await recipientRes.json();
    const recipient = recipients && recipients[0];
    if (!recipient || !recipient.paystack_recipient_code) {
      return res.status(400).json({
        error: `This ${entry.recipient_type} has no verified payout account on file yet — they need to complete bank verification first.`,
      });
    }

    // 3. Initiate the real transfer
    const transferRes = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      body: JSON.stringify({
        source: 'balance',
        amount: Math.round(Number(entry.amount) * 100), // kobo
        recipient: recipient.paystack_recipient_code,
        reason: `Sultini Express payout — ledger ${entry.id}`,
      }),
    });
    const transferData = await transferRes.json();

    if (!transferRes.ok || !transferData.status) {
      // Common cause: OTP finalization is enabled on the Paystack account for
      // transfers, which blocks fully automated payouts. If you see this error,
      // disable "OTP for transfers" in Paystack Dashboard > Settings > Preferences
      // (transfers are still fully logged and auditable either way).
      await fetch(`${SUPABASE_URL}/rest/v1/ledger_entries?id=eq.${ledgerEntryId}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'transfer_failed',
          failure_reason: transferData.message || 'Transfer could not be initiated',
        }),
      });
      return res.status(400).json({ error: transferData.message || 'Transfer failed to initiate' });
    }

    // 4. Mark as processing — NOT paid yet. The webhook confirms that.
    await fetch(`${SUPABASE_URL}/rest/v1/ledger_entries?id=eq.${ledgerEntryId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'processing',
        transfer_reference: transferData.data.reference,
        transfer_attempted_at: new Date().toISOString(),
      }),
    });

    return res.status(200).json({ success: true, reference: transferData.data.reference, transferStatus: transferData.data.status });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong initiating the payout' });
  }
}
