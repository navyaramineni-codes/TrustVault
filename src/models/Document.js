const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Document title is required'],
      trim: true,
      maxlength: [255, 'Title cannot exceed 255 characters'],
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
      default: '',
    },
    fileStorageName: {
      type: String,
      required: [true, 'Storage UUID filename is required'],
      unique: true,
      index: true,
    },
    originalFileName: {
      type: String,
      required: [true, 'Original filename is required'],
      trim: true,
    },
    mimeType: {
      type: String,
      required: [true, 'MIME type is required'],
      trim: true,
    },
    sizeBytes: {
      type: Number,
      required: [true, 'File size in bytes is required'],
      min: [0, 'File size cannot be negative'],
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Document owner is required'],
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Indexes supporting authorization and database-level search filtering (Rule 5 & 6)
documentSchema.index({ ownerId: 1, title: 1 });
documentSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('Document', documentSchema);
