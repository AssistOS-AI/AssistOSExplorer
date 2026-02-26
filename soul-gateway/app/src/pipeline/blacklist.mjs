import { getEnabledRules } from '../db/blacklist-dao.mjs';
import { BlacklistError } from '../utils/errors.mjs';

/**
 * Scan all message content against blacklist rules.
 * Throws BlacklistError if any rule matches.
 */
export async function checkBlacklist(messages) {
  const rules = await getEnabledRules();
  if (rules.length === 0) return;

  // Concatenate all message content for scanning
  const allContent = messages
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join(' ');
      }
      return '';
    })
    .join('\n');

  for (const rule of rules) {
    let matched = false;
    switch (rule.match_type) {
      case 'exact':
        matched = allContent === rule.pattern;
        break;
      case 'substring':
        matched = allContent.includes(rule.pattern);
        break;
      case 'regex':
        try {
          const re = new RegExp(rule.pattern, 'i');
          matched = re.test(allContent);
        } catch {
          // Invalid regex, skip
        }
        break;
    }

    if (matched) {
      throw new BlacklistError(
        `Request blocked by content policy rule: ${rule.description || rule.id}`,
        rule.id,
        rule.pattern.slice(0, 50) // Truncate for audit
      );
    }
  }
}
