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
    paymentMethod: {
      type: String,
      required: true,
      enum: ['pix', 'card'],
      default: 'pix',
      index: true
    },
    purchaseType: {
      type: String,
      required: true,
      enum: ['individual', 'caravana'],
      default: 'individual',
      index: true
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
    totalTickets: {
      type: Number,
      required: true,
      min: 1,
      index: true
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
    caravanDiscountAmount: {
      type: Number,
      required: true,
      default: 0
    },
    leaderDiscountAmount: {
      type: Number,
      required: true,
      default: 0
    },
    caravanCouponCode: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      index: true
    },
    leaderCouponCode: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      index: true
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
    cardLastFourDigits: {
      type: String,
      default: null
    },
    cardFirstSixDigits: {
      type: String,
      default: null
    },
    installments: {
      type: Number,
      default: 1
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
