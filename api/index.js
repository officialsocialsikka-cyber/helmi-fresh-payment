
import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

// ==================================================
// HELMI FRESH SETTINGS
// ==================================================

const PAYMENT_AMOUNT = 500; // ₹5 in paise
const PAYMENT_TIMER_SECONDS = 120;
const QR_CLOSE_BY_SECONDS = 960;

// ==================================================
// SEND JSON
// ==================================================

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.end(JSON.stringify(data));
}

// ==================================================
// RAZORPAY AUTH
// ==================================================

function razorpayAuth() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("Razorpay API credentials are not configured");
  }

  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

// ==================================================
// READ RAW BODY
// ==================================================

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

// ==================================================
// RAZORPAY API REQUEST
// ==================================================

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

  const response = await fetch(`https://api.razorpay.com${path}`, options);
  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return { response, data };
}

// ==================================================
// SMALL DELAY
// ==================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================================================
// MAIN HANDLER
// ==================================================

export default async function handler(req, res) {
  try {
    // ==================================================
    // HEALTH CHECK
    // ==================================================

    if (req.method === "GET" && !req.query?.action) {
      return sendJson(res, 200, {
        status: "online",
        service: "HELMI FRESH UPI QR Payment Server",
      });
    }

    // ==================================================
    // CREATE DIRECT UPI QR
    // ==================================================

    if (
      req.method === "POST" &&
      req.headers["x-helmi-action"] === "create-payment"
    ) {
      const referenceId = `HELMI-${Date.now()}`;
      const closeBy = Math.floor(Date.now() / 1000) + QR_CLOSE_BY_SECONDS;

      const createResult = await razorpayRequest(
        "/v1/payments/qr_codes",
        "POST",
        {
          type: "upi_qr",
          name: "HELMI FRESH",
          usage: "single_use",
          fixed_amount: true,
          payment_amount: PAYMENT_AMOUNT,
          description: "HELMI FRESH Helmet Sanitization",
          close_by: closeBy,
          notes: {
            reference_id: referenceId,
            purpose: "Helmet Sanitization",
          },
        }
      );

      console.log("Razorpay CREATE HTTP:", createResult.response.status);
      console.log("Razorpay CREATE RESPONSE:", createResult.data);

      if (!createResult.response.ok) {
        return sendJson(res, createResult.response.status, {
          success: false,
          error:
            createResult.data?.error?.description ||
            createResult.data?.raw ||
            "Razorpay QR creation failed",
        });
      }

      const qr = createResult.data;
      const qrId = qr?.id;

      if (!qrId) {
        console.error("QR ID missing");

        return sendJson(res, 500, {
          success: false,
          error: "Razorpay QR ID missing",
        });
      }

      console.log("QR CREATED:", qrId);

      // ==================================================
      // GET DIRECT UPI PAYLOAD
      // ==================================================

      let upiUrl = qr?.image_content || "";

      if (!upiUrl.startsWith("upi://pay")) {
        console.log("Starting QR FETCH retries...");

        for (let attempt = 1; attempt <= 5; attempt++) {
          console.log(`QR FETCH attempt ${attempt}/5`);

          await sleep(1500);

          const fetchResult = await razorpayRequest(
            `/v1/payments/qr_codes/${encodeURIComponent(qrId)}`,
            "GET"
          );

          console.log("QR FETCH HTTP:", fetchResult.response.status);

          if (
            fetchResult.response.ok &&
            fetchResult.data?.image_content &&
            fetchResult.data.image_content.startsWith("upi://pay")
          ) {
            upiUrl = fetchResult.data.image_content;
            console.log("DIRECT UPI PAYLOAD FOUND");
            break;
          }
        }
      }

      if (!upiUrl || !upiUrl.startsWith("upi://pay")) {
        console.error("DIRECT UPI PAYLOAD NOT FOUND");

        return sendJson(res, 500, {
          success: false,
          error: "QR was created but direct UPI payload was not available",
          qr_id: qrId,
          image_url: qr?.image_url || null,
        });
      }

      return sendJson(res, 200, {
        success: true,
        amount: PAYMENT_AMOUNT / 100,
        qr_id: qrId,
        upi_url: upiUrl,
        status: qr.status || "active",
        payment_timer_seconds: PAYMENT_TIMER_SECONDS,
        razorpay_qr_close_by: qr.close_by || closeBy,
        reference_id: referenceId,
      });
    }

    // ==================================================
    // CHECK QR PAYMENT STATUS
    // ==================================================

    if (
      req.method === "GET" &&
      req.query?.action === "status"
    ) {
      const qrId = req.query.qr_id;

      if (!qrId) {
        return sendJson(res, 400, {
          success: false,
          error: "qr_id is required",
        });
      }

      const result = await razorpayRequest(
        `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/payments?count=100`,
        "GET"
      );

      console.log("QR PAYMENT STATUS HTTP:", result.response.status);

      if (!result.response.ok) {
        return sendJson(res, result.response.status, {
          success: false,
          error:
            result.data?.error?.description ||
            result.data?.raw ||
            "Unable to check QR payment status",
        });
      }

      const items = Array.isArray(result.data?.items)
        ? result.data.items
        : [];

      const paidPayment = items.find(
        payment =>
          payment.status === "captured" &&
          Number(payment.amount) === PAYMENT_AMOUNT
      );

      if (paidPayment) {
        console.log("PAYMENT CAPTURED:", paidPayment.id);

        return sendJson(res, 200, {
          success: true,
          paid: true,
          qr_id: qrId,
          payment_id: paidPayment.id,
          amount: paidPayment.amount,
          status: paidPayment.status,
          method: paidPayment.method,
          created_at: paidPayment.created_at,
        });
      }

      return sendJson(res, 200, {
        success: true,
        paid: false,
        qr_id: qrId,
        status: "pending",
      });
    }

    // ==================================================
    // CLOSE QR
    // ==================================================

    if (
      req.method === "POST" &&
      req.headers["x-helmi-action"] === "cancel-payment"
    ) {
      const qrId = req.query.qr_id;

      if (!qrId) {
        return sendJson(res, 400, {
          success: false,
          error: "qr_id is required",
        });
      }

      const result = await razorpayRequest(
        `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/close`,
        "POST",
        {}
      );

      console.log("QR CLOSE HTTP:", result.response.status);

      if (!result.response.ok) {
        return sendJson(res, result.response.status, {
          success: false,
          error:
            result.data?.error?.description ||
            result.data?.raw ||
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

    // ==================================================
    // RAZORPAY WEBHOOK + HOSTINGER DATABASE FORWARDING
    // ==================================================

    if (req.method === "POST") {
      console.log("[DEBUG] Webhook POST reached");

      const rawBody = await readRawBody(req);
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.headers["x-razorpay-signature"];

      if (!webhookSecret || typeof signature !== "string") {
        console.error("[DEBUG] Webhook secret/signature missing");

        return sendJson(res, 401, {
          success: false,
          error: "Webhook authentication failed",
        });
      }

      // Verify Razorpay signature against the exact raw request body.
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      const received = Buffer.from(signature, "utf8");
      const expected = Buffer.from(expectedSignature, "utf8");

      if (
        received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)
      ) {
        console.error("[DEBUG] Invalid webhook signature");

        return sendJson(res, 401, {
          success: false,
          error: "Invalid webhook signature",
        });
      }

      let event;

      try {
        event = JSON.parse(rawBody.toString("utf8"));
      } catch {
        console.error("[DEBUG] Invalid webhook JSON");

        return sendJson(res, 400, {
          success: false,
          error: "Invalid webhook JSON",
        });
      }

      console.log("[DEBUG] Verified event:", event.event);

      let qrId = null;
      let payment = null;

      // --------------------------------------------------
      // EVENT: payment.captured
      // --------------------------------------------------

      if (event.event === "payment.captured") {
        payment = event.payload?.payment?.entity || null;
        qrId = payment?.qr_code_id || null;

        // If the webhook does not include QR ID, fetch
        // the payment details from Razorpay.
        if (payment?.id && !qrId) {
          console.log("[DEBUG] Fetching full payment details");

          const paymentResult = await razorpayRequest(
            `/v1/payments/${encodeURIComponent(payment.id)}`,
            "GET"
          );

          console.log(
            "[DEBUG] Payment details API HTTP:",
            paymentResult.response.status
          );

          if (paymentResult.response.ok) {
            payment = paymentResult.data;
            qrId = payment?.qr_code_id || null;
          }
        }
      }

      // --------------------------------------------------
      // EVENT: qr_code.credited
      // --------------------------------------------------

      if (event.event === "qr_code.credited") {
        const qrEntity = event.payload?.qr_code?.entity;

        qrId =
          qrEntity?.id ||
          event.payload?.qr_code?.id ||
          null;

        console.log("[DEBUG] QR credited; QR ID present:", Boolean(qrId));

        if (qrId) {
          const qrPaymentsResult = await razorpayRequest(
            `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/payments?count=100`,
            "GET"
          );

          console.log(
            "[DEBUG] QR payments API HTTP:",
            qrPaymentsResult.response.status
          );

          if (!qrPaymentsResult.response.ok) {
            console.error("[DEBUG] Failed to retrieve QR payments");

            return sendJson(res, 502, {
              success: false,
              error: "Unable to retrieve QR payments",
            });
          }

          const items = Array.isArray(qrPaymentsResult.data?.items)
            ? qrPaymentsResult.data.items
            : [];

          payment =
            items.find(
              item =>
                item.status === "captured" &&
                Number(item.amount) === PAYMENT_AMOUNT
            ) || null;
        }
      }

      // Ignore unrelated events.
      if (
        event.event !== "payment.captured" &&
        event.event !== "qr_code.credited"
      ) {
        console.log("[DEBUG] Event ignored:", event.event);

        return sendJson(res, 200, {
          received: true,
          verified: true,
          ignored: true,
        });
      }

      // Only accept a captured payment of exactly ₹5.
      if (
        !payment ||
        payment.status !== "captured" ||
        Number(payment.amount) !== PAYMENT_AMOUNT
      ) {
        console.log("[DEBUG] Captured ₹5 payment not found");

        return sendJson(res, 200, {
          received: true,
          verified: true,
          forwarded: false,
          reason: "Captured ₹5 payment not found",
        });
      }

      const paymentId = payment.id;
      const eventSecret = process.env.HELMI_EVENT_SECRET;

      console.log("[DEBUG] Payment ID present:", Boolean(paymentId));
      console.log("[DEBUG] QR ID present:", Boolean(qrId));

      if (!qrId || !paymentId) {
        console.error("[DEBUG] QR ID or payment ID missing after lookup");

        return sendJson(res, 200, {
          received: true,
          verified: true,
          forwarded: false,
          reason: "QR ID or payment ID missing after lookup",
        });
      }

      if (!eventSecret) {
        console.error("[DEBUG] HELMI_EVENT_SECRET is not configured");

        return sendJson(res, 500, {
          success: false,
          error: "Event secret is not configured",
        });
      }

      // --------------------------------------------------
      // FORWARD PAYMENT TO HOSTINGER
      // --------------------------------------------------

      console.log("[DEBUG] Forwarding payment to Hostinger");

      const hostingerResponse = await fetch(
        "https://helmifresh.in/api/payment-event.php",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Helmi-Event-Secret": eventSecret,
          },
          body: JSON.stringify({
            qr_id: qrId,
            payment_id: paymentId,
            amount: payment.amount,
            status: payment.status,
            event_id: event.id || "",
          }),
        }
      );

      const responseText = await hostingerResponse.text();

      console.log(
        "[DEBUG] Hostinger payment event HTTP:",
        hostingerResponse.status
      );

      if (!hostingerResponse.ok) {
        console.error("[DEBUG] Hostinger payment event failed");

        return sendJson(res, 502, {
          success: false,
          error: "Hostinger payment event failed",
        });
      }

      let hostingerData;

      try {
        hostingerData = JSON.parse(responseText);
      } catch {
        hostingerData = null;
      }

      if (!hostingerData?.success || !hostingerData?.saved) {
        console.error("[DEBUG] Hostinger did not confirm database save");

        return sendJson(res, 502, {
          success: false,
          error: "Hostinger did not confirm database save",
        });
      }

      console.log("[DEBUG] Hostinger payment record saved");

      return sendJson(res, 200, {
        received: true,
        verified: true,
        forwarded: true,
        saved: true,
      });
    }

    // ==================================================
    // METHOD NOT ALLOWED
    // ==================================================

    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed",
    });

  } catch (error) {
    console.error("HELMI FRESH PAYMENT ERROR:", error);

    return sendJson(res, 500, {
      success: false,
      error: error?.message || "Internal server error",
    });
  }
}
