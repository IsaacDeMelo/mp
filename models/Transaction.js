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
      required: false,
      index: true
    },
    buyerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    buyerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true
    },
    buyerPhone: {
      type: String,
      required: false,
      trim: true,
      maxlength: 30
    },
    quantityWithoutLunch: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    quantityWithLunch: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    baseTicketPrice: {
      type: Number,
      required: true,
      default: 1
    },
    lunchAddonPrice: {
      type: Number,
      required: true,
      default: 0.5
    },
    subtotalAmount: {
      type: Number,
      required: true,
      min: 0.01
    },
    discountAmount: {
      type: Number,
      required: true,
      default: 0
    },
    couponCode: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      index: true
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01
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
