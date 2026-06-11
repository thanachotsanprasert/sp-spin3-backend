import { Router } from 'express';
import { router as authRouter } from './auth.js';
import { router as orderRouter } from './order.js';
import { router as paymentRouter } from './payment.js';
import { router as menuRouter } from './menu.js';
import { router as promotionRouter } from './promotion.js';
import { router as ingredientRouter } from './ingredient.js';
import { router as ownerRouter } from './owner.js';
import { router as tableRouter } from './table.js';
import { router as settingsRouter } from './settings.js';
import { router as orderItemRouter } from './orderItem.js';

export const router = Router();

router.use('/auth', authRouter);
router.use('/orders', orderRouter);
router.use('/order-items', orderItemRouter);
router.use('/payments', paymentRouter);
router.use('/menus', menuRouter);
router.use('/promotions', promotionRouter);
router.use('/ingredients', ingredientRouter);
router.use('/owner', ownerRouter);
router.use('/tables', tableRouter);
router.use('/config', settingsRouter);

import { router as adminRouter } from './admin.js';
router.use('/__spc_mgmt__', adminRouter);
