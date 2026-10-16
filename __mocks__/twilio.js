// Manual Jest mock for the `twilio` package.
// Every test run uses this automatically (Jest looks in __mocks__ for
// node_modules package mocks) — no test ever sends a real text message
// or makes a real network call to Twilio, regardless of what's in .env.test.

function twilio(accountSid, authToken) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({ sid: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", status: "queued" }),
    },
  };
}

class MessagingResponse {
  constructor() {
    this._messages = [];
  }
  message(text) {
    this._messages.push(text);
    return this;
  }
  toString() {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${this._messages
      .map((m) => `<Message>${m}</Message>`)
      .join("")}</Response>`;
  }
}

twilio.twiml = { MessagingResponse };

// Same algorithm as the real library (HMAC-SHA1 of the full URL + the sorted POST parameters, base64), so tests can check the
// inbound-text signature gate without contacting Twilio.
const crypto = require("crypto");
twilio.getExpectedTwilioSignature = (authToken, url, params) => {
  const data = Object.keys(params || {}).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
};
twilio.validateRequest = (authToken, signature, url, params) => signature === twilio.getExpectedTwilioSignature(authToken, url, params);

module.exports = twilio;
