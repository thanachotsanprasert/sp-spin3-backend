import { Router } from 'express';
import { router as authRouter } from './auth.js';
import { router as menuRouter } from './menu.js';
import { router as ownerRouter } from './owner.js';
import { router as tableRouter } from './table.js';
import { isAuth, isEligible } from '../middleware/auth.js';
import { Menu } from '../modules/menus/Menu.js';
import { Order } from '../modules/orders/Order.js';
import { getNextOrderId } from '../modules/orders/orderId.js';

export const router = Router();
const orderAdminAccess = [isAuth, isEligible('owner', 'cashier')];

const toOwnerOrderType = (type) => {
  if (type === 'delivery') return 'Delivery';
  if (type === 'Onsite') return 'In-Restaurant';
  return 'Take Away';
};

const toOwnerOrderStatus = (status) => {
  const map = {
    pending: 'New',
    preparing: 'Cooking',
    completed: 'Ready',
    delivery: 'Delivery',
    finished: 'Finished',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  };
  return map[status] || status;
};

const toBackendOrderStatus = (status) => {
  const map = {
    New: 'pending',
    Cooking: 'preparing',
    Ready: 'completed',
    Delivery: 'delivery',
    Finished: 'finished',
    Paid: 'completed',
    Delivered: 'delivered',
    Cancelled: 'cancelled',
  };
  return map[status] || status;
};

const toBackendOrderType = (type) => {
  if (type === 'Delivery' || type === 'delivery') return 'delivery';
  return 'Onsite';
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

const toOwnerOrder = (order) => ({
  id: String(order._id),
  orderId: order.orderId || null,
  type: toOwnerOrderType(order.type),
  status: toOwnerOrderStatus(order.status),
  items: (order.orderList || []).map((item) => ({
    id: String(item._id),
    name: item.name || 'Menu item',
    quantity: item.quantity,
    price: item.price_at_purchase ?? item.price ?? 0,
    status: item.status || 'InKitchen',
    note: item.note || '',
  })),
  total: getOrderTotal(order),
  tableId: order.tableId || '',
  customer: order.customer,
  createdAt: order.createdAt,
});

const toOwnerOrderDetail = async (order) => {
  const menuIds = (order.orderList || []).map((item) => item.menu_id).filter(Boolean);
  const names = (order.orderList || []).map((item) => item.name).filter(Boolean);
  const menus = await Menu.find({
    $or: [
      { _id: { $in: menuIds } },
      { name: { $in: names } },
    ],
  }).populate('ingredients.ingredient');
  const menusById = new Map(menus.map((menu) => [String(menu._id), menu]));
  const menusByName = new Map(menus.map((menu) => [menu.name, menu]));

  return {
    ...toOwnerOrder(order),
    payment: order.payment,
    bookingDate: order.bookingDate,
    bookingTime: order.bookingTime,
    items: (order.orderList || []).map((item) => {
      const menu = menusById.get(String(item.menu_id || '')) || menusByName.get(item.name);
      return {
        id: String(item._id),
        menuId: item.menu_id ? String(item.menu_id) : '',
        name: item.name || menu?.name || 'Menu item',
        quantity: item.quantity,
        price: item.price_at_purchase ?? item.price ?? 0,
        status: item.status || 'InKitchen',
        note: item.note || '',
        menu: menu ? {
          id: String(menu._id),
          name: menu.name,
          category: menu.category,
          cookingTime: menu.cookingTime,
          available: menu.available,
        } : null,
        ingredients: menu?.ingredients?.map((entry) => ({
          id: entry.ingredient?._id ? String(entry.ingredient._id) : '',
          lotId: entry.ingredient?._id ? String(entry.ingredient._id) : '',
          name: entry.ingredient?.name || 'Unknown ingredient',
          quantityPerItem: entry.quantity,
          requiredQuantity: Number(entry.quantity || 0) * Number(item.quantity || 0),
          availableQuantity: entry.ingredient?.quantity ?? 0,
          unit: entry.ingredient?.unit || '',
          pricePerUnit: entry.ingredient?.price_per_unit ?? 0,
          expiryDate: entry.ingredient?.expiryDate || null,
        })) || [],
      };
    }),
  };
};

const buildOrderUpdates = (body) => {
  const updates = {};

  if (body.status !== undefined) updates.status = toBackendOrderStatus(body.status);
  if (body.type !== undefined) updates.type = toBackendOrderType(body.type);
  if (body.customer !== undefined) updates.customer = body.customer;
  if (body.items !== undefined) {
    updates.orderList = body.items.map((item) => ({
      ...(item.id ? { _id: item.id } : {}),
      name: item.name || 'Menu item',
      quantity: Number(item.quantity || 1),
      price: Number(item.price || 0),
      price_at_purchase: Number(item.price || 0),
      status: item.status || 'InKitchen',
      note: item.note || '',
    }));
  }
  if (body.total !== undefined) {
    updates.payment = {
      amount: Number(body.total || 0),
      method: body.paymentMethod || 'manual',
    };
  }

  return updates;
};

const normalizeOrderItems = (items = []) => items.map((item) => ({
  name: item.name || 'Menu item',
  quantity: Number(item.quantity || 1),
  price: Number(item.price || 0),
  price_at_purchase: Number(item.price || 0),
  status: item.status || 'InKitchen',
  note: item.note || '',
}));

router.use('/auth', authRouter);
router.use('/owner', ownerRouter);
router.use('/menus', menuRouter);
router.use('/tables', tableRouter);

router.get('/orders', orderAdminAccess, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders.map(toOwnerOrder));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/orders/:id', orderAdminAccess, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(await toOwnerOrderDetail(order));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/orders/:id', orderAdminAccess, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      buildOrderUpdates(req.body),
      { new: true, runValidators: true },
    );

    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(toOwnerOrder(order));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post('/orders', orderAdminAccess, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const total = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
    const order = await Order.create({
      orderId: await getNextOrderId(),
      type: toBackendOrderType(req.body.type || 'In-Restaurant'),
      user_id: String(req.user.id),
      customerId: req.user.id,
      customer: req.body.customer || {},
      customerSnapshot: {
        name: req.body.customer?.name || '',
        phone: req.body.customer?.phone || req.body.customer?.contact || '',
        email: req.body.customer?.email || '',
        address: req.body.customer?.address || '',
        note: req.body.customer?.note || '',
      },
      orderList: normalizeOrderItems(items),
      payment: {
        amount: Number(req.body.total ?? total),
        method: req.body.paymentMethod || 'manual',
      },
      status: toBackendOrderStatus(req.body.status || 'New'),
    });

    res.status(201).json(toOwnerOrder(order));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/orders/:id', orderAdminAccess, async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
