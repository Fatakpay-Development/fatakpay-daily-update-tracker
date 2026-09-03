(function () {
  const ADMIN_EMAIL = "dayline-admin@fatakpay.com";
  const CLAIM_KEY = "dayline_identity_claim_v2";
  const DEFAULT_ACCENTS = ["#2b5aa0", "#0d7a6f", "#c45c26", "#6b4c9a", "#8a5a2b", "#b45309", "#0f766e", "#7c3aed"];
  const TZ = "Asia/Kolkata";

  const defaults = window.DAYLINE_TEAM;
  const firebaseConfig = window.DAYLINE_FIREBASE || {};
  const cloudEnabled = Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.databaseURL &&
      firebaseConfig.projectId
  );

  let db = null;
  let auth = null;
  let updatesRef = null;
  let teamRef = null;
  let settingsRef = null;
  let claimsDayRef = null;
  let wfhRef = null;
  let updatesCache = [];
  let claimsCache = {}; // { [deptId]: { [safeMember]: { token, memberName, ... } } }
  let wfhCache = {}; // { [deptId]: { [safeMember]: { [date]: record } } }
  let wfhListening = false;
  let wfhInFlight = false;
  let team = cloneDefaults();
  let settings = { cutoffEnabled: false, cutoffTime: "19:00" };
  let isAdmin = false;
  let adminUnlocked = false;
  let submitInFlight = false;

  const els = {
    department: document.getElementById("department"),
    member: document.getElementById("member"),
    memberNote: document.getElementById("memberNote"),
    dayStatus: document.getElementById("dayStatus"),
    taskField: document.getElementById("taskField"),
    task: document.getElementById("task"),
    form: document.getElementById("updateForm"),
    status: document.getElementById("formStatus"),
    charCount: document.getElementById("charCount"),
    viewDate: document.getElementById("viewDate"),
    prevDayBtn: document.getElementById("prevDayBtn"),
    nextDayBtn: document.getElementById("nextDayBtn"),
    yesterdayBtn: document.getElementById("yesterdayBtn"),
    todayBtn: document.getElementById("todayBtn"),
    boards: document.getElementById("departmentBoards"),
    boardMeta: document.getElementById("boardMeta"),
    exportBtn: document.getElementById("exportBtn"),
    clearDayBtn: document.getElementById("clearDayBtn"),
    copyWhatsAppBtn: document.getElementById("copyWhatsAppBtn"),
    adminToggleBtn: document.getElementById("adminToggleBtn"),
    adminPanel: document.getElementById("adminPanel"),
    adminLogoutBtn: document.getElementById("adminLogoutBtn"),
    adminLoginDialog: document.getElementById("adminLoginDialog"),
    adminLoginForm: document.getElementById("adminLoginForm"),
    adminPassword: document.getElementById("adminPassword"),
    adminLoginError: document.getElementById("adminLoginError"),
    adminLoginCancel: document.getElementById("adminLoginCancel"),
    addDeptForm: document.getElementById("addDeptForm"),
    newDeptName: document.getElementById("newDeptName"),
    adminDeptStatus: document.getElementById("adminDeptStatus"),
    addMemberForm: document.getElementById("addMemberForm"),
    adminDeptSelect: document.getElementById("adminDeptSelect"),
    newMemberName: document.getElementById("newMemberName"),
    adminMemberStatus: document.getElementById("adminMemberStatus"),
    adminRoster: document.getElementById("adminRoster"),
    syncBanner: document.getElementById("syncBanner"),
    identityLockNote: document.getElementById("identityLockNote"),
    cutoffInfo: document.getElementById("cutoffInfo"),
    submitBtn: document.getElementById("submitBtn"),
    cutoffForm: document.getElementById("cutoffForm"),
    cutoffTime: document.getElementById("cutoffTime"),
    cutoffEnabled: document.getElementById("cutoffEnabled"),
    adminCutoffStatus: document.getElementById("adminCutoffStatus"),
    reportForm: document.getElementById("reportForm"),
    reportStart: document.getElementById("reportStart"),
    reportEnd: document.getElementById("reportEnd"),
    adminReportStatus: document.getElementById("adminReportStatus"),
    wfhTracker: document.getElementById("wfhTracker"),
    wfhNote: document.getElementById("wfhNote"),
    wfhMonth: document.getElementById("wfhMonth"),
    wfhPrevMonth: document.getElementById("wfhPrevMonth"),
    wfhNextMonth: document.getElementById("wfhNextMonth"),
    wfhFilterDept: document.getElementById("wfhFilterDept"),
    wfhCopyAllBtn: document.getElementById("wfhCopyAllBtn"),
    wfhShareStatus: document.getElementById("wfhShareStatus"),
    wfhPeopleGrid: document.getElementById("wfhPeopleGrid"),
  };

  function getIndiaParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value || "00";
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      hour: Number(get("hour")),
      minute: Number(get("minute")),
    };
  }

  function todayISO() {
    return getIndiaParts().date;
  }

  function addDaysISO(isoDate, delta) {
    const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const base = m ? `${m[1]}-${m[2]}-${m[3]}` : todayISO();
    const parts = base.split("-").map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2] + Number(delta || 0));
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }

  function currentViewDate() {
    return (els.viewDate && els.viewDate.value) || todayISO();
  }

  function setViewDate(isoDate) {
    if (!els.viewDate) return;
    els.viewDate.value = isoDate;
    renderBoards();
  }

  function sameName(a, b) {
    return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  }

  function personOnDay(members, name) {
    if (!members) return null;
    if (members.has(name)) return members.get(name);
    for (const [key, person] of members) {
      if (sameName(key, name)) return person;
    }
    return null;
  }

  function expectedNamesForDept(dept, viewDate) {
    const names = [];
    const seen = new Set();
    const add = (name) => {
      const trimmed = String(name || "").trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(trimmed);
    };
    (dept.members || []).forEach(add);
    const windowStart = addDaysISO(viewDate, -14);
    loadUpdates().forEach((u) => {
      if (u.departmentId !== dept.id || !u.memberName || !u.date) return;
      if (u.date >= windowStart && u.date <= viewDate) add(u.memberName);
    });
    return names;
  }

  function minutesNow() {
    const n = getIndiaParts();
    return n.hour * 60 + n.minute;
  }

  function parseTimeToMinutes(hhmm) {
    if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  function formatCutoffDisplay(hhmm) {
    try {
      const [h, m] = hhmm.split(":").map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return hhmm;
    }
  }

  function isPastCutoff() {
    if (!settings.cutoffEnabled || !settings.cutoffTime) return false;
    const limit = parseTimeToMinutes(settings.cutoffTime);
    if (limit == null) return false;
    return minutesNow() > limit;
  }

  function cloneDefaults() {
    return {
      departments: defaults.departments.map((d) => ({
        id: d.id,
        name: d.name,
        accent: d.accent,
        members: [...d.members],
      })),
    };
  }

  function normalizeTeam(raw) {
    if (!raw || !Array.isArray(raw.departments)) return cloneDefaults();
    return {
      departments: raw.departments
        .map((d) => ({
          id: String(d.id || ""),
          name: String(d.name || "").trim(),
          accent: d.accent || DEFAULT_ACCENTS[0],
          members: Array.isArray(d.members)
            ? d.members.map((n) => String(n).trim()).filter(Boolean)
            : [],
        }))
        .filter((d) => d.id && d.name),
    };
  }

  function getClaim() {
    try {
      const raw = localStorage.getItem(CLAIM_KEY);
      if (!raw) return getLegacyClaimMigrated();
      const claim = JSON.parse(raw);
      if (!claim || claim.date !== todayISO()) return getLegacyClaimMigrated();
      if (!claim.departmentId || !claim.memberName || !claim.token) return getLegacyClaimMigrated();
      return claim;
    } catch {
      return getLegacyClaimMigrated();
    }
  }

  /** Older local-only lock (no token) — used to re-claim ownership after upgrade. */
  function getLegacyClaimMigrated() {
    try {
      const raw = localStorage.getItem("dayline_identity_claim_v1");
      if (!raw) return null;
      const claim = JSON.parse(raw);
      if (!claim || claim.date !== todayISO()) return null;
      if (!claim.departmentId || !claim.memberName) return null;
      return { ...claim, token: null, legacy: true };
    } catch {
      return null;
    }
  }

  function setClaim(departmentId, memberName, token) {
    localStorage.setItem(
      CLAIM_KEY,
      JSON.stringify({
        date: todayISO(),
        departmentId,
        memberName,
        token,
      })
    );
    localStorage.removeItem("dayline_identity_claim_v1");
  }

  function safeFirebaseKey(value) {
    return String(value).replace(/[.#$\[\]\/]/g, "_");
  }

  function claimRefFor(date, departmentId, memberName) {
    return db.ref(
      `dayline/claims/${date}/${safeFirebaseKey(departmentId)}/${safeFirebaseKey(memberName)}`
    );
  }

  function findRemoteClaim(departmentId, memberName) {
    const dept = claimsCache[safeFirebaseKey(departmentId)];
    if (!dept) return null;
    return dept[safeFirebaseKey(memberName)] || null;
  }

  function isNameTakenBySomeoneElse(departmentId, memberName) {
    if (isAdmin) return false;
    const remote = findRemoteClaim(departmentId, memberName);
    const local = getClaim();
    const hasUpdate = getSelfTasks(departmentId, memberName).length > 0;

    if (remote) {
      return !(local && local.token && local.token === remote.token && local.memberName === memberName);
    }
    // Update exists but no cloud claim yet — only the original browser (legacy/local claim) may edit
    if (hasUpdate) {
      return !(
        local &&
        local.memberName === memberName &&
        local.departmentId === departmentId
      );
    }
    return false;
  }

  /**
   * Shared lock: first successful submitter owns that name for the day (token in Firebase + localStorage).
   * Other browsers get a validation error and must NOT write.
   */
  async function assertCanWritePerson(departmentId, memberName) {
    if (isAdmin) return { ok: true };

    const local = getClaim();
    if (local && (local.memberName !== memberName || local.departmentId !== departmentId)) {
      return {
        ok: false,
        message: `You've already submitted as ${local.memberName} today. You can only update your own entry — not someone else's. Nothing was saved.`,
      };
    }

    if (!db || !cloudEnabled) {
      return { ok: false, message: "Shared sync is not available." };
    }

    const date = todayISO();
    const ref = claimRefFor(date, departmentId, memberName);
    const snap = await ref.once("value");
    const remote = snap.val();
    const hasExistingUpdate = getSelfTasks(departmentId, memberName).length > 0;

    async function createClaimToken() {
      const token =
        (crypto.randomUUID && crypto.randomUUID()) ||
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const tx = await ref.transaction((current) => {
        if (current != null) return;
        return {
          token,
          memberName,
          departmentId,
          claimedAt: new Date().toISOString(),
        };
      });

      if (!tx.committed) {
        return {
          ok: false,
          message: `${memberName} already submitted today. You can't add tasks for them. Nothing was saved.`,
        };
      }

      setClaim(departmentId, memberName, token);
      return { ok: true, token };
    }

    if (!remote) {
      // Existing update with no cloud claim: only original browser (local/legacy claim) may take ownership
      if (hasExistingUpdate) {
        if (
          local &&
          local.memberName === memberName &&
          local.departmentId === departmentId
        ) {
          return createClaimToken();
        }
        return {
          ok: false,
          message: `${memberName} already has today's update. Only they or an admin can change it. Nothing was saved.`,
        };
      }
      return createClaimToken();
    }

    if (local && local.token && local.token === remote.token && local.memberName === memberName) {
      return { ok: true, token: local.token };
    }

    return {
      ok: false,
      message: `${memberName} already submitted today's update. Only they or an admin can edit it — your changes were not saved.`,
    };
  }

  function setSyncBanner(message, tone) {
    if (!els.syncBanner) return;
    if (!message) {
      els.syncBanner.hidden = true;
      els.syncBanner.textContent = "";
      return;
    }
    els.syncBanner.hidden = false;
    els.syncBanner.textContent = message;
    els.syncBanner.classList.toggle("warn", tone === "warn");
    els.syncBanner.classList.toggle("ok", tone === "ok");
  }

  function initCloud() {
    if (!cloudEnabled) {
      setSyncBanner(
        "Shared sync is not configured yet. Updates stay on this device only. Add Firebase keys in firebase-config.js so the whole team can share one board.",
        "warn"
      );
      updateCutoffUi();
      applyIdentityLock();
      return;
    }

    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      updatesRef = db.ref("dayline/updates");
      teamRef = db.ref("dayline/team");
      settingsRef = db.ref("dayline/settings");
      claimsDayRef = db.ref(`dayline/claims/${todayISO()}`);
      auth = firebase.auth();
      auth.setPersistence(firebase.auth.Auth.Persistence.NONE);
      auth.onAuthStateChanged((user) => {
        const signedIn = Boolean(user && user.email === ADMIN_EMAIL);
        if (!signedIn) adminUnlocked = false;
        isAdmin = Boolean(signedIn && adminUnlocked);
        setAdminUi({ scroll: false });
      });
      auth.signOut().catch(() => {});

      updatesRef.on("value", (snap) => {
        const val = snap.val() || {};
        updatesCache = Object.keys(val).map((key) => {
          const row = val[key] || {};
          return {
            id: row.id || key,
            departmentId: row.departmentId,
            departmentName: row.departmentName,
            memberName: row.memberName,
            tasks: Array.isArray(row.tasks) ? row.tasks : [],
            onLeave: Boolean(row.onLeave),
            date: row.date,
            createdAt: row.createdAt,
          };
        });
        renderBoards();
        applyIdentityLock();
      });

      claimsDayRef.on("value", (snap) => {
        claimsCache = snap.val() || {};
        applyIdentityLock();
      });

      teamRef.on("value", (snap) => {
        const val = snap.val();
        if (!val || !Array.isArray(val.departments) || val.departments.length === 0) {
          team = cloneDefaults();
          saveTeam().catch(() => {});
        } else {
          team = normalizeTeam(val);
        }
        refreshAll();
      });

      settingsRef.on("value", (snap) => {
        const val = snap.val() || {};
        settings = {
          cutoffEnabled: Boolean(val.cutoffEnabled),
          cutoffTime: val.cutoffTime || "19:00",
        };
        if (els.cutoffTime) els.cutoffTime.value = settings.cutoffTime;
        if (els.cutoffEnabled) els.cutoffEnabled.checked = settings.cutoffEnabled;
        updateCutoffUi();
        applyIdentityLock();
      });

      setSyncBanner("Live sync on — everyone sees the same updates.", "ok");
      setTimeout(() => setSyncBanner(""), 4000);
    } catch (err) {
      console.error(err);
      setSyncBanner(
        "Could not connect to Firebase. Check firebase-config.js values and Realtime Database rules.",
        "warn"
      );
    }
  }

  function loadUpdates() {
    return updatesCache.slice();
  }

  async function persistUpdates(list) {
    updatesCache = list;
    if (!cloudEnabled || !updatesRef) return;
    const payload = {};
    list.forEach((item) => {
      payload[item.id] = item;
    });
    await updatesRef.set(payload);
  }

  /** One entry per person per day — replace existing tasks for that person. */
  async function upsertPersonDay(entry) {
    const existing = loadUpdates().find(
      (u) =>
        u.date === entry.date &&
        u.departmentId === entry.departmentId &&
        u.memberName === entry.memberName
    );
    if (existing) entry.id = existing.id;
    updatesCache = loadUpdates().filter(
      (u) =>
        !(
          u.date === entry.date &&
          u.departmentId === entry.departmentId &&
          u.memberName === entry.memberName
        )
    );
    updatesCache.push(entry);
    if (!cloudEnabled || !updatesRef) return;
    await updatesRef.child(entry.id).set(entry);
  }

  function rosterIndexes(departments) {
    const allowedMembers = {};
    const allowedDepartments = {};
    (departments || []).forEach((dept) => {
      if (!dept || !dept.id) return;
      allowedDepartments[dept.id] = true;
      (dept.members || []).forEach((name) => {
        const memberName = String(name || "").trim();
        if (!memberName) return;
        allowedMembers[memberName] = { departmentId: dept.id, memberName };
      });
    });
    return { allowedMembers, allowedDepartments };
  }

  async function saveTeam() {
    if (!cloudEnabled || !teamRef || !db) return;
    const { allowedMembers, allowedDepartments } = rosterIndexes(team.departments);
    await teamRef.set({ departments: team.departments });
    await db.ref("dayline/allowedMembers").set(allowedMembers);
    await db.ref("dayline/allowedDepartments").set(allowedDepartments);
  }

  async function saveSettings() {
    if (cloudEnabled && settingsRef) {
      await settingsRef.set(settings);
      return;
    }
  }

  function findDept(id) {
    return team.departments.find((d) => d.id === id);
  }

  function slugify(name) {
    const base =
      String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "dept";
    let id = base;
    let n = 2;
    while (team.departments.some((d) => d.id === id)) {
      id = `${base}-${n++}`;
    }
    return id;
  }

  function parseTasks(raw) {
    return String(raw)
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^\s*[-*•]+\s*/, "")
          .replace(/^\s*\d+[.)]\s*/, "")
          .trim()
      )
      .filter(Boolean);
  }

  function fillDepartments() {
    const selected = els.department.value;
    const claim = getClaim();
    els.department.innerHTML = '<option value="">Select department</option>';
    team.departments.forEach((dept) => {
      const opt = document.createElement("option");
      opt.value = dept.id;
      opt.textContent = dept.name;
      els.department.appendChild(opt);
    });
    if (claim && !isAdmin && findDept(claim.departmentId)) {
      els.department.value = claim.departmentId;
    } else if (selected && findDept(selected)) {
      els.department.value = selected;
    }
  }

  function fillMembers(deptId) {
    const claim = getClaim();
    els.member.innerHTML = '<option value="">Select name</option>';
    const dept = findDept(deptId);
    const hasMembers = Boolean(dept && dept.members.length);

    if (!dept) {
      els.member.disabled = true;
      els.memberNote.hidden = true;
      return;
    }

    if (hasMembers) {
      dept.members.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        const taken = isNameTakenBySomeoneElse(deptId, name);
        opt.textContent = taken ? `${name} (already submitted)` : name;
        if (taken) opt.disabled = true;
        els.member.appendChild(opt);
      });
      els.member.disabled = false;
      els.memberNote.hidden = true;
      if (claim && !isAdmin && claim.departmentId === deptId) {
        els.member.value = claim.memberName;
      }
    } else {
      els.member.disabled = true;
      els.memberNote.hidden = false;
    }
  }

  function fillAdminDeptSelect() {
    const selected = els.adminDeptSelect.value;
    els.adminDeptSelect.innerHTML = '<option value="">Select department</option>';
    team.departments.forEach((dept) => {
      const opt = document.createElement("option");
      opt.value = dept.id;
      opt.textContent = dept.name;
      els.adminDeptSelect.appendChild(opt);
    });
    if (selected && findDept(selected)) {
      els.adminDeptSelect.value = selected;
    }
  }

  function fillDeptOptions(selectEl, emptyLabel) {
    if (!selectEl) return;
    const selected = selectEl.value;
    selectEl.innerHTML = `<option value="">${emptyLabel}</option>`;
    team.departments.forEach((dept) => {
      const opt = document.createElement("option");
      opt.value = dept.id;
      opt.textContent = dept.name;
      selectEl.appendChild(opt);
    });
    if (selected && findDept(selected)) {
      selectEl.value = selected;
    }
  }

  function fillWfhSelects() {
    fillDeptOptions(els.wfhFilterDept, "All departments");
  }

  function initWfhControls() {
    if (els.wfhMonth && !els.wfhMonth.value) els.wfhMonth.value = todayISO().slice(0, 7);
  }

  function shiftWfhMonth(delta) {
    const ym = currentWfhMonth();
    const m = String(ym).match(/^(\d{4})-(\d{2})$/);
    if (!m || !els.wfhMonth) return;
    const next = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
    els.wfhMonth.value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    renderWfhGrid();
    if (els.wfhShareStatus) setStatus(els.wfhShareStatus, "");
  }

  function currentWfhMonth() {
    return (els.wfhMonth && els.wfhMonth.value) || todayISO().slice(0, 7);
  }

  function formatMonthLabel(ym) {
    const m = String(ym || "").match(/^(\d{4})-(\d{2})$/);
    if (!m) return ym || "";
    return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
  }

  function formatShareDate(isoDate) {
    const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return isoDate || "";
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function wfhPath(departmentId, memberName, date) {
    return `dayline/wfh/${departmentId}/${safeFirebaseKey(memberName)}/${date}`;
  }

  function getWfhRecords(departmentId, memberName) {
    const node =
      (wfhCache[departmentId] && wfhCache[departmentId][safeFirebaseKey(memberName)]) || {};
    return Object.keys(node)
      .map((key) => node[key])
      .filter((row) => row && row.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function getWfhOnDate(departmentId, memberName, date) {
    return getWfhRecords(departmentId, memberName).find((row) => row.date === date) || null;
  }

  function attachWfhListener() {
    if (!db || !isAdmin || wfhListening) return;
    wfhRef = db.ref("dayline/wfh");
    wfhRef.on(
      "value",
      (snap) => {
        wfhCache = snap.val() || {};
        renderWfhGrid();
      },
      (err) => {
        console.error(err);
        if (els.wfhShareStatus) {
          setStatus(els.wfhShareStatus, "Could not load WFH records. Sign in as admin and try again.", true);
        }
      }
    );
    wfhListening = true;
  }

  function detachWfhListener() {
    if (wfhRef && wfhListening) {
      wfhRef.off("value");
    }
    wfhListening = false;
    wfhCache = {};
    if (els.wfhPeopleGrid) els.wfhPeopleGrid.innerHTML = "";
  }

  async function saveWfhDay({ departmentId, memberName, date, note }) {
    const dept = findDept(departmentId);
    if (!dept) throw new Error("Unknown department.");
    if (!dept.members.includes(memberName)) throw new Error("Name is not on this department roster.");
    const record = {
      date,
      departmentId,
      departmentName: dept.name,
      memberName,
      note: String(note || "").trim(),
      updatedAt: new Date().toISOString(),
    };
    if (cloudEnabled && db) {
      await db.ref(wfhPath(departmentId, memberName, date)).set(record);
      return;
    }
    const memberKey = safeFirebaseKey(memberName);
    if (!wfhCache[departmentId]) wfhCache[departmentId] = {};
    if (!wfhCache[departmentId][memberKey]) wfhCache[departmentId][memberKey] = {};
    wfhCache[departmentId][memberKey][date] = record;
    renderWfhGrid();
  }

  async function removeWfhDay(departmentId, memberName, date) {
    if (cloudEnabled && db) {
      await db.ref(wfhPath(departmentId, memberName, date)).remove();
      return;
    }
    const memberKey = safeFirebaseKey(memberName);
    if (wfhCache[departmentId] && wfhCache[departmentId][memberKey]) {
      delete wfhCache[departmentId][memberKey][date];
    }
    renderWfhGrid();
  }

  function buildPersonWfhText(dept, memberName, monthYm) {
    const all = getWfhRecords(dept.id, memberName);
    const monthRows = monthYm ? all.filter((row) => String(row.date).startsWith(monthYm)) : all;
    const lines = [`WFH — ${memberName} (${dept.name})`];
    if (monthYm) {
      lines.push(formatMonthLabel(monthYm));
      if (monthRows.length === 0) {
        lines.push("No WFH days this month.");
      } else {
        monthRows.forEach((row) => {
          lines.push(row.note ? `• ${formatShareDate(row.date)} — ${row.note}` : `• ${formatShareDate(row.date)}`);
        });
        lines.push(`This month: ${monthRows.length} day${monthRows.length === 1 ? "" : "s"}`);
      }
      const older = all.filter((row) => !String(row.date).startsWith(monthYm));
      if (older.length) {
        lines.push("");
        lines.push("All other WFH days");
        older.forEach((row) => {
          lines.push(row.note ? `• ${formatShareDate(row.date)} — ${row.note}` : `• ${formatShareDate(row.date)}`);
        });
        lines.push(`All time: ${all.length} day${all.length === 1 ? "" : "s"}`);
      }
    } else {
      if (all.length === 0) {
        lines.push("No WFH days recorded.");
      } else {
        all.forEach((row) => {
          lines.push(row.note ? `• ${formatShareDate(row.date)} — ${row.note}` : `• ${formatShareDate(row.date)}`);
        });
        lines.push(`Total: ${all.length} day${all.length === 1 ? "" : "s"}`);
      }
    }
    return lines.join("\n");
  }

  function buildAllWfhText(monthYm) {
    const filterDept = els.wfhFilterDept && els.wfhFilterDept.value;
    const depts = team.departments.filter((d) => !filterDept || d.id === filterDept);
    const blocks = [];
    depts.forEach((dept) => {
      const people = [];
      dept.members.forEach((name) => {
        const monthRows = getWfhRecords(dept.id, name).filter((row) => String(row.date).startsWith(monthYm));
        if (monthRows.length === 0) return;
        const lines = [`${name}`];
        monthRows.forEach((row) => {
          lines.push(row.note ? `• ${formatShareDate(row.date)} — ${row.note}` : `• ${formatShareDate(row.date)}`);
        });
        lines.push(`${monthRows.length} day${monthRows.length === 1 ? "" : "s"}`);
        people.push(lines.join("\n"));
      });
      if (people.length) {
        blocks.push(`${dept.name}\n${people.join("\n\n")}`);
      }
    });
    if (blocks.length === 0) {
      return `WFH tracker — ${formatMonthLabel(monthYm)}\nNo WFH days marked this month.`;
    }
    return `WFH tracker — ${formatMonthLabel(monthYm)}\n\n${blocks.join("\n\n")}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  function renderWfhCalendar(dept, memberName, monthYm) {
    const m = String(monthYm || "").match(/^(\d{4})-(\d{2})$/);
    if (!m) return "";
    const year = Number(m[1]);
    const month = Number(m[2]);
    const dim = new Date(year, month, 0).getDate();
    const firstMon0 = (new Date(year, month - 1, 1).getDay() + 6) % 7;
    const today = todayISO();
    const marked = new Set(
      getWfhRecords(dept.id, memberName)
        .filter((row) => String(row.date).startsWith(monthYm))
        .map((row) => row.date)
    );

    const weekdays = ["M", "T", "W", "T", "F", "S", "S"]
      .map((d) => `<span>${d}</span>`)
      .join("");
    const cells = [];
    for (let i = 0; i < firstMon0; i += 1) {
      cells.push('<button type="button" class="wfh-cal-day" disabled></button>');
    }
    for (let day = 1; day <= dim; day += 1) {
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const weekday = (firstMon0 + day - 1) % 7;
      const classes = ["wfh-cal-day"];
      if (weekday >= 5) classes.push("is-weekend");
      if (iso === today) classes.push("is-today");
      if (marked.has(iso)) classes.push("is-wfh");
      cells.push(
        `<button type="button" class="${classes.join(" ")}" data-action="toggle-wfh" data-dept="${escapeHtml(dept.id)}" data-name="${escapeHtml(memberName)}" data-date="${iso}" aria-label="${marked.has(iso) ? "Remove WFH" : "Mark WFH"} ${iso}">${day}</button>`
      );
    }

    return `<div class="wfh-cal"><div class="wfh-cal-weekdays">${weekdays}</div><div class="wfh-cal-days">${cells.join("")}</div></div>`;
  }

  function renderWfhGrid() {
    if (!els.wfhPeopleGrid) return;
    if (!isAdmin) {
      els.wfhPeopleGrid.innerHTML = "";
      return;
    }

    const monthYm = currentWfhMonth();
    const filterDept = els.wfhFilterDept && els.wfhFilterDept.value;
    const depts = team.departments.filter((d) => !filterDept || d.id === filterDept);
    els.wfhPeopleGrid.innerHTML = "";

    if (depts.length === 0) {
      els.wfhPeopleGrid.innerHTML = '<p class="empty-state">No departments to show.</p>';
      return;
    }

    depts.forEach((dept) => {
      if (dept.members.length === 0) return;
      dept.members.forEach((name) => {
        const all = getWfhRecords(dept.id, name);
        const monthRows = all.filter((row) => String(row.date).startsWith(monthYm));
        const card = document.createElement("article");
        card.className = "wfh-person-card";
        card.style.setProperty("--dept-accent", dept.accent);
        card.innerHTML = `
          <div class="wfh-person-head">
            <div>
              <h4>${escapeHtml(name)}</h4>
              <p class="wfh-person-meta">${escapeHtml(dept.name)} · ${monthRows.length} this month · ${all.length} total</p>
            </div>
            <button type="button" class="btn-ghost btn-sm" data-action="copy-wfh" data-dept="${escapeHtml(dept.id)}" data-name="${escapeHtml(name)}">Copy list</button>
          </div>
          ${renderWfhCalendar(dept, name, monthYm)}
          ${
            monthRows.length
              ? `<ul class="wfh-dates">${monthRows
                  .map(
                    (row) =>
                      `<li><span>${escapeHtml(formatShareDate(row.date))}${
                        row.note ? ` <span class="wfh-date-note">— ${escapeHtml(row.note)}</span>` : ""
                      }</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="wfh-empty">Click a date to mark WFH.</p>`
          }
        `;
        els.wfhPeopleGrid.appendChild(card);
      });
    });

    if (!els.wfhPeopleGrid.children.length) {
      els.wfhPeopleGrid.innerHTML = '<p class="empty-state">No names in this department yet.</p>';
    }
  }

  function getSelfTasks(departmentId, memberName) {
    return getDayUpdates(todayISO())
      .filter((u) => u.departmentId === departmentId && u.memberName === memberName)
      .flatMap((u) => (Array.isArray(u.tasks) ? u.tasks : []));
  }

  function syncLeaveUi() {
    const onLeave = els.dayStatus && els.dayStatus.value === "leave";
    if (els.taskField) els.taskField.hidden = onLeave;
    if (els.task) {
      els.task.required = !onLeave;
      if (onLeave) {
        els.task.value = "";
        if (els.charCount) els.charCount.textContent = "0";
      }
    }
  }

  function prefillSelfTasks() {
    const claim = getClaim();
    if (!claim || isAdmin) return;
    const entries = getDayUpdates(todayISO()).filter(
      (u) => u.departmentId === claim.departmentId && u.memberName === claim.memberName
    );
    if (entries.length === 0) return;

    const onLeave = entries.some((u) => u.onLeave);
    if (els.dayStatus) {
      els.dayStatus.value = onLeave ? "leave" : "working";
      syncLeaveUi();
    }
    if (onLeave) return;

    const tasks = entries.flatMap((u) => (Array.isArray(u.tasks) ? u.tasks : [])).filter(Boolean);
    if (tasks.length === 0) return;
    if (els.task.value.trim()) return;
    els.task.value = tasks.join("\n");
    els.charCount.textContent = String(els.task.value.length);
  }

  function updateCutoffUi() {
    if (!els.cutoffInfo) return;
    if (settings.cutoffEnabled && settings.cutoffTime) {
      const closed = isPastCutoff();
      els.cutoffInfo.hidden = false;
      els.cutoffInfo.textContent = closed
        ? `Submissions closed for today after ${formatCutoffDisplay(settings.cutoffTime)} IST.`
        : `Submit by ${formatCutoffDisplay(settings.cutoffTime)} IST today.`;
      els.cutoffInfo.classList.toggle("closed", closed);
    } else {
      els.cutoffInfo.hidden = true;
      els.cutoffInfo.textContent = "";
      els.cutoffInfo.classList.remove("closed");
    }
  }

  function applyIdentityLock() {
    const claim = getClaim();
    const locked = Boolean(claim) && !isAdmin;
    const closed = isPastCutoff() && !isAdmin;

    if (els.identityLockNote) {
      if (locked) {
        els.identityLockNote.hidden = false;
        els.identityLockNote.textContent = `Signed in as ${claim.memberName} for today. You can add or edit your own update only — not someone else’s.`;
      } else {
        els.identityLockNote.hidden = true;
        els.identityLockNote.textContent = "";
      }
    }

    fillDepartments();
    fillMembers(els.department.value || (claim && claim.departmentId) || "");

    if (locked) {
      els.department.value = claim.departmentId;
      fillMembers(claim.departmentId);
      els.member.value = claim.memberName;
      els.department.disabled = true;
      els.member.disabled = true;
      prefillSelfTasks();
      if (els.submitBtn) els.submitBtn.textContent = "Update my entry";
    } else {
      els.department.disabled = false;
      if (els.department.value) {
        fillMembers(els.department.value);
        els.member.disabled = !findDept(els.department.value)?.members.length;
      }
      if (els.submitBtn) els.submitBtn.textContent = isAdmin ? "Submit update (admin)" : "Submit update";
    }

    if (els.submitBtn) {
      els.submitBtn.disabled = closed;
      els.task.disabled = closed;
      if (els.dayStatus) els.dayStatus.disabled = closed;
    }

    if (closed && !isAdmin) {
      setFormStatus(
        `Submissions are closed for today after ${formatCutoffDisplay(settings.cutoffTime)} IST. Please contact an admin if you need a change.`,
        true
      );
    }
  }

  function formatDateDisplay(isoDate) {
    // 2026-07-23 → 23-07-2026 (senior sheet style)
    const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return isoDate || "";
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  function sheetNameSafe(name) {
    const cleaned = String(name || "Sheet")
      .replace(/[\\/?*\[\]:]/g, "-")
      .trim()
      .slice(0, 31);
    return cleaned || "Sheet";
  }

  function uniqueSheetName(base, used) {
    let name = sheetNameSafe(base);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    let n = 2;
    while (used.has(`${name.slice(0, 28)}-${n}`)) n += 1;
    const finalName = `${name.slice(0, 28)}-${n}`;
    used.add(finalName);
    return finalName;
  }

  function memberColumnsForDept(dept, allUpdates) {
    const fromRoster = Array.isArray(dept.members) ? [...dept.members] : [];
    const extras = [];
    allUpdates
      .filter((u) => u.departmentId === dept.id)
      .forEach((u) => {
        if (u.memberName && !fromRoster.includes(u.memberName) && !extras.includes(u.memberName)) {
          extras.push(u.memberName);
        }
      });
    return [...fromRoster, ...extras];
  }

  function tasksTextForPerson(allUpdates, date, departmentId, memberName, fillMissing) {
    const personEntries = allUpdates.filter(
      (u) =>
        u.date === date &&
        u.departmentId === departmentId &&
        u.memberName === memberName
    );
    if (personEntries.some((u) => u.onLeave)) return "Leave";
    const tasks = personEntries
      .flatMap((u) => (Array.isArray(u.tasks) ? u.tasks : []))
      .filter(Boolean);
    if (tasks.length === 0) {
      return fillMissing ? "No update received today" : "";
    }
    return tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
  }

  function datesInRange(startISO, endISO) {
    const start = new Date(`${startISO}T00:00:00`);
    const end = new Date(`${endISO}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return [];
    }
    const dates = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, "0");
      const d = String(cursor.getDate()).padStart(2, "0");
      dates.push(`${y}-${m}-${d}`);
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }

  /** Senior-style workbook: one sheet per team, Date | names as columns. */
  function buildExcelWorkbook(allUpdates, options) {
    const opts = options || {};
    const fillMissing = Boolean(opts.fillMissing);
    let dates = Array.isArray(opts.dates) ? opts.dates.slice() : [];

    if (typeof XLSX === "undefined") {
      throw new Error("Excel library failed to load. Refresh the page and try again.");
    }

    if (dates.length === 0) {
      dates = [...new Set(allUpdates.map((u) => u.date).filter(Boolean))].sort();
    }
    if (dates.length === 0) {
      throw new Error("No dates available to export.");
    }

    const wb = XLSX.utils.book_new();
    const usedNames = new Set();

    team.departments.forEach((dept) => {
      const members = fillMissing
        ? (Array.isArray(dept.members) ? [...dept.members] : [])
        : memberColumnsForDept(dept, allUpdates);
      if (members.length === 0) return;

      const headerTeam = ["Date", dept.name, ...Array(Math.max(members.length - 1, 0)).fill("")];
      const headerNames = ["Date", ...members];
      const rows = [headerTeam, headerNames];

      dates.forEach((date) => {
        const row = [formatDateDisplay(date)];
        members.forEach((name) => {
          row.push(tasksTextForPerson(allUpdates, date, dept.id, name, fillMissing));
        });
        if (fillMissing) {
          rows.push(row);
          return;
        }
        const hasAny = row.slice(1).some((cell) => String(cell).trim());
        if (hasAny) rows.push(row);
      });

      if (rows.length === 2) {
        rows.push([formatDateDisplay(dates[dates.length - 1] || todayISO()), ...members.map(() => "")]);
      }

      const ws = XLSX.utils.aoa_to_sheet(rows);

      if (members.length > 0) {
        ws["!merges"] = [{ s: { r: 0, c: 1 }, e: { r: 0, c: members.length } }];
      }

      ws["!cols"] = [{ wch: 12 }, ...members.map(() => ({ wch: 36 }))];

      const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
      for (let R = range.s.r; R <= range.e.r; R += 1) {
        for (let C = range.s.c; C <= range.e.c; C += 1) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (!ws[addr]) continue;
          ws[addr].s = {
            alignment: { wrapText: true, vertical: "top" },
            font: { name: "Arial", sz: 11 },
          };
        }
      }

      XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(dept.name, usedNames));
    });

    if (!wb.SheetNames.length) {
      throw new Error("No departments available to export.");
    }
    return wb;
  }

  function downloadRangeExcel(startISO, endISO) {
    const dates = datesInRange(startISO, endISO);
    if (dates.length === 0) {
      throw new Error("Pick a valid start and end date (start cannot be after end).");
    }
    if (dates.length > 93) {
      throw new Error("Please choose a range of 93 days or less.");
    }
    const allUpdates = loadUpdates();
    const wb = buildExcelWorkbook(allUpdates, { dates, fillMissing: false });
    const fileName = `Daily-update-${formatDateDisplay(startISO)}-to-${formatDateDisplay(endISO)}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function groupByDeptAndMember(dayUpdates) {
    const byDept = new Map();

    dayUpdates.forEach((entry) => {
      if (!byDept.has(entry.departmentId)) byDept.set(entry.departmentId, new Map());
      const byMember = byDept.get(entry.departmentId);
      if (!byMember.has(entry.memberName)) {
        byMember.set(entry.memberName, {
          memberName: entry.memberName,
          tasks: [],
          onLeave: false,
          lastAt: entry.createdAt,
        });
      }
      const person = byMember.get(entry.memberName);
      if (entry.onLeave) {
        person.onLeave = true;
        person.tasks = ["Leave"];
      } else if (!person.onLeave) {
        const tasks = Array.isArray(entry.tasks) ? entry.tasks : [entry.task].filter(Boolean);
        tasks.forEach((t) => person.tasks.push(t));
      }
      if (new Date(entry.createdAt) > new Date(person.lastAt)) {
        person.lastAt = entry.createdAt;
      }
    });

    return byDept;
  }

  function getDayUpdates(date) {
    return loadUpdates()
      .filter((u) => u.date === date)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  function buildWhatsAppText(date) {
    const dayUpdates = getDayUpdates(date);
    const grouped = groupByDeptAndMember(dayUpdates);
    const blocks = [];

    team.departments.forEach((dept) => {
      const members = grouped.get(dept.id);
      if (!members || members.size === 0) return;

      const lines = [dept.name, ""];
      const order = dept.members.length
        ? [
            ...dept.members.filter((n) => members.has(n)),
            ...[...members.keys()].filter((n) => !dept.members.includes(n)),
          ]
        : [...members.keys()];

      order.forEach((name) => {
        const person = members.get(name);
        if (!person) return;
        lines.push(name);
        if (person.onLeave) {
          lines.push("*Leave*");
        } else {
          person.tasks.forEach((task, i) => {
            lines.push(`${i + 1}. ${task}`);
          });
        }
        lines.push("");
      });

      blocks.push(lines.join("\n").trimEnd());
    });

    if (blocks.length === 0) return "";
    return blocks.join("\n\n=====================\n\n");
  }

  function renderBoards() {
    const date = currentViewDate();
    const dayUpdates = getDayUpdates(date);
    const grouped = groupByDeptAndMember(dayUpdates);
    const showMissing = date < todayISO();
    let updatedCount = 0;
    let missingCount = 0;
    let taskCount = 0;
    if (els.nextDayBtn) els.nextDayBtn.disabled = date >= todayISO();

    team.departments.forEach((dept) => {
      const members = grouped.get(dept.id);
      const names = expectedNamesForDept(dept, date);
      names.forEach((name) => {
        const person = personOnDay(members, name);
        if (person) {
          updatedCount += 1;
          taskCount += person.tasks.length;
        } else if (showMissing) {
          missingCount += 1;
        }
      });
      if (members) {
        members.forEach((person, name) => {
          if (names.some((n) => sameName(n, name))) return;
          updatedCount += 1;
          taskCount += person.tasks.length;
        });
      }
    });

    const missingLabel =
      showMissing && missingCount > 0 ? ` · ${missingCount} no status` : "";
    const dayLabel = date === todayISO() ? "today" : date === addDaysISO(todayISO(), -1) ? "yesterday" : formatShareDate(date);
    els.boardMeta.textContent =
      `${updatedCount} updated${missingLabel} · ${taskCount} task${taskCount === 1 ? "" : "s"} · ${dayLabel} (${date})`;
    if (document.getElementById("board-title")) {
      document.getElementById("board-title").textContent = `Department boards — ${dayLabel}`;
    }
    els.boards.innerHTML = "";

    team.departments.forEach((dept, index) => {
      const members = grouped.get(dept.id);
      const expected = expectedNamesForDept(dept, date);
      const extras = members
        ? [...members.keys()].filter((name) => !expected.some((n) => sameName(n, name)))
        : [];
      const names = [...expected, ...extras];
      const updatedInDept = names.filter((name) => personOnDay(members, name)).length;
      const missingInDept = showMissing ? names.length - updatedInDept : 0;

      const panel = document.createElement("article");
      panel.className = "dept-panel";
      panel.style.setProperty("--dept-accent", dept.accent);
      panel.style.animationDelay = `${index * 0.04}s`;

      const countBits = [`${updatedInDept} update${updatedInDept === 1 ? "" : "s"}`];
      if (missingInDept > 0) {
        countBits.push(`${missingInDept} no status`);
      }
      const head = document.createElement("div");
      head.className = "dept-panel-head";
      head.innerHTML = `
        <h3><span class="dept-dot" aria-hidden="true"></span>${escapeHtml(dept.name)}</h3>
        <span class="dept-count">${countBits.join(" · ")}</span>
      `;
      panel.appendChild(head);

      if (names.length === 0 || (!showMissing && updatedInDept === 0)) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent =
          names.length === 0
            ? "No names in this department yet."
            : "No updates yet for this department.";
        panel.appendChild(empty);
        els.boards.appendChild(panel);
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "dept-people";

      names.forEach((name) => {
        const person = personOnDay(members, name);
        const block = document.createElement("div");

        if (!person) {
          if (!showMissing) return;
          block.className = "person-block is-missing";
          block.innerHTML = `
            <div class="person-head">
              <span class="update-name">${escapeHtml(name)}</span>
            </div>
            <p class="missing-mark" role="status">NO STATUS UPDATED</p>
          `;
          wrap.appendChild(block);
          return;
        }

        block.className = person.onLeave ? "person-block is-leave" : "person-block";
        let bodyHtml;
        if (person.onLeave) {
          bodyHtml = `<p class="leave-mark" role="status"><strong>Leave</strong></p>`;
        } else {
          const tasksHtml = person.tasks
            .map(
              (t, i) =>
                `<li><span class="task-num">${i + 1}.</span> <span class="task-body">${escapeHtml(t)}</span></li>`
            )
            .join("");
          bodyHtml = `<ol class="task-list">${tasksHtml}</ol>`;
        }
        block.innerHTML = `
          <div class="person-head">
            <span class="update-name">${escapeHtml(person.memberName)}${
              person.onLeave ? ' <span class="leave-badge">Leave</span>' : ""
            }</span>
            <span class="update-time">${escapeHtml(formatTime(person.lastAt))}</span>
          </div>
          ${bodyHtml}
        `;
        wrap.appendChild(block);
      });

      panel.appendChild(wrap);
      els.boards.appendChild(panel);
    });
  }

  function setStatus(el, message, isError) {
    el.textContent = message;
    el.classList.toggle("error", Boolean(isError));
  }

  function setFormStatus(message, isError) {
    setStatus(els.status, message, isError);
  }

  function refreshAll() {
    fillAdminDeptSelect();
    renderBoards();
    applyIdentityLock();
    if (isAdmin) {
      attachWfhListener();
      fillWfhSelects();
      renderAdminRoster();
      renderWfhGrid();
    }
  }

  function renderAdminRoster() {
    els.adminRoster.innerHTML = "";
    if (team.departments.length === 0) {
      els.adminRoster.innerHTML = '<p class="empty-state">No departments yet.</p>';
      return;
    }

    team.departments.forEach((dept) => {
      const card = document.createElement("article");
      card.className = "admin-roster-card";
      card.style.setProperty("--dept-accent", dept.accent);

      const head = document.createElement("div");
      head.className = "admin-roster-head";
      head.innerHTML = `
        <h3><span class="dept-dot" aria-hidden="true"></span>${escapeHtml(dept.name)}</h3>
        <button type="button" class="btn-ghost danger btn-sm" data-action="remove-dept" data-dept="${escapeHtml(dept.id)}">Remove department</button>
      `;
      card.appendChild(head);

      const list = document.createElement("ul");
      list.className = "admin-member-list";

      if (dept.members.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty-state";
        empty.textContent = "No names yet.";
        list.appendChild(empty);
      } else {
        dept.members.forEach((name) => {
          const li = document.createElement("li");
          li.innerHTML = `
            <span>${escapeHtml(name)}</span>
            <button type="button" class="btn-ghost danger btn-sm" data-action="remove-member" data-dept="${escapeHtml(dept.id)}" data-name="${escapeHtml(name)}">Remove</button>
          `;
          list.appendChild(li);
        });
      }

      card.appendChild(list);
      els.adminRoster.appendChild(card);
    });
  }

  function isSignedInAdmin() {
    return Boolean(auth && auth.currentUser && auth.currentUser.email === ADMIN_EMAIL);
  }

  function setAdminUi(opts = {}) {
    isAdmin = Boolean(adminUnlocked && isSignedInAdmin());
    els.adminPanel.hidden = !isAdmin;
    els.adminToggleBtn.textContent = isAdmin ? "Admin panel" : "Admin";
    els.adminToggleBtn.classList.toggle("is-active", isAdmin);
    applyIdentityLock();
    if (isAdmin) {
      fillAdminDeptSelect();
      initWfhControls();
      fillWfhSelects();
      attachWfhListener();
      renderAdminRoster();
      renderWfhGrid();
      if (els.cutoffTime) els.cutoffTime.value = settings.cutoffTime || "19:00";
      if (els.cutoffEnabled) els.cutoffEnabled.checked = Boolean(settings.cutoffEnabled);
      if (els.reportStart && !els.reportStart.value) els.reportStart.value = todayISO();
      if (els.reportEnd && !els.reportEnd.value) els.reportEnd.value = todayISO();
      if (opts.scroll !== false) {
        els.adminPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } else {
      detachWfhListener();
    }
  }

  function requireAdmin() {
    isAdmin = Boolean(adminUnlocked && isSignedInAdmin());
    if (!isAdmin) {
      adminUnlocked = false;
      alert("Admin login required.");
      setAdminUi({ scroll: false });
      return false;
    }
    return true;
  }

  function requireCloudForShare() {
    if (!cloudEnabled) {
      setFormStatus(
        "Shared sync not set up yet — only this browser will see the update. Configure firebase-config.js first.",
        true
      );
      return false;
    }
    return true;
  }

  els.department.addEventListener("change", () => {
    if (!isAdmin && getClaim()) {
      applyIdentityLock();
      setFormStatus(
        `You've already submitted as ${getClaim().memberName} today. You can only update your own entry — not someone else's.`,
        true
      );
      return;
    }
    fillMembers(els.department.value);
    setFormStatus("");
  });

  els.member.addEventListener("change", () => {
    const claim = getClaim();
    const deptId = els.department.value;
    const name = els.member.value;

    if (!isAdmin && claim && name && name !== claim.memberName) {
      els.member.value = claim.memberName;
      setFormStatus(
        `You've already submitted as ${claim.memberName} today. You can only update your own entry — not someone else's.`,
        true
      );
      return;
    }

    if (!isAdmin && name && deptId && isNameTakenBySomeoneElse(deptId, name)) {
      els.member.value = "";
      setFormStatus(
        `${name} already submitted today. You can't add or edit tasks for them.`,
        true
      );
      return;
    }

    setFormStatus("");
  });

  els.task.addEventListener("input", () => {
    els.charCount.textContent = String(els.task.value.length);
  });

  if (els.dayStatus) {
    els.dayStatus.addEventListener("change", () => {
      syncLeaveUi();
      setFormStatus("");
    });
  }

  els.viewDate.addEventListener("change", renderBoards);

  if (els.prevDayBtn) {
    els.prevDayBtn.addEventListener("click", () => {
      setViewDate(addDaysISO(currentViewDate(), -1));
    });
  }

  if (els.nextDayBtn) {
    els.nextDayBtn.addEventListener("click", () => {
      const next = addDaysISO(currentViewDate(), 1);
      if (next > todayISO()) return;
      setViewDate(next);
    });
  }

  if (els.yesterdayBtn) {
    els.yesterdayBtn.addEventListener("click", () => {
      setViewDate(addDaysISO(todayISO(), -1));
    });
  }

  if (els.todayBtn) {
    els.todayBtn.addEventListener("click", () => {
      setViewDate(todayISO());
    });
  }

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitInFlight) return;
    if (!requireCloudForShare()) return;

    if (!isAdmin && isPastCutoff()) {
      setFormStatus(
        `Submissions are closed for today after ${formatCutoffDisplay(settings.cutoffTime)} IST. Please contact an admin if you need a change.`,
        true
      );
      return;
    }

    const departmentId = els.department.value;
    const memberName = els.member.value.trim();
    const onLeave = els.dayStatus && els.dayStatus.value === "leave";
    const tasks = onLeave ? ["Leave"] : parseTasks(els.task.value);
    const dept = findDept(departmentId);

    if (!departmentId || !dept) {
      setFormStatus("Please select a department.", true);
      return;
    }
    if (!memberName) {
      setFormStatus("Please select your name.", true);
      return;
    }
    if (!dept.members.includes(memberName)) {
      setFormStatus("Selected name is not in this department. Ask an admin to add it.", true);
      return;
    }
    if (!onLeave && tasks.length === 0) {
      setFormStatus("Please write at least one task, or choose Leave.", true);
      return;
    }

    submitInFlight = true;
    if (els.submitBtn) els.submitBtn.disabled = true;

    try {
      // Shared lock check FIRST — never write if another person owns this name today
      const access = await assertCanWritePerson(departmentId, memberName);
      if (!access.ok) {
        setFormStatus(access.message, true);
        applyIdentityLock();
        return;
      }

      const entry = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        departmentId,
        departmentName: dept.name,
        memberName,
        tasks,
        onLeave: Boolean(onLeave),
        date: todayISO(),
        createdAt: new Date().toISOString(),
      };

      await upsertPersonDay(entry);

      els.viewDate.value = todayISO();
      setFormStatus(
        onLeave
          ? `Marked on Leave under ${dept.name} → ${memberName}.`
          : `Saved under ${dept.name} → ${memberName}.`
      );
      applyIdentityLock();
      if (!onLeave) {
        els.task.value = tasks.join("\n");
        els.charCount.textContent = String(els.task.value.length);
      }
      renderBoards();
    } catch (err) {
      console.error(err);
      setFormStatus("Could not save update to the shared board. Try again.", true);
    } finally {
      submitInFlight = false;
      applyIdentityLock();
    }
  });

  els.copyWhatsAppBtn.addEventListener("click", async () => {
    const date = els.viewDate.value || todayISO();
    const text = buildWhatsAppText(date);
    if (!text) {
      setFormStatus("Nothing to copy for this date.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setFormStatus("WhatsApp-format summary copied to clipboard.");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setFormStatus("WhatsApp-format summary copied to clipboard.");
    }
  });

  els.exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(loadUpdates(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dayline-updates-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  els.clearDayBtn.addEventListener("click", async () => {
    if (!requireAdmin()) return;
    const date = els.viewDate.value || todayISO();
    if (!confirm(`Clear all updates for ${date} for everyone on the shared board?`)) return;
    if (!requireCloudForShare()) return;
    try {
      const remaining = loadUpdates().filter((u) => u.date !== date);
      await persistUpdates(remaining);
      if (db) await db.ref(`dayline/claims/${date}`).remove();
      setFormStatus(`Cleared updates for ${date}.`);
      renderBoards();
      applyIdentityLock();
    } catch (err) {
      console.error(err);
      setFormStatus("Could not clear updates.", true);
    }
  });

  els.adminToggleBtn.addEventListener("click", () => {
    if (adminUnlocked && isSignedInAdmin()) {
      els.adminPanel.hidden = false;
      els.adminPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    els.adminLoginError.textContent = "";
    els.adminPassword.value = "";
    if (typeof els.adminLoginDialog.showModal === "function") {
      els.adminLoginDialog.showModal();
    } else {
      els.adminLoginDialog.setAttribute("open", "");
    }
    els.adminPassword.focus();
  });

  els.adminLoginCancel.addEventListener("click", () => {
    els.adminLoginDialog.close();
  });

  els.adminLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const entered = els.adminPassword.value;
    els.adminLoginError.textContent = "";
    if (!auth) {
      els.adminLoginError.textContent = "Admin login is not available.";
      return;
    }
    const submitBtn = els.adminLoginForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await auth.signInWithEmailAndPassword(ADMIN_EMAIL, entered);
      adminUnlocked = true;
      els.adminPassword.value = "";
      els.adminLoginDialog.close();
      setAdminUi();
      setFormStatus("Admin unlocked. You can manage the team, WFH tracker, cutoff time, and submit for anyone.");
    } catch (err) {
      console.error(err);
      els.adminLoginError.textContent = "Incorrect password.";
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  els.adminLogoutBtn.addEventListener("click", async () => {
    try {
      if (auth) await auth.signOut();
    } catch (err) {
      console.error(err);
    }
    adminUnlocked = false;
    isAdmin = false;
    setAdminUi({ scroll: false });
    setFormStatus("Admin logged out.");
  });

  if (els.reportForm) {
    els.reportForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireAdmin()) return;
      const startISO = els.reportStart.value;
      const endISO = els.reportEnd.value;
      if (!startISO || !endISO) {
        setStatus(els.adminReportStatus, "Select start date and end date.", true);
        return;
      }
      try {
        downloadRangeExcel(startISO, endISO);
        setStatus(
          els.adminReportStatus,
          `Excel downloaded for ${formatDateDisplay(startISO)} to ${formatDateDisplay(endISO)}. Only submitted updates are included.`
        );
      } catch (err) {
        console.error(err);
        setStatus(els.adminReportStatus, err.message || "Could not create Excel file.", true);
      }
    });
  }

  els.cutoffForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireAdmin()) return;
    if (!requireCloudForShare()) return;

    const time = els.cutoffTime.value;
    if (!time) {
      setStatus(els.adminCutoffStatus, "Pick a cutoff time.", true);
      return;
    }

    settings = {
      cutoffEnabled: Boolean(els.cutoffEnabled.checked),
      cutoffTime: time,
    };

    try {
      await saveSettings();
      setStatus(
        els.adminCutoffStatus,
        settings.cutoffEnabled
          ? `Cutoff saved: submissions close at ${formatCutoffDisplay(time)} IST.`
          : "Cutoff saved (enforcement is off)."
      );
      updateCutoffUi();
      applyIdentityLock();
    } catch (err) {
      console.error(err);
      setStatus(els.adminCutoffStatus, "Could not save cutoff.", true);
    }
  });

  if (els.wfhMonth) {
    els.wfhMonth.addEventListener("change", () => {
      renderWfhGrid();
      if (els.wfhShareStatus) setStatus(els.wfhShareStatus, "");
    });
  }

  if (els.wfhPrevMonth) {
    els.wfhPrevMonth.addEventListener("click", () => shiftWfhMonth(-1));
  }

  if (els.wfhNextMonth) {
    els.wfhNextMonth.addEventListener("click", () => shiftWfhMonth(1));
  }

  if (els.wfhFilterDept) {
    els.wfhFilterDept.addEventListener("change", () => {
      renderWfhGrid();
      if (els.wfhShareStatus) setStatus(els.wfhShareStatus, "");
    });
  }

  if (els.wfhCopyAllBtn) {
    els.wfhCopyAllBtn.addEventListener("click", async () => {
      if (!requireAdmin()) return;
      const text = buildAllWfhText(currentWfhMonth());
      try {
        await copyText(text);
        setStatus(els.wfhShareStatus, "Copied all WFH lists for this month.");
      } catch (err) {
        console.error(err);
        setStatus(els.wfhShareStatus, "Could not copy the list.", true);
      }
    });
  }

  if (els.wfhPeopleGrid) {
    els.wfhPeopleGrid.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-action]");
      if (!btn || !requireAdmin()) return;
      const action = btn.getAttribute("data-action");
      const departmentId = btn.getAttribute("data-dept");
      const memberName = btn.getAttribute("data-name");
      const date = btn.getAttribute("data-date");
      const dept = findDept(departmentId);
      if (!dept || !memberName) return;

      if (action === "copy-wfh") {
        try {
          await copyText(buildPersonWfhText(dept, memberName, currentWfhMonth()));
          setStatus(els.wfhShareStatus, `Copied WFH list for ${memberName}.`);
        } catch (err) {
          console.error(err);
          setStatus(els.wfhShareStatus, "Could not copy the list.", true);
        }
        return;
      }

      if (action === "toggle-wfh") {
        if (!requireCloudForShare()) return;
        if (wfhInFlight) return;
        wfhInFlight = true;
        try {
          const existing = getWfhOnDate(departmentId, memberName, date);
          if (existing) {
            await removeWfhDay(departmentId, memberName, date);
            setStatus(els.wfhShareStatus, `Removed WFH for ${memberName} on ${formatShareDate(date)}.`);
          } else {
            await saveWfhDay({
              departmentId,
              memberName,
              date,
              note: els.wfhNote ? els.wfhNote.value.trim() : "",
            });
            setStatus(els.wfhShareStatus, `Marked WFH for ${memberName} on ${formatShareDate(date)}.`);
          }
          renderWfhGrid();
        } catch (err) {
          console.error(err);
          setStatus(els.wfhShareStatus, "Could not update that WFH day.", true);
        } finally {
          wfhInFlight = false;
        }
      }
    });
  }

  els.addDeptForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireAdmin()) return;
    if (!requireCloudForShare()) return;
    const name = els.newDeptName.value.trim();
    if (!name) {
      setStatus(els.adminDeptStatus, "Enter a department name.", true);
      return;
    }
    if (team.departments.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
      setStatus(els.adminDeptStatus, "That department already exists.", true);
      return;
    }
    const accent = DEFAULT_ACCENTS[team.departments.length % DEFAULT_ACCENTS.length];
    team.departments.push({
      id: slugify(name),
      name,
      accent,
      members: [],
    });
    try {
      await saveTeam();
      els.newDeptName.value = "";
      setStatus(els.adminDeptStatus, `Department “${name}” added.`);
      refreshAll();
    } catch (err) {
      console.error(err);
      setStatus(els.adminDeptStatus, "Could not save department.", true);
    }
  });

  els.addMemberForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireAdmin()) return;
    if (!requireCloudForShare()) return;
    const deptId = els.adminDeptSelect.value;
    const name = els.newMemberName.value.trim();
    const dept = findDept(deptId);
    if (!dept) {
      setStatus(els.adminMemberStatus, "Select a department.", true);
      return;
    }
    if (!name) {
      setStatus(els.adminMemberStatus, "Enter a name.", true);
      return;
    }
    if (dept.members.some((n) => n.toLowerCase() === name.toLowerCase())) {
      setStatus(els.adminMemberStatus, "That name is already in this department.", true);
      return;
    }
    dept.members.push(name);
    try {
      await saveTeam();
      els.newMemberName.value = "";
      setStatus(els.adminMemberStatus, `Added ${name} to ${dept.name}.`);
      refreshAll();
    } catch (err) {
      console.error(err);
      setStatus(els.adminMemberStatus, "Could not save name.", true);
    }
  });

  els.adminRoster.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn || !requireAdmin()) return;
    if (!requireCloudForShare()) return;

    const action = btn.getAttribute("data-action");
    const deptId = btn.getAttribute("data-dept");
    const dept = findDept(deptId);
    if (!dept) return;

    if (action === "remove-dept") {
      if (!confirm(`Remove department “${dept.name}” and all its names?`)) return;
      team.departments = team.departments.filter((d) => d.id !== deptId);
      try {
        await saveTeam();
        setStatus(els.adminDeptStatus, `Removed department “${dept.name}”.`);
        refreshAll();
      } catch (err) {
        console.error(err);
        setStatus(els.adminDeptStatus, "Could not remove department.", true);
      }
      return;
    }

    if (action === "remove-member") {
      const name = btn.getAttribute("data-name");
      if (!confirm(`Remove “${name}” from ${dept.name}?`)) return;
      dept.members = dept.members.filter((n) => n !== name);
      try {
        await saveTeam();
        setStatus(els.adminMemberStatus, `Removed ${name} from ${dept.name}.`);
        refreshAll();
      } catch (err) {
        console.error(err);
        setStatus(els.adminMemberStatus, "Could not remove name.", true);
      }
    }
  });

  els.viewDate.value = todayISO();
  renderBoards();
  setAdminUi();
  syncLeaveUi();
  initCloud();
})();
