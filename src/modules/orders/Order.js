import mongoose from 'mongoose';
import { embeddedOrderItemSchema } from '../orderItems/OrderItem.js';
 
const orderSchema = new mongoose.Schema({
  type: { type: String, enum: ['delivery', 'Onsite'], required: true },
  orderId: { type: String, unique: true },
  user_id: { type: String, required: true },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  customer: {
    userId: { type: String },
    email: { type: String },
    username: { type: String },
    name: { type: String },
    contact: { type: String },
    address: { type: String },
    note: { type: String },
    kitchenNote: { type: String }
  },
  customerSnapshot: {
    name: { type: String },
    phone: { type: String },
    email: { type: String },
    address: { type: String },
    note: { type: String },
  },
  bookingDate: { type: String },
  bookingTime: { type: String },
  tableId: { type: String },
  reservationPax: { type: Number },
  note_global: { type: String },
  cancelReason: { type: String },
  cancelledBy: {
    userId: { type: String },
    name: { type: String },
    role: { type: String },
  },
  rider: { userId: String, name: String, phone: String, vehicle: String, plate: String },
  orderList: [embeddedOrderItemSchema],
  payment: {
    method: { type: String },
    amount: { type: Number },
    transactionId: { type: String },
    slipUrl: { type: String },
    paidAt: { type: Date }
  },
  receiptUrl: { type: String },
  evidenceImage: { type: String },
  deliveredAt: { type: Date },
  inventoryDeductedAt: { type: Date },
  status: { 
    type: String, 
    enum: ['pending', 'reserved', 'checked-in', 'preparing', 'completed', 'delivery', 'shipping', 'finished', 'delivered', 'received', 'cancelled'], 
    default: 'pending' 
  },
  createdAt: { type: Date, default: Date.now }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

orderSchema.virtual('items').get(function() {
  return this.orderList;
});

orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ user_id: 1, createdAt: -1 });
orderSchema.index({ 'customer.userId': 1, createdAt: -1 });
orderSchema.index({ type: 1, status: 1, createdAt: -1 });

// Virtual: alias orderList as items for frontend compatibility
orderSchema.virtual('items').get(function () {
  return this.orderList;
});

orderSchema.virtual('total').get(function () {
  const CANCELLED = new Set(['cancel', 'cancelled'])
  const items = Array.isArray(this.orderList) ? this.orderList : []
  const subtotal = items.reduce((sum, item) => {
    if (CANCELLED.has(item?.status)) return sum
    const qty = Number(item?.quantity) || 1
    const price = Number(item?.price ?? item?.price_at_purchase ?? 0)
    return sum + price * qty
  }, 0)
  const tax = subtotal * 0.07
  return Math.round((subtotal + tax) * 100) / 100
})

orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

export const Order = mongoose.model('Order', orderSchema);
