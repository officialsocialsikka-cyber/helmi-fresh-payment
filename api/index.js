
import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const PAYMENT_AMOUNT = 500; // ₹5 in paise
const PAYMENT_TIMER_SECONDS = 120;
const QR_CLOSE_BY_SECONDS = 960;

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.end(JSON.stringify(data));
}

function razorpayAuth() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("Razorpay API credentials are not configured");
  }

  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Save a verified captured payment to Hostinger.
// Called by the status endpoint and the webhook.
async function savePaymentToHostinger({ qrId, payment, eventId = "" }) {
  if (!qrId || !payment?.id) {
    return { saved: false, error: "QR ID or payment ID is missing" };
  }

  if (
    payment.status !== "captured" ||
    Number(payment.amount) !== PAYMENT_AMOUNT
  ) {
    return {
      saved: false,
      error: "Payment is not a captured ₹5 payment",
    };
  }

  const eventSecret = process.env.HELMI_EVENT_SECRET;

  if (!eventSecret) {
    return {
      saved: false,
      error: "HELMI_EVENT_SECRET is not configured",
    };
  }

  const response = await fetch(
    "https://helmifresh.in/api/payment-event.php",
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
        event_id: eventId || `status-poll:${qrId}:${payment.id}`,
      }),
    }
  );

  const responseText = await response.text();

  let data = null;

  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = null;
  }

  console.log("[DEBUG] Hostinger payment event HTTP:", response.status);

  if (!response.ok || !data?.success || !data?.saved) {
    console.error(
      "[DEBUG] Hostinger payment save failed:",
      response.status,
      responseText
    );

    return {
      saved: false,
      error: data?.error || "Hostinger did not confirm database save",
    };
  }

  console.log("[DEBUG] Hostinger payment record saved:", payment.id);

  return { saved: true };
}

export default async function handler(req, res) {
  try {
    // HEALTH CHECK
    if (req.method === "GET" && !req.query?.action) {
      return sendJson(res, 200, {
        status: "online",
        service: "HELMI FRESH UPI QR Payment Server",
      });
    }

    // CREATE QR PAYMENT
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
        return sendJson(res, 500, {
          success: false,
          error: "Razorpay QR ID missing",
        });
      }

      console.log("QR CREATED:", qrId);

      let upiUrl = qr?.image_content || "";

      if (!upiUrl.startsWith("upi://pay")) {
        for (let attempt = 1; attempt <= 5; attempt++) {
          console.log(`QR FETCH attempt ${attempt}/5`);

          await sleep(1500);

          const fetchResult = await razorpayRequest(
            `/v1/payments/qr_codes/${encodeURIComponent(qrId)}`,
            "GET"
          );

          if (
            fetchResult.response.ok &&
            fetchResult.data?.image_content?.startsWith("upi://pay")
          ) {
            upiUrl = fetchResult.data.image_content;
            break;
          }
        }
      }

      if (!upiUrl.startsWith("upi://pay")) {
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

    // CHECK PAYMENT STATUS AND SAVE TO DATABASE
    if (req.method === "GET" && req.query?.action === "status") {
      const qrId = req.query.qr_id;

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

      if (!paidPayment) {
        return sendJson(res, 200, {
          success: true,
          paid: false,
          qr_id: qrId,
          status: "pending",
        });
      }

      console.log("PAYMENT CAPTURED:", paidPayment.id);

      // QR ID is known from the status request.
      // This avoids relying on qr_code_id in the webhook payload.
      let saveResult;

      try {
        saveResult = await savePaymentToHostinger({
          qrId,
          payment: paidPayment,
          eventId: `status-poll:${qrId}:${paidPayment.id}`,
        });
      } catch (error) {
        console.error("[DEBUG] Hostinger save request failed:", error);
        saveResult = {
          saved: false,
          error: "Hostinger save request failed",
        };
      }

      return sendJson(res, 200, {
        success: true,
        paid: true,
        saved: saveResult.saved,
        save_error: saveResult.saved ? undefined : saveResult.error,
        qr_id: qrId,
        payment_id: paidPayment.id,
        amount: paidPayment.amount,
        status: paidPayment.status,
        method: paidPayment.method,
        created_at: paidPayment.created_at,
      });
    }

    // CLOSE QR PAYMENT
    if (
      req.method === "POST" &&
      req.headers["x-helmi-action"] === "cancel-payment"
    ) {
      const qrId = req.query.qr_id;

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

    // RAZORPAY WEBHOOK
    if (req.method === "POST") {
      console.log("[DEBUG] Webhook POST reached");

      const rawBody = await readRawBody(req);
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.headers["x-razorpay-signature"];

      if (!webhookSecret || typeof signature !== "string") {
        return sendJson(res, 401, {
          success: false,
          error: "Webhook authentication failed",
        });
      }

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
        return sendJson(res, 400, {
          success: false,
          error: "Invalid webhook JSON",
        });
      }

      console.log("[DEBUG] Verified event:", event.event);

      let qrId = null;
      let payment = null;

      if (event.event === "payment.captured") {
        payment = event.payload?.payment?.entity || null;
        qrId = payment?.qr_code_id || null;

        // A payment lookup may not contain qr_code_id.
        // The status endpoint is the fallback for saving.
        if (payment?.id && !qrId) {
          console.log(
            "[DEBUG] QR ID absent from payment.captured payload; status polling can save it"
          );
        }
      } else if (event.event === "qr_code.credited") {
        const qrEntity = event.payload?.qr_code?.entity;

        qrId = qrEntity?.id || event.payload?.qr_code?.id || null;

        if (qrId) {
          const qrPaymentsResult = await razorpayRequest(
            `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/payments?count=100`,
            "GET"
          );

          if (!qrPaymentsResult.response.ok) {
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
      } else {
        return sendJson(res, 200, {
          received: true,
          verified: true,
          ignored: true,
        });
      }

      if (
        !payment ||
        payment.status !== "captured" ||
        Number(payment.amount) !== PAYMENT_AMOUNT
      ) {
        return sendJson(res, 200, {
          received: true,
          verified: true,
          forwarded: false,
          reason: "Captured ₹5 payment not found",
        });
      }

      if (!qrId) {
        // Do not invent or guess the QR ID.
        // Razorpay's status API can save the payment once called with qr_id.
        return sendJson(res, 200, {
          received: true,
          verified: true,
          forwarded: false,
          reason: "QR ID missing; status API fallback is required",
          payment_id: payment.id,
        });
      }

      try {
        const saveResult = await savePaymentToHostinger({
          qrId,
          payment,
          eventId: event.id || "",
        });

        if (!saveResult.saved) {
          return sendJson(res, 502, {
            received: true,
            verified: true,
            forwarded: false,
            error: saveResult.error,
          });
        }

        return sendJson(res, 200, {
          received: true,
          verified: true,
          forwarded: true,
          saved: true,
        });
      } catch (error) {
        console.error("[DEBUG] Hostinger forwarding failed:", error);

        return sendJson(res, 502, {
          received: true,
          verified: true,
          forwarded: false,
          error: "Hostinger payment save request failed",
        });
      }
    }

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
