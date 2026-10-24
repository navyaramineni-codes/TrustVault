const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Document',
      required: [true, 'Document reference is required'],
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
      index: true,
    },
    level: {
      type: String,
      required: [true, 'Permission level is required'],
      enum: {
        values: ['read', 'edit'],
        message: '{VALUE} is not a valid permission level. Only "read" or "edit" are allowed.',
      },
    },
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Granted by user reference is required'],
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
  }
);

// Compound unique constraint: A user has at most one permission record per document
permissionSchema.index({ documentId: 1, userId: 1 }, { unique: true });

// Compound index supporting database-level permission filtering during search (Rule 6)
permissionSchema.index({ userId: 1, level: 1, documentId: 1 });

module.exports = mongoose.model('Permission', permissionSchema);
