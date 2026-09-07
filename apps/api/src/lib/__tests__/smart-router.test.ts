import { describe, it, expect } from 'vitest';
import { SmartRouter } from '../smart-router';
import { PromptOptimizer } from '../prompt-optimizer';

describe('SmartRouter', () => {
  const router = new SmartRouter();

  it('classifies task type correctly', () => {
    const task = router.classifyTask('Write a Python function to sort a list');
    expect(task).toHaveProperty('category');
    expect(['code', 'chat', 'analysis', 'creative', 'translation']).toContain(task.category);
  });

  it('selects optimal model for code task', () => {
    const model = router.selectModel({
      category: 'code',
      maxTokens: 4096,
      latencyPriority: 'balanced',
    });
    expect(model).toHaveProperty('provider');
    expect(model).toHaveProperty('model');
  });

  it('selects cheaper model when cost priority', () => {
    const model = router.selectModel({
      category: 'chat',
      maxTokens: 1024,
      latencyPriority: 'cost',
    });
    expect(model).toHaveProperty('provider');
  });

  it('routes to consensus mode when requested', () => {
    const result = router.routeWithConsensus('Explain quantum computing', {
      numModels: 3,
    });
    expect(result).toHaveProperty('responses');
    expect(Array.isArray(result.responses)).toBe(true);
    expect(result.responses.length).toBe(3);
  });
});

describe('PromptOptimizer', () => {
  const optimizer = new PromptOptimizer();

  it('compresses long prompts', () => {
    const original = 'Please write a function. '.repeat(100);
    const compressed = optimizer.compress(original);
    expect(compressed.length).toBeLessThanOrEqual(original.length);
  });

  it('manages token budget', () => {
    const prompt = 'Write a function that sorts a list of numbers using merge sort. Include error handling for empty arrays.';
    const result = optimizer.fitTokenBudget(prompt, 20);
    expect(result).toHaveProperty('tokens');
    expect(result.tokens).toBeLessThanOrEqual(20);
  });

  it('caches responses', () => {
    const prompt = 'What is 2+2?';
    optimizer.cacheResponse(prompt, '4');
    const cached = optimizer.getCachedResponse(prompt);
    expect(cached).toBe('4');
  });
});
