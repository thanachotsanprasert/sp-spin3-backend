import { Router } from 'express';
import mongoose from 'mongoose';

export const router = Router();

const ADMIN_KEY = process.env.SPC_ADMIN_KEY;

const COLLECTIONS = {
  orders: 'orders',
  ingredients: 'ingredients',
  menus: 'menus',
  tables: 'tables',
  users: 'users',
  promotions: 'promotions',
  waste: 'wastes',
  deliveries: 'deliveries',
};

router.post('/', async (req, res) => {
  const key = req.headers['x-spc-key'];
  if (!key || key !== ADMIN_KEY) {
    return res.status(404).json({ message: 'Not found' });
  }

  const { collection, action, query = {}, data = {}, options = {} } = req.body;

  if (!collection || !COLLECTIONS[collection]) {
    return res.status(400).json({ message: 'Invalid collection' });
  }

  if (!action) {
    return res.status(400).json({ message: 'Action required' });
  }

  try {
    const col = mongoose.connection.db.collection(COLLECTIONS[collection]);
    let result;

    const parseQuery = (q) => {
      if (q._id && typeof q._id === 'string') {
        try { q._id = new mongoose.Types.ObjectId(q._id) } catch {}
      }
      return q;
    };

    switch (action) {
      case 'find':
        result = await col.find(parseQuery(query)).limit(options.limit || 100).toArray();
        break;
      case 'findOne':
        result = await col.findOne(parseQuery(query));
        break;
      case 'create':
        result = await col.insertOne({ ...data, createdAt: new Date(), updatedAt: new Date() });
        break;
      case 'update':
        result = await col.updateMany(parseQuery(query), { $set: { ...data, updatedAt: new Date() } });
        break;
      case 'updateOne':
        result = await col.updateOne(parseQuery(query), { $set: { ...data, updatedAt: new Date() } });
        break;
      case 'delete':
        result = await col.deleteOne(parseQuery(query));
        break;
      case 'deleteMany':
        result = await col.deleteMany(parseQuery(query));
        break;
      default:
        return res.status(400).json({ message: 'Invalid action' });
    }

    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
