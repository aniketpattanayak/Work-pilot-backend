const mongoose = require('mongoose');

const BillingSchema = new mongoose.Schema({
  tenantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  plan:        { type: String, enum: ['free', 'starter', 'pro', 'enterprise', 'custom'], default: 'free' },
  amount:      { type: Number, default: 0 },        // in INR
  currency:    { type: String, default: 'INR' },
  billingCycle:{ type: String, enum: ['monthly', 'yearly', 'one-time'], default: 'monthly' },
  paidAt:      { type: Date, default: null },
  dueAt:       { type: Date, default: null },
  renewalDate: { type: Date, default: null },
  status:      { type: String, enum: ['paid', 'due', 'overdue', 'free', 'cancelled'], default: 'free' },
  notes:       { type: String, default: '' },
  invoiceId:   { type: String, default: '' },
}, { timestamps: true });

BillingSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('Billing', BillingSchema);
