/**
 * Shared cloud config — required so everyone sees the same updates.
 *
 * One-time setup (~5 min):
 * 1. Open https://console.firebase.google.com/ and create a project (e.g. fatakpay-dayline)
 * 2. Build → Realtime Database → Create database → Start in **test mode** → Choose any region
 * 3. Project settings (gear icon) → Your apps → Web app </>) → Register app
 * 4. Copy the firebaseConfig object values into this file
 * 5. Commit & push so GitHub Pages updates
 *
 * Realtime Database rules (Rules tab) — use for internal team:
 * {
 *   "rules": {
 *     ".read": true,
 *     ".write": true
 *   }
 * }
 */
window.DAYLINE_FIREBASE = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};
