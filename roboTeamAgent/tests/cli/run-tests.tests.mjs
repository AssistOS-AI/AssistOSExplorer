/**
 * Tests for run-tests skill
 *
 * Tests the test discovery and execution functionality.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import the modules to test
import {
    discoverSkillTests,
    discoverSkillTest,
    runTestFile,
    runTestSuite,
} from '../src/lib/testDiscovery.mjs';

import {
    formatDuration,
    formatTestResult,
    formatSuiteResults,
    formatCompactResult,
    formatTestList,
} from '../src/ui/TestResultFormatter.mjs';

// Test utilities
function assertEqual(actual, expected, message = '') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
    }
}

function assertTrue(value, message = 'Expected true') {
    if (!value) throw new Error(message);
}

function assertFalse(value, message = 'Expected false') {
    if (value) throw new Error(message);
}

function assertContains(str, substring, message = '') {
    if (!str || !str.includes(substring)) {
        throw new Error(`${message}\nExpected "${str}" to contain "${substring}"`);
    }
}

/**
 * Create a temporary test file for testing the test runner
 */
function createTempTestFile(content) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    const testFile = path.join(tmpDir, '.tests.mjs');
    fs.writeFileSync(testFile, content, 'utf8');
    return { tmpDir, testFile };
}

/**
 * Clean up temporary directory
 */
function cleanupTempDir(tmpDir) {
    try {
        fs.rmSync(tmpDir, { recursive: true });
    } catch (e) {
        // Ignore cleanup errors
    }
}

/**
 * Run all tests
 */
export default async function runTests() {
    const results = { passed: 0, failed: 0, errors: [] };

    async function test(name, fn) {
        try {
            await fn();
            results.passed++;
            console.log(`  ✓ ${name}`);
        } catch (error) {
            results.failed++;
            results.errors.push(`${name}: ${error.message}`);
            console.log(`  ✗ ${name}: ${error.message}`);
        }
    }

    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║              Run-Tests Skill Unit Tests                        ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    // ========================================================================
    // formatDuration Tests
    // ========================================================================
    console.log('📏 FORMAT DURATION TESTS');
    console.log('─'.repeat(50));

    await test('formatDuration formats milliseconds', () => {
        assertEqual(formatDuration(500), '500ms');
        assertEqual(formatDuration(0), '0ms');
        assertEqual(formatDuration(999), '999ms');
    });

    await test('formatDuration formats seconds', () => {
        assertEqual(formatDuration(1000), '1.00s');
        assertEqual(formatDuration(1500), '1.50s');
        assertEqual(formatDuration(12345), '12.35s');
    });

    // ========================================================================
    // formatTestResult Tests
    // ========================================================================
    console.log('\n📊 FORMAT TEST RESULT TESTS');
    console.log('─'.repeat(50));

    await test('formatTestResult formats passing test', () => {
        const result = {
            skillName: 'my-skill',
            success: true,
            passed: 5,
            failed: 0,
            duration: 100,
        };
        const formatted = formatTestResult(result);
        assertContains(formatted, 'PASS');
        assertContains(formatted, 'my-skill');
        assertContains(formatted, '5 passed');
    });

    await test('formatTestResult formats failing test', () => {
        const result = {
            skillName: 'my-skill',
            success: false,
            passed: 3,
            failed: 2,
            duration: 200,
            errors: ['Test 1 failed', 'Test 2 failed'],
        };
        const formatted = formatTestResult(result);
        assertContains(formatted, 'FAIL');
        assertContains(formatted, 'my-skill');
        assertContains(formatted, '2 failed');
    });

    await test('formatTestResult handles missing counts', () => {
        const result = {
            skillName: 'my-skill',
            success: true,
            duration: 50,
        };
        const formatted = formatTestResult(result);
        assertContains(formatted, 'PASS');
        assertContains(formatted, 'my-skill');
    });

    // ========================================================================
    // formatSuiteResults Tests
    // ========================================================================
    console.log('\n📋 FORMAT SUITE RESULTS TESTS');
    console.log('─'.repeat(50));

    await test('formatSuiteResults formats suite with all passing', () => {
        const suiteResult = {
            success: true,
            totalTests: 2,
            totalPassed: 5,
            totalFailed: 0,
            duration: 300,
            results: [
                { skillName: 'skill-1', success: true, passed: 3, failed: 0 },
                { skillName: 'skill-2', success: true, passed: 2, failed: 0 },
            ],
        };
        const formatted = formatSuiteResults(suiteResult);
        assertContains(formatted, 'All tests passed');
        assertContains(formatted, 'Tests:   2');
        // Passed count has ANSI codes around it
        assertContains(formatted, 'Passed:');
        assertContains(formatted, '5');
    });

    await test('formatSuiteResults formats suite with failures', () => {
        const suiteResult = {
            success: false,
            totalTests: 2,
            totalPassed: 3,
            totalFailed: 2,
            duration: 500,
            results: [
                { skillName: 'skill-1', success: true, passed: 3, failed: 0 },
                { skillName: 'skill-2', success: false, passed: 0, failed: 2, errors: ['Error 1'] },
            ],
        };
        const formatted = formatSuiteResults(suiteResult);
        assertContains(formatted, 'Some tests failed');
        // Failed count has ANSI codes around it
        assertContains(formatted, 'Failed:');
        assertContains(formatted, '2');
    });

    // ========================================================================
    // formatCompactResult Tests
    // ========================================================================
    console.log('\n📝 FORMAT COMPACT RESULT TESTS');
    console.log('─'.repeat(50));

    await test('formatCompactResult formats single line', () => {
        const result = {
            skillName: 'test-skill',
            success: true,
            passed: 10,
            failed: 0,
            duration: 150,
        };
        const formatted = formatCompactResult(result);
        assertContains(formatted, 'test-skill');
        assertContains(formatted, '10✓');
    });

    await test('formatCompactResult shows failures', () => {
        const result = {
            skillName: 'test-skill',
            success: false,
            passed: 5,
            failed: 3,
            duration: 200,
        };
        const formatted = formatCompactResult(result);
        assertContains(formatted, '5✓');
        assertContains(formatted, '3✗');
    });

    // ========================================================================
    // formatTestList Tests
    // ========================================================================
    console.log('\n📃 FORMAT TEST LIST TESTS');
    console.log('─'.repeat(50));

    await test('formatTestList transforms test info array', () => {
        const tests = [
            { skillName: 'skill-a', shortName: 'a', skillType: 'cskill', testFile: '/path/to/.tests.mjs' },
            { skillName: 'skill-b', shortName: 'b', skillType: 'tskill', testFile: '/other/.tests.mjs' },
        ];
        const formatted = formatTestList(tests);
        assertEqual(formatted.length, 2);
        assertEqual(formatted[0].name, 'a');
        assertContains(formatted[0].description, 'cskill');
        assertEqual(formatted[1].name, 'b');
        assertContains(formatted[1].description, 'tskill');
    });

    await test('formatTestList handles empty array', () => {
        const formatted = formatTestList([]);
        assertEqual(formatted.length, 0);
    });

    // ========================================================================
    // discoverSkillTests Tests
    // ========================================================================
    console.log('\n🔍 DISCOVER SKILL TESTS');
    console.log('─'.repeat(50));

    await test('discoverSkillTests returns empty for null agent', () => {
        const tests = discoverSkillTests(null);
        assertEqual(tests, []);
    });

    await test('discoverSkillTests returns empty for agent without catalog', () => {
        const tests = discoverSkillTests({});
        assertEqual(tests, []);
    });

    await test('discoverSkillTests finds tests in tests folder', () => {
        // Create a mock agent with skill catalog and context pointing to the skill-manager-cli directory
        // The tests folder contains run-tests.tests.mjs
        const workingDir = path.join(__dirname, '..');
        const mockAgent = {
            skillCatalog: new Map([
                ['run-tests-code', {
                    skillDir: path.join(workingDir, 'src/.AchillesSkills/run-tests'),
                    shortName: 'run-tests',
                    type: 'code',
                }],
            ]),
            context: { workingDir },
        };
        const tests = discoverSkillTests(mockAgent);
        assertEqual(tests.length, 1);
        assertEqual(tests[0].skillName, 'run-tests-code');
        assertEqual(tests[0].shortName, 'run-tests');
        assertEqual(tests[0].skillType, 'code');
        assertContains(tests[0].testFile, 'run-tests.tests.mjs');
    });

    // ========================================================================
    // discoverSkillTest Tests
    // ========================================================================
    console.log('\n🎯 DISCOVER SKILL TEST');
    console.log('─'.repeat(50));

    await test('discoverSkillTest returns null for null agent', () => {
        const test = discoverSkillTest(null, 'some-skill');
        assertEqual(test, null);
    });

    await test('discoverSkillTest returns null for missing skill', () => {
        const mockAgent = {
            findSkillFile: () => null,
        };
        const test = discoverSkillTest(mockAgent, 'nonexistent');
        assertEqual(test, null);
    });

    await test('discoverSkillTest finds test for existing skill', () => {
        const workingDir = path.join(__dirname, '..');
        const mockAgent = {
            context: { workingDir },
            findSkillFile: (name) => {
                if (name === 'run-tests') {
                    return {
                        filePath: path.join(workingDir, 'src/.AchillesSkills/run-tests/cskill.md'),
                        record: {
                            skillDir: path.join(workingDir, 'src/.AchillesSkills/run-tests'),
                            shortName: 'run-tests',
                            type: 'code',
                        },
                    };
                }
                return null;
            },
        };
        const foundTest = discoverSkillTest(mockAgent, 'run-tests');
        assertTrue(foundTest !== null, 'Should find test');
        assertEqual(foundTest.skillName, 'run-tests');
        assertEqual(foundTest.shortName, 'run-tests');
        assertContains(foundTest.testFile, 'run-tests.tests.mjs');
    });

    // ========================================================================
    // runTestFile Tests
    // ========================================================================
    console.log('\n▶️ RUN TEST FILE TESTS');
    console.log('─'.repeat(50));

    await test('runTestFile runs passing test file', async () => {
        // Create test file without leading whitespace
        const { tmpDir, testFile } = createTempTestFile(
`export default async function runTests() {
    return { passed: 3, failed: 0, errors: [] };
}`
        );

        try {
            const result = await runTestFile(testFile, { timeout: 5000 });
            assertTrue(result.success, `Test should pass: ${JSON.stringify(result)}`);
            assertEqual(result.passed, 3);
            assertEqual(result.failed, 0);
        } finally {
            cleanupTempDir(tmpDir);
        }
    });

    await test('runTestFile runs failing test file', async () => {
        const { tmpDir, testFile } = createTempTestFile(
`export default async function runTests() {
    return { passed: 1, failed: 2, errors: ['Error 1', 'Error 2'] };
}`
        );

        try {
            const result = await runTestFile(testFile, { timeout: 5000 });
            assertFalse(result.success, 'Test should fail');
            assertEqual(result.passed, 1);
            assertEqual(result.failed, 2);
        } finally {
            cleanupTempDir(tmpDir);
        }
    });

    await test('runTestFile handles test timeout', async () => {
        const { tmpDir, testFile } = createTempTestFile(
`export default async function runTests() {
    await new Promise(r => setTimeout(r, 10000));
    return { passed: 1, failed: 0 };
}`
        );

        try {
            const result = await runTestFile(testFile, { timeout: 500 });
            assertFalse(result.success, 'Should timeout');
            assertContains(result.errors[0], 'timeout');
        } finally {
            cleanupTempDir(tmpDir);
        }
    });

    await test('runTestFile handles syntax errors', async () => {
        const { tmpDir, testFile } = createTempTestFile(
`export default async function runTests( {
    return { passed: 1, failed: 0 };
}`
        );

        try {
            const result = await runTestFile(testFile, { timeout: 5000 });
            assertFalse(result.success, 'Should fail with syntax error');
        } finally {
            cleanupTempDir(tmpDir);
        }
    });

    // ========================================================================
    // runTestSuite Tests
    // ========================================================================
    console.log('\n🏃 RUN TEST SUITE TESTS');
    console.log('─'.repeat(50));

    await test('runTestSuite runs multiple tests', async () => {
        const tmp1 = createTempTestFile(
`export default async function() { return { passed: 2, failed: 0 }; }`
        );
        const tmp2 = createTempTestFile(
`export default async function() { return { passed: 3, failed: 0 }; }`
        );

        try {
            const tests = [
                { skillName: 'test-1', testFile: tmp1.testFile },
                { skillName: 'test-2', testFile: tmp2.testFile },
            ];
            const result = await runTestSuite(tests, { timeout: 5000 });
            assertTrue(result.success, `Suite should pass: ${JSON.stringify(result)}`);
            assertEqual(result.totalTests, 2);
            assertEqual(result.totalPassed, 5);
            assertEqual(result.totalFailed, 0);
        } finally {
            cleanupTempDir(tmp1.tmpDir);
            cleanupTempDir(tmp2.tmpDir);
        }
    });

    await test('runTestSuite aggregates failures', async () => {
        const tmp1 = createTempTestFile(
`export default async function() { return { passed: 2, failed: 1, errors: ['Fail 1'] }; }`
        );
        const tmp2 = createTempTestFile(
`export default async function() { return { passed: 1, failed: 2, errors: ['Fail 2', 'Fail 3'] }; }`
        );

        try {
            const tests = [
                { skillName: 'test-1', testFile: tmp1.testFile },
                { skillName: 'test-2', testFile: tmp2.testFile },
            ];
            const result = await runTestSuite(tests, { timeout: 5000 });
            assertFalse(result.success, 'Suite should fail');
            assertEqual(result.totalPassed, 3);
            assertEqual(result.totalFailed, 3);
            assertEqual(result.errors.length, 3);
        } finally {
            cleanupTempDir(tmp1.tmpDir);
            cleanupTempDir(tmp2.tmpDir);
        }
    });

    // ========================================================================
    // Summary
    // ========================================================================
    console.log('\n' + '═'.repeat(60));
    console.log(`Run-Tests Skill Tests: ${results.passed} passed, ${results.failed} failed`);
    console.log('═'.repeat(60));

    return results;
}
