const mongoose = require('mongoose');

const auditEventSchema = new mongoose.Schema(
  {
    timestamp: {
      type: Date,
      default: Date.now,
      immutable: true,
      index: true,
    },
    eventType: {
      type: String,
      required: [true, 'Event type is required'],
      trim: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Document',
      default: null,
      index: true,
    },
    action: {
      type: String,
      required: [true, 'Action is required'],
      trim: true,
    },
    status: {
      type: String,
      required: [true, 'Status is required'],
      enum: {
        values: ['SUCCESS', 'DENIED', 'FAILURE'],
        message: '{VALUE} is not a valid audit status',
      },
      index: true,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
    ipAddress: {
      type: String,
      trim: true,
      default: null,
    },
    userAgent: {
      type: String,
      trim: true,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    sequenceNumber: {
      type: Number,
    },
    previousHash: {
      type: String,
    },
    hash: {
      type: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // Append-only log: createdAt only
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Cryptographic linear sequence and timeline query optimization
auditEventSchema.index({ sequenceNumber: 1 }, { unique: true });
auditEventSchema.index({ documentId: 1, timestamp: -1 });
auditEventSchema.index({ userId: 1, timestamp: -1 });
auditEventSchema.index({ eventType: 1, status: 1, timestamp: -1 });

// Immutability protection: Prevent modifications or updates to existing audit entries
const blockUpdate = function (next) {
  const err = new Error('Audit records are immutable and cannot be modified.');
  if (typeof next === 'function') {
    return next(err);
  }
  throw err;
};

auditEventSchema.pre('updateOne', blockUpdate);
auditEventSchema.pre('updateMany', blockUpdate);
auditEventSchema.pre('findOneAndUpdate', blockUpdate);
auditEventSchema.pre('replaceOne', blockUpdate);

// Block updates on individual document instances and compute fallback chain fields
auditEventSchema.pre('save', async function (next) {
  if (!this.isNew) {
    return next(new Error('Audit records are immutable and cannot be updated.'));
  }

  if (this.sequenceNumber === undefined || this.sequenceNumber === null) {
    try {
      const crypto = require('crypto');
      const last = await this.constructor.findOne().sort({ sequenceNumber: -1 }).select('sequenceNumber hash');
      this.sequenceNumber = last && typeof last.sequenceNumber === 'number' ? last.sequenceNumber + 1 : 1;
      this.previousHash = this.previousHash || (last && last.hash ? last.hash : '0'.repeat(64));
      if (!this.hash) {
        const canonical = JSON.stringify({
          sequenceNumber: this.sequenceNumber,
          timestamp: this.timestamp instanceof Date ? this.timestamp.toISOString() : new Date().toISOString(),
          eventType: this.eventType,
          action: this.action,
          status: this.status,
        });
        this.hash = crypto.createHash('sha256').update(`${this.previousHash}:${canonical}`).digest('hex');
      }
    } catch (err) {
      return next(err);
    }
  }

  next();
});

module.exports = mongoose.model('AuditEvent', auditEventSchema);

