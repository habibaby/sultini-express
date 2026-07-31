// /api/reset-rider-password.js
//
// Riders log in with a phone-derived synthetic email, so there's no real
// inbox for Supabase's normal "send reset link" flow to reach. Instead,
// admin sets a new password directly here when a rider calls/WhatsApps
// asking for one — using the Supabase Admin API with the service role key.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { riderId, newPassword } = req.body;
  if (!riderId || !newPassword) {
    return res.status(400).json({ error: 'Missing riderId or newPassword' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminHeaders = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

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
    if (!updateRes.ok) {
      return res.status(400).json({ error: updateData.msg || 'Could not reset password' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong resetting the password' });
  }
}
