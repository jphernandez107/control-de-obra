import { useRef, type ReactNode } from "react";
import { ErrorState } from "@/components/ui/States";
import { LoginPage } from "@/pages/LoginPage";
import { useSession } from "@/queries";
import { ApiError } from "@/services/api/client";

/**
 * Renders the app only with a valid session; otherwise the login screen. The
 * URL is kept, so a shared link opens the right page after signing in. Any
 * request that comes back 401 later re-checks the session (see main.tsx).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const signedIn = useRef(false);
  if (session.data) signedIn.current = true;

  if (session.isPending) return <div className="min-h-dvh bg-bg" aria-busy="true" />;
  if (session.error instanceof ApiError && session.error.status === 401) return <LoginPage expired={signedIn.current} />;
  if (session.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <ErrorState title="No pudimos conectar con el servidor" onRetry={() => void session.refetch()} retrying={session.isFetching} />
      </div>
    );
  }
  return children;
}
