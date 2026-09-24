#!/usr/bin/env node
// Prints a callback secret for BLOCKONOMICS_CALLBACK_SECRET.
const { randomBytes } = require("crypto")

console.log(`MEDUSA_${randomBytes(32).toString("hex")}`)
