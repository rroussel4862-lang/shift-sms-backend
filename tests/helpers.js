const crypto = require("crypto");

// Unique values per call so tests never collide with leftover data from a
// previous run or with each other, without needing to truncate between files.
function uniqueSuffix() {
  return crypto.randomBytes(4).toString("hex");
}

function uniqueEmail(prefix = "test") {
  return `${prefix}-${Date.now()}-${uniqueSuffix()}@example.com`;
}

function uniquePhone() {
  // +1 555 is a reserved, always-fake North American prefix — never a real number.
  const n = Math.floor(1000000 + Math.random() * 8999999);
  return `+1555${n}`;
}

// Signs up a brand-new restaurant and returns a supertest agent that's already
// logged in (cookies persist automatically on the agent for every request after
// this), plus the restaurant's id and the credentials used.
async function createRestaurant(agentFactory, overrides = {}) {
  const email = overrides.email || uniqueEmail("owner");
  const password = overrides.password || "testpassword123";
  const restaurantName = overrides.restaurantName || `Test Restaurant ${uniqueSuffix()}`;

  const agent = agentFactory();
  const res = await agent
    .post("/api/auth/signup")
    .send({ restaurantName, email, password });

  if (res.status !== 201) {
    throw new Error(`createRestaurant signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return { agent, restaurantId: res.body.restaurant.id, email, password, restaurantName };
}

module.exports = { uniqueSuffix, uniqueEmail, uniquePhone, createRestaurant };
