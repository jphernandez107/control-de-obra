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

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ServicesProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AssistantProvider>
              <RouterProvider router={router} />
            </AssistantProvider>
          </ToastProvider>
        </QueryClientProvider>
      </ServicesProvider>
    </ThemeProvider>
  </StrictMode>,
);
