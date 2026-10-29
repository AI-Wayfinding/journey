import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

/** Options for {@link createVerifier}. */
export interface VerifierOptions {
  /** Expected `iss`: the AuthKit domain, for example `https://welcoming-folk-53-staging.authkit.app`. */
  issuer: string;
  /** This server's RFC 8707 resource identifier; tokens must carry it as `aud`. */
  resource: URL;
  /** JWKS location. Defaults to `<issuer>/oauth2/jwks`. Ignored when `getKey` is given. */
  jwksUrl?: URL;
  /** Key lookup, for tests that sign with a local key pair. Takes precedence over `jwksUrl`. */
  getKey?: JWTVerifyGetKey;
  /** Accepted clock skew in seconds. */
  clockToleranceSec?: number;
}

/** AuthKit signs access tokens with RS256; refuse every other algorithm. */
const ALGORITHMS = ['RS256'];

/**
 * Build a token verifier for AuthKit access tokens.
 *
 * A caller must not be able to reach the MCP handler with a token that was
 * signed by another key, issued by another issuer, issued for another
 * resource, or already expired: each of those throws `invalid_token`, which
 * `requireBearerAuth` turns into a `401` challenge.
 */
export function createVerifier(options: VerifierOptions): OAuthTokenVerifier {
  const getKey = options.getKey ?? createRemoteJWKSet(options.jwksUrl ?? new URL('/oauth2/jwks', options.issuer));
  const resource = options.resource.href;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: options.issuer,
          audience: resource,
          algorithms: ALGORITHMS,
          clockTolerance: options.clockToleranceSec ?? 5,
          requiredClaims: ['sub', 'exp'],
        }));
      } catch (error) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, describe(error));
      }

      const sub = payload.sub;
      const exp = payload.exp;
      if (typeof sub !== 'string' || sub === '' || typeof exp !== 'number') {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token lacks sub or exp');
      }

      return {
        token,
        clientId: sub,
        scopes: scopesOf(payload),
        expiresAt: exp,
        resource: audienceFor(payload, options.resource),
        extra: { sub },
      };
    },
  };
}

/** The `aud` entry on this server's origin, if any; `requireBearerAuth` compares it with `expectedResource`. */
function audienceFor(payload: JWTPayload, resource: URL): URL | undefined {
  const audiences = [payload.aud ?? []].flat();
  const match = audiences.find((aud) => URL.canParse(aud) && new URL(aud).origin === resource.origin);
  return match === undefined ? undefined : new URL(match);
}

/** OAuth `scope` is a space-separated string; AuthKit tokens may carry none. */
function scopesOf(payload: JWTPayload): string[] {
  const scope = payload['scope'];
  if (typeof scope !== 'string') return [];
  return scope.split(' ').filter((s) => s !== '');
}

/** A short reason for the challenge; never echoes token content. */
function describe(error: unknown): string {
  if (error instanceof errors.JWTExpired) return 'Access token expired';
  if (error instanceof errors.JWTClaimValidationFailed) return `Access token claim "${error.claim}" is not valid`;
  if (error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JWKSNoMatchingKey) {
    return 'Access token signature is not valid';
  }
  return 'Access token is not valid';
}
