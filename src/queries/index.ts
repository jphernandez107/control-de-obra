import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityFilters } from "@/domain/types";
import { useServices } from "@/services";

export const queryKeys = {
  dashboard: ["dashboard"] as const,
  orders: ["orders"] as const,
  order: (id: string) => ["orders", id] as const,
  suppliers: ["suppliers"] as const,
  supplier: (id: string) => ["suppliers", id] as const,
  supplierOptions: ["suppliers", "options"] as const,
  materials: ["materials"] as const,
  material: (id: string) => ["materials", id] as const,
  activity: (filters: ActivityFilters) => ["activity", filters] as const,
  conversations: ["assistant", "conversations"] as const,
  session: ["session"] as const,
  users: ["users"] as const,
  materialOptions: ["materials", "options"] as const,
  units: ["units"] as const,
};

export function useSession() {
  const { session } = useServices();
  return useQuery({ queryKey: queryKeys.session, queryFn: () => session.get(), staleTime: 5 * 60_000 });
}

export function useLogin() {
  const { auth } = useServices();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { username: string; password: string }) => auth.login(v.username, v.password),
    // Start from a clean cache: nothing from a previous user is kept.
    onSuccess: () => qc.resetQueries(),
  });
}

export function useLogout() {
  const { auth } = useServices();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => auth.logout(),
    onSettled: () => {
      qc.clear();
      // Back to a clean page (and the login screen) without anything from this session.
      window.location.assign("/");
    },
  });
}

export function useUsers(enabled = true) {
  const { users } = useServices();
  return useQuery({ queryKey: queryKeys.users, queryFn: () => users.list(), enabled });
}

export function useCreateUser() {
  const { users } = useServices();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (user: Parameters<typeof users.create>[0]) => users.create(user),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export function useMaterialOptions() {
  const { materials } = useServices();
  return useQuery({ queryKey: queryKeys.materialOptions, queryFn: () => materials.options() });
}

export function useUnits() {
  const { materials } = useServices();
  return useQuery({ queryKey: queryKeys.units, queryFn: () => materials.units(), staleTime: Infinity });
}

export function useDashboard() {
  const { dashboard } = useServices();
  return useQuery({ queryKey: queryKeys.dashboard, queryFn: () => dashboard.summary() });
}

export function useOrders() {
  const { orders } = useServices();
  return useQuery({ queryKey: queryKeys.orders, queryFn: () => orders.list() });
}

export function useOrder(id: string) {
  const { orders } = useServices();
  return useQuery({ queryKey: queryKeys.order(id), queryFn: () => orders.getById(id) });
}

export function useSuppliers() {
  const { suppliers } = useServices();
  return useQuery({ queryKey: queryKeys.suppliers, queryFn: () => suppliers.list() });
}

export function useSupplier(id: string) {
  const { suppliers } = useServices();
  return useQuery({ queryKey: queryKeys.supplier(id), queryFn: () => suppliers.getById(id) });
}

export function useSupplierOptions() {
  const { suppliers } = useServices();
  return useQuery({ queryKey: queryKeys.supplierOptions, queryFn: () => suppliers.options() });
}

export function useMaterials() {
  const { materials } = useServices();
  return useQuery({ queryKey: queryKeys.materials, queryFn: () => materials.overview() });
}

export function useMaterial(id: string) {
  const { materials } = useServices();
  return useQuery({ queryKey: queryKeys.material(id), queryFn: () => materials.getById(id) });
}

export function useActivity(filters: ActivityFilters) {
  const { activity } = useServices();
  return useQuery({ queryKey: queryKeys.activity(filters), queryFn: () => activity.list(filters), placeholderData: (prev) => prev });
}

export function useConversations(enabled: boolean) {
  const { assistant } = useServices();
  return useQuery({ queryKey: queryKeys.conversations, queryFn: () => assistant.conversations(), enabled });
}

/** Every confirmed record can change balances, statuses and activity. */
export function useInvalidateAll() {
  const client = useQueryClient();
  return () => client.invalidateQueries();
}

/** Uploads a computation spreadsheet and returns the matching preview (nothing is saved yet). */
export function useUploadComputation() {
  const { materials } = useServices();
  return useMutation({ mutationFn: (file: File) => materials.previewComputation(file) });
}

export function useImportComputation() {
  const { materials } = useServices();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { documentId: string; rows: Parameters<typeof materials.importComputation>[1] }) => materials.importComputation(v.documentId, v.rows),
    onSuccess: invalidate,
  });
}

export function useMarkReviewed() {
  const { materials } = useServices();
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (id: string) => materials.markReviewed(id), onSuccess: invalidate });
}

export function useAdjustComputation() {
  const { materials } = useServices();
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (v: { id: string; expected: number; reason?: string }) => materials.adjustComputation(v.id, v.expected, v.reason), onSuccess: invalidate });
}
