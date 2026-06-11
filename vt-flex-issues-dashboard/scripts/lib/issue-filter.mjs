// Issue classifier for the Slack route.
//
// Splits incoming Flex issues into:
//   - ACTIONABLE   → managers should triage these (audio drops, UI bugs,
//                    routing failures, NAT notes, etc.)
//   - FILTERED     → routing/attribution complaints (Prof Certs, PC, CS,
//                    Client) that managers can't act on between calls
//
// The rules are deliberately precision-biased: better to send a borderline
// issue to managers than to silently swallow it. The audit table
// (vt_flex_slack_posts.filter_hits) records why anything was filtered, so
// the rules can be tuned from real evidence after a week of live data.
//
// History: validated against ~34 issues spanning 24h on 2026-06-10.
// Reverse-test results posted in #flex-support-help-bot thread starting at
// ts 1781125613.122089.

// PC verb-form lookahead: refuse to match technical-symptom uses of "PC"
// like "my PC froze", "had to reboot my PC", "PC won't load", "PC was muted".
const PC_TECH_SYMPTOM_LOOKAHEAD =
  '(?!\\s+(?:was|is|crash|froz|freez|reboot|restart|won|wont|doesn|isn|broke|broken|slow|down|locked|hung|stuck))';

export const FILTER_RULES = [
  // Prof Certs — also catches the "Pro certs" typo we see in the wild
  { name: 'prof_cert', re: /\bpro\.?f?[\s.\-]{0,3}certs?\b/i },

  // PC (Prospective Customer) used as a routing tag/category
  { name: 'pc_routing_noun', re: /\bPC\s+(call|lead|sc|xfer|transfer|client|inbound|outbound|cb|callback|tag|task|chat)\b/i },
  { name: 'pc_prep',         re: /\b(for|under|to|as)\s+PC\b/i },
  { name: 'pc_routed_verb',  re: new RegExp(
      `\\b(routed|got|received|sent|transferr?ed)\\s+(?:\\w+\\s+){0,3}?(?:a\\s+|an\\s+|another\\s+|the\\s+)?PC\\b${PC_TECH_SYMPTOM_LOOKAHEAD}`,
      'i'
    ) },

  // Client Services / CS
  { name: 'client_services', re: /\bclient\s+services?\b/i },
  { name: 'cs_routing_noun', re: /\bCS\s+(call|lead|xfer|transfer|tag|task|client|chat)\b/i },
  { name: 'cs_routed_verb',  re: /\b(routed|got|received|sent|transferr?ed)\s+(?:\w+\s+){0,3}?(?:a\s+|an\s+|to\s+|the\s+)?CS\b/i },

  // Client routed (existing client landed in lead queue)
  { name: 'already_client',     re: /\balready\s+a?\s*clients?\b/i },
  { name: 'current_client',     re: /\b(current|existing)\s+clients?\b/i },
  { name: 'client_routed_verb', re: /\b(routed|got|received|sent|transferr?ed)\s+(?:\w+\s+){0,3}?(?:a\s+|an\s+|me\s+|the\s+)?clients?\b/i },
  { name: 'client_noun',        re: /\bclients?\s+(call|lead|xfer|transfer|tag|task|sc|cb|callback)\b/i }
];

/**
 * Classify an issue by its rep-written description.
 * @param {string|null} description - issue.agent_description
 * @returns {{ filtered: boolean, hits: string[] }}
 *   filtered=true means DO NOT send to managers (skip / route to filtered-bucket).
 *   hits is the list of rule names that matched; useful for audit + tuning.
 */
export function classifyIssue(description) {
  const text = String(description || '');
  const hits = FILTER_RULES.filter((r) => r.re.test(text)).map((r) => r.name);
  return { filtered: hits.length > 0, hits };
}
