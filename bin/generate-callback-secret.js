#!/usr/bin/env node
// Prints a callback secret for BLOCKONOMICS_CALLBACK_SECRET.
const { randomBytes } = require("crypto")

console.error("Add this line to your .env file:")
console.log(`BLOCKONOMICS_CALLBACK_SECRET=MEDUSA_${randomBytes(32).toString("hex")}`)
