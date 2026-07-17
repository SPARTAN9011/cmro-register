import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* ---------- config / client ---------- */
const cfg = window.CMRO_CONFIG || {};
const configured =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
  !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");
const sb = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const root = document.getElementById("root");
const VERSION = "v12 · dashboard donut";
const TRACK_FROM = "2026-07-01";   // attendance history starts here

/* ---------- time helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const prettyDate = (d) => `${DOW[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

const DEFAULT_SETTINGS = {
  section:"CMRO Section", report_time:"10:45", late_after:"10:30", working_days:[1,2,3,4,5],
  geofence_on:true, office_lat:16.4204779, office_lng:80.5607027, office_radius:200,
};

const STATUS_META = {
  present:{ label:"Present", cls:"present" },
  lp:{ label:"Late permission", cls:"lp" },
  od:{ label:"On duty (OD)", cls:"od" },
  absent:{ label:"Absent", cls:"absent" },
  leave:{ label:"On leave", cls:"leave" },
  pending:{ label:"Awaiting", cls:"pending" },
};
function statusOf(rec, finalized){
  if (rec?.clock_in) return "present";
  if (rec?.reason_type === "od") return "od";
  if (rec?.reason_type === "lp") return "lp";
  if (rec?.leave || rec?.reason_type === "leave") return "leave";
  if (finalized) return "absent";
  return "pending";
}

const REASON_LABEL = {
  work_assigned:"Work assigned", late_permission:"Late permission",
  od:"On duty (OD)", lp:"Late permission", leave:"Leave", other:"Other",
};
const LATE_REASONS = [["work_assigned","Work assigned"],["late_permission","Late permission"],["other","Other"]];

// per-device id (stored on this browser/phone; not a hardware MAC — browsers can't read that)
function getDeviceId(){
  try {
    let id = localStorage.getItem("cmro_device_id");
    if (!id){ id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); localStorage.setItem("cmro_device_id", id); }
    return id;
  } catch { return "nostorage-" + Math.random().toString(16).slice(2); }
}

// distance in metres between two lat/lng points
function metresBetween(la1, lo1, la2, lo2){
  const R = 6371000, rad = (x) => x * Math.PI / 180;
  const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
  const a = Math.sin(dLa/2)**2 + Math.cos(rad(la1))*Math.cos(rad(la2))*Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function getPosition(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("no-geo"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p), (e) => reject(e),
      { enableHighAccuracy:true, timeout:12000, maximumAge:0 }
    );
  });
}

/* ---------- state ---------- */
const S = {
  user:null, users:[], settings:DEFAULT_SETTINGS,
  today:dateKey(new Date()), att:{ records:{}, finalized:false, reopened:false },
  now:new Date(), tab:"clock", loginErr:"", loginNote:"", forceChange:false, changeErr:"",
  history:null, histDate:null, histAtt:null, geoBusy:false, modal:false, deferredInstall:null,
};

/* ---------- data layer ---------- */
async function fetchSettings(){
  const { data } = await sb.from("settings").select("*").eq("id",1).maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return {
    section:data.section, report_time:data.report_time, late_after:data.late_after,
    working_days:data.working_days || [1,2,3,4,5],
    geofence_on: data.geofence_on ?? true,
    office_lat: data.office_lat ?? DEFAULT_SETTINGS.office_lat,
    office_lng: data.office_lng ?? DEFAULT_SETTINGS.office_lng,
    office_radius: data.office_radius ?? DEFAULT_SETTINGS.office_radius,
  };
}
async function fetchUsers(){
  const { data } = await sb.from("users").select("*").order("created_at",{ ascending:true });
  return data || [];
}
async function fetchDay(date){
  const { data:recs } = await sb.from("attendance").select("*").eq("date",date);
  const { data:ds } = await sb.from("day_status").select("*").eq("date",date).maybeSingle();
  const records = {};
  (recs||[]).forEach(r => { records[r.user_id] = { clock_in:r.clock_in, leave:r.leave, exception:r.exception, reason_type:r.reason_type, reason_note:r.reason_note, reason_status:r.reason_status }; });
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
async function afterAuth(){
  S.forceChange = false; S.changeErr = ""; S.history = null; S.histDate = null; S.histAtt = null;
  S.tab = (S.user.role === "employee") ? "clock" : "register";
  if (S.user.role === "admin" || S.user.role === "supervisor") S.users = await fetchUsers();
  S.settings = await fetchSettings();
  await refreshDay();
  render();
}
async function login(username, pin){
  S.loginErr = ""; S.loginNote = "";
  const { data, error } = await sb.from("users").select("*")
    .eq("username", username.trim().toLowerCase()).eq("pin", pin).eq("disabled", false).maybeSingle();
  if (error){ S.loginErr = "Can't reach the register. Check the internet connection."; render(); return; }
  if (!data){ S.loginErr = "Username or PIN not recognised."; render(); return; }

  // one-device-per-employee: this device is tied to the first employee who signs in on it.
  // Admin & supervisor are exempt (they don't clock in and may use shared machines).
  if (data.role === "employee"){
    const did = getDeviceId();
    const { data: dev } = await sb.from("devices").select("*").eq("device_id", did).maybeSingle();
    if (dev && dev.user_id !== data.id){
      S.loginErr = `This device is registered to ${dev.user_name || "another staff member"}. Each person must use their own device — ask the admin to reset it if this device was reassigned.`;
      render(); return;
    }
    if (!dev){ await sb.from("devices").insert({ device_id:did, user_id:data.id, user_name:data.name }); }
  }

  S.user = data;
  if (data.must_change_pin){ S.forceChange = true; render(); return; }   // first login -> set new PIN
  await afterAuth();
}
async function changePin(p1, p2){
  S.changeErr = "";
  if (!/^\d{4,6}$/.test(p1)){ S.changeErr = "PIN must be 4–6 digits."; render(); return; }
  if (p1 !== p2){ S.changeErr = "The two PINs don't match."; render(); return; }
  const { error } = await sb.from("users").update({ pin:p1, must_change_pin:false }).eq("id", S.user.id);
  if (error){ S.changeErr = "Could not save. Try again."; render(); return; }
  S.user.pin = p1; S.user.must_change_pin = false;
  toast("PIN updated."); await afterAuth();
}
function logout(){ S.user=null; S.users=[]; S.history=null; S.forceChange=false; render(); }

async function clockIn(){
  if (!isWorkingDay(S.now) || S.att.finalized || reached()) return;
  const rec = S.att.records[S.user.id];
  if (rec?.clock_in || rec?.leave) return;

  // one-device-per-person: block if this device belongs to someone else
  const did = getDeviceId();
  const { data: dev } = await sb.from("devices").select("*").eq("device_id", did).maybeSingle();
  if (dev && dev.user_id !== S.user.id){
    toast(`This device is registered to ${dev.user_name || "another user"}. Use your own device to clock in.`, "err");
    return;
  }

  let lat = null, lng = null;
  if (S.settings.geofence_on){
    S.geoBusy = true; render();
    try {
      const pos = await getPosition();
      lat = pos.coords.latitude; lng = pos.coords.longitude;
      const dist = metresBetween(lat, lng, S.settings.office_lat, S.settings.office_lng);
      if (dist > S.settings.office_radius){
        S.geoBusy = false; render();
        toast(`You're about ${Math.round(dist)} m from the office. Clock in from within the premises.`, "err");
        return;
      }
    } catch (e){
      S.geoBusy = false; render();
      toast(e && e.code === 1 ? "Allow location access to clock in." : "Couldn't get your location. Turn on GPS and try again.", "err");
      return;
    }
    S.geoBusy = false;
  }
  if (!dev) await sb.from("devices").insert({ device_id:did, user_id:S.user.id, user_name:S.user.name });
  await sb.from("attendance").upsert({ user_id:S.user.id, date:S.today, clock_in:hhmm(S.now), leave:false, exception:false, lat, lng, device_id:did }, { onConflict:"user_id,date" });
  await refreshDay(); toast(`Clocked in at ${hhmm(new Date())}.`); render();
}

// employee: give a reason for late arrival (attached to today's record)
async function submitReason(type){
  let note = null;
  if (type === "other"){ note = window.prompt("Briefly describe the reason:", ""); if (note === null) return; }
  await sb.from("attendance").upsert(
    { user_id:S.user.id, date:S.today, reason_type:type, reason_note:note, reason_status:"pending" },
    { onConflict:"user_id,date" });
  await refreshDay(); toast("Reason submitted for verification."); render();
}
// employee: declare OD, LP (late permission) or Leave for today
async function submitAbsence(kind){
  if (S.att.finalized) { toast("Today's register is closed. Ask the admin.", "err"); return; }
  const label = { od:"On Duty", lp:"Late Permission", leave:"Leave" }[kind] || kind;
  const note = window.prompt(`Add a note for your ${label} (optional):`, "");
  if (note === null) return;
  await sb.from("attendance").upsert(
    { user_id:S.user.id, date:S.today, clock_in:null, leave: kind === "leave", exception:false, reason_type:kind, reason_note:note || null, reason_status:"pending" },
    { onConflict:"user_id,date" });
  await refreshDay(); toast(`${label} submitted for verification.`); render();
}
// supervisor/admin: verify or reject a submitted reason
async function setReasonStatus(userId, status){
  await sb.from("attendance").upsert({ user_id:userId, date:S.today, reason_status:status }, { onConflict:"user_id,date" });
  await refreshDay(); toast(status === "verified" ? "Marked verified." : "Marked rejected."); render();
}
// admin: edit any person's entry on the selected History date
async function histSet(userId, name){
  const cur = S.histAtt?.records?.[userId] || {};
  const raw = window.prompt(
    `Edit attendance for ${name} on ${S.histDate}.\n\nEnter a time as HH:MM, or:\n  L = Leave\n  O = On duty (OD)\n  P = Late permission (LP)\n  C = Clear (mark absent)`,
    cur.clock_in || "");
  if (raw === null) return;
  const v = raw.trim().toUpperCase();
  if (v === "C"){
    await sb.from("attendance").delete().eq("user_id", userId).eq("date", S.histDate);
    await loadHistDay(); toast("Entry cleared."); render(); return;
  }
  let patch;
  if (v === "L") patch = { clock_in:null, leave:true,  exception:false, reason_type:"leave", reason_note:null, reason_status:"verified" };
  else if (v === "O") patch = { clock_in:null, leave:false, exception:false, reason_type:"od", reason_note:null, reason_status:"verified" };
  else if (v === "P") patch = { clock_in:null, leave:false, exception:false, reason_type:"lp", reason_note:null, reason_status:"verified" };
  else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim())) patch = { clock_in:raw.trim(), leave:false, exception:false, reason_type:null, reason_note:null, reason_status:null };
  else { toast("Enter HH:MM, or L / O / P / C.", "err"); return; }
  await sb.from("attendance").upsert({ user_id:userId, date:S.histDate, ...patch }, { onConflict:"user_id,date" });
  await loadHistDay(); toast("Attendance updated."); render();
}
async function histVerify(userId, status){
  await sb.from("attendance").upsert({ user_id:userId, date:S.histDate, reason_status:status }, { onConflict:"user_id,date" });
  await loadHistDay(); toast(status === "verified" ? "Verified." : "Rejected."); render();
}
// admin: release a person's device so a new phone can be registered
async function resetDevice(userId, name){
  if (!window.confirm(`Release ${name}'s registered device? Their next clock-in will register a new one.`)) return;
  await sb.from("devices").delete().eq("user_id", userId);
  toast(`Device released for ${name}.`);
}
async function toggleLeave(userId){
  const rec = S.att.records[userId] || {};
  await sb.from("attendance").upsert({ user_id:userId, date:S.today, clock_in:null, leave:!rec.leave, exception:false }, { onConflict:"user_id,date" });
  await refreshDay(); render();
}
async function allowLate(userId, name){
  const def = hhmm(new Date());
  const t = window.prompt(`Record arrival for ${name}.\nEnter arrival time (24h HH:MM):`, def);
  if (t === null) return;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.trim())){ toast("Enter time as HH:MM, e.g. 10:52.", "err"); return; }
  await sb.from("attendance").upsert({ user_id:userId, date:S.today, clock_in:t.trim(), leave:false, exception:false }, { onConflict:"user_id,date" });
  await refreshDay(); toast("Attendance recorded."); render();
}
async function finalizeNow(){ await sb.from("day_status").upsert({ date:S.today, finalized:true, reopened:false },{ onConflict:"date" }); await refreshDay(); render(); }
async function reopen(){ await sb.from("day_status").upsert({ date:S.today, finalized:false, reopened:true },{ onConflict:"date" }); await refreshDay(); render(); }

async function addUser(u){
  const { error } = await sb.from("users").insert({ ...u, username:u.username.toLowerCase(), disabled:false, must_change_pin:true });
  if (error){ toast(error.code === "23505" ? "That username is already taken." : "Could not add user.", "err"); return false; }
  S.users = await fetchUsers(); toast(`${u.name} added to the register.`); return true;
}
async function resetPin(id, name){
  const t = window.prompt(`Set a temporary PIN for ${name} (4–6 digits).\nThey'll be asked to change it at next login.`, "1234");
  if (t === null) return;
  if (!/^\d{4,6}$/.test(t.trim())){ toast("PIN must be 4–6 digits.", "err"); return; }
  await sb.from("users").update({ pin:t.trim(), must_change_pin:true }).eq("id", id);
  S.users = await fetchUsers(); toast(`PIN reset for ${name}.`); render();
}
async function toggleDisabled(id, val){ await sb.from("users").update({ disabled:val }).eq("id",id); S.users = await fetchUsers(); render(); }
async function saveSettings(s){ await sb.from("settings").upsert({ id:1, ...s },{ onConflict:"id" }); S.settings = s; toast("Settings saved."); render(); }

async function loadHistory(){
  const from = new Date(S.now); from.setDate(from.getDate() - 44);
  const gte = dateKey(from) < TRACK_FROM ? TRACK_FROM : dateKey(from);
  const { data } = await sb.from("attendance").select("*").eq("user_id", S.user.id)
    .gte("date", gte).order("date", { ascending:false });
  const map = {}; (data||[]).forEach(r => { map[r.date] = r; });
  const days = [];
  for (let i = 0; i < 60; i++){
    const d = new Date(S.now); d.setDate(d.getDate() - i);
    const key = dateKey(d);
    if (key < TRACK_FROM) break;                     // nothing before tracking start
    if (!isWorkingDay(d)) continue;                  // list working days only
    const rec = map[key];
    const past = key < S.today;
    let status;
    if (rec) status = statusOf({ clock_in:rec.clock_in, leave:rec.leave, exception:rec.exception, reason_type:rec.reason_type }, past, S.settings.late_after);
    else status = past ? "absent" : "pending";
    days.push({ date:d, key, clock_in:rec?.clock_in || null, leave:!!rec?.leave, status });
    if (days.length >= 30) break;
  }
  S.history = days;
}
function parseKey(k){ const [y,m,d] = k.split("-").map(Number); return new Date(y, m-1, d); }
function shiftKey(k, delta){ const d = parseKey(k); d.setDate(d.getDate() + delta); return dateKey(d); }
async function loadHistDay(){
  if (!S.histDate) S.histDate = S.today;
  S.histAtt = await fetchDay(S.histDate);
}
function histFinalized(){
  const key = S.histDate || S.today;
  return key < S.today ? true : (S.histAtt?.finalized ?? false);
}

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
function rosterUsers(){ return S.users.filter(u => !u.disabled && u.role === "employee"); }
function rowsFrom(att, finalized){
  return rosterUsers().map((u,i) => {
    const rec = att.records[u.id] || {};
    return { sl:i+1, u, clock_in:rec.clock_in||null, leave:!!rec.leave,
      reason_type:rec.reason_type||null, reason_note:rec.reason_note||null, reason_status:rec.reason_status||null,
      status:statusOf(rec, finalized, S.settings.late_after) };
  });
}
function currentRows(){ return rowsFrom(S.att, S.att.finalized); }
function todayCtx(){ return { att:S.att, finalized:S.att.finalized, dateObj:S.now, key:S.today }; }
function histCtx(){ const key = S.histDate || S.today; return { att:S.histAtt || { records:{} }, finalized:histFinalized(), dateObj:parseKey(key), key }; }

async function exportXLSX(ctx = todayCtx()){
  toast("Building Excel…");
  try {
    const mod = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
    const XLSX = mod.utils ? mod : (mod.default || mod);
    const rows = rowsFrom(ctx.att, ctx.finalized);
    const rTxt = (r) => r.reason_type ? (REASON_LABEL[r.reason_type] || r.reason_type) + (r.reason_note ? ` (${r.reason_note})` : "") : "—";
    const vTxt = (r) => r.reason_type ? (r.reason_status === "verified" ? "Verified" : r.reason_status === "rejected" ? "Rejected" : "Pending") : "—";
    const aoa = [
      [`Attendance Report of ${S.settings.section}`],
      ["Date", prettyDate(ctx.dateObj)],
      ["Report finalised", ctx.finalized ? "Yes" : "No (open)"],
      [],
      ["Sl.No","Name","Designation","Clocked In","Status","Reason","Verified"],
      ...rows.map(r => [r.sl, r.u.name, r.u.designation, r.leave ? "Leave" : (r.clock_in || "—"), STATUS_META[r.status].label, rTxt(r), vTxt(r)]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch:6 },{ wch:28 },{ wch:14 },{ wch:12 },{ wch:14 },{ wch:26 },{ wch:12 }];
    ws["!merges"] = [{ s:{ r:0,c:0 }, e:{ r:0,c:6 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendance");
    XLSX.writeFile(wb, `CMRO_attendance_${ctx.key}.xlsx`);
    toast("Excel downloaded.");
  } catch (e){ toast("Excel export needs internet. Try again online.","err"); }
}

// load a script from the first CDN that responds (some office networks block certain CDNs)
function loadScriptOnce(src){
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => res(src);
    s.onerror = () => { s.remove(); rej(new Error("failed " + src)); };
    document.head.appendChild(s);
  });
}
async function loadFirst(urls){
  let lastErr;
  for (const u of urls){ try { return await loadScriptOnce(u); } catch (e){ lastErr = e; } }
  throw lastErr || new Error("all CDNs failed");
}
async function ensureJsPDF(){
  if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return;
  if (!(window.jspdf && window.jspdf.jsPDF)){
    await loadFirst([
      "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
      "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
      "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js",
    ]);
  }
  if (!window.jspdf.jsPDF.API.autoTable){
    await loadFirst([
      "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
      "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js",
      "https://unpkg.com/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js",
    ]);
  }
}
async function exportPDF(ctx = todayCtx()){
  toast("Building PDF…");
  try {
    await ensureJsPDF();
    const { jsPDF } = window.jspdf;
    const rows = rowsFrom(ctx.att, ctx.finalized);
    const rTxt = (r) => r.reason_type ? (REASON_LABEL[r.reason_type] || r.reason_type) + (r.reason_note ? ` (${r.reason_note})` : "") : "—";
    const vTxt = (r) => r.reason_type ? (r.reason_status === "verified" ? "Verified" : r.reason_status === "rejected" ? "Rejected" : "Pending") : "—";
    const doc = new jsPDF();
    doc.setFont("times","bold"); doc.setFontSize(15);
    doc.text(`Attendance Report — ${S.settings.section}`, 14, 18);
    doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(90);
    doc.text(`${prettyDate(ctx.dateObj)}    ·    ${ctx.finalized ? "Finalised" : "Open (not yet finalised)"}`, 14, 25);
    doc.autoTable({
      startY: 30,
      head: [["Sl.","Name","Designation","In","Status","Reason","Verified"]],
      body: rows.map(r => [r.sl, r.u.name, r.u.designation, r.leave ? "Leave" : (r.clock_in || "—"), STATUS_META[r.status].label, rTxt(r), vTxt(r)]),
      styles: { fontSize: 9, cellPadding: 2.5 },
      headStyles: { fillColor: [18,58,46], textColor: [238,240,224] },
      alternateRowStyles: { fillColor: [244,244,238] },
      columnStyles: { 0: { halign:"center", cellWidth:10 }, 3: { halign:"center" } },
    });
    doc.save(`CMRO_attendance_${ctx.key}.pdf`);
    toast("PDF downloaded.");
  } catch (e){ toast("Couldn't load the PDF tool — your network may block it. Use Print → Save as PDF instead.","err"); }
}

/* ================= RENDER ================= */
function render(){
  if (!configured){ root.innerHTML = setupNeeded(); return; }
  if (!S.user){ root.innerHTML = loginScreen(); bindLogin(); return; }
  if (S.forceChange){ root.innerHTML = changePinScreen(); bindChangePin(); return; }
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
    <h1 class="login-title">Digital Duty Register</h1>
    <p class="login-sub">Sign in to record or review today's attendance.</p>
    ${S.loginErr ? `<p class="err-line">${esc(S.loginErr)}</p>` : ""}
    <label class="fld"><span>Username</span>
      <input id="in-user" placeholder="e.g. naga" autocapitalize="none" autocomplete="username"></label>
    <label class="fld"><span>PIN</span>
      <input id="in-pin" type="password" inputmode="numeric" placeholder="4-digit PIN" autocomplete="current-password"></label>
    <button class="btn primary big" id="btn-login">Sign in</button>
    <button class="linky" id="btn-forgot">Forgot PIN?</button>
    ${S.loginNote ? `<p class="login-note">${esc(S.loginNote)}</p>` : ""}
  </div></div>`;
}
function bindLogin(){
  const go = () => login(document.getElementById("in-user").value, document.getElementById("in-pin").value);
  document.getElementById("btn-login").onclick = go;
  document.getElementById("in-pin").onkeydown = (e) => { if (e.key === "Enter") go(); };
  document.getElementById("btn-forgot").onclick = () => {
    S.loginNote = "Ask your admin to reset your PIN from the People screen. You'll set a new PIN the next time you sign in.";
    render();
  };
}
function changePinScreen(){
  return `<div class="login-wrap"><div class="login-card">
    <div class="seal">CMRO</div>
    <h1 class="login-title">Set your PIN</h1>
    <p class="login-sub">Welcome, ${esc(S.user.name.split(" ")[0])}. Choose a new PIN before continuing.</p>
    ${S.changeErr ? `<p class="err-line">${esc(S.changeErr)}</p>` : ""}
    <label class="fld"><span>New PIN (4–6 digits)</span>
      <input id="cp1" type="password" inputmode="numeric" placeholder="New PIN"></label>
    <label class="fld"><span>Confirm new PIN</span>
      <input id="cp2" type="password" inputmode="numeric" placeholder="Re-enter PIN"></label>
    <button class="btn primary big" id="cp-save">Save PIN and continue</button>
  </div></div>`;
}
function bindChangePin(){
  const go = () => changePin(document.getElementById("cp1").value.trim(), document.getElementById("cp2").value.trim());
  document.getElementById("cp-save").onclick = go;
  document.getElementById("cp2").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

function masthead(){
  const r = S.user.role;
  const roleTag = r === "admin" ? "Admin" : r === "supervisor" ? "Supervisor" : "Staff";
  const tabs = [];
  if (r === "employee"){ tabs.push(["clock","Clock in"]); tabs.push(["mydays","My attendance"]); }
  else {
    tabs.push(["register","Register"]); tabs.push(["history","History"]);
    if (r === "admin"){ tabs.push(["people","People"]); tabs.push(["settings","Settings"]); }
  }
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
  const r = S.user.role;
  if (r === "employee"){ return S.tab === "mydays" ? myDaysScreen() : clockScreen(); }
  if (S.tab === "history") return historyScreen();
  if (S.tab === "people" && r === "admin") return peopleScreen();
  if (S.tab === "settings" && r === "admin") return settingsScreen();
  return registerScreen();
}

function reasonBadge(st){
  if (st === "verified") return '<span class="vbadge ok">Verified by supervisor</span>';
  if (st === "rejected") return '<span class="vbadge no">Rejected — please correct</span>';
  if (st === "pending")  return '<span class="vbadge wait">Pending verification</span>';
  return "";
}

function clockScreen(){
  const rec = S.att.records[S.user.id];
  const status = statusOf(rec, S.att.finalized);
  const wd = isWorkingDay(S.now);
  const locked = S.att.finalized || reached();
  let stamp;
  if (rec?.clock_in) stamp = `<div class="stamp present"><span class="stamp-top">CLOCKED IN</span><span class="stamp-time">${rec.clock_in}</span><span class="stamp-bot">${prettyDate(S.now)}</span></div>`;
  else if (status === "od") stamp = `<div class="stamp od"><span class="stamp-top">ON DUTY</span><span class="stamp-time">OD</span><span class="stamp-bot">${prettyDate(S.now)}</span></div>`;
  else if (status === "lp") stamp = `<div class="stamp lp"><span class="stamp-top">LATE PERMISSION</span><span class="stamp-time">LP</span><span class="stamp-bot">${prettyDate(S.now)}</span></div>`;
  else if (rec?.leave || rec?.reason_type === "leave") stamp = `<div class="stamp leave"><span class="stamp-top">ON LEAVE</span><span class="stamp-time">—</span><span class="stamp-bot">${prettyDate(S.now)}</span></div>`;
  else if (locked && wd) stamp = `<div class="stamp absent"><span class="stamp-top">NOT MARKED</span><span class="stamp-time">✕</span><span class="stamp-bot">Register closed at ${S.settings.report_time}</span></div>`;
  else stamp = `<div class="clock-face"><div class="cf-time">${hhmm(S.now)}</div><div class="cf-day">${prettyDate(S.now)}</div></div>`;

  const declared = status === "od" || status === "lp";
  const canClock = !rec?.clock_in && !rec?.leave && !declared && wd && !locked;
  const hasReason = !!rec?.reason_type;
  const canDeclare = !rec?.clock_in && !rec?.leave && !declared && wd && !locked && !hasReason;
  const applyBtns = `<button class="mini alt" data-absence="lp">Late permission</button>
        <button class="mini alt" data-absence="od">On duty (OD)</button>
        <button class="mini alt" data-absence="leave">Leave</button>`;

  // reason block: a submitted declaration shows its status; otherwise staff can apply LP / OD / Leave
  let reasonBlock = "";
  if (hasReason){
    reasonBlock = `<div class="reason-card">
      <div class="reason-line"><b>Marked:</b> ${esc(REASON_LABEL[rec.reason_type] || rec.reason_type)}${rec.reason_note?` — ${esc(rec.reason_note)}`:""}</div>
      ${reasonBadge(rec.reason_status)}
      ${rec.reason_status === "rejected" ? `<div class="reason-actions">${applyBtns}</div>` : ""}
    </div>`;
  } else if (canDeclare){
    reasonBlock = `<div class="reason-card">
      <div class="reason-line">Coming in with late permission, on duty elsewhere, or on leave?</div>
      <div class="reason-actions">${applyBtns}</div></div>`;
  }

  return `<div class="clock-screen">
    ${!wd ? `<div class="banner"><div><b>Not a working day</b><span>The register runs ${(S.settings.working_days||[]).map(d=>DOW[d].slice(0,3)).join(", ")}. No attendance today.</span></div></div>` : ""}
    <div class="stamp-stage">${stamp}</div>
    ${canClock ? (S.geoBusy
      ? `<button class="btn primary big" disabled style="max-width:320px">Checking location…</button>`
      : `<button class="btn primary big press" id="btn-clock" style="max-width:320px">Clock in now</button>
         <p class="hint">${S.settings.geofence_on ? "You must be at the office to clock in. " : ""}The register closes at <b>${S.settings.report_time}</b>.</p>`) : ""}
    ${locked && wd && !rec?.clock_in && !rec?.leave && !declared ? `<p class="hint">Today's register is closed. Contact the admin if you arrived — they can record your attendance.</p>` : ""}
    ${rec?.clock_in ? `<p class="hint good">Your attendance is recorded for today.</p>` : ""}
    ${reasonBlock}
  </div>`;
}

function tallyPills(tally){
  return ["present","lp","od","leave","absent","pending"]
    .map(k => tally[k] ? `<span class="tpill ${k}">${STATUS_META[k].label} · ${tally[k]}</span>` : "").join("");
}
function dayBuckets(rows){
  const n = (f) => rows.filter(f).length;
  return [
    { label:"Present", color:"#1f7a4d", value:n(r => r.status === "present" || r.status === "lp") },
    { label:"OD",      color:"#e08a1e", value:n(r => r.status === "od") },
    { label:"Leave",   color:"#2563eb", value:n(r => r.status === "leave") },
    { label:"Absent",  color:"#b23b3b", value:n(r => r.status === "absent") },
    { label:"Pending", color:"#9a9a90", value:n(r => r.status === "pending") },
  ];
}
function donutSVG(buckets, total){
  const r = 54, cx = 64, cy = 64, sw = 18, C = 2 * Math.PI * r;
  let off = 0, segs = "";
  if (total > 0){
    buckets.forEach(b => {
      if (!b.value) return;
      const len = (b.value / total) * C;
      segs += `<circle r="${r}" cx="${cx}" cy="${cy}" fill="none" stroke="${b.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C-len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
      off += len;
    });
  } else {
    segs = `<circle r="${r}" cx="${cx}" cy="${cy}" fill="none" stroke="#e3e5db" stroke-width="${sw}"></circle>`;
  }
  return `<svg viewBox="0 0 128 128" width="120" height="120" role="img" aria-label="Attendance donut">
    ${segs}
    <text x="64" y="60" text-anchor="middle" font-size="27" font-weight="800" fill="#123a2e">${total}</text>
    <text x="64" y="79" text-anchor="middle" font-size="10.5" fill="#6a7268" letter-spacing=".08em">STAFF</text>
  </svg>`;
}
function dashboard(rows){
  const total = rows.length;
  const buckets = dayBuckets(rows);
  const legend = buckets.map(b => {
    const pct = total ? Math.round(b.value / total * 100) : 0;
    return `<div class="lg-row"><span class="lg-dot" style="background:${b.color}"></span>
      <span class="lg-label">${b.label}</span><span class="lg-val">${b.value} · ${pct}%</span></div>`;
  }).join("");
  return `<div class="dash">
    <div class="dash-brand">
      <div class="dash-seal">CMRO</div>
      <div><div class="dash-title">Attendance</div>
        <div class="dash-sub">${esc(S.settings.section)} · ${prettyDate(S.now)}</div></div>
    </div>
    <div class="dash-chart">
      <div class="donut-wrap">${donutSVG(buckets, total)}</div>
      <div class="legend">${legend}</div>
    </div>
  </div>`;
}
function reasonCell(r){
  if (!r.reason_type) return "—";
  const lbl = REASON_LABEL[r.reason_type] || r.reason_type;
  const note = r.reason_note ? ` <span class="muted-note">(${esc(r.reason_note)})</span>` : "";
  const badge = r.reason_status === "verified" ? '<span class="vbadge ok">Verified</span>'
    : r.reason_status === "rejected" ? '<span class="vbadge no">Rejected</span>'
    : '<span class="vbadge wait">Pending</span>';
  return `${esc(lbl)}${note}<br>${badge}`;
}
function readTable(rows, edit){
  return `<div class="table-wrap"><table class="reg-table"><thead><tr>
    <th class="c-sl">Sl.</th><th>Name</th><th class="c-des">Designation</th><th class="c-in">Clocked in</th><th class="c-st">Status</th><th class="c-reason">Reason</th>${edit?'<th class="c-act no-print">Edit</th>':""}
  </tr></thead><tbody>${rows.map(r=>`<tr>
    <td class="c-sl">${r.sl}</td><td class="c-name">${esc(r.u.name)}</td><td class="c-des">${esc(r.u.designation)}</td>
    <td class="c-in mono">${r.leave?"Leave":(r.clock_in||"—")}</td>
    <td class="c-st"><span class="stat ${STATUS_META[r.status].cls}">${STATUS_META[r.status].label}</span></td>
    <td class="c-reason">${reasonCell(r)}
      ${edit && r.reason_type && r.reason_status !== "verified" ? `<div class="reason-actions no-print"><button class="mini" data-hverify="${r.u.id}">Verify</button>${r.reason_status!=="rejected"?`<button class="mini danger" data-hreject="${r.u.id}">Reject</button>`:""}</div>` : ""}</td>
    ${edit?`<td class="c-act no-print"><button class="mini" data-histedit="${r.u.id}" data-name="${esc(r.u.name)}">Edit</button></td>`:""}
  </tr>`).join("")}</tbody></table></div>`;
}

function registerScreen(){
  const rows = currentRows();
  const finalized = S.att.finalized;
  const canEdit = S.user.role === "admin" || S.user.role === "supervisor";
  const tally = rows.reduce((a,r)=>{ a[r.status]=(a[r.status]||0)+1; return a; },{});
  const actCol = canEdit;
  const pending = rows.filter(r => r.reason_status === "pending").length;
  return `<div class="register">
    ${dashboard(rows)}
    <div class="reg-head">
      <div><h2 class="reg-title">Attendance Report — ${esc(S.settings.section)}</h2>
        <div class="reg-meta">${prettyDate(S.now)} · ${finalized ? '<span class="badge done">Finalised</span>' : isWorkingDay(S.now) ? `<span class="badge open">Open · closes ${S.settings.report_time}</span>` : '<span class="badge">Non-working day</span>'}${pending?` · <span class="badge open">${pending} reason${pending>1?"s":""} to verify</span>`:""}</div></div>
      <div class="reg-actions no-print">
        <button class="btn ghost" id="btn-print">Print</button>
        <button class="btn ghost" id="btn-pdf">PDF</button>
        <button class="btn primary" id="btn-xlsx">Excel</button></div>
    </div>
    <div class="table-wrap"><table class="reg-table"><thead><tr>
      <th class="c-sl">Sl.</th><th>Name</th><th class="c-des">Designation</th><th class="c-in">Clocked in</th><th class="c-st">Status</th><th class="c-reason">Reason / verify</th>
      ${actCol ? '<th class="c-act no-print">Actions</th>' : ""}
    </tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td class="c-sl">${r.sl}</td><td class="c-name">${esc(r.u.name)}</td><td class="c-des">${esc(r.u.designation)}</td>
        <td class="c-in mono">${r.leave?"Leave":(r.clock_in||"—")}</td>
        <td class="c-st"><span class="stat ${STATUS_META[r.status].cls}">${STATUS_META[r.status].label}</span></td>
        <td class="c-reason">${reasonCell(r)}
          ${canEdit && r.reason_type && r.reason_status !== "verified" ? `<div class="reason-actions no-print"><button class="mini" data-verify="${r.u.id}">Verify</button>${r.reason_status!=="rejected"?`<button class="mini danger" data-reject="${r.u.id}">Reject</button>`:""}</div>` : ""}
        </td>
        ${actCol ? `<td class="c-act no-print">
          ${!finalized ? `<button class="mini ${r.leave?"on":""}" data-leave="${r.u.id}">${r.leave?"Clear leave":"Leave"}</button>` : ""}
          ${!r.clock_in && !r.leave && r.status !== "od" && r.status !== "lp" ? `<button class="mini alt" data-allowlate="${r.u.id}" data-name="${esc(r.u.name)}">Record arrival</button>` : ""}
        </td>` : ""}
      </tr>`).join("")}
    </tbody></table></div>
    ${canEdit ? `<div class="reg-foot no-print">${
      !finalized ? '<button class="btn outline" id="btn-final">Finalise now</button>'
      : S.user.role === "admin" ? '<button class="btn outline" id="btn-reopen">Reopen for corrections</button>'
      : '<span class="hint">Finalised. Only the admin can reopen the day.</span>'
    }</div>` : ""}
    <p class="fineprint no-print">Finalises automatically at <b>${S.settings.report_time}</b> on working days when opened. After close, use <b>Record arrival</b> to mark someone who came in after the register closed.</p>
  </div>`;
}

function historyScreen(){
  const key = S.histDate || S.today;
  const dObj = parseKey(key);
  const rows = rowsFrom(S.histAtt || { records:{} }, histFinalized());
  const tally = rows.reduce((a,r)=>{ a[r.status]=(a[r.status]||0)+1; return a; },{});
  const atToday = key >= S.today;
  const atStart = key <= TRACK_FROM;
  return `<div class="register">
    <div class="reg-head">
      <div><h2 class="reg-title">Attendance history</h2>
        <div class="reg-meta">${prettyDate(dObj)}${!isWorkingDay(dObj) ? ' · <span class="badge">Non-working day</span>' : ""}</div></div>
      <div class="reg-actions no-print">
        <button class="btn ghost" id="h-print">Print</button>
        <button class="btn ghost" id="h-pdf">PDF</button>
        <button class="btn primary" id="h-xlsx">Excel</button></div>
    </div>
    <div class="hist-picker no-print">
      <button class="mini" id="h-prev" ${atStart?"disabled":""}>‹ Prev day</button>
      <input type="date" id="h-date" value="${key}" min="${TRACK_FROM}" max="${S.today}">
      <button class="mini" id="h-next" ${atToday?"disabled":""}>Next day ›</button>
      <button class="mini" id="h-today">Today</button>
    </div>
    <div class="tally no-print">${S.histAtt ? tallyPills(tally) : '<span class="tpill pending">Loading…</span>'}</div>
    ${S.histAtt ? readTable(rows, S.user.role === "admin") : ""}
    <p class="fineprint no-print">Pick any date to view and export that day's register.${S.user.role === "admin" ? " As admin you can <b>Edit</b> any entry — set a time, or mark Leave / OD / LP / clear." : ""}</p>
  </div>`;
}

function myDaysScreen(){
  if (!S.history) return `<div class="clock-screen"><p class="hint">Loading your attendance…</p></div>`;
  const rows = S.history;
  const tally = rows.reduce((a,d)=>{ a[d.status]=(a[d.status]||0)+1; return a; },{});
  return `<div class="register">
    <div class="reg-head"><div><h2 class="reg-title">My attendance</h2>
      <div class="reg-meta">${esc(S.user.name)} · last 30 working days</div></div></div>
    <div class="tally">${tallyPills(tally)}</div>
    <div class="table-wrap"><table class="reg-table"><thead><tr><th>Date</th><th class="c-in">Clocked in</th><th class="c-st">Status</th></tr></thead>
    <tbody>${rows.map(d=>`<tr>
      <td class="c-name">${prettyDate(d.date)}</td>
      <td class="c-in mono">${d.leave?"Leave":(d.clock_in||"—")}</td>
      <td class="c-st"><span class="stat ${STATUS_META[d.status].cls}">${STATUS_META[d.status].label}</span></td>
    </tr>`).join("")}</tbody></table></div>
  </div>`;
}

function peopleScreen(){
  const rowHtml = S.users.map(u=>`<tr class="${u.disabled?"row-off":""}">
    <td class="c-name">${esc(u.name)}</td><td>${esc(u.designation)}</td><td class="mono">${esc(u.username)}</td>
    <td><span class="role-tag ${u.role}">${u.role}</span></td>
    <td>${u.disabled?'<span class="stat absent">Disabled</span>':'<span class="stat present">Active</span>'}</td>
    <td class="c-act">
      <button class="mini" data-reset="${u.id}" data-name="${esc(u.name)}">Reset PIN</button>
      ${u.role === "employee" ? `<button class="mini" data-resetdev="${u.id}" data-name="${esc(u.name)}">Reset device</button>` : ""}
      <button class="mini ${u.disabled?"":"danger"}" data-toggle="${u.id}" data-val="${u.disabled?"0":"1"}">${u.disabled?"Enable":"Disable"}</button>
    </td>
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
      <div class="fld-row"><label class="fld"><span>Register closes at</span><input id="s-report" type="time" value="${s.report_time}"></label>
        <label class="fld"><span>&nbsp;</span><span class="fineprint" style="margin:0">After this time the register finalises and absentees are marked.</span></label></div>
      <div class="fld"><span>Working days</span><div class="daychips">
        ${DOW.map((d,i)=>`<button class="daychip ${(s.working_days||[]).includes(i)?"on":""}" data-day="${i}">${d.slice(0,3)}</button>`).join("")}</div></div>
    </div>

    <h3 class="set-sub">Location (geofence)</h3>
    <div class="set-grid">
      <div class="fld-row">
        <label class="fld"><span>Restrict clock-in to office</span>
          <select id="s-geo"><option value="1" ${s.geofence_on?"selected":""}>On</option><option value="0" ${!s.geofence_on?"selected":""}>Off</option></select></label>
        <label class="fld"><span>Allowed radius (metres)</span><input id="s-radius" type="number" min="30" value="${s.office_radius}"></label>
      </div>
      <div class="fld-row">
        <label class="fld"><span>Office latitude</span><input id="s-lat" value="${s.office_lat}"></label>
        <label class="fld"><span>Office longitude</span><input id="s-lng" value="${s.office_lng}"></label>
      </div>
      <button class="mini" id="s-here">Use my current location</button>
      <p class="fineprint">Staff can clock in only within this radius of the office. Set the radius wider (150–250 m) to allow for GPS drift near buildings.</p>
    </div>

    <button class="btn primary big" id="s-save">Save settings</button></div>`;
}

function installFab(){
  return S.deferredInstall ? `<button class="btn primary install-fab" id="btn-install">Install app</button>` : "";
}

/* ---------- bind app-level events ---------- */
function bindApp(){
  document.getElementById("btn-logout").onclick = logout;
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = async () => {
    S.tab = b.dataset.tab; S.modal = false;
    if (S.tab === "mydays"){ S.history = null; render(); await loadHistory(); render(); return; }
    if (S.tab === "history"){ if (!S.histDate) S.histDate = S.today; S.histAtt = null; render(); await loadHistDay(); render(); return; }
    render();
  });

  const clk = document.getElementById("btn-clock"); if (clk) clk.onclick = clockIn;
  document.querySelectorAll("[data-reason]").forEach(b => b.onclick = () => submitReason(b.dataset.reason));
  document.querySelectorAll("[data-absence]").forEach(b => b.onclick = () => submitAbsence(b.dataset.absence));
  document.querySelectorAll("[data-verify]").forEach(b => b.onclick = () => setReasonStatus(b.dataset.verify, "verified"));
  document.querySelectorAll("[data-reject]").forEach(b => b.onclick = () => setReasonStatus(b.dataset.reject, "rejected"));
  const xls = document.getElementById("btn-xlsx"); if (xls) xls.onclick = () => exportXLSX();
  const pdf = document.getElementById("btn-pdf"); if (pdf) pdf.onclick = () => exportPDF();
  const prt = document.getElementById("btn-print"); if (prt) prt.onclick = () => window.print();
  const fin = document.getElementById("btn-final"); if (fin) fin.onclick = finalizeNow;
  const rop = document.getElementById("btn-reopen"); if (rop) rop.onclick = reopen;
  document.querySelectorAll("[data-leave]").forEach(b => b.onclick = () => toggleLeave(b.dataset.leave));
  document.querySelectorAll("[data-allowlate]").forEach(b => b.onclick = () => allowLate(b.dataset.allowlate, b.dataset.name));

  // history calendar
  const hx = document.getElementById("h-xlsx"); if (hx) hx.onclick = () => exportXLSX(histCtx());
  const hp = document.getElementById("h-pdf"); if (hp) hp.onclick = () => exportPDF(histCtx());
  const hpr = document.getElementById("h-print"); if (hpr) hpr.onclick = () => window.print();
  const hd = document.getElementById("h-date"); if (hd) hd.onchange = async () => { let v = hd.value; if (v < TRACK_FROM) v = TRACK_FROM; S.histDate = v; S.histAtt = null; render(); await loadHistDay(); render(); };
  const goHist = async (key) => { S.histDate = key; S.histAtt = null; render(); await loadHistDay(); render(); };
  const hprev = document.getElementById("h-prev"); if (hprev) hprev.onclick = () => { const p = shiftKey(S.histDate || S.today, -1); if (p >= TRACK_FROM) goHist(p); };
  const hnext = document.getElementById("h-next"); if (hnext) hnext.onclick = () => { const n = shiftKey(S.histDate || S.today, 1); if (n <= S.today) goHist(n); };
  const htoday = document.getElementById("h-today"); if (htoday) htoday.onclick = () => goHist(S.today);
  document.querySelectorAll("[data-histedit]").forEach(b => b.onclick = () => histSet(b.dataset.histedit, b.dataset.name));
  document.querySelectorAll("[data-hverify]").forEach(b => b.onclick = () => histVerify(b.dataset.hverify, "verified"));
  document.querySelectorAll("[data-hreject]").forEach(b => b.onclick = () => histVerify(b.dataset.hreject, "rejected"));

  const add = document.getElementById("btn-add"); if (add) add.onclick = () => { S.modal=true; render(); };
  document.querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => toggleDisabled(b.dataset.toggle, b.dataset.val==="1"));
  document.querySelectorAll("[data-reset]").forEach(b => b.onclick = () => resetPin(b.dataset.reset, b.dataset.name));
  document.querySelectorAll("[data-resetdev]").forEach(b => b.onclick = () => resetDevice(b.dataset.resetdev, b.dataset.name));

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
    const here = document.getElementById("s-here");
    if (here) here.onclick = async () => {
      here.textContent = "Locating…";
      try { const p = await getPosition();
        document.getElementById("s-lat").value = p.coords.latitude.toFixed(7);
        document.getElementById("s-lng").value = p.coords.longitude.toFixed(7);
        toast("Location filled in.");
      } catch { toast("Couldn't get location. Allow GPS access.","err"); }
      here.textContent = "Use my current location";
    };
    document.getElementById("s-save").onclick = () => saveSettings({
      section:document.getElementById("s-section").value.trim() || "CMRO Section",
      late_after:S.settings.late_after,
      report_time:document.getElementById("s-report").value,
      working_days:wd,
      geofence_on: document.getElementById("s-geo").value === "1",
      office_lat: parseFloat(document.getElementById("s-lat").value) || S.settings.office_lat,
      office_lng: parseFloat(document.getElementById("s-lng").value) || S.settings.office_lng,
      office_radius: parseInt(document.getElementById("s-radius").value, 10) || 200,
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
