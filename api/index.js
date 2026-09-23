import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

// ==================================================
// HELMI FRESH SETTINGS
// ==================================================

// ₹5 = 500 paise
const PAYMENT_AMOUNT = 500;

// ESP32 timer = 120 seconds
const PAYMENT_TIMER_SECONDS = 120;

// Razorpay QR must stay valid beyond the ESP32 timer.
// 960 seconds = 16 minutes.
const QR_CLOSE_BY_SECONDS = 960;


// ==================================================
// SEND JSON
// ==================================================

function sendJson(res, status, data) {
  res.status(status);

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  return res.end(
    JSON.stringify(data)
  );
}


// ==================================================
// RAZORPAY AUTH
// ==================================================

function razorpayAuth() {

  const keyId =
    process.env.RAZORPAY_KEY_ID;

  const keySecret =
    process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "Razorpay API credentials are not configured"
    );
  }

  return (
    "Basic " +
    Buffer.from(
      `${keyId}:${keySecret}`
    ).toString("base64")
  );
}


// ==================================================
// READ RAW BODY
// ==================================================

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


// ==================================================
// RAZORPAY REQUEST
// ==================================================

async function razorpayRequest(
  path,
  method = "GET",
  body = null
) {

  const options = {
    method,

    headers: {
      Authorization:
        razorpayAuth(),

      "Content-Type":
        "application/json",
    },
  };

  if (body !== null) {
    options.body =
      JSON.stringify(body);
  }

  const response =
    await fetch(
      `https://api.razorpay.com${path}`,
      options
    );

  const data =
    await response.json();

  return {
    response,
    data,
  };
}


// ==================================================
// MAIN HANDLER
// ==================================================

export default async function handler(
  req,
  res
) {

  try {

    // ==================================================
    // HEALTH CHECK
    // ==================================================

    if (
      req.method === "GET" &&
      !req.query?.action
    ) {

      return sendJson(
        res,
        200,
        {
          status: "online",

          service:
            "HELMI FRESH UPI QR Payment Server",
        }
      );
    }


    // ==================================================
    // CREATE DIRECT UPI QR
    // ==================================================

    if (
      req.method === "POST" &&
      req.headers[
        "x-helmi-action"
      ] === "create-payment"
    ) {

      const referenceId =
        `HELMI-${Date.now()}`;


      const closeBy =
        Math.floor(
          Date.now() / 1000
        ) +
        QR_CLOSE_BY_SECONDS;


      // ------------------------------------------------
      // CREATE RAZORPAY UPI QR
      // ------------------------------------------------

      const result =
        await razorpayRequest(
          "/v1/payments/qr_codes",
          "POST",
          {
            type:
              "upi_qr",

            name:
              "HELMI FRESH",

            usage:
              "single_use",

            fixed_amount:
              true,

            payment_amount:
              PAYMENT_AMOUNT,

            description:
              "HELMI FRESH Helmet Sanitization",

            close_by:
              closeBy,

            notes: {
              reference_id:
                referenceId,

              purpose:
                "Helmet Sanitization",
            },
          }
        );


      // ------------------------------------------------
      // RAZORPAY ERROR
      // ------------------------------------------------

      if (
        !result.response.ok
      ) {

        return sendJson(
          res,
          result.response.status,
          {
            success: false,

            error:
              result.data?.error
                ?.description ||
              "Razorpay QR creation failed",
          }
        );
      }


      const qr =
        result.data;


      // ------------------------------------------------
      // IMPORTANT:
      // image_content IS ALREADY IN CREATE RESPONSE
      // ------------------------------------------------

      const upiUrl =
        qr.image_content;


      if (
        !upiUrl ||
        !upiUrl.startsWith(
          "upi://pay"
        )
      ) {

        console.error(
          "Razorpay QR response:",
          qr
        );

        return sendJson(
          res,
          500,
          {
            success: false,

            error:
              "Razorpay did not return a valid UPI QR payload",
          }
        );
      }


      // ------------------------------------------------
      // RETURN DATA TO ESP32
      // ------------------------------------------------

      return sendJson(
        res,
        200,
        {
          success: true,

          amount: 5,

          qr_id:
            qr.id,

          upi_url:
            upiUrl,

          status:
            qr.status,

          payment_timer_seconds:
            PAYMENT_TIMER_SECONDS,

          razorpay_qr_close_by:
            qr.close_by,

          reference_id:
            referenceId,
        }
      );
    }


    // ==================================================
    // CHECK QR PAYMENT STATUS
    // ==================================================

    if (
      req.method === "GET" &&
      req.query?.action === "status"
    ) {

      const qrId =
        req.query.qr_id;


      if (!qrId) {

        return sendJson(
          res,
          400,
          {
            success: false,

            error:
              "qr_id is required",
          }
        );
      }


      const result =
        await razorpayRequest(
          `/v1/payments/qr_codes/${encodeURIComponent(
            qrId
          )}/payments?count=100`,
          "GET"
        );


      if (
        !result.response.ok
      ) {

        return sendJson(
          res,
          result.response.status,
          {
            success: false,

            error:
              result.data?.error
                ?.description ||
              "Unable to check QR payment status",
          }
        );
      }


      const items =
        Array.isArray(
          result.data?.items
        )
          ? result.data.items
          : [];


      // Find captured ₹5 payment
      const paidPayment =
        items.find(
          (payment) =>
            payment.status ===
              "captured" &&
            Number(
              payment.amount
            ) ===
              PAYMENT_AMOUNT
        );


      if (paidPayment) {

        return sendJson(
          res,
          200,
          {
            success: true,

            paid: true,

            qr_id:
              qrId,

            payment_id:
              paidPayment.id,

            amount:
              paidPayment.amount,

            status:
              paidPayment.status,

            method:
              paidPayment.method,

            created_at:
              paidPayment.created_at,
          }
        );
      }


      return sendJson(
        res,
        200,
        {
          success: true,

          paid: false,

          qr_id:
            qrId,

          status:
            "pending",
        }
      );
    }


    // ==================================================
    // CLOSE QR
    // ==================================================

    if (
      req.method === "POST" &&
      req.headers[
        "x-helmi-action"
      ] === "cancel-payment"
    ) {

      const qrId =
        req.query.qr_id;


      if (!qrId) {

        return sendJson(
          res,
          400,
          {
            success: false,

            error:
              "qr_id is required",
          }
        );
      }


      const result =
        await razorpayRequest(
          `/v1/payments/qr_codes/${encodeURIComponent(
            qrId
          )}/close`,
          "POST",
          {}
        );


      if (
        !result.response.ok
      ) {

        return sendJson(
          res,
          result.response.status,
          {
            success: false,

            error:
              result.data?.error
                ?.description ||
              "QR close failed",
          }
        );
      }


      return sendJson(
        res,
        200,
        {
          success: true,

          qr_id:
            result.data.id,

          status:
            result.data.status,

          closed_at:
            result.data.closed_at,

          close_reason:
            result.data.close_reason,
        }
      );
    }


    // ==================================================
    // RAZORPAY WEBHOOK
    // ==================================================

    if (
      req.method === "POST"
    ) {

      const rawBody =
        await readRawBody(req);


      const webhookSecret =
        process.env
          .RAZORPAY_WEBHOOK_SECRET;


      const signature =
        req.headers[
          "x-razorpay-signature"
        ];


      if (
        !webhookSecret ||
        !signature
      ) {

        return sendJson(
          res,
          401,
          {
            success: false,

            error:
              "Webhook authentication failed",
          }
        );
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
        Buffer.from(
          signature
        );


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

        return sendJson(
          res,
          401,
          {
            success: false,

            error:
              "Invalid webhook signature",
          }
        );
      }


      const event =
        JSON.parse(
          rawBody.toString(
            "utf8"
          )
        );


      console.log(
        "Verified Razorpay webhook:",
        event.event
      );


      return sendJson(
        res,
        200,
        {
          received: true,

          verified: true,
        }
      );
    }


    // ==================================================
    // METHOD NOT ALLOWED
    // ==================================================

    return sendJson(
      res,
      405,
      {
        success: false,

        error:
          "Method not allowed",
      }
    );

  } catch (error) {

    console.error(
      "HELMI FRESH Payment Error:",
      error
    );


    return sendJson(
      res,
      500,
      {
        success: false,

        error:
          "Internal server error",
      }
    );
  }
}
