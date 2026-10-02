import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "./styles/index.css";
import { ThemeProvider } from "./app/theme";
import { router } from "./app/router";
import { ServicesProvider } from "./services";
import { ToastProvider } from "./components/ui/Toast";
import { AssistantProvider } from "./features/assistant/AssistantProvider";
import { AuthGate } from "./features/auth/AuthGate";
import { onUnauthorized } from "./services/api/client";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } },
});

// A 401 anywhere means the session ended: re-check it, and the gate shows the login screen.
onUnauthorized(() => void queryClient.invalidateQueries({ queryKey: ["session"] }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ServicesProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AuthGate>
              <AssistantProvider>
                <RouterProvider router={router} />
              </AssistantProvider>
            </AuthGate>
          </ToastProvider>
        </QueryClientProvider>
      </ServicesProvider>
    </ThemeProvider>
  </StrictMode>,
);
