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
    discountMode: {
      type: String,
      required: true,
      enum: ['fixed', 'percent', 'per_ticket'],
      default: 'fixed',
      index: true
    },
    couponType: {
      type: String,
      required: true,
      enum: ['caravana', 'lider'],
      default: 'caravana',
      index: true
    },
    singleUse: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    usageCount: {
      type: Number,
      default: 0
    },
    lastUsedAt: {
      type: Date,
      default: null
    },
    lastUsedByPaymentId: {
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
