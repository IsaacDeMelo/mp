const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema(
  {
    localPaymentId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01
    },
    baseAmount: {
      type: Number,
      default: 1
    },
    lunchAddon: {
      type: Number,
      default: 0
    },
    withLunch: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      required: true,
      default: 'pending',
      index: true
    },
    statusDetail: {
      type: String,
      default: null
    },
    mpPaymentId: {
      type: String,
      index: true,
      default: null
    },
    externalReference: {
      type: String,
      index: true,
      default: null
    },
    qrCode: {
      type: String,
      default: null
    },
    qrCodeBase64: {
      type: String,
      default: null
    },
    ticketUrl: {
      type: String,
      default: null
    },
    lastCheckedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Transaction', TransactionSchema);
