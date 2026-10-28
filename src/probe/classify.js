export function classify(bootText, entries, completionSignal) {
  const failing = entries.filter((entry) => !/waiting for service/.test(entry.reason || ''));
  if (failing.length > 0) return 'inactive-error';
  if (entries.length > 0) return 'awaiting-service';
  if (completionSignal === true) return 'active';
  if (completionSignal === false) return 'boot-failed';
  return /MISSING_CREDENTIAL/.test(bootText) ? 'active' : 'boot-failed';
}
