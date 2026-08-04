// Native ESM: no transform, and `test` runs jest under
// NODE_OPTIONS=--experimental-vm-modules (required for import.meta support).
export default {
  testEnvironment: 'node',
  transform: {},
  // real Postgres round-trips, and cross-database tests serialize CREATE
  // DATABASE on an advisory lock — allow well beyond Jest's 5s default
  testTimeout: 30000,
};
