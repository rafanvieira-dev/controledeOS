const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");

initializeApp();
const firestore = getFirestore();

const SMTP_HOST = defineSecret("SMTP_HOST");
const SMTP_PORT = defineSecret("SMTP_PORT");
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const SMTP_FROM = defineSecret("SMTP_FROM");

const TZ = "America/Sao_Paulo";
const HOUR_MS = 60 * 60 * 1000;
const REMINDER_WINDOW_MS = 24 * HOUR_MS;

function localParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}
function keyFromParts(p) { return `${p.year}-${p.month}-${p.day}`; }
function parseLocalDateTime(date, time = "00:00") {
  if (!date) return null;
  const d = String(date).slice(0, 10);
  const t = /^\d{2}:\d{2}/.test(String(time)) ? String(time).slice(0, 5) : "00:00";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  // Rio de Janeiro uses UTC-03:00. The app stores local date/time fields.
  const parsed = new Date(`${d}T${t}:00-03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function addCalendarDays(key, amount) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
function easterSundayKey(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function holidaySet(years) {
  const holidays = new Set();
  for (const year of years) {
    for (const md of ["01-01","04-21","05-01","09-07","10-12","11-02","11-15","11-20","12-25"]) holidays.add(`${year}-${md}`);
    const easter = easterSundayKey(year);
    for (const offset of [-47,-2,60]) {
      const [ey, em, ed] = easter.split("-").map(Number);
      const day = new Date(Date.UTC(ey, em - 1, ed + offset));
      holidays.add(`${day.getUTCFullYear()}-${String(day.getUTCMonth()+1).padStart(2,"0")}-${String(day.getUTCDate()).padStart(2,"0")}`);
    }
    holidays.add(`${year}-04-23`); // São Jorge, feriado estadual do RJ
  }
  return holidays;
}
function isBusinessDayKey(key, holidays) {
  const [y,m,d] = key.split("-").map(Number);
  const weekday = new Date(Date.UTC(y,m-1,d)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(key);
}
function nextBusinessInstant(date, holidays) {
  const p = localParts(date);
  let key = keyFromParts(p);
  while (!isBusinessDayKey(key, holidays)) key = addCalendarDays(key, 1);
  return parseLocalDateTime(key, `${p.hour}:${p.minute}`);
}
function businessElapsedMs(from, to, holidays) {
  if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return 0;
  let total = 0;
  let cursor = new Date(from);
  while (cursor < to) {
    const key = keyFromParts(localParts(cursor));
    const nextMidnight = parseLocalDateTime(addCalendarDays(key, 1), "00:00");
    const segmentEnd = nextMidnight < to ? nextMidnight : to;
    if (isBusinessDayKey(key, holidays)) total += Math.max(0, segmentEnd.getTime() - cursor.getTime());
    cursor = segmentEnd;
  }
  return total;
}
function deadlineData(order, now) {
  const rawStart = parseLocalDateTime(order.entry, order.entryTime || "00:00");
  const rawEnd = parseLocalDateTime(order.due, order.dueTime || "00:00");
  if (!rawStart || !rawEnd) return null;
  const years = [rawStart.getUTCFullYear(), rawEnd.getUTCFullYear(), now.getUTCFullYear()];
  const holidays = holidaySet(Array.from({length: Math.max(...years)-Math.min(...years)+1}, (_,i)=>Math.min(...years)+i));
  const start = nextBusinessInstant(rawStart, holidays);
  const end = nextBusinessInstant(rawEnd, holidays);
  if (end <= start) return null;
  const total = businessElapsedMs(start, end, holidays);
  const effectiveNow = order.status === "pending" && order.pausedAt ? new Date(order.pausedAt) : now;
  const elapsed = Math.max(0, businessElapsedMs(start, effectiveNow, holidays) - Number(order.pausedBusinessMs || 0));
  return { remainingMs: total - elapsed };
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function formatDate(date, time) {
  if (!date) return "não informado";
  const [y,m,d] = String(date).slice(0,10).split("-");
  return `${d}/${m}/${y}${time ? " às " + time : ""}`;
}
function dueKey(order) { return `${order.due || ""}T${order.dueTime || "00:00"}`; }

exports.sendDeadlineReminders = onSchedule({
  schedule: "every 15 minutes",
  timeZone: TZ,
  region: "us-central1",
  maxInstances: 1,
  secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM]
}, async () => {
  const snapshot = await firestore.doc("sistema/controle_ordens_servico").get();
  if (!snapshot.exists) {
    logger.info("Documento principal do Controle OS não existe.");
    return;
  }
  const data = snapshot.data() || {};
  const operators = Array.isArray(data.operators) ? data.operators : [];
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const now = new Date();
  const port = Number(SMTP_PORT.value() || 587);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
  });
  let sent = 0, skipped = 0;

  for (const order of orders) {
    if (order.status !== "active" || !order.operatorId || !order.id) { skipped++; continue; }
    const operator = operators.find(o => String(o.id) === String(order.operatorId));
    const email = String(operator?.email || "").trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }

    const timing = deadlineData(order, now);
    if (!timing || timing.remainingMs <= 0 || timing.remainingMs > REMINDER_WINDOW_MS) { skipped++; continue; }

    const reminderId = encodeURIComponent(String(order.id)).replace(/%/g, "_");
    const reminderRef = firestore.collection("deadlineReminders").doc(reminderId);
    const due = dueKey(order);
    const previous = await reminderRef.get();
    if (previous.exists && previous.data()?.dueKey === due) { skipped++; continue; }

    const remainingHours = Math.max(1, Math.ceil(timing.remainingMs / HOUR_MS));
    const subject = `Prazo próximo: OS ${order.number || order.id} — faltam até 24 horas`;
    const textBody = [
      `Olá, ${operator.name || "operador"}!`,
      "",
      `A ordem de serviço ${order.number || order.id} está próxima do vencimento.`,
      `Serviço: ${order.title || "não informado"}`,
      `Prazo final: ${formatDate(order.due, order.dueTime)}`,
      `Tempo efetivo restante estimado: até ${remainingHours} hora(s).`,
      "",
      "Por favor, verifique o andamento e conclua a OS dentro do prazo.",
      "",
      "Aviso automático do Controle de Ordens de Serviço."
    ].join("\n");
    const htmlBody = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172b4d;max-width:620px;margin:auto"><h2 style="color:#006b43">Aviso de vencimento próximo</h2><p>Olá, ${escapeHtml(operator.name || "operador")}!</p><p>A ordem de serviço está próxima do vencimento.</p><div style="padding:16px;background:#f2f7f5;border-radius:10px"><p><strong>OS:</strong> ${escapeHtml(order.number || order.id)}</p><p><strong>Serviço:</strong> ${escapeHtml(order.title || "não informado")}</p><p><strong>Prazo final:</strong> ${escapeHtml(formatDate(order.due, order.dueTime))}</p><p><strong>Tempo efetivo restante estimado:</strong> até ${remainingHours} hora(s)</p></div><p>Por favor, verifique o andamento e conclua a OS dentro do prazo.</p><hr><small>Aviso automático do Controle de Ordens de Serviço.</small></div>`;

    await transporter.sendMail({ from: SMTP_FROM.value(), to: email, subject, text: textBody, html: htmlBody });
    await reminderRef.set({
      orderId: String(order.id), orderNumber: String(order.number || ""),
      operatorId: String(order.operatorId), recipient: email, dueKey: due,
      sentAt: FieldValue.serverTimestamp()
    });
    sent++;
    logger.info("Alerta de prazo enviado.", {orderId: String(order.id), recipient: email});
  }
  logger.info("Verificação de prazos concluída.", {sent, skipped});
});
