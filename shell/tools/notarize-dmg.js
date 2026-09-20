// afterAllArtifactBuild hook:.dmg 送 Apple 公證並 staple。憑證只從環境變數來(同 electron-builder 公證 .app 用的那三個)。
const { execFileSync } = require("child_process");

module.exports = async function notarizeDmg(result) {
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!process.env.BLAVE_MAC_IDENTITY || !key || !keyId || !issuer) return [];
  for (const dmg of result.artifactPaths.filter((p) => p.endsWith(".dmg"))) {
    execFileSync("xcrun", ["notarytool", "submit", dmg, "--key", key, "--key-id", keyId, "--issuer", issuer, "--wait"],
      { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
