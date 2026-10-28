export const STATUS = Object.freeze({
  ACTIVE: 'active',
  AWAITING_SERVICE: 'awaiting-service',
  INACTIVE_ERROR: 'inactive-error',
});

export const TRUST = Object.freeze({
  SELF_REPORTED: 'self-reported',
  VERIFIED: 'verified',
  DISPUTED: 'disputed',
  LEGACY_UNPINNED: 'legacy-unpinned',
});
