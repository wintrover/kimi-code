// Barrel re-export so #/guard resolves to a single .ts file (the first
// entry in the package imports map). Real module lives under ./guard.
export * from './guard/index';
