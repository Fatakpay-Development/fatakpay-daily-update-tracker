(function () {
  const ADMIN_SESSION_KEY = "dayline_admin_session";
  const CLAIM_KEY = "dayline_identity_claim_v1";
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
  let updatesRef = null;
  let teamRef = null;
  let settingsRef = null;
  let updatesCache = [];
  let team = cloneDefaults();
  let settings = { cutoffEnabled: false, cutoffTime: "19:00" };
  let isAdmin = sessionStorage.getItem(ADMIN_SESSION_KEY) === "1";

  const els = {
    department: document.getElementById("department"),
    member: document.getElementById("member"),
    memberNote: document.getElementById("memberNote"),
    task: document.getElementById("task"),
    form: document.getElementById("updateForm"),
    status: document.getElementById("formStatus"),
    charCount: document.getElementById("charCount"),
    viewDate: document.getElementById("viewDate"),
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
      if (!raw) return null;
      const claim = JSON.parse(raw);
      if (!claim || claim.date !== todayISO()) return null;
      if (!claim.departmentId || !claim.memberName) return null;
      return claim;
    } catch {
      return null;
    }
  }

  function setClaim(departmentId, memberName) {
    localStorage.setItem(
      CLAIM_KEY,
      JSON.stringify({
        date: todayISO(),
        departmentId,
        memberName,
      })
    );
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
            date: row.date,
            createdAt: row.createdAt,
          };
        });
        renderBoards();
        applyIdentityLock();
      });

      teamRef.on("value", (snap) => {
        const val = snap.val();
        if (!val || !Array.isArray(val.departments) || val.departments.length === 0) {
          team = cloneDefaults();
          teamRef.set(team).catch(() => {});
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
    const remaining = loadUpdates().filter(
      (u) =>
        !(
          u.date === entry.date &&
          u.departmentId === entry.departmentId &&
          u.memberName === entry.memberName
        )
    );
    remaining.push(entry);
    await persistUpdates(remaining);
  }

  async function saveTeam() {
    if (cloudEnabled && teamRef) {
      await teamRef.set({ departments: team.departments });
    }
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
        opt.textContent = name;
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

  function getSelfTasks(departmentId, memberName) {
    return getDayUpdates(todayISO())
      .filter((u) => u.departmentId === departmentId && u.memberName === memberName)
      .flatMap((u) => (Array.isArray(u.tasks) ? u.tasks : []));
  }

  function prefillSelfTasks() {
    const claim = getClaim();
    if (!claim || isAdmin) return;
    const tasks = getSelfTasks(claim.departmentId, claim.memberName);
    if (tasks.length === 0) return;
    // Only prefill if textarea empty, so we don't wipe in-progress typing
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
    }

    if (closed && !isAdmin) {
      setFormStatus(
        `Submissions are closed for today after ${formatCutoffDisplay(settings.cutoffTime)} IST. Please contact an admin if you need a change.`,
        true
      );
    }
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
          lastAt: entry.createdAt,
        });
      }
      const person = byMember.get(entry.memberName);
      const tasks = Array.isArray(entry.tasks) ? entry.tasks : [entry.task].filter(Boolean);
      tasks.forEach((t) => person.tasks.push(t));
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
        person.tasks.forEach((task, i) => {
          lines.push(`${i + 1}. ${task}`);
        });
        lines.push("");
      });

      blocks.push(lines.join("\n").trimEnd());
    });

    if (blocks.length === 0) return "";
    return blocks.join("\n\n=====================\n\n");
  }

  function renderBoards() {
    const date = els.viewDate.value || todayISO();
    const dayUpdates = getDayUpdates(date);
    const grouped = groupByDeptAndMember(dayUpdates);
    let personCount = 0;
    let taskCount = 0;

    grouped.forEach((members) => {
      personCount += members.size;
      members.forEach((p) => {
        taskCount += p.tasks.length;
      });
    });

    els.boardMeta.textContent =
      `${personCount} people · ${taskCount} task${taskCount === 1 ? "" : "s"} · ${date}`;
    els.boards.innerHTML = "";

    team.departments.forEach((dept, index) => {
      const members = grouped.get(dept.id);
      const panel = document.createElement("article");
      panel.className = "dept-panel";
      panel.style.setProperty("--dept-accent", dept.accent);
      panel.style.animationDelay = `${index * 0.04}s`;

      const memberCount = members ? members.size : 0;
      const head = document.createElement("div");
      head.className = "dept-panel-head";
      head.innerHTML = `
        <h3><span class="dept-dot" aria-hidden="true"></span>${escapeHtml(dept.name)}</h3>
        <span class="dept-count">${memberCount} update${memberCount === 1 ? "" : "s"}</span>
      `;
      panel.appendChild(head);

      if (!members || members.size === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No updates yet for this department.";
        panel.appendChild(empty);
      } else {
        const wrap = document.createElement("div");
        wrap.className = "dept-people";

        const order = dept.members.length
          ? [
              ...dept.members.filter((n) => members.has(n)),
              ...[...members.keys()].filter((n) => !dept.members.includes(n)),
            ]
          : [...members.keys()];

        order.forEach((name) => {
          const person = members.get(name);
          if (!person) return;
          const block = document.createElement("div");
          block.className = "person-block";
          const tasksHtml = person.tasks
            .map(
              (t, i) =>
                `<li><span class="task-num">${i + 1}.</span> <span class="task-body">${escapeHtml(t)}</span></li>`
            )
            .join("");
          block.innerHTML = `
            <div class="person-head">
              <span class="update-name">${escapeHtml(person.memberName)}</span>
              <span class="update-time">${escapeHtml(formatTime(person.lastAt))}</span>
            </div>
            <ol class="task-list">${tasksHtml}</ol>
          `;
          wrap.appendChild(block);
        });

        panel.appendChild(wrap);
      }

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
    if (isAdmin) renderAdminRoster();
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

  function setAdminUi() {
    els.adminPanel.hidden = !isAdmin;
    els.adminToggleBtn.textContent = isAdmin ? "Admin panel" : "Admin";
    els.adminToggleBtn.classList.toggle("is-active", isAdmin);
    applyIdentityLock();
    if (isAdmin) {
      fillAdminDeptSelect();
      renderAdminRoster();
      if (els.cutoffTime) els.cutoffTime.value = settings.cutoffTime || "19:00";
      if (els.cutoffEnabled) els.cutoffEnabled.checked = Boolean(settings.cutoffEnabled);
      els.adminPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function requireAdmin() {
    if (!isAdmin) {
      alert("Admin login required.");
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
    if (!isAdmin && claim && els.member.value && els.member.value !== claim.memberName) {
      els.member.value = claim.memberName;
      setFormStatus(
        `You've already submitted as ${claim.memberName} today. You can only update your own entry — not someone else's.`,
        true
      );
    } else {
      setFormStatus("");
    }
  });

  els.task.addEventListener("input", () => {
    els.charCount.textContent = String(els.task.value.length);
  });

  els.viewDate.addEventListener("change", renderBoards);

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
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
    const tasks = parseTasks(els.task.value);
    const dept = findDept(departmentId);
    const claim = getClaim();

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

    if (
      !isAdmin &&
      claim &&
      (claim.memberName !== memberName || claim.departmentId !== departmentId)
    ) {
      setFormStatus(
        `You've already submitted as ${claim.memberName} today. You can only update your own entry — not someone else's.`,
        true
      );
      applyIdentityLock();
      return;
    }

    if (tasks.length === 0) {
      setFormStatus("Please write at least one task (one per line).", true);
      return;
    }

    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      departmentId,
      departmentName: dept.name,
      memberName,
      tasks,
      date: todayISO(),
      createdAt: new Date().toISOString(),
    };

    try {
      await upsertPersonDay(entry);
      if (!isAdmin) setClaim(departmentId, memberName);

      els.viewDate.value = todayISO();
      setFormStatus(
        claim || getSelfTasks(departmentId, memberName).length
          ? `Your update was saved under ${dept.name} → ${memberName}.`
          : `Submitted under ${dept.name} → ${memberName}.`
      );
      applyIdentityLock();
      // After lock, show saved tasks in the form for further edits
      els.task.value = tasks.join("\n");
      els.charCount.textContent = String(els.task.value.length);
      renderBoards();
    } catch (err) {
      console.error(err);
      setFormStatus("Could not save update to the shared board. Try again.", true);
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
      setFormStatus(`Cleared updates for ${date}.`);
      renderBoards();
    } catch (err) {
      console.error(err);
      setFormStatus("Could not clear updates.", true);
    }
  });

  els.adminToggleBtn.addEventListener("click", () => {
    if (isAdmin) {
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

  els.adminLoginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const entered = els.adminPassword.value;
    if (entered !== defaults.adminPassword) {
      els.adminLoginError.textContent = "Incorrect password.";
      return;
    }
    isAdmin = true;
    sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
    els.adminLoginDialog.close();
    setAdminUi();
    setFormStatus("Admin unlocked. You can manage the team, cutoff time, and submit for anyone.");
  });

  els.adminLogoutBtn.addEventListener("click", () => {
    isAdmin = false;
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    setAdminUi();
    setFormStatus("Admin logged out.");
  });

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
  initCloud();
})();
