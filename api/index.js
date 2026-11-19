// ============================================================
// HELMIFRESH HUMAN DETECTION + VERCEL DEFAULT HANDLER
// APPEND THIS AFTER YOUR ORIGINAL webhook() FUNCTION
// ============================================================

const HUMAN_DETECT_MAX_BYTES = 4 * 1024 * 1024;

function secureTokenEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

async function readRawBody(req, maxBytes = HUMAN_DETECT_MAX_BYTES) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    total += buffer.length;

    if (total > maxBytes) {
      throw new Error("BODY_TOO_LARGE");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

// ------------------------------------------------------------
// GEMINI HUMAN DETECTION
// ------------------------------------------------------------

async function humanDetect(req, res) {
  const expectedToken = requiredEnv(
    "HELMI_HUMAN_DETECT_TOKEN"
  );

  const suppliedToken =
    req.headers["x-helmi-human-token"];

  if (
    !secureTokenEqual(
      suppliedToken,
      expectedToken
    )
  ) {
    return sendJson(res, 401, {
      success: false,
      result: "UNAUTHORIZED",
    });
  }

  const contentType = String(
    req.headers["content-type"] || ""
  ).toLowerCase();

  if (!contentType.startsWith("image/jpeg")) {
    return sendJson(res, 415, {
      success: false,
      error: "Content-Type must be image/jpeg",
      result: "UNCERTAIN",
    });
  }

  let imageBuffer;

  try {
    imageBuffer = await readRawBody(
      req,
      HUMAN_DETECT_MAX_BYTES
    );
  } catch (error) {
    if (error.message === "BODY_TOO_LARGE") {
      return sendJson(res, 413, {
        success: false,
        error: "JPEG image exceeds 4 MB",
        result: "UNCERTAIN",
      });
    }

    return sendJson(res, 400, {
      success: false,
      error: "Unable to read image",
      result: "UNCERTAIN",
    });
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    return sendJson(res, 400, {
      success: false,
      error: "Empty image",
      result: "UNCERTAIN",
    });
  }

  // Basic JPEG validation
  if (
    imageBuffer.length < 4 ||
    imageBuffer[0] !== 0xff ||
    imageBuffer[1] !== 0xd8
  ) {
    return sendJson(res, 400, {
      success: false,
      error: "Invalid JPEG image",
      result: "UNCERTAIN",
    });
  }

  const geminiKey = requiredEnv(
    "GEMINI_API_KEY"
  );

  const model =
    process.env.HUMAN_DETECT_MODEL ||
    "gemini-2.5-flash";

  const prompt = `
Analyze this camera image for the presence of a real human person.

Classify the image using exactly ONE of these labels:

HUMAN
NO_HUMAN
UNCERTAIN

Rules:
- HUMAN: A real human person is clearly visible in the image.
- NO_HUMAN: No human person is visible. Pets, animals, helmets,
  objects, shadows, pictures, posters and reflections are not humans.
- UNCERTAIN: Image is blurry, obstructed, too dark, ambiguous,
  incomplete, or confidence is insufficient.

Do not infer a human from a pet or object.
Do not provide explanations.
Return only the classification label.
`;

  const imageBase64 =
    imageBuffer.toString("base64");

  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent`;

  let geminiResponse;

  try {
    geminiResponse = await fetchTimeout(
      geminiUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
                {
                  inline_data: {
                    mime_type: "image/jpeg",
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 10,
          },
        }),
      },
      GEMINI_TIMEOUT_MS
    );
  } catch (error) {
    console.error(
      "[HUMAN-DETECT] Gemini request failed:",
      error.message
    );

    return sendJson(res, 502, {
      success: false,
      result: "UNCERTAIN",
      error: "AI service unavailable",
    });
  }

  let geminiData;

  try {
    geminiData = await geminiResponse.json();
  } catch {
    return sendJson(res, 502, {
      success: false,
      result: "UNCERTAIN",
      error: "Invalid AI response",
    });
  }

  if (!geminiResponse.ok) {
    console.error(
      "[HUMAN-DETECT] Gemini HTTP error:",
      geminiResponse.status
    );

    return sendJson(res, 502, {
      success: false,
      result: "UNCERTAIN",
      error: "Gemini API error",
    });
  }

  const outputText =
    geminiData?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join(" ")
      .trim()
      .toUpperCase() || "";

  let result = "UNCERTAIN";

  if (
    outputText === "HUMAN" ||
    outputText.includes("HUMAN")
  ) {
    result = "HUMAN";
  } else if (
    outputText === "NO_HUMAN" ||
    outputText.includes("NO_HUMAN")
  ) {
    result = "NO_HUMAN";
  }

  // Avoid accepting malformed or conflicting AI output.
  if (
    outputText.includes("HUMAN") &&
    outputText.includes("NO_HUMAN")
  ) {
    result = "UNCERTAIN";
  }

  console.log(
    `[HUMAN-DETECT] Result=${result} Model=${model}`
  );

  return sendJson(res, 200, {
    success: true,
    result,
    model,
  });
}

// ============================================================
// VERCEL DEFAULT HANDLER
// THIS FIXES THE "DEFAULT EXPORT MUST BE A FUNCTION" ERROR
// ============================================================

export default async function handler(req, res) {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );

      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
      );

      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Helmi-Action, X-Helmi-Human-Token, X-Razorpay-Signature"
      );

      return res.end();
    }

    // Health check
    if (
      req.method === "GET" &&
      !req.query?.action
    ) {
      return sendJson(res, 200, {
        success: true,
        status: "online",
        service: "HelmiFresh Payment + Human Detection API",
        payment: "available",
        human_detection: "available",
      });
    }

    const action = String(
      req.headers["x-helmi-action"] || ""
    ).toLowerCase();

    // HUMAN DETECTION
    if (
      req.method === "POST" &&
      action === "human-detect"
    ) {
      return await humanDetect(req, res);
    }

    // CREATE PAYMENT QR
    if (
      req.method === "POST" &&
      action === "create-payment"
    ) {
      return await createPayment(res);
    }

    // CANCEL QR
    if (
      req.method === "POST" &&
      action === "cancel-payment"
    ) {
      const qrId = req.query?.qr_id;

      if (
        typeof qrId !== "string" ||
        !/^qr_[A-Za-z0-9]+$/.test(qrId)
      ) {
        return sendJson(res, 400, {
          success: false,
          error: "Valid qr_id is required",
        });
      }

      const result = await razorpayRequest(
        `/v1/payments/qr_codes/${encodeURIComponent(qrId)}/close`,
        "POST",
        {}
      );

      if (!result.response.ok) {
        return sendJson(
          res,
          result.response.status,
          {
            success: false,
            error:
              result.data?.error?.description ||
              "QR close failed",
          }
        );
      }

      return sendJson(res, 200, {
        success: true,
        qr_id: result.data.id,
        status: result.data.status,
        closed_at: result.data.closed_at,
        close_reason: result.data.close_reason,
      });
    }

    // PAYMENT STATUS
    if (
      req.method === "GET" &&
      req.query?.action === "status"
    ) {
      return await checkStatus(
        res,
        req.query?.qr_id
      );
    }

    // MANUAL PAYMENT RECOVERY
    if (
      req.method === "GET" &&
      req.query?.action === "recover-payment"
    ) {
      return await recoverPayment(
        res,
        req.query?.payment_id
      );
    }

    // RAZORPAY WEBHOOK
    // POST without a Helmi action is treated as webhook.
    if (req.method === "POST") {
      return await webhook(req, res);
    }

    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed",
    });
  } catch (error) {
    console.error(
      "[VERCEL HANDLER ERROR]",
      error
    );

    return sendJson(res, 500, {
      success: false,
      error: "Internal server error",
    });
  }
}
