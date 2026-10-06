const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.test") });

module.exports = async function globalSetup() {
  if (process.env.ALLOW_TEST_DB_WIPE !== "true") {
    throw new Error(
      "Refusing to run tests: ALLOW_TEST_DB_WIPE is not set to \"true\" in .env.test. " +
      "Only ever set this against a dedicated TEST database."
    );
  }

  // Requiring server.js here creates the schema (via initDb) and gives us a pool
  // scoped to this one-time setup process — separate from whatever pool each
  // test file creates when it requires server.js again.
  const { pool, initDb } = require("../server.js");
  await initDb();

  // One clean slate at the start of the whole run. CASCADE pulls in every table
  // with a foreign key back to restaurants (staff, shifts, postings, schedule,
  // sales data, etc.) in a single statement. platform_admins has no restaurant_id,
  // so it's listed separately.
  await pool.query("TRUNCATE restaurants, platform_admins RESTART IDENTITY CASCADE;");

  await pool.end();
};
