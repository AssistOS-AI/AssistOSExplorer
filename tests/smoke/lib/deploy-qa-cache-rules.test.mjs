import { run } from '../../../.github/scripts/cloudflare-cache-rules.mjs';
import { registerCacheRulesTests } from '../../cloudflare-cache-rules-cases.mjs';

registerCacheRulesTests(run, new URL('../../../.github/scripts/cloudflare-cache-rules.mjs', import.meta.url));
