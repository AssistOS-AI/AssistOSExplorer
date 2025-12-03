/**
 * Tests for CommandSelector, buildCommandList, and showSkillSelector.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// CommandSelector - Full Suite
// ============================================================================

describe('CommandSelector - Full Suite', () => {
    let CommandSelector;

    const testCommands = [
        { name: '/help', description: 'Show help', usage: '/help' },
        { name: '/list', description: 'List skills', usage: '/list' },
        { name: '/read', description: 'Read a skill', usage: '/read <skill>' },
        { name: '/write', description: 'Write a skill', usage: '/write <skill>' },
        { name: '/delete', description: 'Delete a skill', usage: '/delete <skill>' },
        { name: '/generate', description: 'Generate code', usage: '/generate <skill>' },
        { name: '/test', description: 'Test code', usage: '/test <skill>' },
        { name: '/refine', description: 'Refine skill', usage: '/refine <skill>' },
        { name: '/exec', description: 'Execute skill', usage: '/exec <skill>' },
        { name: '/template', description: 'Get template', usage: '/template <type>' },
    ];

    beforeEach(async () => {
        const module = await import('../src/ui/CommandSelector.mjs');
        CommandSelector = module.CommandSelector;
    });

    describe('Initialization', () => {
        it('should initialize with all commands', () => {
            const selector = new CommandSelector(testCommands);
            assert.strictEqual(selector.filteredCommands.length, testCommands.length);
        });

        it('should respect maxVisible option', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            assert.strictEqual(selector.maxVisible, 5);
        });
    });

    describe('Filtering', () => {
        it('should filter by command name', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('read');
            assert.strictEqual(selector.filteredCommands.length, 1);
            assert.strictEqual(selector.filteredCommands[0].name, '/read');
        });

        it('should filter by description', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('skill');
            assert.ok(selector.filteredCommands.length > 1, 'Should match multiple commands');
        });

        it('should be case-insensitive', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('READ');
            assert.strictEqual(selector.filteredCommands.length, 1);
        });

        it('should reset selection on filter update', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveDown();
            selector.moveDown();
            selector.updateFilter('read');
            assert.strictEqual(selector.selectedIndex, 0);
        });

        it('should handle empty filter', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('read');
            selector.updateFilter('');
            assert.strictEqual(selector.filteredCommands.length, testCommands.length);
        });

        it('should handle no matches', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            assert.strictEqual(selector.filteredCommands.length, 0);
        });
    });

    describe('Navigation', () => {
        it('should move down through list', () => {
            const selector = new CommandSelector(testCommands);
            assert.strictEqual(selector.selectedIndex, 0);
            selector.moveDown();
            assert.strictEqual(selector.selectedIndex, 1);
        });

        it('should not move past end of list', () => {
            const selector = new CommandSelector(testCommands);
            for (let i = 0; i < testCommands.length + 5; i++) {
                selector.moveDown();
            }
            assert.strictEqual(selector.selectedIndex, testCommands.length - 1);
        });

        it('should move up through list', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveDown();
            selector.moveDown();
            selector.moveUp();
            assert.strictEqual(selector.selectedIndex, 1);
        });

        it('should not move past beginning of list', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveUp();
            assert.strictEqual(selector.selectedIndex, 0);
        });

        it('should handle scrollOffset when moving down', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) {
                selector.moveDown();
            }
            assert.ok(selector.scrollOffset > 0, 'Should have scrolled');
        });

        it('should handle scrollOffset when moving up', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) selector.moveDown();
            for (let i = 0; i < 5; i++) selector.moveUp();
            assert.strictEqual(selector.scrollOffset, 0, 'Should scroll back to top');
        });
    });

    describe('Selection', () => {
        it('should return selected command', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveDown();
            const selected = selector.getSelected();
            assert.strictEqual(selected.name, testCommands[1].name);
        });

        it('should return null when no commands match filter', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            assert.strictEqual(selector.getSelected(), null);
        });
    });

    describe('Rendering', () => {
        it('should render visible items', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            const lines = selector.render();
            assert.ok(lines.length > 0, 'Should have rendered lines');
        });

        it('should show scroll indicators', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) selector.moveDown();
            const lines = selector.render();
            const hasMoreAbove = lines.some(l => l.includes('more above'));
            const hasMoreBelow = lines.some(l => l.includes('more below'));
            assert.ok(hasMoreAbove || hasMoreBelow, 'Should show scroll indicator');
        });

        it('should show empty state message', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            const lines = selector.render();
            assert.ok(lines.some(l => l.toLowerCase().includes('no matching')), 'Should show no matching message');
        });

        it('should highlight selected item', () => {
            const selector = new CommandSelector(testCommands);
            const lines = selector.render();
            assert.ok(lines[0].includes('❯') || lines[0].includes('\x1b[36m'), 'Should highlight selection');
        });

        it('should render fewer lines when filter reduces list size', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            const initialCount = selector.getRenderedLineCount();

            selector.updateFilter('help');
            const filteredLines = selector.render();
            const filteredCount = selector.getRenderedLineCount();

            assert.ok(filteredCount < initialCount, 'Filtered list should have fewer rendered lines');
            assert.strictEqual(filteredLines.length, 1, 'Should only render one command');
        });

        it('should handle rapid filter changes without state corruption', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });

            selector.updateFilter('r');
            selector.updateFilter('re');
            selector.updateFilter('rea');
            selector.updateFilter('read');
            selector.updateFilter('rea');
            selector.updateFilter('re');
            selector.updateFilter('');

            assert.strictEqual(selector.filteredCommands.length, testCommands.length);
            assert.strictEqual(selector.selectedIndex, 0);
            assert.strictEqual(selector.scrollOffset, 0);
        });
    });

    describe('getRenderedLineCount', () => {
        it('should count visible lines correctly', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            const count = selector.getRenderedLineCount();
            assert.strictEqual(count, 6); // 5 visible + 1 "more below"
        });

        it('should count scroll indicators', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) selector.moveDown();
            const count = selector.getRenderedLineCount();
            assert.ok(count >= 4, 'Should include scroll indicators');
        });

        it('should handle empty filtered list', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            const count = selector.getRenderedLineCount();
            assert.strictEqual(count, 1); // Just the "no matching" message
        });
    });
});

// ============================================================================
// buildCommandList Tests
// ============================================================================

describe('buildCommandList - Full Suite', () => {
    let buildCommandList;
    let SlashCommandHandler;

    beforeEach(async () => {
        const cmdModule = await import('../src/ui/CommandSelector.mjs');
        buildCommandList = cmdModule.buildCommandList;
        const handlerModule = await import('../src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = handlerModule.SlashCommandHandler;
    });

    it('should build command list from COMMANDS', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        assert.ok(Array.isArray(commands), 'Should return array');
        assert.ok(commands.length > 0, 'Should have commands');
    });

    it('should include /help command', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        const helpCmd = commands.find(c => c.name === '/help');
        assert.ok(helpCmd, 'Should include /help');
    });

    it('should have required properties for each command', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        for (const cmd of commands) {
            assert.ok(cmd.name, 'Command should have name');
            assert.ok(cmd.description, 'Command should have description');
            assert.ok(cmd.usage, 'Command should have usage');
            assert.ok('needsSkillArg' in cmd, 'Command should have needsSkillArg');
        }
    });

    it('should sort commands alphabetically', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        const names = commands.map(c => c.name);
        const sorted = [...names].sort();
        assert.deepStrictEqual(names, sorted, 'Commands should be sorted');
    });

    it('should deduplicate aliases', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        const listCommands = commands.filter(c => c.name === '/list' || c.name === '/ls');
        assert.ok(listCommands.length <= 2, 'Should deduplicate aliases');
    });
});

// ============================================================================
// showSkillSelector Tests
// ============================================================================

describe('showSkillSelector - Full Suite', () => {
    let showSkillSelector;
    let CommandSelector;

    const testSkills = [
        { name: 'calculator', shortName: 'calculator', type: 'code', description: 'Math operations' },
        { name: 'formatter', shortName: 'formatter', type: 'code', description: 'Format text' },
        { name: 'booking', shortName: 'booking', type: 'interactive', description: 'Make reservations' },
        { name: 'inventory', shortName: 'inventory', type: 'dbtable', description: 'Track stock' },
    ];

    beforeEach(async () => {
        const module = await import('../src/ui/CommandSelector.mjs');
        showSkillSelector = module.showSkillSelector;
        CommandSelector = module.CommandSelector;
    });

    it('showSkillSelector should be a function', () => {
        assert.strictEqual(typeof showSkillSelector, 'function');
    });

    it('skill items should be transformed correctly for CommandSelector', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        assert.strictEqual(skillItems[0].name, 'calculator');
        assert.strictEqual(skillItems[0].description, '[code] Math operations');
        assert.strictEqual(skillItems[0].type, 'code');
    });

    it('CommandSelector should work with skill items', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });

        assert.strictEqual(selector.filteredCommands.length, 4);
        assert.strictEqual(selector.getSelected().name, 'calculator');
    });

    it('filtering skills by type should work', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('code');

        assert.strictEqual(selector.filteredCommands.length, 2);
    });

    it('filtering skills by name should work', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('calc');

        assert.strictEqual(selector.filteredCommands.length, 1);
        assert.strictEqual(selector.getSelected().name, 'calculator');
    });

    it('selected skill should include type property', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        const selected = selector.getSelected();

        assert.ok('type' in selected, 'Selected skill should have type property');
        assert.strictEqual(selected.type, 'code');
    });

    it('should handle skills with missing shortName', () => {
        const skills = [{ name: 'long-skill-name', type: 'code', description: 'Test' }];
        const skillItems = skills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        assert.strictEqual(skillItems[0].name, 'long-skill-name');
    });

    it('should handle skills with missing description', () => {
        const skills = [{ name: 'no-desc', shortName: 'no-desc', type: 'code' }];
        const skillItems = skills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        assert.strictEqual(skillItems[0].description, '[code]');
    });

    it('should filter by partial skill name', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('form');

        assert.strictEqual(selector.filteredCommands.length, 1);
        assert.strictEqual(selector.getSelected().name, 'formatter');
    });

    it('should filter by description content', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('reserv');

        assert.strictEqual(selector.filteredCommands.length, 1);
        assert.strictEqual(selector.getSelected().name, 'booking');
    });
});
