import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { isAuth, isEligible } from '../middleware/auth.js';
import { Ingredient } from '../modules/ingredients/Ingredient.js';
import { IngredientLot } from '../modules/ingredients/IngredientLot.js';
import { Order } from '../modules/orders/Order.js';
import { Promotion } from '../modules/promotions/Promotion.js';
import { User } from '../modules/users/User.js';
import { Waste } from '../modules/wastes/Waste.js';
import { processExpiredIngredientLots, syncIngredientState, consumeFromLots, withInventoryTransaction } from '../modules/ingredients/inventoryLifecycle.js';

export const router = Router();

const ownerOnly = [isAuth, isEligible('owner')];
const staffRoles = ['owner', 'cashier', 'cook', 'rider', 'waitress'];

const roleToOwnerRole = (role) => {
  const map = {
    cook: 'kitchen',
    waitress: 'server',
    rider: 'server',
  };
  return map[role] || role;
};

const ownerRoleToUserRole = (role) => {
  const map = {
    kitchen: 'cook',
    server: 'waitress',
    manager: 'cashier',
  };
  return map[role] || role;
};

const buildDateFilter = (period) => {
  const BKK_OFFSET = 7 * 60 * 60 * 1000;
  const nowUTC = Date.now();
  const nowBKK = new Date(nowUTC + BKK_OFFSET);

  const todayBKK = new Date(nowBKK);
  todayBKK.setUTCHours(0, 0, 0, 0);
  const todayStartUTC = new Date(todayBKK.getTime() - BKK_OFFSET);

  if (period === 'today') {
    return { $gte: todayStartUTC, $lte: new Date(nowUTC) };
  }

  if (period === 'month') {
    const monthStartBKK = new Date(nowBKK);
    monthStartBKK.setUTCDate(1);
    monthStartBKK.setUTCHours(0, 0, 0, 0);
    const monthStartUTC = new Date(monthStartBKK.getTime() - BKK_OFFSET);
    return { $gte: monthStartUTC, $lte: new Date(nowUTC) };
  }

  const weekStartUTC = new Date(todayStartUTC.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { $gte: weekStartUTC, $lte: new Date(nowUTC) };
};

const getOrderTotal = (order) => {
  if (Number.isFinite(Number(order.payment?.amount))) {
    return Number(order.payment.amount);
  }

  return (order.orderList || []).reduce((sum, item) => {
    if (['cancel', 'cancelled'].includes(item.status)) return sum;
    const price = Number(item.price_at_purchase ?? item.price ?? 0);
    const quantity = Number(item.quantity || 0);
    return sum + price * quantity;
  }, 0);
};

const roundQuantity = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
};

const parseRequiredExpiryDate = (expiryDate) => {
  if (!expiryDate) return null;
  const parsedDate = new Date(expiryDate);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
};

const getCustomerTier = (totalSpent) => {
  if (totalSpent >= 50000) return 'VIP';
  if (totalSpent >= 20000) return 'Gold';
  if (totalSpent >= 5000) return 'Silver';
  return 'Basic';
};

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeWasteReason = (reason) => {
  const validReasons = new Set(['Expired', 'Wrong Order', 'Accident/Spill', 'Quality Control']);
  return validReasons.has(reason) ? reason : 'Quality Control';
};

const toStockLot = (ingredient) => ({
  id: String(ingredient._id),
  ingredientName: ingredient.name,
  quantity: ingredient.quantity,
  unit: ingredient.unit,
  price: ingredient.price_per_unit,
  reorderPoint: ingredient.low_stock_threshold,
  expiryDate: ingredient.expiryDate || null,
  active: ingredient.active_status,
});

const toWasteEntry = (entry) => {
  const ingredient = entry.ingredient;
  const user = entry.user;

  return {
    id: String(entry._id),
    itemName: entry.itemName || ingredient?.name || 'Unknown item',
    reason: normalizeWasteReason(entry.reason),
    quantity: entry.quantity ?? entry.quantity_wasted ?? 0,
    unit: entry.unit || ingredient?.unit || '',
    estimatedCost: entry.estimatedCost ?? entry.total_cost ?? 0,
    recordedBy: entry.recordedBy || user?.name || 'Owner',
    date: entry.date || entry.createdAt,
  };
};

const toPromotion = (promotion) => ({
  id: String(promotion._id),
  name: promotion.name,
  code: promotion.code || promotion.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, ''),
  discountType: promotion.type,
  discountValue: promotion.value,
  startDate: promotion.date_from,
  endDate: promotion.date_to,
  active: promotion.active_status,
  usageCount: promotion.usageCount || 0,
  totalAmountSaved: promotion.totalAmountSaved || 0,
});

const toStaffMember = (user) => ({
  id: String(user._id),
  name: `${user.name || ''} ${user.surname || ''}`.trim() || user.username,
  email: user.email,
  role: roleToOwnerRole(user.role),
  area: user.role === 'cook' ? 'Kitchen' : user.role === 'rider' ? 'Delivery' : 'Front of house',
  lastLogin: user.updatedAt || user.createdAt,
  isLocked: user.active_status === false,
  on_duty: user.on_duty,
  isPending: false,
});

router.get('/summary', ownerOnly, async (req, res) => {
  try {
    const { period, startDate, endDate } = req.query;
    let dateFilter = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter = { $gte: start, $lte: end };
    } else {
      dateFilter = buildDateFilter(period);
    }

    const stats = await Order.aggregate([
      { $match: { createdAt: dateFilter } },
      {
        $group: {
          _id: null,
          revenue: {
            $sum: {
              $cond: [
                { $in: ['$status', ['finished', 'delivered', 'completed', 'received']] },
                { $ifNull: ['$payment.amount', 0] },
                0
              ]
            }
          },
          orderCount: { $sum: 1 },
          activeTables: {
            $sum: {
              $cond: [
                { $and: [
                  { $in: ['$status', ['pending', 'preparing']] },
                  { $eq: ['$type', 'Onsite'] }
                ]},
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const result = stats[0] || { revenue: 0, orderCount: 0, activeTables: 0 };

    res.json({
      revenue: result.revenue,
      orders: result.orderCount,
      aov: result.orderCount ? result.revenue / result.orderCount : 0,
      activeTables: result.activeTables,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/stock', ownerOnly, async (req, res) => {
  try {
    const ingredients = await Ingredient.find().sort({ name: 1 });
    res.json(ingredients.map(toStockLot));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/stock/:id', ownerOnly, async (req, res) => {
  try {
    const currentIngredient = await Ingredient.findById(req.params.id).select('_id');
    if (!currentIngredient) return res.status(404).json({ message: 'Stock item not found' });

    const updates = {};
    if (req.body.ingredientName !== undefined || req.body.name !== undefined) {
      const nextName = String(req.body.ingredientName ?? req.body.name).trim();
      if (!nextName) return res.status(400).json({ message: 'Ingredient name is required' });
      const duplicate = await Ingredient.findOne({
        _id: { $ne: currentIngredient._id },
        name: new RegExp(`^${escapeRegex(nextName)}$`, 'i'),
      });
      if (duplicate) return res.status(409).json({ message: 'Ingredient name already exists' });
      updates.name = nextName;
    }
    if (req.body.unit !== undefined) {
      const nextUnit = String(req.body.unit).trim();
      if (!nextUnit) return res.status(400).json({ message: 'Unit is required' });
      updates.unit = nextUnit;
    }
    if (req.body.price !== undefined) updates.price_per_unit = Number(req.body.price);
    if (req.body.reorderPoint !== undefined) updates.low_stock_threshold = roundQuantity(req.body.reorderPoint);
    if (req.body.active !== undefined) updates.active_status = Boolean(req.body.active);

    const saved = await withInventoryTransaction(async (session) => {
      const ingredient = await Ingredient.findById(req.params.id).session(session);
      if (!ingredient) {
        const error = new Error('Stock item not found');
        error.statusCode = 404;
        throw error;
      }

      // Apply basic updates
      Object.assign(ingredient, updates);
      await ingredient.save({ session });

      // Handle quantity and expiry changes via lots
      if (req.body.quantity !== undefined || req.body.expiryDate !== undefined) {
        const newQty = req.body.quantity !== undefined ? roundQuantity(req.body.quantity) : ingredient.quantity;
        const newExpiry = req.body.expiryDate !== undefined ? (req.body.expiryDate ? new Date(req.body.expiryDate) : null) : ingredient.expiryDate;

        const diff = roundQuantity(newQty - ingredient.quantity);
        if (diff !== 0 || (req.body.expiryDate !== undefined && String(newExpiry) !== String(ingredient.expiryDate))) {
          if (diff > 0) {
            const lotExpiryDate = parseRequiredExpiryDate(newExpiry);
            if (!lotExpiryDate) {
              const error = new Error('Expiry date is required when adding stock');
              error.statusCode = 400;
              throw error;
            }
            await IngredientLot.create([{
              ingredient: ingredient._id,
              quantity: diff,
              remainingQuantity: diff,
              unit: updates.unit || ingredient.unit,
              expiryDate: lotExpiryDate,
              type: 'IN',
              reason: 'Owner dashboard update',
            }], { session });
          } else if (diff < 0) {
            await consumeFromLots(ingredient._id, Math.abs(diff), 'ADJUSTMENT', 'Owner dashboard update', { session });
          } else if (req.body.expiryDate !== undefined) {
            const earliestLot = await IngredientLot.findOne({
              ingredient: ingredient._id,
              type: 'IN',
              remainingQuantity: { $gt: 0 },
            }).sort({ expiryDate: 1, createdAt: 1 }).session(session);
            
            if (earliestLot) {
              earliestLot.expiryDate = newExpiry;
              await earliestLot.save({ session });
            }
          }
        }
      }

      await syncIngredientState(ingredient._id, { session });
      if (updates.unit !== undefined) {
        await IngredientLot.updateMany(
          { ingredient: ingredient._id, type: 'IN' },
          { $set: { unit: updates.unit } },
          { session },
        );
      }
      return Ingredient.findById(ingredient._id).session(session);
    });
    res.json(toStockLot(saved));
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message });
  }
});

router.get('/waste', ownerOnly, async (req, res) => {
  try {
    const waste = await Waste.find()
      .populate('ingredient')
      .populate('user', 'name surname email')
      .sort({ createdAt: -1 });

    res.json(waste.map(toWasteEntry));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/waste', ownerOnly, async (req, res) => {
  try {
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    const created = await withInventoryTransaction(async (session) => {
      const createdWaste = [];

      for (const entry of entries) {
        const quantity = roundQuantity(entry.quantity || 0);
        if (quantity <= 0) {
          const error = new Error('Waste quantity must be positive');
          error.statusCode = 400;
          throw error;
        }

        const ingredient = entry.ingredient
          ? await Ingredient.findById(entry.ingredient).session(session)
          : await Ingredient.findOne({ name: new RegExp(`^${escapeRegex(entry.itemName)}$`, 'i') }).session(session);

        const [waste] = await Waste.create([{
          ingredient: ingredient?._id,
          user: req.user.id,
          itemName: entry.itemName || ingredient?.name,
          reason: normalizeWasteReason(entry.reason),
          quantity,
          unit: entry.unit || ingredient?.unit || '',
          estimatedCost: Number(entry.estimatedCost || 0),
          recordedBy: entry.recordedBy || 'Owner',
          date: entry.date ? new Date(entry.date) : new Date(),
          quantity_wasted: quantity,
          total_cost: Number(entry.estimatedCost || 0),
        }], { session });

        if (ingredient) {
          await consumeFromLots(ingredient._id, quantity, 'WASTE', `Manual waste: ${waste.reason}`, { session });
          await syncIngredientState(ingredient._id, { session });
        }
        createdWaste.push(waste);
      }

      return createdWaste;
    });

    res.status(201).json(created.map(toWasteEntry));
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message });
  }
});

router.get('/promotions', ownerOnly, async (req, res) => {
  try {
    const promotions = await Promotion.find().sort({ date_from: -1 });
    res.json(promotions.map(toPromotion));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/promotions', ownerOnly, async (req, res) => {
  try {
    const startDate = req.body.startDate || req.body.date_from || new Date();
    const endDate = req.body.endDate || req.body.date_to || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const promotion = await Promotion.create({
      name: req.body.name,
      type: req.body.discountType || req.body.type || 'fixed',
      value: Number(req.body.discountValue ?? req.body.value ?? 0),
      date_from: startDate,
      date_to: endDate,
      active_status: req.body.active !== undefined ? Boolean(req.body.active) : true,
    });

    res.status(201).json(toPromotion(promotion));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch('/promotions/:id', ownerOnly, async (req, res) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.discountType !== undefined) updates.type = req.body.discountType;
    if (req.body.discountValue !== undefined) updates.value = Number(req.body.discountValue);
    if (req.body.startDate !== undefined) updates.date_from = req.body.startDate;
    if (req.body.endDate !== undefined) updates.date_to = req.body.endDate;
    if (req.body.active !== undefined) updates.active_status = Boolean(req.body.active);

    const promotion = await Promotion.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!promotion) return res.status(404).json({ message: 'Promotion not found' });
    res.json(toPromotion(promotion));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/promotions/:id', ownerOnly, async (req, res) => {
  try {
    const promotion = await Promotion.findByIdAndDelete(req.params.id);
    if (!promotion) return res.status(404).json({ message: 'Promotion not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/customers', ownerOnly, async (req, res) => {
  try {
    const [customers, orders] = await Promise.all([
      User.find({ role: 'customer' }).sort({ name: 1 }),
      Order.find().sort({ createdAt: -1 }),
    ]);

    const ordersByCustomer = new Map();
    orders.forEach((order) => {
      const keys = [
        order.customer?.contact,
        order.customer?.name,
      ].filter(Boolean);

      keys.forEach((key) => {
        const normalizedKey = String(key).toLowerCase();
        const list = ordersByCustomer.get(normalizedKey) || [];
        list.push(order);
        ordersByCustomer.set(normalizedKey, list);
      });
    });

    const result = customers.map((customer) => {
      const name = `${customer.name || ''} ${customer.surname || ''}`.trim();
      const matchedOrders = [
        ...(ordersByCustomer.get(String(customer.email).toLowerCase()) || []),
        ...(ordersByCustomer.get(String(customer.username).toLowerCase()) || []),
        ...(ordersByCustomer.get(name.toLowerCase()) || []),
      ];
      const uniqueOrders = [...new Map(matchedOrders.map((order) => [String(order._id), order])).values()];
      const totalSpent = uniqueOrders.reduce((sum, order) => sum + getOrderTotal(order), 0);
      const lastOrder = uniqueOrders[0];

      return {
        id: String(customer._id),
        name,
        phone: customer.username,
        email: customer.email,
        tier: getCustomerTier(totalSpent),
        points: Math.floor(totalSpent / 10),
        totalSpent,
        lastVisit: lastOrder?.createdAt || customer.updatedAt || customer.createdAt,
        lastChannel: lastOrder?.type || 'online',
        active: customer.active_status,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/customers/:id', ownerOnly, async (req, res) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.email !== undefined) updates.email = req.body.email;
    if (req.body.phone !== undefined) updates.username = req.body.phone;
    if (req.body.active !== undefined) updates.active_status = Boolean(req.body.active);

    const customer = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'customer' },
      updates,
      { new: true, runValidators: true },
    );

    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    res.json({
      id: String(customer._id),
      name: `${customer.name || ''} ${customer.surname || ''}`.trim(),
      phone: customer.username,
      email: customer.email,
      tier: 'Basic',
      points: 0,
      totalSpent: 0,
      lastVisit: customer.updatedAt,
      lastChannel: 'online',
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/staff', isAuth, isEligible('owner'), async (req, res) => {
  try {
    const staff = await User.find({ role: { $in: staffRoles } }).sort({ role: 1, name: 1 });
    res.json(staff.map(toStaffMember));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/staff', isAuth, isEligible('owner'), async (req, res) => {
  try {
    const { email, role } = req.body;
    const userRole = ownerRoleToUserRole(role);
    const username = email?.split('@')[0];

    if (!email || !userRole) {
      return res.status(400).json({ message: 'Email and role are required' });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email or username already exists' });
    }

    const password = await bcrypt.hash(`Temp-${Date.now()}`, 10);
    const user = await User.create({
      name: username,
      surname: 'Staff',
      username,
      email,
      password,
      role: userRole,
    });

    res.status(201).json(toStaffMember(user));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch('/staff/:id', isAuth, isEligible('owner'), async (req, res) => {
  try {
    const updates = {};
    if (req.body.isLocked !== undefined) updates.active_status = !req.body.isLocked;
    if (req.body.role !== undefined) updates.role = ownerRoleToUserRole(req.body.role);

    const staff = await User.findOneAndUpdate(
      { _id: req.params.id, role: { $in: staffRoles } },
      updates,
      { new: true, runValidators: true },
    );

    if (!staff) return res.status(404).json({ message: 'Staff member not found' });
    res.json(toStaffMember(staff));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/staff/:id', isAuth, isEligible('owner'), async (req, res) => {
  try {
    const { User } = await import('../modules/users/User.js');
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'Staff not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
