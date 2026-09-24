// Explorer adapter for the shared skill export transaction protocol. The
// protocol module is a byte-identical copy of Ploinky's
// cli/utils/skills/exportTransaction.mjs; only the link factory differs.
import {
  syncManagedSkillExports as syncWithTransaction,
  relativeSkillLink,
  skillTreeDigest,
  copyFreshSkillTree,
  EXPORT_LEDGER
} from './skill-export-transaction.mjs';

export { skillTreeDigest, copyFreshSkillTree, EXPORT_LEDGER };

/** Compatibility export only. Existing files are never adopted from names.
 * Retired trees stay outside the skill root, including for writes through old
 * open descriptors. Publication runs as one recoverable transaction under the
 * folder's export lock.
 */
export function syncManagedSkillExports(options) {
  return syncWithTransaction({ linker: relativeSkillLink, ...options });
}
