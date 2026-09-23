import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const AMOUNT = 500; // ₹5

// ESP32 screen payment timer
const PAYMENT_TIMEOUT_SECONDS = 120;

// Razorpay Payment Link must remain valid for at least 15 minutes.
// 960 seconds = 16 minutes, giving a little safety margin.
const RAZORPAY_LINK_EXPIRY_SECONDS = 960;

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
    throw new Error(
      "Razorpay API credentials are not configured"
    );
  }

  return (
    "Basic " +
    Buffer.from(`${keyId}:${keySecret}`).toString("base64")
  );
}

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  try {
    // ==================================================
    // HEALTH CHECK
    // ==================================================

    if (
      req.method === "GET" &&
      !req.query?.action
    ) {
      return sendJson(res, 200, {
        status: "online",
        service: "HELMI FRESH Payment Server",
      });
    }

    // ==================================================
    // CHECK PAYMENT STATUS
    // ==================================================

    if (
      req.method === "GET" &&
      req.query?.action === "status"
    ) {
      const paymentLinkId =
        req.query.payment_link_id;

      if (!paymentLinkId) {
        return sendJson(res, 400, {
          success: false,
          error: "payment_link_id is required",
        });
      }

      const response = await fetch(
        `https://api.razorpay.com/v1/payment_links/${encodeURIComponent(
          paymentLinkId
        )}`,
        {
          method: "GET",
          headers: {
            Authorization: razorpayAuth(),
          },
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return sendJson(res, response.status, {
          success: false,
          error:
            data.error?.description ||
            "Unable to check payment status",
        });
      }

      return sendJson(res, 200, {
        success: true,
        payment_link_id: data.id,
        status: data.status,
        amount: data.amount,
        amount_paid: data.amount_paid,
      });
    }

    // ==================================================
    // CANCEL PAYMENT LINK
    // ==================================================

    if (
      req.method === "POST" &&
      req.headers["x-helmi-action"] ===
        "cancel-payment"
    ) {
      const paymentLinkId =
        req.query.payment_link_id;

      if (!paymentLinkId) {
        return sendJson(res, 400, {
          success: false,
          error: "payment_link_id is required",
        });
      }

      const response = await fetch(
        `https://api.razorpay.com/v1/payment_links/${encodeURIComponent(
          paymentLinkId
        )}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: razorpayAuth(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return sendJson(res, response.status, {
          success: false,
          error:
            data.error?.description ||
            "Payment link cancellation failed",
        });
      }

      return sendJson(res, 200, {
        success: true,
        payment_link_id: data.id,
        status: data.status,
        cancelled_at: data.cancelled_at,
      });
    }

    // ==================================================
    // CREATE ₹5 PAYMENT LINK
    // ==================================================

    if (
      req.method === "POST" &&
      req.headers["x-helmi-action"] ===
        "create-payment"
    ) {
      const referenceId =
        `HELMI-${Date.now()}`;

      const response = await fetch(
        "https://api.razorpay.com/v1/payment_links",
        {
          method: "POST",
          headers: {
            Authorization: razorpayAuth(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: AMOUNT,
            currency: "INR",
            accept_partial: false,

            description:
              "HELMI FRESH Helmet Sanitization",

            reference_id: referenceId,

            reminder_enable: false,

            // Razorpay link validity:
            // 16 minutes
            expire_by:
              Math.floor(Date.now() / 1000) +
              RAZORPAY_LINK_EXPIRY_SECONDS,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return sendJson(res, response.status, {
          success: false,
          error:
            data.error?.description ||
            "Payment Link creation failed",
        });
      }

      return sendJson(res, 200, {
        success: true,

        // ₹5
        amount: 5,

        payment_link_id: data.id,

        short_url: data.short_url,

        status: data.status,

        reference_id: data.reference_id,

        // ESP32 payment timer
        payment_timer_seconds:
          PAYMENT_TIMEOUT_SECONDS,

        // Actual Razorpay link expiry
        razorpay_link_expiry_seconds:
          RAZORPAY_LINK_EXPIRY_SECONDS,
      });
    }

    // ==================================================
    // RAZORPAY WEBHOOK
    // ==================================================

    if (req.method === "POST") {
      const rawBody =
        await readRawBody(req);

      const webhookSecret =
        process.env.RAZORPAY_WEBHOOK_SECRET;

      const signature =
        req.headers[
          "x-razorpay-signature"
        ];

      if (
        !webhookSecret ||
        !signature
      ) {
        return sendJson(res, 401, {
          success: false,
          error:
            "Webhook authentication failed",
        });
      }

      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            webhookSecret
          )
          .update(rawBody)
          .digest("hex");

      const received =
        Buffer.from(signature);

      const expected =
        Buffer.from(
          expectedSignature
        );

      if (
        received.length !==
          expected.length ||
        !crypto.timingSafeEqual(
          received,
          expected
        )
      ) {
        return sendJson(res, 401, {
          success: false,
          error:
            "Invalid webhook signature",
        });
      }

      const event =
        JSON.parse(
          rawBody.toString("utf8")
        );

      console.log(
        "Verified Razorpay webhook:",
        event.event
      );

      return sendJson(res, 200, {
        received: true,
        verified: true,
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
    console.error(
      "HELMI FRESH Payment Error:",
      error
    );

    return sendJson(res, 500, {
      success: false,
      error: "Internal server error",
    });
  }
}
