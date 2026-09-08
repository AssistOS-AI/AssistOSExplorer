/**
 * HelpPrinter - Stateless utility functions for displaying help and history.
 *
 * Extracted from AchillesCli to reduce file size and improve modularity.
 * Uses HelpSystem for the main help content.
 */

import { getQuickReference } from './HelpSystem.mjs';

/**
 * Print the quick reference help screen.
 */
export function printHelp() {
    console.log(getQuickReference());
}

/**
 * Show recent command history.
 *
 * @param {HistoryManager} historyManager - The history manager instance
 * @param {number} count - Number of recent commands to show (default: 20)
 */
export function showHistory(historyManager, count = 20) {
    const recent = historyManager.getRecent(count);
    if (recent.length === 0) {
        console.log('\nNo command history yet.\n');
        return;
    }

    console.log(`\nCommand history (last ${recent.length} of ${historyManager.length}):`);
    recent.forEach(({ index, command }) => {
        console.log(`  ${index.toString().padStart(4)}  ${command}`);
    });
    console.log(`\nHistory stored at: ${historyManager.getHistoryPath()}\n`);
}

/**
 * Search command history for matching entries.
 *
 * @param {HistoryManager} historyManager - The history manager instance
 * @param {string} query - Search query
 * @param {number} limit - Maximum results to show (default: 20)
 */
export function searchHistory(historyManager, query, limit = 20) {
    const results = historyManager.search(query, limit);
    if (results.length === 0) {
        console.log(`\nNo history entries matching "${query}".\n`);
        return;
    }

    console.log(`\nHistory entries matching "${query}":`);
    results.forEach(({ index, command }) => {
        console.log(`  ${index.toString().padStart(4)}  ${command}`);
    });
    console.log('');
}

export default {
    printHelp,
    showHistory,
    searchHistory,
};
