import { Outlet, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";

/** Routes that bring their own bottom action bar on mobile instead of the tab bar. */
const NO_TAB_BAR = [/^\/pedidos\/[^/]+$/];

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hideTabBar = NO_TAB_BAR.some((re) => re.test(pathname));
  return (
    <div className="flex h-dvh flex-col bg-bg lg:flex-row">
      <Sidebar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" id="main">
        <Outlet />
      </main>
      {hideTabBar ? null : <TabBar />}
    </div>
  );
}
