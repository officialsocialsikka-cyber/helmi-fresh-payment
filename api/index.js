export default function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      status: "online",
      service: "HELMI FRESH Payment Server"
    });
  }

  if (req.method === "POST") {
    console.log("Razorpay webhook received");

    return res.status(200).json({
      received: true
    });
  }

  return res.status(405).json({
    error: "Method not allowed"
  });
}
