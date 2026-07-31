// /api/create-rider-account.js
//
// Handles two rider-account admin actions in one file — creating a new
// rider login, and resetting a rider's password — merged together purely
// to stay under Vercel's 12-serverless-function limit on the free Hobby
// plan. Deploys were failing once the project crossed that count.
//
// Usage:
//   POST { action: 'create', password, full_name, phone, ... }        → new rider account
//   POST { action: 'reset-password', riderId, newPassword }           → reset existing rider's password
//
// Both run entirely server-side with the service_role key — doing this in
// the browser would log the ADMIN out and log them in as the rider by
// accident, since Supabase's client-side signup always switches session.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminHeaders = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

  const action = req.body?.action || 'create'; // default to 'create' so existing calls without an action still work

  // ---------- Reset an existing rider's password ----------
  if (action === 'reset-password') {
    const { riderId, newPassword } = req.body;
    if (!riderId || !newPassword) return res.status(400).json({ error: 'Missing riderId or newPassword' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    try {
      const riderRes = await fetch(`${SUPABASE_URL}/rest/v1/riders?id=eq.${riderId}&select=user_id`, { headers: adminHeaders });
      const riders = await riderRes.json();
      const userId = riders && riders[0] && riders[0].user_id;
      if (!userId) return res.status(404).json({ error: 'Rider not found or has no login account' });

      const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ password: newPassword }),
      });
      const updateData = await updateRes.json();
      if (!updateRes.ok) return res.status(400).json({ error: updateData.msg || 'Could not reset password' });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong resetting the password' });
    }
  }

  // ---------- Create a new rider account (default action) ----------
  const { password, full_name, phone, vehicle, bank_name, account_number, added_by, dedicated_vendor_id } = req.body;
  if (!password || !full_name || !phone) {
    return res.status(400).json({ error: 'Missing required rider details' });
  }

  // Riders log in with their phone number — this builds the login
  // identifier Supabase auth needs behind the scenes. Must exactly match
  // the format rider.html uses when logging in.
  const digits = phone.replace(/\D/g, '');
  const intl = digits.startsWith('234') ? digits : '234' + digits.replace(/^0/, '');
  const email = `${intl}@riders.sultini.internal`;

  try {
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name } }),
    });
    const createData = await createRes.json();
    if (!createRes.ok) {
      return res.status(400).json({ error: createData.msg || createData.error_description || 'Could not create rider account' });
    }
    const userId = createData.id;

    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ role: 'rider' }),
    });

    const riderRes = await fetch(`${SUPABASE_URL}/rest/v1/riders`, {
      method: 'POST',
      headers: { ...adminHeaders, Prefer: 'return=representation' },
      body: JSON.stringify([{
        full_name, phone, vehicle: vehicle || null, active: true,
        bank_name: bank_name || null, account_number: account_number || null,
        user_id: userId, added_by: added_by || null,
        dedicated_vendor_id: dedicated_vendor_id || null,
      }]),
    });
    const riderData = await riderRes.json();
    if (!riderRes.ok) throw new Error(JSON.stringify(riderData));

    return res.status(200).json({ success: true, rider: riderData[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong creating the rider account' });
  }
}
