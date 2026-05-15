const jwt = require("jsonwebtoken");

function createZainCashToken({
  merchantId,
  merchantMsisdn,
  amount,
  orderId,
  redirectUrl,
}) {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    merchantId: merchantId,
    amount: amount,
    serviceType: "Doctor Subscription",
    msisdn: merchantMsisdn,
    orderId: orderId,
    redirectUrl: redirectUrl,
    iat: now,
    exp: now + 60 * 10, // valid for 10 minutes
  };

  return jwt.sign(payload, process.env.ZAINCASH_SECRET, {
    algorithm: "HS256",
  });
}

module.exports = {
  createZainCashToken,
};
