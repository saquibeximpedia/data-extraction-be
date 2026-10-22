import { Request, Response } from 'express';
import { User } from '@supabase/supabase-js';
import { roleOf, supabase } from '../config/supabase';
import { currentUser, forgetUser } from '../middlewares/auth.middleware';
import { parse } from '../middlewares/validate.middleware';
import { createUserSchema, updateUserSchema } from '../schemas';
import { badRequest, HttpError } from '../utils/errors';

const describe = (u: User) => ({
  id: u.id,
  email: u.email ?? '',
  role: roleOf(u),
  createdAt: u.created_at,
  lastSignInAt: u.last_sign_in_at ?? null,
});

/** Supabase errors become 400s with Supabase's own message (e.g. "User already registered") */
function fail(error: { message: string; status?: number }): never {
  throw new HttpError(error.status && error.status < 500 ? 400 : 502, error.message);
}

async function allUsers(): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(error);
    users.push(...data.users);
    if (data.users.length < 200) return users;
  }
}

/** GET /api/admin/users */
export async function listUsers(_req: Request, res: Response): Promise<void> {
  const users = (await allUsers()).map(describe).sort((a, b) => a.email.localeCompare(b.email));
  res.json({ users });
}

/** POST /api/admin/users { email, password, role } → account ready to sign in (no confirmation email) */
export async function createUser(req: Request, res: Response): Promise<void> {
  const body = parse(createUserSchema, req.body);
  const { data, error } = await supabase.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    app_metadata: { role: body.role },
  });
  if (error) fail(error);
  res.status(201).json(describe(data.user));
}

/** PATCH /api/admin/users/:id { role?, password? } */
export async function updateUser(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const body = parse(updateUserSchema, req.body);
  if (id === currentUser(res).id && body.role === 'user') throw badRequest('You cannot remove your own admin role.');
  const { data, error } = await supabase.auth.admin.updateUserById(id, {
    ...(body.password && { password: body.password }),
    ...(body.role && { app_metadata: { role: body.role } }),
  });
  if (error) fail(error);
  forgetUser(id);
  res.json(describe(data.user));
}

/** DELETE /api/admin/users/:id */
export async function deleteUser(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  if (id === currentUser(res).id) throw badRequest('You cannot delete your own account.');
  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) fail(error);
  forgetUser(id);
  res.json({ deleted: id });
}
