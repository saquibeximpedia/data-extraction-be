/**
 * Creates the first admin account (or promotes an existing user to admin).
 *
 *   npm run create-admin -- --email you@company.com --password 'a-long-password'
 *
 * Later accounts are created by admins in the UI (Admin page).
 */
import { supabase } from '../config/supabase';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function findByEmail(email: string) {
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match || data.users.length < 200) return match;
  }
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const password = arg('password');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Pass --email you@company.com');

  const existing = await findByEmail(email);
  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      app_metadata: { ...existing.app_metadata, role: 'admin' },
      ...(password && { password }),
    });
    if (error) throw error;
    console.log(`✅ ${email} is now an admin${password ? ' (password updated)' : ''}.`);
    return;
  }

  if (!password || password.length < 8) throw new Error('Pass --password with at least 8 characters');
  const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: 'admin' } });
  if (error) throw error;
  console.log(`✅ Admin ${email} created. Sign in to the web UI with this email and password.`);
}

main().catch((err) => {
  console.error(`❌ ${err.message ?? err}`);
  process.exit(1);
});
