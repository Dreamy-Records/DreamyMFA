import { Buffer } from "buffer";
import authenticator from "authenticator";
import jsQR from "jsqr";

window.Buffer = window.Buffer || Buffer;
window.SharedAuthenticator = {
  generateToken(secret) {
    return authenticator.generateToken(secret).replace(/\s+/g, "").padStart(6, "0");
  },
  verifyToken(secret, token) {
    return authenticator.verifyToken(secret, token);
  },
  generateTotpUri(secret, accountName, issuer = "X") {
    return authenticator.generateTotpUri(secret, accountName, issuer, "SHA1", 6, 30);
  },
};

window.SharedQr = {
  decode(imageData, width, height) {
    return jsQR(imageData, width, height)?.data || "";
  },
};
