/**
 * Tests for Logger and Metrics modules.
 *
 * Tests structured logging, metrics collection, and observability features.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

describe('Logger', () => {
    let Logger, logger, LOG_LEVELS;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/Logger.mjs');
        Logger = module.Logger;
        logger = module.logger;
        LOG_LEVELS = module.LOG_LEVELS;
    });

    describe('Logger class', () => {
        it('should export Logger class', () => {
            assert.ok(Logger);
            assert.strictEqual(typeof Logger, 'function');
        });

        it('should export logger singleton', () => {
            assert.ok(logger);
        });

        it('should export LOG_LEVELS', () => {
            assert.ok(LOG_LEVELS);
            assert.strictEqual(LOG_LEVELS.debug, 0);
            assert.strictEqual(LOG_LEVELS.info, 1);
            assert.strictEqual(LOG_LEVELS.warn, 2);
            assert.strictEqual(LOG_LEVELS.error, 3);
        });
    });

    describe('logging methods', () => {
        it('should have debug method', () => {
            const log = new Logger({ level: 'debug' });
            assert.strictEqual(typeof log.debug, 'function');
        });

        it('should have info method', () => {
            const log = new Logger();
            assert.strictEqual(typeof log.info, 'function');
        });

        it('should have warn method', () => {
            const log = new Logger();
            assert.strictEqual(typeof log.warn, 'function');
        });

        it('should have error method', () => {
            const log = new Logger();
            assert.strictEqual(typeof log.error, 'function');
        });
    });

    describe('log levels', () => {
        it('should filter by log level', () => {
            const logged = [];
            const mockOutput = {
                log: (msg) => logged.push(msg),
                error: (msg) => logged.push(msg),
            };

            const log = new Logger({
                level: 'warn',
                output: mockOutput,
                color: false,
            });

            log.debug('debug message');
            log.info('info message');
            log.warn('warn message');
            log.error('error message');

            assert.strictEqual(logged.length, 2);
            assert.ok(logged.some(l => l.includes('warn')));
            assert.ok(logged.some(l => l.includes('error')));
        });

        it('should get current level', () => {
            const log = new Logger({ level: 'warn' });

            assert.strictEqual(log.getLevel(), 'warn');
        });

        it('should set level', () => {
            const log = new Logger({ level: 'info' });
            log.setLevel('debug');

            assert.strictEqual(log.getLevel(), 'debug');
        });

        it('should check if level is enabled', () => {
            const log = new Logger({ level: 'warn' });

            assert.strictEqual(log.isLevelEnabled('debug'), false);
            assert.strictEqual(log.isLevelEnabled('info'), false);
            assert.strictEqual(log.isLevelEnabled('warn'), true);
            assert.strictEqual(log.isLevelEnabled('error'), true);
        });
    });

    describe('structured logging', () => {
        it('should include data in log', () => {
            const logged = [];
            const mockOutput = {
                log: (msg) => logged.push(msg),
                error: (msg) => logged.push(msg),
            };

            const log = new Logger({
                output: mockOutput,
                color: false,
            });

            log.info('test message', { key: 'value' });

            assert.strictEqual(logged.length, 1);
            assert.ok(logged[0].includes('key=value'));
        });

        it('should output JSON when configured', () => {
            const logged = [];
            const mockOutput = {
                log: (msg) => logged.push(msg),
                error: (msg) => logged.push(msg),
            };

            const log = new Logger({
                output: mockOutput,
                json: true,
            });

            log.info('test message', { key: 'value' });

            const parsed = JSON.parse(logged[0]);
            assert.strictEqual(parsed.message, 'test message');
            assert.strictEqual(parsed.key, 'value');
            assert.ok(parsed.timestamp);
        });
    });

    describe('child logger', () => {
        it('should create child with default data', () => {
            const logged = [];
            const mockOutput = {
                log: (msg) => logged.push(msg),
                error: (msg) => logged.push(msg),
            };

            const parent = new Logger({
                output: mockOutput,
                color: false,
            });

            const child = parent.child({ component: 'test' });
            child.info('child message');

            assert.strictEqual(logged.length, 1);
            assert.ok(logged[0].includes('component=test'));
        });

        it('should merge child-specific data', () => {
            const logged = [];
            const mockOutput = {
                log: (msg) => logged.push(msg),
                error: (msg) => logged.push(msg),
            };

            const parent = new Logger({
                output: mockOutput,
                color: false,
            });

            const child = parent.child({ component: 'test' });
            child.info('message', { extra: 'data' });

            assert.ok(logged[0].includes('component=test'));
            assert.ok(logged[0].includes('extra=data'));
        });

        it('should create grandchild logger', () => {
            const logged = [];
            const mockOutput = {
                log: (msg) => logged.push(msg),
                error: (msg) => logged.push(msg),
            };

            const parent = new Logger({
                output: mockOutput,
                color: false,
            });

            const child = parent.child({ level1: 'a' });
            const grandchild = child.child({ level2: 'b' });
            grandchild.info('message');

            assert.ok(logged[0].includes('level1=a'));
            assert.ok(logged[0].includes('level2=b'));
        });
    });
});

describe('Metrics', () => {
    let Metrics, metrics, METRIC_NAMES;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/Metrics.mjs');
        Metrics = module.Metrics;
        metrics = module.metrics;
        METRIC_NAMES = module.METRIC_NAMES;

        // Reset metrics for clean tests
        metrics.reset();
    });

    describe('Metrics class', () => {
        it('should export Metrics class', () => {
            assert.ok(Metrics);
            assert.strictEqual(typeof Metrics, 'function');
        });

        it('should export metrics singleton', () => {
            assert.ok(metrics);
        });

        it('should export METRIC_NAMES constants', () => {
            assert.ok(METRIC_NAMES);
            assert.ok(METRIC_NAMES.SKILL_EXECUTIONS);
            assert.ok(METRIC_NAMES.LLM_REQUESTS);
        });
    });

    describe('counters', () => {
        it('should increment counter', () => {
            const m = new Metrics();

            m.increment('test_counter');

            assert.strictEqual(m.getCounter('test_counter'), 1);
        });

        it('should increment by specified value', () => {
            const m = new Metrics();

            m.increment('test_counter', 5);

            assert.strictEqual(m.getCounter('test_counter'), 5);
        });

        it('should accumulate increments', () => {
            const m = new Metrics();

            m.increment('test_counter', 3);
            m.increment('test_counter', 2);

            assert.strictEqual(m.getCounter('test_counter'), 5);
        });

        it('should support labels', () => {
            const m = new Metrics();

            m.increment('test_counter', 1, { type: 'a' });
            m.increment('test_counter', 1, { type: 'b' });
            m.increment('test_counter', 1, { type: 'a' });

            assert.strictEqual(m.getCounter('test_counter', { type: 'a' }), 2);
            assert.strictEqual(m.getCounter('test_counter', { type: 'b' }), 1);
        });
    });

    describe('timing/histograms', () => {
        it('should record timing', () => {
            const m = new Metrics();

            m.timing('test_timing', 100);

            const stats = m.getHistogram('test_timing');
            assert.ok(stats);
            assert.strictEqual(stats.count, 1);
            assert.strictEqual(stats.avg, 100);
        });

        it('should calculate statistics', () => {
            const m = new Metrics();

            m.timing('test_timing', 100);
            m.timing('test_timing', 200);
            m.timing('test_timing', 300);

            const stats = m.getHistogram('test_timing');
            assert.strictEqual(stats.count, 3);
            assert.strictEqual(stats.sum, 600);
            assert.strictEqual(stats.avg, 200);
            assert.strictEqual(stats.min, 100);
            assert.strictEqual(stats.max, 300);
        });

        it('should calculate percentiles', () => {
            const m = new Metrics();

            for (let i = 1; i <= 100; i++) {
                m.timing('test_timing', i);
            }

            const stats = m.getHistogram('test_timing');
            assert.ok(stats.p50 >= 50);
            assert.ok(stats.p90 >= 90);
            assert.ok(stats.p99 >= 99);
        });

        it('should support timing with labels', () => {
            const m = new Metrics();

            m.timing('test_timing', 100, { op: 'read' });
            m.timing('test_timing', 200, { op: 'write' });

            const readStats = m.getHistogram('test_timing', { op: 'read' });
            const writeStats = m.getHistogram('test_timing', { op: 'write' });

            assert.strictEqual(readStats.avg, 100);
            assert.strictEqual(writeStats.avg, 200);
        });
    });

    describe('gauge', () => {
        it('should record gauge value', () => {
            const m = new Metrics();

            m.gauge('active_connections', 5);

            assert.strictEqual(m.getCounter('active_connections'), 5);
        });

        it('should overwrite gauge value', () => {
            const m = new Metrics();

            m.gauge('active_connections', 5);
            m.gauge('active_connections', 3);

            assert.strictEqual(m.getCounter('active_connections'), 3);
        });
    });

    describe('time and timeAsync', () => {
        it('should time synchronous function', () => {
            const m = new Metrics();

            const result = m.time('test_timing', () => {
                let sum = 0;
                for (let i = 0; i < 1000; i++) sum += i;
                return sum;
            });

            assert.strictEqual(result, 499500);
            const stats = m.getHistogram('test_timing');
            assert.ok(stats);
            assert.ok(stats.avg >= 0);
        });

        it('should time async function', async () => {
            const m = new Metrics();

            const result = await m.timeAsync('test_timing', async () => {
                await new Promise(resolve => setTimeout(resolve, 50));
                return 'done';
            });

            assert.strictEqual(result, 'done');
            const stats = m.getHistogram('test_timing');
            assert.ok(stats);
            assert.ok(stats.avg >= 45);
        });
    });

    describe('metric hooks', () => {
        it('should notify hooks on counter increment', () => {
            const m = new Metrics();
            const events = [];

            m.onMetric((event) => {
                events.push(event);
            });

            m.increment('test_counter', 1, { label: 'value' });

            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].type, 'counter');
            assert.strictEqual(events[0].name, 'test_counter');
            assert.strictEqual(events[0].value, 1);
            assert.deepStrictEqual(events[0].labels, { label: 'value' });
        });

        it('should notify hooks on timing', () => {
            const m = new Metrics();
            const events = [];

            m.onMetric((event) => {
                events.push(event);
            });

            m.timing('test_timing', 100);

            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].type, 'timing');
        });

        it('should allow unsubscribe', () => {
            const m = new Metrics();
            const events = [];

            const unsubscribe = m.onMetric((event) => {
                events.push(event);
            });

            m.increment('test_counter');
            unsubscribe();
            m.increment('test_counter');

            assert.strictEqual(events.length, 1);
        });

        it('should handle hook errors gracefully', () => {
            const m = new Metrics();

            m.onMetric(() => {
                throw new Error('Hook error');
            });

            // Should not throw
            m.increment('test_counter');
        });
    });

    describe('getStats', () => {
        it('should return summary of all metrics', () => {
            const m = new Metrics();

            m.increment('counter1', 5);
            m.increment('counter2', 3);
            m.timing('timing1', 100);
            m.timing('timing1', 200);

            const stats = m.getStats();

            assert.ok(stats.counters);
            assert.ok(stats.histograms);
            assert.strictEqual(stats.counters['counter1'], 5);
            assert.strictEqual(stats.counters['counter2'], 3);
            assert.ok(stats.histograms['timing1']);
        });
    });

    describe('reset', () => {
        it('should clear all metrics', () => {
            const m = new Metrics();

            m.increment('counter1', 5);
            m.timing('timing1', 100);
            m.reset();

            assert.strictEqual(m.getCounter('counter1'), 0);
            assert.strictEqual(m.getHistogram('timing1'), null);
        });
    });

    describe('enabled/disabled', () => {
        it('should start enabled by default', () => {
            const m = new Metrics();
            assert.strictEqual(m.isEnabled(), true);
        });

        it('should not record when disabled', () => {
            const m = new Metrics();
            m.setEnabled(false);

            m.increment('counter1', 5);
            m.timing('timing1', 100);

            assert.strictEqual(m.getCounter('counter1'), 0);
            assert.strictEqual(m.getHistogram('timing1'), null);
        });

        it('should resume recording when re-enabled', () => {
            const m = new Metrics();
            m.setEnabled(false);
            m.increment('counter1', 5);
            m.setEnabled(true);
            m.increment('counter1', 3);

            assert.strictEqual(m.getCounter('counter1'), 3);
        });
    });
});
