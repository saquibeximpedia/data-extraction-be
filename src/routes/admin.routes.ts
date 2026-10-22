import { Router } from 'express';
import * as admin from '../controllers/admin.controller';
import { requireAdmin } from '../middlewares/auth.middleware';

/** Account management, admins only */
export const adminRoutes = Router();

adminRoutes.use(requireAdmin);
adminRoutes.get('/users', admin.listUsers);
adminRoutes.post('/users', admin.createUser);
adminRoutes.patch('/users/:id', admin.updateUser);
adminRoutes.delete('/users/:id', admin.deleteUser);
