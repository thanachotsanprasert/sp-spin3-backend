import { Router } from 'express';
import { Table } from '../modules/tables/Table.js';
import { Order } from '../modules/orders/Order.js';
import { broadcastTableOrderUpdate } from '../realtime/tableOrderSocket.js';
import { sseHandler } from '../utils/sse.js';

export const router = Router();

const toOwnerStatus = (status) => {
  const map = {
    FREE: 'Available',
    OCCUPIED: 'Eating',
    BILL: 'Payment',
    RESERVED: 'Reserved',
  };
  return map[status] || 'Available';
};

const toBackendStatus = (status) => {
  const map = {
    Available: 'FREE',
    Eating: 'OCCUPIED',
    Cooking: 'RESERVED',
    Reserved: 'RESERVED',
    Payment: 'BILL',
  };
  return map[status] || status;
};

const getTableNumber = (table) => {
  if (table.number) return table.number;
  const match = String(table.table_Id || '').match(/\d+/);
  return match ? Number(match[0]) : 0;
};

const normalizeSlot = (value = '') => String(value).replace(/\s+/g, '');

router.get('/stream', sseHandler);

router.get('/availability', async (req, res) => {
  try {
    const date = String(req.query.date || '');
    const timeSlot = String(req.query.timeSlot || '');
    const pax = Number(req.query.pax || 1);

    if (!date || !timeSlot) {
      return res.status(400).json({ message: 'date and timeSlot are required' });
    }

    const tables = await Table.find({
      active_status: { $ne: false },
      onlineReservable: { $ne: false },
      seats: { $gte: pax },
    }).sort({ seats: 1, number: 1, table_Id: 1 });

    const tableIds = tables.map((table) => table.table_Id);
    const reservations = await Order.find({
      bookingDate: date,
      tableId: { $in: tableIds },
      status: { $nin: ['cancelled', 'completed', 'delivered', 'received'] },
    }).select('bookingTime tableId');

    const busyTableIds = new Set(
      reservations
        .filter((order) => normalizeSlot(order.bookingTime) === normalizeSlot(timeSlot))
        .map((order) => order.tableId),
    );

    const availableTable = tables.find((table) => !busyTableIds.has(table.table_Id));
    res.json({
      available: Boolean(availableTable),
      tableId: availableTable?.table_Id || '',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const toOwnerTable = (table) => ({
  id: String(table._id),
  table_Id: table.table_Id,
  number: getTableNumber(table),
  area: table.area || 'Main Floor',
  seats: table.seats || 4,
  x: table.x ?? 50,
  y: table.y ?? 50,
  onlineReservable: table.onlineReservable !== false,
  status: toOwnerStatus(table.status),
  seatedAt: table.seatedAt,
  active: table.active_status,
});

router.get('/', async (req, res) => {
  try {
    const tables = await Table.find({ active_status: { $ne: false } }).sort({ number: 1, table_Id: 1 });
    res.json(tables.map(toOwnerTable));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const number = Number(req.body.number);
    const table = await Table.create({
      table_Id: req.body.table_Id || `T${String(number || Date.now()).padStart(2, '0')}`,
      number,
      area: req.body.area || 'Main Floor',
      seats: Number(req.body.seats || 4),
      x: Number(req.body.x ?? 50),
      y: Number(req.body.y ?? 50),
      onlineReservable: req.body.onlineReservable !== false,
      status: toBackendStatus(req.body.status || 'Available'),
      seatedAt: req.body.status && req.body.status !== 'Available' ? new Date() : null,
      active_status: true,
    });

    await broadcastTableOrderUpdate();
    res.status(201).json(toOwnerTable(table));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const updates = {};
    if (req.body.status !== undefined) {
      updates.status = toBackendStatus(req.body.status);
      updates.seatedAt = req.body.status === 'Available' ? null : new Date();
    }
    if (req.body.area !== undefined) updates.area = req.body.area;
    if (req.body.seats !== undefined) updates.seats = Number(req.body.seats);
    if (req.body.x !== undefined) updates.x = Number(req.body.x);
    if (req.body.y !== undefined) updates.y = Number(req.body.y);
    if (req.body.onlineReservable !== undefined) updates.onlineReservable = Boolean(req.body.onlineReservable);
    if (req.body.active !== undefined) updates.active_status = Boolean(req.body.active);

    const table = await Table.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!table) return res.status(404).json({ message: 'Table not found' });
    await broadcastTableOrderUpdate();
    res.json(toOwnerTable(table));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const table = await Table.findByIdAndUpdate(
      req.params.id,
      { active_status: false },
      { new: true }
    )
    if (!table) return res.status(404).json({ message: 'Table not found' })
    await broadcastTableOrderUpdate()
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})
