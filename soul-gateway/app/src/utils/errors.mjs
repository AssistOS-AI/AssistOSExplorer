export class SoulGatewayError extends Error {
  constructor(message, status = 500, type = 'internal_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export class AuthError extends SoulGatewayError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'authentication_error');
  }
}

export class RateLimitError extends SoulGatewayError {
  constructor(message = 'Rate limit exceeded', retryAfter = 60) {
    super(message, 429, 'rate_limit_error');
    this.retryAfter = retryAfter;
  }
}

export class BlacklistError extends SoulGatewayError {
  constructor(message = 'Request blocked by content policy', ruleId, match) {
    super(message, 400, 'content_blocked');
    this.ruleId = ruleId;
    this.match = match;
  }
}

export class ModelNotFoundError extends SoulGatewayError {
  constructor(model) {
    super(`Model '${model}' not found or not allowed`, 404, 'model_not_found');
  }
}

export class LoopDetectedError extends SoulGatewayError {
  constructor(pattern, message = 'Loop detected — request blocked') {
    super(message, 429, 'loop_detected');
    this.retryAfter = 30;
    this.pattern = pattern;
  }
}

export class BudgetExceededError extends SoulGatewayError {
  constructor(scope, spent, budget) {
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
    nextMonth.setUTCHours(0, 0, 0, 0);
    const retryAfter = Math.min(Math.ceil((nextMonth - Date.now()) / 1000), 86400);

    super(
      `Monthly budget exceeded for ${scope}: $${spent.toFixed(2)} / $${budget.toFixed(2)}`,
      429,
      'budget_exceeded',
    );
    this.retryAfter = retryAfter;
    this.scope = scope;
    this.spent = spent;
    this.budget = budget;
  }
}

export class UpstreamError extends SoulGatewayError {
  constructor(message, status = 502, type = 'upstream_error') {
    super(message, status, type);
  }
}
