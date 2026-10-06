module.exports = async function globalTeardown() {
  // Each test file closes its own database pool in its own afterAll.
  // Nothing shared to clean up here.
};
