export const AUTHENTICATED_HOME = "/drivers" as const;

export function postAuthRedirect(): typeof AUTHENTICATED_HOME {
  return AUTHENTICATED_HOME;
}

export function isAuthenticatedHome(pathname: string): boolean {
  return pathname === AUTHENTICATED_HOME || pathname.startsWith(`${AUTHENTICATED_HOME}/`);
}
