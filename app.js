import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* ---------- config / client ---------- */
const cfg = window.CMRO_CONFIG || {};
const configured =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
  !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");
const sb = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const root = document.getElementById("root");

/* ---------- time helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const prettyDate = (d) => `${DOW[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

const DEFAULT_SETTINGS = { section:"CMRO Section", report_time:"10:30", late_after:"10:00", working_days:[1,2,3,4,5] };

const STATUS_META = {
  present:{ label:"On time", cls:"present" },
  late:{ label:"Late", cls:"late" },
  absent:{ label:"Absent", cls:"absent" },
  leave:{ label:"On leave", cls:"leave" },
  pending:{ label:"Awaiting", cls:"pending" },
};
function statusOf(rec, finalized, lateAfter){
  if (rec?.leave) return "leave";
  if (rec?.clock_in) return rec.clock_in <= lateAfter ? "present" : "late";
  if (finalized) return "absent";
  return "pending";
}

/* ---------- state ---------- */
const S = {
  user:null, users:[], settings:DEFAULT_SETTINGS,
  today:dateKey(new Date()), att:{ records:{}, finalized:false, reopened:false },
  now:new Date(), tab:"clock", loginErr:"", modal:false, deferredInstall:null,
};

/* ---------- data layer ---------- */
async function fetchSettings(){
  const { data } = await sb.from("settings").select("*").eq("id",1).maybeSingle();
  return data ? { section:data.section, report_time:data.report_time, late_after:data.late_after, working_days:data.working_days || [1,2,3,4,5] } : DEFAULT_SETTINGS;
}
async function fetchUsers(){
  const { data } = await sb.from("users").select("*").order("created_at",{ ascending:true });
  return data || [];
}
async function fetchDay(date){
  const { data:recs } = await sb.from("attendance").select("*").eq("date",date);
  const { data:ds } = await sb.from("day_status").select("*").eq("date",date).maybeSingle();
  const records = {};
  (recs||[]).forEach(r => { records[r.user_id] = { clock_in:r.clock_in, leave:r.leave }; });
  return { records, finalized:!!ds?.finalized, reopened:!!ds?.reopened };
}
const isWorkingDay = (d) => (S.settings.working_days||[]).includes(d.getDay());
const reached = () => isWorkingDay(S.now) && hhmm(S.now) >= S.settings.report_time;

async function refreshDay(){
  S.today = dateKey(S.now);
  S.att = await fetchDay(S.today);
  if ((S.user?.role === "admin" || S.user?.role === "supervisor") &&
      reached() && !S.att.finalized && !S.att.reopened){
    await sb.from("day_status").upsert({ date:S.today, finalized:true, reopened:false }, { onConflict:"date" });
    S.att.finalized = true;
  }
}

/* ---------- actions ---------- */
async function login(username, pin){
  S.loginErr = "";
  const { data, error } = await sb.from("users").select("*")
    .eq("username", username.trim().toLowerCase()).eq("pin", pin).eq("disabled", false).maybeSingle();
  if (error){ S.loginErr = "Can't reach the register. Check the internet connection."; render(); return; }
  if (!data){ S.loginErr = "Username or PIN not recognised."; render(); return; }
  S.user = data; S.tab = "clock";
  if (data.role === "admin") S.users = await fetchUsers();
  S.settings = await fetchSettings();
  await refreshDay();
  render();
}
function logout(){ S.user=null; S.users=[]; render(); }

async function clockIn(){
  if (!isWorkingDay(S.now) || S.att.finalized || reached()) return;
  const rec = S.att.records[S.user.id];
  if (rec?.clock_in || rec?.leave) return;
  await sb.from("attendance").upsert({ user_id:S.user.id, date:S.today, clock_in:hhmm(S.now), leave:false }, { onConflict:"user_id,date" });
  await refreshDay(); toast(`Clocked in at ${hhmm(new Date())}.`); render();
}
async function toggleLeave(userId){
  const rec = S.att.records[userId] || {};
  await sb.from("attendance").upsert({ user_id:userId, date:S.today, clock_in:null, leave:!rec.leave }, { onConflict:"user_id,date" });
  await refreshDay(); render();
}
async function finalizeNow(){ await sb.from("day_status").upsert({ date:S.today, finalized:true, reopened:false },{ onConflict:"date" }); await refreshDay(); render(); }
async function reopen(){ await sb.from("day_status").upsert({ date:S.today, finalized:false, reopened:true },{ onConflict:"date" }); await refreshDay(); render(); }

async function addUser(u){
  const { error } = await sb.from("users").insert({ ...u, username:u.username.toLowerCase(), disabled:false });
  if (error){ toast(error.code === "23505" ? "That username is already taken." : "Could not add user.", "err"); return false; }
  S.users = await fetchUsers(); toast(`${u.name} added to the register.`); return true;
}
async function toggleDisabled(id, val){ await sb.from("users").update({ disabled:val }).eq("id",id); S.users = await fetchUsers(); render(); }
async function saveSettings(s){ await sb.from("settings").upsert({ id:1, ...s },{ onConflict:"id" }); S.settings = s; toast("Settings saved."); render(); }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, kind="ok"){
  clearTimeout(toastTimer);
  let el = document.getElementById("toast");
  if (!el){ el = document.createElement("div"); el.id="toast"; document.body.appendChild(el); }
  el.className = `toast ${kind}`; el.textContent = msg;
  toastTimer = setTimeout(() => el.remove(), 2600);
}

/* ---------- export ---------- */
function currentRows(){
  return S.users.filter(u => !u.disabled).map((u,i) => {
    const rec = S.att.records[u.id];
    return { sl:i+1, u, clock_in:rec?.clock_in||null, leave:!!rec?.leave, status:statusOf(rec, S.att.finalized, S.settings.late_after) };
  });
}
function downloadCSV(){
  const rows = currentRows();
  const head = [
    `Attendance Report of ${S.settings.section}`,
    `Date,${prettyDate(S.now)}`,
    `Report finalised,${S.att.finalized ? "Yes" : "No (open)"}`,
    "", "Sl.No,Name,Designation,Clocked In,Status",
  ];
  const body = rows.map(r => [r.sl, `"${r.u.name}"`, r.u.designation, r.leave?"Leave":(r.clock_in||"—"), STATUS_META[r.status].label].join(","));
  const blob = new Blob([[...head,...body].join("\n")], { type:"text/csv;charset=utf-8;" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `attendance_${S.today}.csv`; a.click(); URL.revokeObjectURL(a.href);
  toast("Report downloaded.");
}

/* ================= RENDER ================= */
function render(){
  if (!configured){ root.innerHTML = setupNeeded(); return; }
  if (!S.user){ root.innerHTML = loginScreen(); bindLogin(); return; }
  root.innerHTML = `<div class="app">${masthead()}<main class="page">${screen()}</main></div>` + installFab();
  bindApp();
}

function setupNeeded(){
  return `<div class="setup-wrap"><div class="setup-card">
    <h1>One step left</h1>
    <p>This register isn't connected to its database yet. The admin needs to do the one-time setup:</p>
    <ol>
      <li>Open <code>config.js</code> in this folder.</li>
      <li>Paste your Supabase <b>Project URL</b> and <b>anon public key</b>.</li>
      <li>Re-upload the files and reload this page.</li>
    </ol>
    <p>Full walkthrough is in <code>SETUP-GUIDE.md</code>.</p>
  </div></div>`;
}

function loginScreen(){
  return `<div class="login-wrap"><div class="login-card">
    <div class="seal">CMRO</div>
    <p class="eyebrow">Office of the Tahsildar</p>
    <h1 class="login-title">Digital Duty Register</h1>
    <p class="login-sub">Sign in to record or review today's attendance.</p>
    ${S.loginErr ? `<p class="err-line">${esc(S.loginErr)}</p>` : ""}
    <label class="fld"><span>Username</span>
      <input id="in-user" placeholder="e.g. naga" autocapitalize="none" autocomplete="username"></label>
    <label class="fld"><span>PIN</span>
      <input id="in-pin" type="password" inputmode="numeric" placeholder="4-digit PIN" autocomplete="current-password"></label>
    <button class="btn primary big" id="btn-login">Sign in</button>
    <div class="demo"><span class="demo-label">First time? Seeded logins use PIN 1234 — e.g. admin <b>ashrafunnisa</b>, supervisor <b>jeevan</b>, staff <b>naga</b>. Change PINs after signing in.</span></div>
  </div></div>`;
}
function bindLogin(){
  const go = () => login(document.getElementById("in-user").value, document.getElementById("in-pin").value);
  document.getElementById("btn-login").onclick = go;
  document.getElementById("in-pin").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

function masthead(){
  const roleTag = S.user.role === "admin" ? "Admin" : S.user.role === "supervisor" ? "Supervisor" : "Staff";
  const tabs = [["clock","Clock in"]];
  if (S.user.role === "supervisor" || S.user.role === "admin") tabs.push(["register","Register"]);
  if (S.user.role === "admin"){ tabs.push(["people","People"]); tabs.push(["settings","Settings"]); }
  return `<header class="masthead">
    <div class="mast-top">
      <div class="mast-id"><span class="mast-seal">CMRO</span>
        <div><div class="mast-section">${esc(S.settings.section)}</div>
        <div class="mast-date">${prettyDate(S.now)} · ${hhmm(S.now)}</div></div></div>
      <div class="mast-user"><div class="mu-name">${esc(S.user.name)}</div>
        <div class="mu-role">${esc(S.user.designation)} · ${roleTag}</div></div>
      <button class="btn ghost logout" id="btn-logout">Sign out</button>
    </div>
    <nav class="nav">${tabs.map(([id,l]) => `<button class="nav-btn ${S.tab===id?"on":""}" data-tab="${id}">${l}</button>`).join("")}</nav>
  </header>`;
}

function screen(){
  if (S.tab === "clock") return clockScreen();
  if (S.tab === "register") return registerScreen();
  if (S.tab === "people" && S.user.role === "admin") return peopleScreen();
  if (S.tab === "settings" && S.user.role === "admin") return settingsScreen();
  return clockScreen();
}

function clockScreen(){
  const rec = S.att.records[S.user.id];
  const status = statusOf(rec, S.att.finalized, S.settings.late_after);
  const wd = isWorkingDay(S.now);
  const locked = S.att.finalized || reached();
  let stamp;
  if (rec?.clock_in) stamp = `<div class="stamp ${status}"><span class="stamp-top">CLOCKED IN</span><span class="stamp-time">${rec.clock_in}</span><span class="stamp-bot">${prettyDate(S.now)}</span>${status==="late"?'<span class="stamp-flag">LATE</span>':""}</div>`;
  else if (rec?.leave) stamp = `<div class="stamp leave"><span class="stamp-top">ON LEAVE</span><span class="stamp-time">—</span><span class="stamp-bot">${prettyDate(S.now)}</span></div>`;
  else if (locked && wd) stamp = `<div class="stamp absent"><span class="stamp-top">NOT MARKED</span><span class="stamp-time">✕</span><span class="stamp-bot">Register closed at ${S.settings.report_time}</span></div>`;
  else stamp = `<div class="clock-face"><div class="cf-time">${hhmm(S.now)}</div><div class="cf-day">${prettyDate(S.now)}</div></div>`;

  const canClock = !rec?.clock_in && !rec?.leave && wd && !locked;
  return `<div class="clock-screen">
    ${!wd ? `<div class="banner"><div><b>Not a working day</b><span>The register runs ${(S.settings.working_days||[]).map(d=>DOW[d].slice(0,3)).join(", ")}. No attendance today.</span></div></div>` : ""}
    <div class="stamp-stage">${stamp}</div>
    ${canClock ? `<button class="btn primary big press" id="btn-clock" style="max-width:320px">Clock in now</button>
      <p class="hint">After <b>${S.settings.late_after}</b> you'll be marked late. The register closes and finalises at <b>${S.settings.report_time}</b>.</p>` : ""}
    ${locked && wd && !rec?.clock_in && !rec?.leave ? `<p class="hint">Today's register is closed. Contact the admin for corrections.</p>` : ""}
    ${rec?.clock_in ? `<p class="hint good">Your attendance is recorded for today.</p>` : ""}
  </div>`;
}

function registerScreen(){
  const rows = currentRows();
  const finalized = S.att.finalized;
  const canEdit = S.user.role === "admin" || S.user.role === "supervisor";
  const tally = rows.reduce((a,r)=>{ a[r.status]=(a[r.status]||0)+1; return a; },{});
  return `<div class="register">
    <div class="reg-head">
      <div><h2 class="reg-title">Attendance Report — ${esc(S.settings.section)}</h2>
        <div class="reg-meta">${prettyDate(S.now)} · ${finalized ? '<span class="badge done">Finalised</span>' : isWorkingDay(S.now) ? `<span class="badge open">Open · closes ${S.settings.report_time}</span>` : '<span class="badge">Non-working day</span>'}</div></div>
      <div class="reg-actions no-print">
        <button class="btn ghost" id="btn-print">Print</button>
        <button class="btn primary" id="btn-csv">Download report</button></div>
    </div>
    <div class="tally no-print">${["present","late","leave","absent","pending"].map(k=>tally[k]?`<span class="tpill ${k}">${STATUS_META[k].label} · ${tally[k]}</span>`:"").join("")}</div>
    <div class="table-wrap"><table class="reg-table"><thead><tr>
      <th class="c-sl">Sl.</th><th>Name</th><th class="c-des">Designation</th><th class="c-in">Clocked in</th><th class="c-st">Status</th>
      ${canEdit && !finalized ? '<th class="c-act no-print">Leave</th>' : ""}
    </tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td class="c-sl">${r.sl}</td><td class="c-name">${esc(r.u.name)}</td><td class="c-des">${esc(r.u.designation)}</td>
        <td class="c-in mono">${r.leave?"Leave":(r.clock_in||"—")}</td>
        <td class="c-st"><span class="stat ${STATUS_META[r.status].cls}">${STATUS_META[r.status].label}</span></td>
        ${canEdit && !finalized ? `<td class="c-act no-print"><button class="mini ${r.leave?"on":""}" data-leave="${r.u.id}">${r.leave?"Clear":"Mark"}</button></td>` : ""}
      </tr>`).join("")}
    </tbody></table></div>
    ${canEdit ? `<div class="reg-foot no-print">${
      !finalized ? '<button class="btn outline" id="btn-final">Finalise now</button>'
      : S.user.role === "admin" ? '<button class="btn outline" id="btn-reopen">Reopen for corrections</button>'
      : '<span class="hint">Finalised. Only the admin can reopen the day.</span>'
    }</div>` : ""}
    <p class="fineprint no-print">The register finalises automatically at <b>${S.settings.report_time}</b> on working days whenever an admin or supervisor has it open. For fully unattended finalising (even with no one online), enable the scheduled job noted in SETUP-GUIDE.md.</p>
  </div>`;
}

function peopleScreen(){
  const rowHtml = S.users.map(u=>`<tr class="${u.disabled?"row-off":""}">
    <td class="c-name">${esc(u.name)}</td><td>${esc(u.designation)}</td><td class="mono">${esc(u.username)}</td>
    <td><span class="role-tag ${u.role}">${u.role}</span></td>
    <td>${u.disabled?'<span class="stat absent">Disabled</span>':'<span class="stat present">Active</span>'}</td>
    <td class="c-act"><button class="mini ${u.disabled?"":"danger"}" data-toggle="${u.id}" data-val="${u.disabled?"0":"1"}">${u.disabled?"Enable":"Disable"}</button></td>
  </tr>`).join("");
  return `<div class="people">
    <div class="ppl-head"><h2 class="reg-title">People &amp; access</h2><button class="btn primary" id="btn-add">Add user</button></div>
    <div class="table-wrap"><table class="reg-table"><thead><tr><th>Name</th><th>Designation</th><th>Username</th><th>Role</th><th>Status</th><th class="c-act">Action</th></tr></thead><tbody>${rowHtml}</tbody></table></div>
    <p class="fineprint">Only the admin can add users or disable access. Disabled users can't sign in and drop out of the daily register.</p>
    ${S.modal?addUserModal():""}
  </div>`;
}
function addUserModal(){
  return `<div class="modal-back" id="modal-back"><div class="modal">
    <div class="modal-head"><h3>Add user</h3><button class="icon-btn" id="modal-close">✕</button></div>
    <label class="fld"><span>Full name</span><input id="f-name" placeholder="e.g. K.Ravi Teja"></label>
    <label class="fld"><span>Designation</span><input id="f-des" placeholder="e.g. JA"></label>
    <div class="fld-row"><label class="fld"><span>Username</span><input id="f-user" placeholder="raviteja" autocapitalize="none"></label>
      <label class="fld"><span>PIN (4 digits)</span><input id="f-pin" inputmode="numeric" placeholder="1234"></label></div>
    <label class="fld"><span>Role</span><select id="f-role">
      <option value="employee">Employee — clock in only</option>
      <option value="supervisor">Supervisor — view &amp; download report</option>
      <option value="admin">Admin — full access</option></select></label>
    <button class="btn primary big" id="f-submit">Add to register</button>
  </div></div>`;
}

function settingsScreen(){
  const s = S.settings;
  return `<div class="settings"><h2 class="reg-title">Register settings</h2>
    <div class="set-grid">
      <label class="fld"><span>Section name</span><input id="s-section" value="${esc(s.section)}"></label>
      <div class="fld-row"><label class="fld"><span>Late after</span><input id="s-late" type="time" value="${s.late_after}"></label>
        <label class="fld"><span>Report finalises at</span><input id="s-report" type="time" value="${s.report_time}"></label></div>
      <div class="fld"><span>Working days</span><div class="daychips">
        ${DOW.map((d,i)=>`<button class="daychip ${(s.working_days||[]).includes(i)?"on":""}" data-day="${i}">${d.slice(0,3)}</button>`).join("")}</div></div>
    </div>
    <button class="btn primary big" id="s-save">Save settings</button></div>`;
}

function installFab(){
  return S.deferredInstall ? `<button class="btn primary install-fab" id="btn-install">Install app</button>` : "";
}

/* ---------- bind app-level events ---------- */
function bindApp(){
  document.getElementById("btn-logout").onclick = logout;
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; S.modal=false; render(); });

  const clk = document.getElementById("btn-clock"); if (clk) clk.onclick = clockIn;
  const csv = document.getElementById("btn-csv"); if (csv) csv.onclick = downloadCSV;
  const prt = document.getElementById("btn-print"); if (prt) prt.onclick = () => window.print();
  const fin = document.getElementById("btn-final"); if (fin) fin.onclick = finalizeNow;
  const rop = document.getElementById("btn-reopen"); if (rop) rop.onclick = reopen;
  document.querySelectorAll("[data-leave]").forEach(b => b.onclick = () => toggleLeave(b.dataset.leave));

  const add = document.getElementById("btn-add"); if (add) add.onclick = () => { S.modal=true; render(); };
  document.querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => toggleDisabled(b.dataset.toggle, b.dataset.val==="1"));

  if (S.modal){
    document.getElementById("modal-close").onclick = () => { S.modal=false; render(); };
    document.getElementById("modal-back").onclick = (e) => { if (e.target.id==="modal-back"){ S.modal=false; render(); } };
    document.getElementById("f-submit").onclick = async () => {
      const u = {
        name:document.getElementById("f-name").value.trim(),
        designation:document.getElementById("f-des").value.trim(),
        username:document.getElementById("f-user").value.trim().replace(/\s/g,""),
        pin:document.getElementById("f-pin").value.replace(/\D/g,"").slice(0,6),
        role:document.getElementById("f-role").value,
      };
      if (!u.name || !u.username || u.pin.length < 4){ toast("Fill name, username and a 4-digit PIN.","err"); return; }
      if (await addUser(u)){ S.modal=false; render(); }
    };
  }

  if (S.tab === "settings"){
    let wd = [...(S.settings.working_days||[])];
    document.querySelectorAll("[data-day]").forEach(b => b.onclick = () => {
      const d = +b.dataset.day; wd = wd.includes(d) ? wd.filter(x=>x!==d) : [...wd,d].sort();
      b.classList.toggle("on");
    });
    document.getElementById("s-save").onclick = () => saveSettings({
      section:document.getElementById("s-section").value.trim() || "CMRO Section",
      late_after:document.getElementById("s-late").value,
      report_time:document.getElementById("s-report").value,
      working_days:wd,
    });
  }

  const ib = document.getElementById("btn-install");
  if (ib) ib.onclick = async () => { S.deferredInstall.prompt(); S.deferredInstall = null; };
}

/* ---------- install prompt ---------- */
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.deferredInstall = e; if (S.user) render(); });

/* ---------- ticking + polling ---------- */
setInterval(async () => {
  S.now = new Date();
  if (!S.user || !configured || S.modal) return;   // don't disturb open forms
  if (S.tab === "clock" || S.tab === "register"){ await refreshDay(); render(); }
}, 20000);

/* ---------- boot ---------- */
render();
