const mongoose = require('mongoose');

const CouponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    discountAmount: {
      type: Number,
      required: true,
      min: 0.01
    },
    isUsed: {
      type: Boolean,
      default: false,
      index: true
    },
    usedAt: {
      type: Date,
      default: null
    },
    usedByPaymentId: {
      type: String,
      default: null
    },
    createdBy: {
      type: String,
      default: 'admin'
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Coupon', CouponSchema);
