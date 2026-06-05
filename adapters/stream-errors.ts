const RECONNECTING_ADVISORY_RE = /^\s*(?:(?:\[[^\]\n]+]|\w[\w.-]*:)\s*)*Reconnecting\b/i;

export function isReconnectAdvisory(message: string): boolean {
  return RECONNECTING_ADVISORY_RE.test(message);
}
