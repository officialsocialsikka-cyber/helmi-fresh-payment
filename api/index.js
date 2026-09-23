import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

// ==================================================
// HELMI FRESH SETTINGS
// ==================================================

const PAYMENT_AMOUNT = 500; // ₹5
const PAYMENT_TIMER_SECONDS = 120;

// Razorpay requires QR close_by to be sufficiently
// ahead of current time. 960 sec = 16 minutes.
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
// RAZORPAY API REQUEST
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

  const text =
    await response.text();

  let data = {};

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text,
    };
  }

  return {
    response,
    data,
  };
}

// ==================================================
// SMALL DELAY
// ==================================================

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
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
          status:
            "online",

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

      console.log(
        "================================"
      );

      console.log(
        "HELMI FRESH: CREATE QR"
      );

      console.log(
        "Reference:",
        referenceId
      );

      console.log(
        "Amount:",
        PAYMENT_AMOUNT
      );

      console.log(
        "================================"
      );

      // ------------------------------------------------
      // CREATE RAZORPAY UPI QR
      // ------------------------------------------------

      const createResult =
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

      console.log(
        "Razorpay CREATE HTTP:",
        createResult.response.status
      );

      console.log(
        "Razorpay CREATE RESPONSE:",
        createResult.data
      );

      // ------------------------------------------------
      // RAZORPAY CREATE ERROR
      // ------------------------------------------------

      if (
        !createResult.response.ok
      ) {

        return sendJson(
          res,
          createResult.response.status,
          {
            success:
              false,

            error:
              createResult.data?.error
                ?.description ||
              createResult.data?.raw ||
              "Razorpay QR creation failed",
          }
        );
      }

      const qr =
        createResult.data;

      const qrId =
        qr?.id;

      // ------------------------------------------------
      // QR ID CHECK
      // ------------------------------------------------

      if (!qrId) {

        console.error(
          "QR ID missing:"
        );

        console.error(qr);

        return sendJson(
          res,
          500,
          {
            success:
              false,

            error:
              "Razorpay QR ID missing",

            razorpay_response:
              qr,
          }
        );
      }

      console.log(
        "QR CREATED:",
        qrId
      );

      // ==================================================
      // GET IMAGE_CONTENT
      // ==================================================

      let upiUrl =
        qr?.image_content || "";

      // ==================================================
      // RETRY FETCH QR
      // ==================================================

      if (
        !upiUrl.startsWith(
          "upi://pay"
        )
      ) {

        console.log(
          "image_content not available in CREATE response."
        );

        console.log(
          "Starting QR FETCH retries..."
        );

        for (
          let attempt = 1;
          attempt <= 5;
          attempt++
        ) {

          console.log(
            `QR FETCH attempt ${attempt}/5`
          );

          // Small delay before fetch
          await sleep(1500);

          const fetchResult =
            await razorpayRequest(
              `/v1/payments/qr_codes/${encodeURIComponent(
                qrId
              )}`,
              "GET"
            );

          console.log(
            "QR FETCH HTTP:",
            fetchResult.response.status
          );

          console.log(
            "QR FETCH RESPONSE:",
            fetchResult.data
          );

          if (
            fetchResult.response.ok &&
            fetchResult.data?.image_content &&
            fetchResult.data.image_content.startsWith(
              "upi://pay"
            )
          ) {

            upiUrl =
              fetchResult.data.image_content;

            console.log(
              "================================"
            );

            console.log(
              "DIRECT UPI PAYLOAD FOUND"
            );

            console.log(
              "================================"
            );

            break;
          }
        }
      }

      // ==================================================
      // FINAL UPI PAYLOAD CHECK
      // ==================================================

      if (
        !upiUrl ||
        !upiUrl.startsWith(
          "upi://pay"
        )
      ) {

        console.error(
          "================================"
        );

        console.error(
          "DIRECT UPI PAYLOAD NOT FOUND"
        );

        console.error(
          "QR ID:",
          qrId
        );

        console.error(
          "IMAGE URL:",
          qr?.image_url || null
        );

        console.error(
          "================================"
        );

        return sendJson(
          res,
          500,
          {
            success:
              false,

            error:
              "QR was created but direct UPI payload was not available",

            qr_id:
              qrId,

            image_url:
              qr?.image_url || null,
          }
        );
      }

      // ==================================================
      // RETURN DATA TO ESP32
      // ==================================================

      console.log(
        "Sending Direct UPI QR data to ESP32..."
      );

      return sendJson(
        res,
        200,
        {
          success:
            true,

          amount:
            PAYMENT_AMOUNT / 100,

          qr_id:
            qrId,

          upi_url:
            upiUrl,

          status:
            qr.status ||
            "active",

          payment_timer_seconds:
            PAYMENT_TIMER_SECONDS,

          razorpay_qr_close_by:
            qr.close_by ||
            closeBy,

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
            success:
              false,

            error:
              "qr_id is required",
          }
        );
      }

      console.log(
        "Checking QR payment:",
        qrId
      );

      const result =
        await razorpayRequest(
          `/v1/payments/qr_codes/${encodeURIComponent(
            qrId
          )}/payments?count=100`,
          "GET"
        );

      console.log(
        "QR PAYMENT STATUS HTTP:",
        result.response.status
      );

      console.log(
        "QR PAYMENT STATUS RESPONSE:",
        result.data
      );

      if (
        !result.response.ok
      ) {

        return sendJson(
          res,
          result.response.status,
          {
            success:
              false,

            error:
              result.data?.error
                ?.description ||
              result.data?.raw ||
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

      // ==================================================
      // FIND CAPTURED ₹5 PAYMENT
      // ==================================================

      const paidPayment =
        items.find(
          payment =>
            payment.status ===
              "captured" &&
            Number(
              payment.amount
            ) ===
              PAYMENT_AMOUNT
        );

      if (paidPayment) {

        console.log(
          "================================"
        );

        console.log(
          "PAYMENT CAPTURED"
        );

        console.log(
          "Payment ID:",
          paidPayment.id
        );

        console.log(
          "================================"
        );

        return sendJson(
          res,
          200,
          {
            success:
              true,

            paid:
              true,

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
          success:
            true,

          paid:
            false,

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
            success:
              false,

            error:
              "qr_id is required",
          }
        );
      }

      console.log(
        "Closing Razorpay QR:",
        qrId
      );

      const result =
        await razorpayRequest(
          `/v1/payments/qr_codes/${encodeURIComponent(
            qrId
          )}/close`,
          "POST",
          {}
        );

      console.log(
        "QR CLOSE HTTP:",
        result.response.status
      );

      console.log(
        "QR CLOSE RESPONSE:",
        result.data
      );

      if (
        !result.response.ok
      ) {

        return sendJson(
          res,
          result.response.status,
          {
            success:
              false,

            error:
              result.data?.error
                ?.description ||
              result.data?.raw ||
              "QR close failed",
          }
        );
      }

      return sendJson(
        res,
        200,
        {
          success:
            true,

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
            success:
              false,

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
            success:
              false,

            error:
              "Invalid webhook signature",
          }
        );
      }

      let event = {};

      try {

        event =
          JSON.parse(
            rawBody.toString(
              "utf8"
            )
          );

      } catch {

        return sendJson(
          res,
          400,
          {
            success:
              false,

            error:
              "Invalid webhook JSON",
          }
        );
      }

      console.log(
        "Verified Razorpay webhook:",
        event.event
      );

      return sendJson(
        res,
        200,
        {
          received:
            true,

          verified:
            true,
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
        success:
          false,

        error:
          "Method not allowed",
      }
    );

  } catch (error) {

    console.error(
      "================================"
    );

    console.error(
      "HELMI FRESH PAYMENT ERROR"
    );

    console.error(
      error
    );

    console.error(
      "================================"
    );

    return sendJson(
      res,
      500,
      {
        success:
          false,

        error:
          error?.message ||
          "Internal server error",
      }
    );
  }
}
