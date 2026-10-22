import { Router } from 'express';
import * as countries from '../controllers/country.controller';
import { requireAdmin } from '../middlewares/auth.middleware';

export const countryRoutes = Router();

countryRoutes.get('/', countries.list);
countryRoutes.post('/:code/months', countries.markMonths);
countryRoutes.post('/:code/months/remove', countries.unmarkMonths);

// Country details are edited by admins only
countryRoutes.post('/', requireAdmin, countries.create);
countryRoutes.patch('/:code', requireAdmin, countries.update);
countryRoutes.delete('/:code', requireAdmin, countries.remove);
