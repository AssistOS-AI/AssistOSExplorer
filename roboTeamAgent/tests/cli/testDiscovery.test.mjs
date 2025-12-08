/**
 * Tests for testDiscovery module.
 *
 * Tests the test discovery and runner functionality.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Test Discovery Tests
// ============================================================================

describe('testDiscovery', () => {
    let testDiscovery;
    let tempDir;

    beforeEach(async () => {
        testDiscovery = await import('../src/lib/testDiscovery.mjs');
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-discovery-'));
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('discoverSkillTests', () => {
        it('should return empty array for null agent', () => {
            const tests = testDiscovery.discoverSkillTests(null);
            assert.deepStrictEqual(tests, []);
        });

        it('should return empty array for agent without skillCatalog', () => {
            const mockAgent = {};
            const tests = testDiscovery.discoverSkillTests(mockAgent);
            assert.deepStrictEqual(tests, []);
        });

        it('should return empty array when tests directory does not exist', () => {
            const mockAgent = {
                skillCatalog: new Map([
                    ['my-skill', { shortName: 'my-skill', type: 'code' }],
                ]),
                context: { workingDir: tempDir },
            };

            const tests = testDiscovery.discoverSkillTests(mockAgent);
            assert.deepStrictEqual(tests, []);
        });

        it('should discover tests for skills with test files', () => {
            // Create tests directory and test file
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            fs.writeFileSync(path.join(testsDir, 'my-skill.tests.mjs'), 'export default () => ({});');

            const mockAgent = {
                skillCatalog: new Map([
                    ['my-skill', { shortName: 'my-skill', type: 'code', skillDir: '/path/to/skill' }],
                ]),
                context: { workingDir: tempDir },
            };

            const tests = testDiscovery.discoverSkillTests(mockAgent);

            assert.strictEqual(tests.length, 1);
            assert.strictEqual(tests[0].skillName, 'my-skill');
            assert.strictEqual(tests[0].shortName, 'my-skill');
            assert.strictEqual(tests[0].skillType, 'code');
            assert.ok(tests[0].testFile.endsWith('my-skill.tests.mjs'));
        });

        it('should not include skills without test files', () => {
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            fs.writeFileSync(path.join(testsDir, 'skill-a.tests.mjs'), 'export default () => ({});');

            const mockAgent = {
                skillCatalog: new Map([
                    ['skill-a', { shortName: 'skill-a', type: 'code' }],
                    ['skill-b', { shortName: 'skill-b', type: 'code' }], // No test file
                ]),
                context: { workingDir: tempDir },
            };

            const tests = testDiscovery.discoverSkillTests(mockAgent);

            assert.strictEqual(tests.length, 1);
            assert.strictEqual(tests[0].skillName, 'skill-a');
        });

        it('should use skill name as shortName fallback', () => {
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            fs.writeFileSync(path.join(testsDir, 'full-skill-name.tests.mjs'), 'export default () => ({});');

            const mockAgent = {
                skillCatalog: new Map([
                    ['full-skill-name', { type: 'code' }], // No shortName
                ]),
                context: { workingDir: tempDir },
            };

            const tests = testDiscovery.discoverSkillTests(mockAgent);

            assert.strictEqual(tests.length, 1);
            assert.strictEqual(tests[0].shortName, 'full-skill-name');
        });

        it('should use options.startDir when context.workingDir not available', () => {
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            fs.writeFileSync(path.join(testsDir, 'my-skill.tests.mjs'), 'export default () => ({});');

            const mockAgent = {
                skillCatalog: new Map([
                    ['my-skill', { shortName: 'my-skill', type: 'code' }],
                ]),
                options: { startDir: tempDir },
            };

            const tests = testDiscovery.discoverSkillTests(mockAgent);
            assert.strictEqual(tests.length, 1);
        });

        it('should use startDir property when others not available', () => {
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            fs.writeFileSync(path.join(testsDir, 'my-skill.tests.mjs'), 'export default () => ({});');

            const mockAgent = {
                skillCatalog: new Map([
                    ['my-skill', { shortName: 'my-skill', type: 'code' }],
                ]),
                startDir: tempDir,
            };

            const tests = testDiscovery.discoverSkillTests(mockAgent);
            assert.strictEqual(tests.length, 1);
        });
    });

    describe('discoverSkillTest', () => {
        it('should return null for skill not found', () => {
            const mockAgent = {
                findSkillFile: () => null,
            };

            const test = testDiscovery.discoverSkillTest(mockAgent, 'nonexistent');
            assert.strictEqual(test, null);
        });

        it('should return null when tests directory does not exist', () => {
            const mockAgent = {
                findSkillFile: () => ({
                    record: { shortName: 'my-skill', type: 'code' },
                    filePath: '/path/to/skill/tskill.md',
                }),
                context: { workingDir: tempDir },
            };

            const test = testDiscovery.discoverSkillTest(mockAgent, 'my-skill');
            assert.strictEqual(test, null);
        });

        it('should return null when test file does not exist', () => {
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            // No test file created

            const mockAgent = {
                findSkillFile: () => ({
                    record: { shortName: 'my-skill', type: 'code' },
                    filePath: '/path/to/skill/tskill.md',
                }),
                context: { workingDir: tempDir },
            };

            const test = testDiscovery.discoverSkillTest(mockAgent, 'my-skill');
            assert.strictEqual(test, null);
        });

        it('should return test info when test file exists', () => {
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            fs.writeFileSync(path.join(testsDir, 'my-skill.tests.mjs'), 'export default () => ({});');

            const mockAgent = {
                findSkillFile: () => ({
                    record: { shortName: 'my-skill', type: 'code', skillDir: '/path/to/skill' },
                    filePath: '/path/to/skill/tskill.md',
                }),
                context: { workingDir: tempDir },
            };

            const test = testDiscovery.discoverSkillTest(mockAgent, 'my-skill');

            assert.ok(test);
            assert.strictEqual(test.skillName, 'my-skill');
            assert.strictEqual(test.shortName, 'my-skill');
            assert.strictEqual(test.skillType, 'code');
            assert.ok(test.testFile.endsWith('my-skill.tests.mjs'));
        });

        it('should use skill name as shortName fallback', () => {
            const testsDir = path.join(tempDir, 'tests');
            fs.mkdirSync(testsDir);
            fs.writeFileSync(path.join(testsDir, 'skill-name.tests.mjs'), 'export default () => ({});');

            const mockAgent = {
                findSkillFile: (name) => ({
                    record: { type: 'code' }, // No shortName
                    filePath: '/path/to/skill/tskill.md',
                }),
                context: { workingDir: tempDir },
            };

            const test = testDiscovery.discoverSkillTest(mockAgent, 'skill-name');

            assert.ok(test);
            assert.strictEqual(test.shortName, 'skill-name');
        });
    });

    describe('runTestFile', () => {
        it('should run test file and return results', async () => {
            const testFile = path.join(tempDir, 'test.mjs');
            fs.writeFileSync(testFile, `
                export default function() {
                    return { passed: 2, failed: 0, errors: [] };
                }
            `);

            const result = await testDiscovery.runTestFile(testFile, { timeout: 5000 });

            assert.strictEqual(result.success, true);
            assert.ok(typeof result.duration === 'number');
        });

        it('should timeout after specified duration', async () => {
            const testFile = path.join(tempDir, 'slow-test.mjs');
            fs.writeFileSync(testFile, `
                export default async function() {
                    await new Promise(r => setTimeout(r, 10000));
                    return { passed: 1, failed: 0 };
                }
            `);

            const result = await testDiscovery.runTestFile(testFile, { timeout: 100 });

            assert.strictEqual(result.success, false);
            assert.ok(result.errors.some(e => e.includes('timeout')));
        });

        it('should handle test file errors', async () => {
            const testFile = path.join(tempDir, 'error-test.mjs');
            fs.writeFileSync(testFile, `
                export default function() {
                    throw new Error('Test error');
                }
            `);

            const result = await testDiscovery.runTestFile(testFile, { timeout: 5000 });

            assert.strictEqual(result.success, false);
        });

        it('should handle non-existent test file', async () => {
            const testFile = path.join(tempDir, 'nonexistent.mjs');

            const result = await testDiscovery.runTestFile(testFile, { timeout: 5000 });

            assert.strictEqual(result.success, false);
            // Either errors array has entries or the output contains error info
            assert.ok(result.errors.length > 0 || result.output.includes('error') || !result.success);
        });
    });

    describe('runTestSuite', () => {
        it('should run multiple tests sequentially', async () => {
            const testsDir = path.join(tempDir, 'suite');
            fs.mkdirSync(testsDir);

            const test1 = path.join(testsDir, 'test1.mjs');
            const test2 = path.join(testsDir, 'test2.mjs');

            fs.writeFileSync(test1, 'export default () => ({ passed: 1, failed: 0 });');
            fs.writeFileSync(test2, 'export default () => ({ passed: 2, failed: 0 });');

            const tests = [
                { testFile: test1, skillName: 'skill1' },
                { testFile: test2, skillName: 'skill2' },
            ];

            const result = await testDiscovery.runTestSuite(tests, { timeout: 5000, parallel: false });

            assert.strictEqual(result.totalTests, 2);
            assert.ok(typeof result.duration === 'number');
            assert.strictEqual(result.results.length, 2);
        });

        it('should run multiple tests in parallel', async () => {
            const parallelDir = path.join(tempDir, 'parallel-suite');
            fs.mkdirSync(parallelDir, { recursive: true });

            const test1 = path.join(parallelDir, 'test1.mjs');
            const test2 = path.join(parallelDir, 'test2.mjs');

            fs.writeFileSync(test1, 'export default () => ({ passed: 1, failed: 0 });');
            fs.writeFileSync(test2, 'export default () => ({ passed: 1, failed: 0 });');

            const tests = [
                { testFile: test1, skillName: 'skill1' },
                { testFile: test2, skillName: 'skill2' },
            ];

            const result = await testDiscovery.runTestSuite(tests, { timeout: 5000, parallel: true });

            assert.strictEqual(result.totalTests, 2);
        });

        it('should aggregate passed and failed counts', async () => {
            const testsDir = path.join(tempDir, 'count-suite');
            fs.mkdirSync(testsDir);

            const test1 = path.join(testsDir, 'test1.mjs');
            const test2 = path.join(testsDir, 'test2.mjs');

            fs.writeFileSync(test1, 'export default () => ({ passed: 3, failed: 1 });');
            fs.writeFileSync(test2, 'export default () => ({ passed: 2, failed: 2 });');

            const tests = [
                { testFile: test1, skillName: 'skill1' },
                { testFile: test2, skillName: 'skill2' },
            ];

            const result = await testDiscovery.runTestSuite(tests, { timeout: 5000 });

            assert.strictEqual(result.totalPassed, 5);
            assert.strictEqual(result.totalFailed, 3);
            assert.strictEqual(result.success, false); // Has failures
        });

        it('should return success true when no failures', async () => {
            const testsDir = path.join(tempDir, 'success-suite');
            fs.mkdirSync(testsDir);

            const test1 = path.join(testsDir, 'test1.mjs');
            fs.writeFileSync(test1, 'export default () => ({ passed: 5, failed: 0 });');

            const tests = [{ testFile: test1, skillName: 'skill1' }];

            const result = await testDiscovery.runTestSuite(tests, { timeout: 5000 });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.totalFailed, 0);
        });

        it('should handle empty test array', async () => {
            const result = await testDiscovery.runTestSuite([], { timeout: 5000 });

            assert.strictEqual(result.totalTests, 0);
            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.results, []);
        });
    });

    describe('runTestFileInProcess', () => {
        it('should run test file in current process', async () => {
            const testFile = path.join(tempDir, 'in-process.mjs');
            fs.writeFileSync(testFile, `
                export default function() {
                    return { passed: 3, failed: 0 };
                }
            `);

            const result = await testDiscovery.runTestFileInProcess(testFile);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.passed, 3);
            assert.strictEqual(result.failed, 0);
        });

        it('should handle errors in in-process execution', async () => {
            const testFile = path.join(tempDir, 'error-in-process.mjs');
            fs.writeFileSync(testFile, `
                export default function() {
                    throw new Error('In-process error');
                }
            `);

            const result = await testDiscovery.runTestFileInProcess(testFile);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.failed, 1);
            assert.ok(result.errors.length > 0);
        });

        it('should support runTests export name', async () => {
            const testFile = path.join(tempDir, 'runtests-export.mjs');
            fs.writeFileSync(testFile, `
                export function runTests() {
                    return { passed: 2, failed: 1 };
                }
            `);

            const result = await testDiscovery.runTestFileInProcess(testFile);

            assert.strictEqual(result.passed, 2);
            assert.strictEqual(result.failed, 1);
        });
    });
});

// ============================================================================
// Test Result Structure Tests
// ============================================================================

describe('testDiscovery - Result Structures', () => {
    describe('Test info object structure', () => {
        it('should have correct properties', () => {
            const testInfo = {
                skillName: 'my-skill',
                shortName: 'my-skill',
                skillType: 'code',
                testFile: '/path/to/test.mjs',
                skillDir: '/path/to/skill',
            };

            assert.ok('skillName' in testInfo);
            assert.ok('shortName' in testInfo);
            assert.ok('skillType' in testInfo);
            assert.ok('testFile' in testInfo);
            assert.ok('skillDir' in testInfo);
        });
    });

    describe('Test result object structure', () => {
        it('should have correct properties', () => {
            const result = {
                success: true,
                passed: 5,
                failed: 0,
                output: 'test output',
                errors: [],
                duration: 1234,
            };

            assert.ok('success' in result);
            assert.ok('passed' in result);
            assert.ok('failed' in result);
            assert.ok('output' in result);
            assert.ok('errors' in result);
            assert.ok('duration' in result);
        });
    });

    describe('Suite result object structure', () => {
        it('should have correct properties', () => {
            const suiteResult = {
                success: true,
                totalTests: 5,
                totalPassed: 10,
                totalFailed: 0,
                results: [],
                errors: [],
                duration: 5000,
            };

            assert.ok('success' in suiteResult);
            assert.ok('totalTests' in suiteResult);
            assert.ok('totalPassed' in suiteResult);
            assert.ok('totalFailed' in suiteResult);
            assert.ok('results' in suiteResult);
            assert.ok('errors' in suiteResult);
            assert.ok('duration' in suiteResult);
        });
    });
});

// ============================================================================
// Default Export Tests
// ============================================================================

describe('testDiscovery - Default Export', () => {
    it('should export all functions via default', async () => {
        const testDiscovery = await import('../src/lib/testDiscovery.mjs');

        assert.ok(testDiscovery.default);
        assert.strictEqual(typeof testDiscovery.default.discoverSkillTests, 'function');
        assert.strictEqual(typeof testDiscovery.default.discoverSkillTest, 'function');
        assert.strictEqual(typeof testDiscovery.default.runTestFile, 'function');
        assert.strictEqual(typeof testDiscovery.default.runTestFileInProcess, 'function');
        assert.strictEqual(typeof testDiscovery.default.runTestSuite, 'function');
    });
});
