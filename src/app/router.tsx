import { createRootRoute, createRoute, createRouter, Link } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { EmptyState } from "@/components/ui/States";
import { AssistantPage } from "@/pages/AssistantPage";
import { AttentionPage } from "@/pages/AttentionPage";
import { OrdersPage } from "@/pages/OrdersPage";
import { OrderDetailPage } from "@/pages/OrderDetailPage";
import { SuppliersPage } from "@/pages/SuppliersPage";
import { SupplierDetailPage } from "@/pages/SupplierDetailPage";
import { MaterialsPage } from "@/pages/MaterialsPage";
import { MaterialDetailPage } from "@/pages/MaterialDetailPage";
import { ActivityPage } from "@/pages/ActivityPage";

function NotFound() {
  return (
    <EmptyState
      icon={SearchX}
      title="No encontramos esta página"
      description="Puede que el enlace esté incompleto o que el registro ya no exista."
      actions={
        <Link to="/" className="text-sm font-medium text-accent">
          Volver al asistente
        </Link>
      }
      className="flex-1"
    />
  );
}

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: AssistantPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/atencion", component: AttentionPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/pedidos", component: OrdersPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/pedidos/$orderId", component: OrderDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/proveedores", component: SuppliersPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/proveedores/$supplierId", component: SupplierDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/materiales", component: MaterialsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/materiales/$materialId", component: MaterialDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/actividad", component: ActivityPage }),
];

const routeTree = rootRoute.addChildren(routes);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
