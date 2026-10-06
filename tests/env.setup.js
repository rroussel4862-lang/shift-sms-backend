// Runs before every test file. Loads .env.test instead of .env, so tests
// never accidentally pick up production credentials.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env.test") });

// Hard safety gate: .env.test must explicitly set this to "true". This exists
// so that pointing DATABASE_URL at the wrong database by mistake doesn't
// silently wipe real data — the test suite refuses to run at all without it.
if (process.env.ALLOW_TEST_DB_WIPE !== "true") {
  throw new Error(
    "Refusing to run tests: ALLOW_TEST_DB_WIPE is not set to \"true\" in .env.test. " +
    "This flag exists so tests can never accidentally wipe a database you didn't mean them to. " +
    "Only set it in a .env.test file pointing at a dedicated TEST database — never your real one."
  );
}
