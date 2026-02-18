import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost } from '../../pipeline/cost-calculator.mjs';

describe('cost-calculator', () => {
  it('calculates costs for typical usage', () => {
    const result = calculateCost(
      { prompt_tokens: 1000, completion_tokens: 500 },
      3.0,  // $3/M input
      15.0  // $15/M output
    );
    assert.equal(result.prompt_tokens, 1000);
    assert.equal(result.completion_tokens, 500);
    assert.equal(result.total_tokens, 1500);
    assert.equal(result.input_cost, 0.003);
    assert.equal(result.output_cost, 0.0075);
    assert.equal(result.total_cost, 0.0105);
  });

  it('handles zero tokens', () => {
    const result = calculateCost({}, 5, 25);
    assert.equal(result.prompt_tokens, 0);
    assert.equal(result.completion_tokens, 0);
    assert.equal(result.total_tokens, 0);
    assert.equal(result.input_cost, 0);
    assert.equal(result.output_cost, 0);
    assert.equal(result.total_cost, 0);
  });

  it('handles missing usage fields', () => {
    const result = calculateCost({ prompt_tokens: 100 }, 5, 25);
    assert.equal(result.prompt_tokens, 100);
    assert.equal(result.completion_tokens, 0);
    assert.equal(result.total_tokens, 100);
  });

  it('maintains 6 decimal precision', () => {
    const result = calculateCost(
      { prompt_tokens: 1, completion_tokens: 1 },
      1.0,
      1.0
    );
    // 1 / 1_000_000 * 1 = 0.000001
    assert.equal(result.input_cost, 0.000001);
    assert.equal(result.output_cost, 0.000001);
    assert.equal(result.total_cost, 0.000002);
  });

  it('handles large token counts', () => {
    const result = calculateCost(
      { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      5,
      25
    );
    assert.equal(result.input_cost, 5);
    assert.equal(result.output_cost, 12.5);
    assert.equal(result.total_cost, 17.5);
  });

  it('does not produce floating point artifacts', () => {
    // This tests the rounding: 3 tokens at $0.000003/token input
    const result = calculateCost(
      { prompt_tokens: 333, completion_tokens: 777 },
      10,
      30
    );
    // 333/1M * 10 = 0.00333, 777/1M * 30 = 0.02331
    assert.equal(result.input_cost, 0.00333);
    assert.equal(result.output_cost, 0.02331);
    assert.equal(result.total_cost, 0.02664);
  });
});
