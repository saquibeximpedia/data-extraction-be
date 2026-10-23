import { Router } from 'express';
import * as countries from '../controllers/country.controller';

export const countryRoutes = Router();

countryRoutes.get('/', countries.list);
