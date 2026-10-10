import { readFileSync } from 'node:fs';

/**
 * The Make account the capture tools talk to. Both files are gitignored: a webhook URL
 * is a live trigger anyone could call, and the token can edit scenarios.
 *
 *   .make-token       Make API token (scenarios read/write)
 *   .make-hooks.json  { "A": "https://hook.eu1.make.com/…", "B": …, "C": …, "D": … }
 *                     the Custom webhook URL of each corpus scenario
 */
export const makeToken = (): string => readFileSync('.make-token', 'utf8').trim();

export function hookUrl(scenario: string): string {
  const hooks = JSON.parse(readFileSync('.make-hooks.json', 'utf8')) as Record<string, string>;
  const url = hooks[scenario];
  if (!url) throw new Error(`.make-hooks.json has no webhook URL for scenario ${scenario}`);
  return url;
}
