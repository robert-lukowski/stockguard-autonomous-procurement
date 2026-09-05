import { sha256 } from "../../security";
import { Pbkdf2AccessCodeVerifier } from "../judge/backend/accessCode";
import type { AccessCodeSecretPort } from "../judge/backend/types";
import type { AccessCodeVerification, AccessCodeVerifierPort } from "./types";

/**
 * Wraps the existing PBKDF2 verifier and adds a stable credential identity.
 *
 * `Pbkdf2AccessCodeVerifier` is deliberately untouched: it answers "is this
 * code correct", which is all the Judge Mode backend needs. This adds the one
 * extra thing WebRTC Judge Mode needs — an identity that is the same on every
 * sign-in with the same code — without changing behaviour anything else relies
 * on.
 *
 * The identity is a hash of the stored digest, not of the code. That matters:
 * an access code is short and low-entropy, so hashing it directly would give
 * anyone who saw an identity an offline oracle for the code. The digest is
 * already 256 bits of PBKDF2 output and already secret, so a hash of it reveals
 * nothing and is cheap to compute.
 */
export class StableAccessCodeVerifier implements AccessCodeVerifierPort {
  private readonly verifier: Pbkdf2AccessCodeVerifier;

  constructor(private readonly secrets: AccessCodeSecretPort) {
    this.verifier = new Pbkdf2AccessCodeVerifier(secrets);
  }

  async verify(accessCode: string): Promise<AccessCodeVerification> {
    if (!(await this.verifier.verify(accessCode))) return { valid: false };

    const secret = await this.secrets.getSecret();
    const digest = await sha256(`stockguard-judge-credential:${secret.derivedKeyBase64}`);
    // Half a SHA-256 is ample to name one credential and keeps log lines short.
    return { valid: true, credentialId: `judge-${digest.slice(0, 32)}` };
  }
}
