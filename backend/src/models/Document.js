const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Document name is required'],
      trim: true,
      maxlength: [255, 'Name cannot exceed 255 characters'],
      default: function () {
        return this.title || this.originalFileName;
      },
      index: true,
    },
    title: {
      type: String,
      trim: true,
      maxlength: [255, 'Title cannot exceed 255 characters'],
      default: function () {
        return this.name;
      },
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
      default: '',
    },
    category: {
      type: String,
      trim: true,
      default: 'general',
      index: true,
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Document owner is required'],
      default: function () {
        return this.ownerId;
      },
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: function () {
        return this.owner;
      },
      index: true,
    },
    size: {
      type: Number,
      required: [true, 'File size is required'],
      min: [0, 'File size cannot be negative'],
      default: function () {
        return this.sizeBytes;
      },
    },
    sizeBytes: {
      type: Number,
      min: [0, 'File size cannot be negative'],
      default: function () {
        return this.size;
      },
    },
    mimeType: {
      type: String,
      required: [true, 'MIME type is required'],
      trim: true,
    },
    sha256: {
      type: String,
      required: [true, 'SHA-256 checksum is required'],
      trim: true,
      index: true,
    },
    storagePath: {
      type: String,
      required: [true, 'Storage path is required'],
      trim: true,
      default: function () {
        return this.fileStorageName;
      },
    },
    fileStorageName: {
      type: String,
      default: function () {
        return this.storagePath;
      },
      index: true,
    },
    originalFileName: {
      type: String,
      trim: true,
      default: function () {
        return this.name;
      },
    },
    deletedAt: {
      type: Date,
      default: null,
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
documentSchema.index({ owner: 1, name: 1 });
documentSchema.index({ ownerId: 1, title: 1 });
documentSchema.index({ name: 'text', title: 'text', description: 'text', category: 'text', tags: 'text' });

module.exports = mongoose.model('Document', documentSchema);
