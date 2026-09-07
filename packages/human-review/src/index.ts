/**
 * Human Review — human-in-the-loop review system for agent executions.
 * Extracted from: inspiration/Nexus/AutoGPT/
 *
 * Provides:
 * - ReviewStatus: WAITING, APPROVED, REJECTED states
 * - PendingHumanReview: Review request with payload, instructions, and editable flag
 * - ReviewItem: Single review with approval status, optional data edits
 * - ReviewRequest: Batch review processing for an execution
 * - ReviewResponse: Results of processing reviews
 * - AutoApproval: Track auto-approve settings per block type
 *
 * Usage: When an agent execution requires human approval (e.g. sending an email,
 * making a purchase), the system pauses and creates a PendingHumanReview.
 * The reviewer can approve, reject, or edit the data before the execution continues.
 */

// ===== Types =====

export enum ReviewStatus {
  WAITING = "WAITING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

/**
 * Pending human review request.
 * Represents data from an agent execution that needs human approval.
 */
export interface PendingHumanReview {
  /** Node execution ID (primary key) */
  nodeExecId: string;
  /** Node definition ID (for grouping reviews from same node) */
  nodeId: string;
  /** User ID who must perform the review */
  userId: string;
  /** Graph execution ID containing this review */
  graphExecId: string;
  /** Graph ID (template) */
  graphId: string;
  /** Graph version */
  graphVersion: number;
  /** The data payload awaiting review */
  payload: Record<string, unknown> | unknown[];
  /** Instructions for the reviewer */
  instructions?: string;
  /** Whether the reviewer can edit the data */
  editable: boolean;
  /** Current review status */
  status: ReviewStatus;
  /** Optional message from the reviewer */
  reviewMessage?: string;
  /** Display name of the agent that requested the review */
  agentName?: string;
  /** Whether the data was modified during review */
  wasEdited?: boolean;
  /** Whether the review result has been processed by the execution engine */
  processed: boolean;
  /** When the review was created */
  createdAt: Date;
  /** When the review was last updated */
  updatedAt?: Date;
  /** When the review was completed */
  reviewedAt?: Date;
}

/**
 * Single review item for batch processing.
 */
export interface ReviewItem {
  /** Node execution ID to review */
  nodeExecId: string;
  /** Whether this review is approved */
  approved: boolean;
  /** Optional review message */
  message?: string;
  /** Optional edited data (ignored if approved=false) */
  reviewedData?: Record<string, unknown> | unknown[];
  /** If true, future executions of this same block will be auto-approved */
  autoApproveFuture?: boolean;
}

/**
 * Request for batch processing of all pending reviews for an execution.
 */
export interface ReviewRequest {
  /** All reviews with their approval status */
  reviews: ReviewItem[];
}

/**
 * Response from review processing.
 */
export interface ReviewResponse {
  /** Number of reviews successfully approved */
  approvedCount: number;
  /** Number of reviews successfully rejected */
  rejectedCount: number;
  /** Number of reviews that failed processing */
  failedCount: number;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Auto-approval tracking per block type.
 * When a reviewer checks "auto-approve future" on a review,
 * future executions of that block are automatically approved.
 */
export interface AutoApprovalRecord {
  /** Block/node definition ID */
  nodeId: string;
  /** User who set the auto-approval */
  userId: string;
  /** When auto-approval was set */
  createdAt: Date;
}

// ===== Engine =====

/**
 * Human review engine — manages review lifecycle.
 */
export class HumanReviewEngine {
  private reviews = new Map<string, PendingHumanReview>();
  private autoApprovals = new Map<string, AutoApprovalRecord>(); // key: `${nodeId}:${userId}`

  /**
   * Create a pending review request.
   */
  createReview(params: {
    nodeExecId: string;
    nodeId: string;
    userId: string;
    graphExecId: string;
    graphId: string;
    graphVersion: number;
    payload: Record<string, unknown>;
    instructions?: string;
    editable?: boolean;
    agentName?: string;
  }): PendingHumanReview {
    const key = params.nodeExecId;

    // Check if auto-approved
    const approvalKey = `${params.nodeId}:${params.userId}`;
    if (this.autoApprovals.has(approvalKey)) {
      // Auto-approve: create and immediately approve
      const review: PendingHumanReview = {
        ...params,
        editable: false,
        status: ReviewStatus.APPROVED,
        processed: true,
        createdAt: new Date(),
        reviewedAt: new Date(),
      };
      this.reviews.set(key, review);
      return review;
    }

    const review: PendingHumanReview = {
      ...params,
      editable: params.editable ?? true,
      status: ReviewStatus.WAITING,
      processed: false,
      createdAt: new Date(),
    };
    this.reviews.set(key, review);
    return review;
  }

  /**
   * Get all pending reviews for a user.
   */
  getPendingReviews(userId: string): PendingHumanReview[] {
    return Array.from(this.reviews.values()).filter(
      (r) => r.userId === userId && r.status === ReviewStatus.WAITING && !r.processed
    );
  }

  /**
   * Get pending reviews for a specific execution.
   */
  getReviewsForExecution(graphExecId: string): PendingHumanReview[] {
    return Array.from(this.reviews.values()).filter(
      (r) => r.graphExecId === graphExecId && !r.processed
    );
  }

  /**
   * Process a batch of reviews for an execution.
   */
  processReviews(request: ReviewRequest): ReviewResponse {
    let approved = 0;
    let rejected = 0;
    let failed = 0;

    for (const item of request.reviews) {
      const review = this.reviews.get(item.nodeExecId);
      if (!review) {
        failed++;
        continue;
      }

      review.status = item.approved ? ReviewStatus.APPROVED : ReviewStatus.REJECTED;
      review.reviewMessage = item.message;
      review.wasEdited = item.reviewedData !== undefined;
      review.reviewedAt = new Date();
      review.processed = true;

      if (item.approved) {
        approved++;
        // Set auto-approval if requested
        if (item.autoApproveFuture) {
          this.setAutoApproval(review.nodeId, review.userId);
        }
      } else {
        rejected++;
      }
    }

    return {
      approvedCount: approved,
      rejectedCount: rejected,
      failedCount: failed,
    };
  }

  /**
   * Set auto-approval for a block type + user combination.
   */
  setAutoApproval(nodeId: string, userId: string): void {
    const key = `${nodeId}:${userId}`;
    this.autoApprovals.set(key, {
      nodeId,
      userId,
      createdAt: new Date(),
    });
  }

  /**
   * Remove auto-approval for a block type + user combination.
   */
  removeAutoApproval(nodeId: string, userId: string): void {
    const key = `${nodeId}:${userId}`;
    this.autoApprovals.delete(key);
  }

  /**
   * Check if a block type is auto-approved for a user.
   */
  isAutoApproved(nodeId: string, userId: string): boolean {
    return this.autoApprovals.has(`${nodeId}:${userId}`);
  }

  /**
   * Check if a review can be edited.
   */
  canEdit(reviewId: string): boolean {
    const review = this.reviews.get(reviewId);
    return review?.editable ?? false;
  }

  /**
   * Get review statistics for a graph execution.
   */
  getStats(graphExecId: string): {
    total: number;
    waiting: number;
    approved: number;
    rejected: number;
  } {
    const reviews = this.getReviewsForExecution(graphExecId);
    return {
      total: reviews.length,
      waiting: reviews.filter((r) => r.status === ReviewStatus.WAITING).length,
      approved: reviews.filter((r) => r.status === ReviewStatus.APPROVED).length,
      rejected: reviews.filter((r) => r.status === ReviewStatus.REJECTED).length,
    };
  }

  /**
   * Cleanup old processed reviews (older than specified days).
   */
  cleanup(maxAgeDays: number = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    let removed = 0;
    for (const [key, review] of this.reviews) {
      if (review.processed && review.reviewedAt && review.reviewedAt < cutoff) {
        this.reviews.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

// ===== Validation =====

/**
 * Validate review data size and depth to prevent abuse.
 */
export function validateReviewData(
  data: unknown,
  maxSizeBytes: number = 1_000_000,
  maxDepth: number = 10
): { valid: boolean; error?: string } {
  try {
    const jsonStr = JSON.stringify(data);
    if (jsonStr.length > maxSizeBytes) {
      return { valid: false, error: `Data too large (max ${maxSizeBytes} bytes)` };
    }

    const depth = getDepth(data);
    if (depth > maxDepth) {
      return { valid: false, error: `Data too deeply nested (max ${maxDepth} levels)` };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: `Data is not JSON serializable: ${e}` };
  }
}

function getDepth(obj: unknown, current: number = 0): number {
  if (current > 20) return current; // Safety limit
  if (obj === null || typeof obj !== "object") return current;
  if (Array.isArray(obj)) {
    return Math.max(...obj.map((item) => getDepth(item, current + 1)), current);
  }
  return Math.max(
    ...Object.values(obj).map((val) => getDepth(val, current + 1)),
    current
  );
}
