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

module.exports = twilio;
