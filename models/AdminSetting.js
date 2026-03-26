const mongoose = require('mongoose');

const AdminSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'main'
    },
    adminPath: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    baseTicketPrice: {
      type: Number,
      default: 65
    },
    lunchAddonPrice: {
      type: Number,
      default: 20
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('AdminSetting', AdminSettingSchema);
