#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");
const outPath = path.join(root, "firebase-config.js");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env. Copy .env.example to .env and fill in the Firebase values.");
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
}

const required = [
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_STORAGE_BUCKET",
  "FIREBASE_MESSAGING_SENDER_ID",
  "FIREBASE_APP_ID",
];

const missing = required.filter((key) => !env[key]);
if (missing.length) {
  console.error(`Missing values in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const js = `/**
 * Generated from .env — do not edit by hand.
 * Run: node scripts/generate-firebase-config.js
 */
window.DAYLINE_FIREBASE = {
  apiKey: ${JSON.stringify(env.FIREBASE_API_KEY)},
  authDomain: ${JSON.stringify(env.FIREBASE_AUTH_DOMAIN)},
  databaseURL: ${JSON.stringify(env.FIREBASE_DATABASE_URL)},
  projectId: ${JSON.stringify(env.FIREBASE_PROJECT_ID)},
  storageBucket: ${JSON.stringify(env.FIREBASE_STORAGE_BUCKET)},
  messagingSenderId: ${JSON.stringify(env.FIREBASE_MESSAGING_SENDER_ID)},
  appId: ${JSON.stringify(env.FIREBASE_APP_ID)},
  measurementId: ${JSON.stringify(env.FIREBASE_MEASUREMENT_ID || "")},
};
`;

fs.writeFileSync(outPath, js);
console.log("Wrote firebase-config.js from .env");
