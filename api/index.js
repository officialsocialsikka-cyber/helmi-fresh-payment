import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const DEVICE_ID = process.env.HELMI_DEVICE_ID || "HF-WROOM-01";
const PAYMENT_TIMER_SECONDS = 120;
const PAYMENT_GRACE_SECONDS = 30;
const QR_CLOSE_BY_SECONDS = 960;
const RAZORPAY_TIMEOUT_MS = 7000;
const HOSTINGER_TIMEOUT_MS = 5000;

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Helmi-Action"
  );
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.end(JSON.stringify(data));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function razorpayAuth() {
  try {
    const result = await bridgeRequest("credentials");
    const keyId = result.credentials?.key_id;
    const keySecret = result.credentials?.key_secret;

    if (
      typeof keyId === "string" &&
      keyId &&
      typeof keySecret === "string" &&
      keySecret
    ) {
      return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    }
  } catch {
    console.warn(
      "Admin Razorpay credentials unavailable; using Vercel fallback."
    );
  }

  const keyId = requiredEnv("RAZORPAY_KEY_ID");
  const keySecret = requiredEnv("RAZORPAY_KEY_SECRET");
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

async function fetchTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function razorpayRequest(path, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      Authorization: await razorpayAuth(),
      "Content-Type": "application/json",
    },
  };

  if (body !== null) options.body = JSON.stringify(body);

  const response = await fetchTimeout(
    `https://api.razorpay.com${path}`,
    options,
    RAZORPAY_TIMEOUT_MS
  );

  const raw = await response.text();
  let data = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  return { response, data };
}

async function bridgeRequest(
  action,
  { method = "GET", query = {}, body = null } = {}
) {
  const base = requiredEnv("HELMI_PAYMENT_BRIDGE_URL");
  const secret = requiredEnv("HELMI_CONFIG_SECRET");
  const url = new URL(base);

  if (method === "GET") {
    url.searchParams.set("action", action);

    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchTimeout(
    url.toString(),
    {
      method,
      headers: {
        "X-Helmi-Config-Secret": secret,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify({ action, ...body }) } : {}),
    },
    HOSTINGER_TIMEOUT_MS
  );

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Hostinger bridge returned invalid JSON");
  }

  if (!response.ok || !data.success) {
    throw new Error(
      data.error || `Hostinger bridge HTTP ${response.status}`
    );
  }

  return data;
}

async function getCurrentConfig() {
  const result = await bridgeRequest("config", {
    query: {
      device_id: DEVICE_ID,
    },
  });

  const amount = Number(result.payment?.amount_paise);
  const version = Number(result.config_version);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Admin Panel payment amount is invalid");
  }

  if (result.payment?.currency !== "INR") {
    throw new Error("Only INR payments are supported");
  }

  if (result.payment?.gateway_enabled !== true) {
    throw new Error("Payment gateway is disabled in Admin Panel");
  }

  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("Admin configuration version is invalid");
  }

  return {
    amountPaise: amount,
    configVersion: version,
    deviceId: result.device_id,
  };
}

function expiryLocalString(unixSeconds) {
  const d = new Date(unixSeconds * 1000 + 330 * 60 * 1000);

  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")} ` +
    `${String(d.getUTCHours()).padStart(2, "0")}:` +
    `${String(d.getUTCMinutes()).padStart(2, "0")}:` +
    `${String(d.getUTCSeconds()).padStart(2, "0")}`
  );
}

function expiryEpochFromSession(session) {
  const value = String(session?.expires_at || "");
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  );

  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;

  return (
    Math.floor(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000) -
    330 * 60
  );
}

function paymentOccurredBeforeExpiry(payment, session) {
  const createdAt = Number(payment?.created_at);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return false;

  const expiryEpoch = expiryEpochFromSession(session);
  if (!Number.isSafeInteger(expiryEpoch)) return false;

  return createdAt <= expiryEpoch + PAYMENT_GRACE_SECONDS;
}

function sessionGraceExpired(session) {
  const expiryEpoch = expiryEpochFromSession(session);
  if (!Number.isSafeInteger(expiryEpoch)) return true;

  return (
    Math.floor(Date.now() / 1000) >=
    expiryEpoch + PAYMENT_GRACE_SECONDS
  );
}

async function getQrSession(qrId) {
  const result = await bridgeRequest("session", {
    query: {
      qr_id: qrId,
    },
  });

  const session = result.session;

  if (
    !session ||
    session.qr_id !== qrId ||
    session.currency !== "INR" ||
    !Number.isSafeInteger(Number(session.expected_amount_paise)) ||
    Number(session.expected_amount_paise) <= 0
  ) {
    throw new Error("QR session data is invalid");
  }

  return {
    ...session,
    expected_amount_paise: Number(session.expected_amount_paise),
  };
}

async function savePaymentToHostinger({
  qrId,
  payment,
  eventId = "",
}) {
  if (!qrId || !payment?.id || payment.status !== "captured") {
    return {
      saved: false,
      error: "Payment is not captured",
    };
  }

  const session = await getQrSession(qrId);

  if (
    Number(payment.amount) !== session.expected_amount_paise ||
    (payment.currency && payment.currency !== "INR")
  ) {
    return {
      saved: false,
      error: "Payment amount does not match QR session",
    };
  }

  if (!paymentOccurredBeforeExpiry(payment, session)) {
    return {
      saved: false,
      expired: true,
      error: "Payment was captured after QR expiry grace period",
    };
  }

  const eventSecret = requiredEnv("HELMI_EVENT_SECRET");

  const response = await fetchTimeout(
    "https://helmifresh.in/api/payment-event-dynamic.php",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Helmi-Event-Secret": eventSecret,
      },
      body: JSON.stringify({
        qr_id: qrId,
        payment_id: payment.id,
        amount: Number(payment.amount),
        status: payment.status,
        payment_created_at: Number(payment.created_at),
        event_id: eventId || `status-poll:${qrId}:${payment.id}`,
      }),
    },
    HOSTINGER_TIMEOUT_MS
  );

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok || !data?.success || !data?.saved) {
    return {
      saved: false,
      error:
        data?.error ||
        `Hostinger event endpoint HTTP ${response.status}`,
    };
  }

  return { saved: true };
}
