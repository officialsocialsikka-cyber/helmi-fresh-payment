
import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const DEVICE_ID = process.env.HELMI_DEVICE_ID || "HF-WROOM-01";
const PAYMENT_TIMER_SECONDS = 120;
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
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function razorpayAuth() {
  const keyId = requiredEnv("RAZORPAY_KEY_ID");
  const keySecret = requiredEnv("RAZORPAY_KEY_SECRET");

  return (
    "Basic " +
    Buffer.from(`${keyId}:${keySecret}`).toString("base64")
  );
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
      Authorization: razorpayAuth(),
      "Content-Type": "application/json",
    },
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

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

// Hostinger server-to-server bridge
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
      ...(body
        ? { body: JSON.stringify({ action, ...body }) }
        : {}),
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

// Read the current amount from Admin Panel
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

// Read immutable amount saved for a QR
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
    !Number.isSafeInteger(
      Number(session.expected_amount_paise)
    ) ||
    Number(session.expected_amount_paise) <= 0
  ) {
    throw new Error("QR session data is invalid");
  }

  return {
    ...session,
    expected_amount_paise: Number(
      session.expected_amount_paise
    ),
  };
}

// Save only a captured payment matching the QR session
async function savePaymentToHostinger({
  qrId,
  payment,
  eventId = "",
}) {
  if (
    !qrId ||
    !payment?.id ||
    payment.status !== "captured"
  ) {
    return {
      saved: false,
      error: "Payment is not captured",
    };
  }

  const session = await getQrSession(qrId);

  if (
    Number(payment.amount) !==
      session.expected_amount_paise ||
    (payment.currency && payment.currency !== "INR")
  ) {
    return {
      saved: false,
      error: "Payment amount does not match QR session",
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
        event_id:
          eventId || `status-poll:${qrId}:${payment.id}`,
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

async function closeRazorpayQr(qrId) {
  try {
    await razorpayRequest(
      `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/close`,
      "POST",
      {}
    );
  } catch (error) {
    console.error("QR close request failed:", error);
  }
}

// Create QR using Admin Panel amount
async function createPayment(res) {
  const cfg = await getCurrentConfig();

  const closeBy =
    Math.floor(Date.now() / 1000) + QR_CLOSE_BY_SECONDS;

  const referenceId = `HELMI-${Date.now()}`;

  const created = await razorpayRequest(
    "/v1/payments/qr_codes",
    "POST",
    {
      type: "upi_qr",
      name: "HELMI FRESH",
      usage: "single_use",
      fixed_amount: true,
      payment_amount: cfg.amountPaise,
      description: "HELMI FRESH Helmet Sanitization",
      close_by: closeBy,
      notes: {
        reference_id: referenceId,
        purpose: "Helmet Sanitization",
        device_id: cfg.deviceId,
        config_version: String(cfg.configVersion),
      },
    }
  );

  if (!created.response.ok) {
    return sendJson(res, created.response.status, {
      success: false,
      error:
        created.data?.error?.description ||
        "Razorpay QR creation failed",
    });
  }

  const qr = created.data;
  const qrId = qr?.id;

  if (
    typeof qrId !== "string" ||
    !/^qr_[A-Za-z0-9]+$/.test(qrId)
  ) {
    return sendJson(res, 502, {
      success: false,
      error: "Razorpay returned invalid QR ID",
    });
  }

  let upiUrl = qr.image_content || "";

  if (!upiUrl.startsWith("upi://pay")) {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1200)
      );

      const fetched = await razorpayRequest(
        `/v1/payments/qr_codes/${encodeURIComponent(qrId)}`,
        "GET"
      );

      if (
        fetched.response.ok &&
        fetched.data?.image_content?.startsWith("upi://pay")
      ) {
        upiUrl = fetched.data.image_content;
        break;
      }
    }
  }

  if (!upiUrl.startsWith("upi://pay")) {
    await closeRazorpayQr(qrId);

    return sendJson(res, 502, {
      success: false,
      error: "UPI payload unavailable; QR was closed",
    });
  }

  // Save the immutable QR amount/version snapshot
  try {
    await bridgeRequest("create_session", {
      method: "POST",
      body: {
        qr_id: qrId,
        device_id: cfg.deviceId,
        amount_paise: cfg.amountPaise,
        config_version: cfg.configVersion,
        expires_at: expiryLocalString(closeBy),
      },
    });
  } catch (error) {
    await closeRazorpayQr(qrId);
    console.error("QR session registration failed:", error);

    return sendJson(res, 409, {
      success: false,
      error:
        "QR session registration failed. QR was closed; please retry.",
    });
  }

  return sendJson(res, 200, {
    success: true,
    amount: cfg.amountPaise / 100,
    amount_paise: cfg.amountPaise,
    currency: "INR",
    config_version: cfg.configVersion,
    qr_id: qrId,
    upi_url: upiUrl,
    status: qr.status || "active",
    payment_timer_seconds: PAYMENT_TIMER_SECONDS,
    razorpay_qr_close_by: qr.close_by || closeBy,
    reference_id: referenceId,
  });
}

// Check payment status using this QR's saved amount
async function checkStatus(res, qrId) {
  if (
    typeof qrId !== "string" ||
    !/^qr_[A-Za-z0-9]+$/.test(qrId)
  ) {
    return sendJson(res, 400, {
      success: false,
      error: "A valid qr_id is required",
    });
  }

  const session = await getQrSession(qrId);

  const result = await razorpayRequest(
    `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/payments?count=10`,
    "GET"
  );

  if (!result.response.ok) {
    return sendJson(res, result.response.status, {
      success: false,
      error:
        result.data?.error?.description ||
        "Unable to check QR payment status",
    });
  }

  const items = Array.isArray(result.data?.items)
    ? result.data.items
    : [];

  const paid = items.find(
    (payment) =>
      payment.status === "captured" &&
      Number(payment.amount) ===
        session.expected_amount_paise &&
      (!payment.currency || payment.currency === "INR")
  );

  if (!paid) {
    return sendJson(res, 200, {
      success: true,
      paid: false,
      qr_id: qrId,
      status: "pending",
    });
  }

  const saved = await savePaymentToHostinger({
    qrId,
    payment: paid,
    eventId: `status-poll:${qrId}:${paid.id}`,
  });

  return sendJson(res, saved.saved ? 200 : 502, {
    success: saved.saved,
    paid: true,
    saved: saved.saved,
    save_error: saved.saved ? undefined : saved.error,
    qr_id: qrId,
    payment_id: paid.id,
    amount: paid.amount,
    status: paid.status,
    method: paid.method,
    created_at: paid.created_at,
  });
}

// Recover an existing captured payment
async function recoverPayment(res, paymentId) {
  if (
    typeof paymentId !== "string" ||
    !/^pay_[A-Za-z0-9]+$/.test(paymentId)
  ) {
    return sendJson(res, 400, {
      success: false,
      error: "Valid payment_id is required",
    });
  }

  const pResult = await razorpayRequest(
    `/v1/payments/${encodeURIComponent(paymentId)}`,
    "GET"
  );

  if (!pResult.response.ok) {
    return sendJson(res, pResult.response.status, {
      success: false,
      error:
        pResult.data?.error?.description ||
        "Unable to fetch payment",
    });
  }

  const payment = pResult.data;

  if (payment.status !== "captured") {
    return sendJson(res, 400, {
      success: false,
      error: "Payment is not captured",
      payment_id: payment.id,
      status: payment.status,
    });
  }

  const qResult = await razorpayRequest(
    `/v1/payments/qr_codes?payment_id=${encodeURIComponent(paymentId)}`,
    "GET"
  );

  if (!qResult.response.ok) {
    return sendJson(res, qResult.response.status, {
      success: false,
      error: "Unable to find QR associated with payment",
    });
  }

  const qrs = Array.isArray(qResult.data?.items)
    ? qResult.data.items
    : [];

  const qrId =
    payment.qr_code_id ||
    qrs.find((item) => item?.id)?.id;

  if (!qrId) {
    return sendJson(res, 404, {
      success: false,
      error: "No QR ID associated with payment; nothing saved",
    });
  }

  let saved;

  try {
    saved = await savePaymentToHostinger({
      qrId,
      payment,
      eventId: `manual-recovery:${payment.id}`,
    });
  } catch (error) {
    console.error("Recovery failed:", error);

    saved = {
      saved: false,
      error: "Payment session verification or Hostinger save failed",
    };
  }

  return sendJson(res, saved.saved ? 200 : 409, {
    success: saved.saved,
    paid: true,
    saved: saved.saved,
    save_error: saved.saved ? undefined : saved.error,
    qr_id: qrId,
    payment_id: payment.id,
    amount: payment.amount,
    status: payment.status,
  });
}

// Razorpay webhook
async function webhook(req, res) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    );
  }

  const raw = Buffer.concat(chunks);
  const secret = requiredEnv("RAZORPAY_WEBHOOK_SECRET");
  const signature = req.headers["x-razorpay-signature"];

  if (typeof signature !== "string") {
    return sendJson(res, 401, {
      success: false,
      error: "Webhook authentication failed",
    });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest("hex");

  const receivedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    )
  ) {
    return sendJson(res, 401, {
      success: false,
      error: "Invalid webhook signature",
    });
  }

  let event;

  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return sendJson(res, 400, {
      success: false,
      error: "Invalid webhook JSON",
    });
  }

  let qrId = null;
  let payment = null;

  if (event.event === "payment.captured") {
    payment = event.payload?.payment?.entity || null;
    qrId = payment?.qr_code_id || null;
  } else if (event.event === "qr_code.credited") {
    const qr = event.payload?.qr_code?.entity;

    qrId =
      qr?.id ||
      event.payload?.qr_code?.id ||
      null;

    if (qrId) {
      const result = await razorpayRequest(
        `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/payments?count=10`,
        "GET"
      );

      if (!result.response.ok) {
        return sendJson(res, 502, {
          received: true,
          verified: true,
          error: "Unable to retrieve QR payments",
        });
      }

      const items = Array.isArray(result.data?.items)
        ? result.data.items
        : [];

      const session = await getQrSession(qrId);

      payment = items.find(
        (item) =>
          item.status === "captured" &&
          Number(item.amount) ===
            session.expected_amount_paise &&
          (!item.currency || item.currency === "INR")
      ) || null;
    }
  } else {
    return sendJson(res, 200, {
      received: true,
      verified: true,
      ignored: true,
    });
  }

  if (!qrId || !payment) {
    return sendJson(res, 200, {
      received: true,
      verified: true,
      forwarded: false,
      reason: "No matching captured payment or QR session",
    });
  }

  try {
    const saved = await savePaymentToHostinger({
      qrId,
      payment,
      eventId: event.id || "",
    });

    if (!saved.saved) {
      return sendJson(res, 502, {
        received: true,
        verified: true,
        forwarded: false,
        error: saved.error,
      });
    }

    return sendJson(res, 200, {
      received: true,
      verified: true,
      forwarded: true,
      saved: true,
    });
  } catch (error) {
    console.error("Webhook Hostinger save failed:", error);

    return sendJson(res, 502, {
      received: true,
      verified: true,
      forwarded: false,
      error: "Hostinger payment save failed",
    });
  }
}

// Main Vercel handler
export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Helmi-Action"
      );
      return res.end();
    }

    // Health check
    if (req.method === "GET" && !req.query?.action) {
      return sendJson(res, 200, {
        status: "online",
        service: "HELMI FRESH UPI QR Payment Server",
      });
    }

    // Create QR
    if (
      req.method === "POST" &&
      req.headers["x-helmi-action"] === "create-payment"
    ) {
      return await createPayment(res);
    }

    // Check QR payment
    if (
      req.method === "GET" &&
      req.query?.action === "status"
    ) {
      return await checkStatus(res, req.query.qr_id);
    }

    // Recover payment
    if (
      req.method === "GET" &&
      req.query?.action === "recover-payment"
    ) {
      return await recoverPayment(
        res,
        req.query.payment_id
      );
    }

    // Close QR
    if (
      req.method === "POST" &&
      req.headers["x-helmi-action"] === "cancel-payment"
    ) {
      const qrId = req.query?.qr_id;

      if (
        typeof qrId !== "string" ||
        !/^qr_[A-Za-z0-9]+$/.test(qrId)
      ) {
        return sendJson(res, 400, {
          success: false,
          error: "A valid qr_id is required",
        });
      }

      const result = await razorpayRequest(
        `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/close`,
        "POST",
        {}
      );

      if (!result.response.ok) {
        return sendJson(res, result.response.status, {
          success: false,
          error:
            result.data?.error?.description ||
            "QR close failed",
        });
      }

      return sendJson(res, 200, {
        success: true,
        qr_id: result.data.id,
        status: result.data.status,
        closed_at: result.data.closed_at,
        close_reason: result.data.close_reason,
      });
    }

    // Razorpay webhook
    if (req.method === "POST") {
      return await webhook(req, res);
    }

    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed",
    });
  } catch (error) {
    console.error("HELMI FRESH PAYMENT ERROR:", error);

    return sendJson(res, 500, {
      success: false,
      error: "Internal server error",
    });
  }
}
