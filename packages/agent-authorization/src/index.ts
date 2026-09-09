// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-authorization — Cedar-style policy engine for agent tool access.
 *
 * Inspired by harness-sdk's CedarAuthorization.
 * Controls which tools agents can access based on role, context,
 * and resource-based authorization policies.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type Effect = "allow" | "deny";

export interface Policy {
  id: string;
  effect: Effect;
  principals: string[]; // agent roles or IDs
  actions: string[]; // tool names or patterns
  resources: string[]; // resource patterns
  conditions?: PolicyCondition[];
}

export interface PolicyCondition {
  type: "string" | "numeric" | "boolean";
  field: string;
  operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "contains";
  value: unknown;
}

export interface AuthContext {
  agentId: string;
  agentRole: string;
  toolName: string;
  resource?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AuthDecision {
  allowed: boolean;
  effect: Effect;
  matchedPolicy?: string;
  reason: string;
}

// ── Authorization Engine ─────────────────────────────────────────────────────

export class AgentAuthorization {
  private policies: Policy[] = [];

  /**
   * Add a policy.
   */
  addPolicy(policy: Policy): void {
    this.policies.push(policy);
  }

  /**
   * Remove a policy by ID.
   */
  removePolicy(id: string): boolean {
    const idx = this.policies.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.policies.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Check if an action is authorized.
   */
  authorize(context: AuthContext): AuthDecision {
    const matchingPolicies = this.policies.filter((p) => this.matchesPolicy(p, context));

    if (matchingPolicies.length === 0) {
      // Default deny if no policies match
      return {
        allowed: false,
        effect: "deny",
        reason: "No matching policy — default deny",
      };
    }

    // Deny policies take precedence over allow
    const denyPolicy = matchingPolicies.find((p) => p.effect === "deny");
    if (denyPolicy) {
      return {
        allowed: false,
        effect: "deny",
        matchedPolicy: denyPolicy.id,
        reason: `Denied by policy ${denyPolicy.id}`,
      };
    }

    // Allow the first matching allow policy
    const allowPolicy = matchingPolicies.find((p) => p.effect === "allow");
    if (allowPolicy) {
      return {
        allowed: true,
        effect: "allow",
        matchedPolicy: allowPolicy.id,
        reason: `Allowed by policy ${allowPolicy.id}`,
      };
    }

    return {
      allowed: false,
      effect: "deny",
      reason: "No allow policy matched",
    };
  }

  /**
   * Get all policies.
   */
  getPolicies(): Policy[] {
    return [...this.policies];
  }

  /**
   * Get policies for a specific agent role.
   */
  getPoliciesForRole(role: string): Policy[] {
    return this.policies.filter((p) => p.principals.includes(role) || p.principals.includes("*"));
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private matchesPolicy(policy: Policy, context: AuthContext): boolean {
    // Check principal
    const principalMatch =
      policy.principals.includes("*") ||
      policy.principals.includes(context.agentRole) ||
      policy.principals.includes(context.agentId);

    if (!principalMatch) return false;

    // Check action
    const actionMatch =
      policy.actions.includes("*") ||
      policy.actions.some((a) => this.matchesPattern(a, context.toolName));

    if (!actionMatch) return false;

    // Check resource
    if (context.resource && policy.resources.length > 0) {
      const resourceMatch =
        policy.resources.includes("*") ||
        policy.resources.some((r) => this.matchesPattern(r, context.resource!));

      if (!resourceMatch) return false;
    }

    // Check conditions
    if (policy.conditions && policy.conditions.length > 0) {
      const allConditionsMet = policy.conditions.every((cond) =>
        this.evaluateCondition(cond, context),
      );
      if (!allConditionsMet) return false;
    }

    return true;
  }

  private matchesPattern(pattern: string, value: string): boolean {
    if (pattern === "*") return true;
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      return regex.test(value);
    }
    return pattern === value;
  }

  private evaluateCondition(condition: PolicyCondition, context: AuthContext): boolean {
    const fieldValue = this.getFieldValue(condition.field, context);
    if (fieldValue === undefined) return false;

    switch (condition.operator) {
      case "==":
        return fieldValue === condition.value;
      case "!=":
        return fieldValue !== condition.value;
      case ">":
        return Number(fieldValue) > Number(condition.value);
      case "<":
        return Number(fieldValue) < Number(condition.value);
      case ">=":
        return Number(fieldValue) >= Number(condition.value);
      case "<=":
        return Number(fieldValue) <= Number(condition.value);
      case "in":
        return Array.isArray(condition.value) && condition.value.includes(fieldValue);
      case "contains":
        return String(fieldValue).includes(String(condition.value));
      default:
        return false;
    }
  }

  private getFieldValue(field: string, context: AuthContext): unknown {
    if (field === "agentId") return context.agentId;
    if (field === "agentRole") return context.agentRole;
    if (field === "toolName") return context.toolName;
    if (field === "resource") return context.resource;
    if (field === "timestamp") return context.timestamp;
    if (context.metadata && field in context.metadata) {
      return context.metadata[field];
    }
    return undefined;
  }
}

// ── Built-in Policies ────────────────────────────────────────────────────────

export const DEFAULT_POLICIES: Policy[] = [
  {
    id: "allow-search",
    effect: "allow",
    principals: ["*"],
    actions: ["search", "read", "list"],
    resources: ["*"],
  },
  {
    id: "deny-destructive-anonymous",
    effect: "deny",
    principals: ["anonymous"],
    actions: ["delete", "write", "execute", "deploy"],
    resources: ["*"],
  },
  {
    id: "allow-admin-all",
    effect: "allow",
    principals: ["admin"],
    actions: ["*"],
    resources: ["*"],
  },
];

export default AgentAuthorization;
