// intent → send → confirm → reconcile. Idempotent on every code path.
// Never retry without reconciling first. See spec §2.8. Day 1.
export {};
