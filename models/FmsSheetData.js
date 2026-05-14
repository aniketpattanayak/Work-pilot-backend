const mongoose = require('mongoose');

const FmsSheetDataSchema = new mongoose.Schema({
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FmsTemplate'
  },

  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant'
  },

  orderIdentifier: String,     // Order ID
  lineItemId: String,          // Line Item ID (🔥 VERY IMPORTANT)

  sheetRowId: String,

  rawData: mongoose.Schema.Types.Mixed, // FULL ROW

}, { timestamps: true });

// 🔥 PREVENT DUPLICATION
FmsSheetDataSchema.index(
  { templateId: 1, orderIdentifier: 1, lineItemId: 1 },
  { unique: true }
);

module.exports = mongoose.model('FmsSheetData', FmsSheetDataSchema);