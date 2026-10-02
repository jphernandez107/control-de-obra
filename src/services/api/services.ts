import type { ActivityFilters } from "@/domain/types";
import type { AnalysisStep } from "@/domain/assistant";
import type { Services } from "../types";
import { api } from "./client";

const ANALYSIS_STEPS = ["Identificando el tipo de comprobante", "Buscando el proveedor", "Leyendo materiales, cantidades e importes", "Buscando registros relacionados"];

/**
 * While a document is being analyzed the server works in one request; the
 * loader advances through the pipeline stages on a timer and stops on the
 * last one until the real response arrives.
 */
function startProgress(onProgress?: (title: string, steps: AnalysisStep[]) => void) {
  if (!onProgress) return () => undefined;
  let current = 0;
  const emit = () =>
    onProgress(
      "Leyendo el comprobante…",
      ANALYSIS_STEPS.map((label, i) => ({ label, state: i < current ? "done" : i === current ? "active" : "todo" })),
    );
  emit();
  const timer = setInterval(() => {
    if (current < ANALYSIS_STEPS.length - 1) {
      current += 1;
      emit();
    }
  }, 900);
  return () => clearInterval(timer);
}

export function createApiServices(): Services {
  return {
    session: { get: () => api.get("/session") },
    orders: {
      list: () => api.get("/orders"),
      getById: (id) => api.get(`/orders/${id}`),
      correct: (id, correction) => api.patch(`/orders/${id}`, correction),
      attachDocument: (id, documentId) => api.post(`/orders/${id}/documents`, { documentId }),
    },
    suppliers: {
      list: () => api.get("/suppliers"),
      getById: (id) => api.get(`/suppliers/${id}`),
      options: () => api.get("/suppliers/options"),
    },
    deliveries: {
      create: (delivery) => api.post("/deliveries", delivery),
    },
    payments: {
      create: (payment) => api.post("/payments", payment),
      allocate: async (paymentId, allocations) => {
        await api.post(`/payments/${paymentId}/allocations`, { allocations });
      },
    },
    materials: {
      overview: () => api.get("/materials"),
      getById: (id) => api.get(`/materials/${id}`),
      options: () => api.get("/materials/options"),
      units: () => api.get("/units"),
      async previewComputation(file) {
        const form = new FormData();
        form.append("file", file);
        form.append("kind", "computation");
        const doc = await api.upload<{ id: string }>("/documents", form);
        return api.post("/computation/preview", { documentId: doc.id });
      },
      importComputation: async (documentId, rows) => {
        await api.post("/computation/import", { documentId, rows });
      },
      markReviewed: async (id) => {
        await api.post(`/materials/${id}/reviewed`);
      },
      adjustComputation: async (id, expected, reason) => {
        await api.put(`/materials/${id}/computation`, { expected, reason });
      },
    },
    documents: {
      upload(file, kind) {
        const form = new FormData();
        form.append("file", file);
        if (kind) form.append("kind", kind);
        return api.upload("/documents", form);
      },
    },
    activity: {
      list(filters: ActivityFilters = {}) {
        const params = new URLSearchParams();
        if (filters.search) params.set("search", filters.search);
        if (filters.supplierId) params.set("supplierId", filters.supplierId);
        if (filters.from) params.set("from", filters.from);
        if (filters.to) params.set("to", filters.to);
        for (const kind of filters.kinds ?? []) params.append("kind", kind);
        const qs = params.toString();
        return api.get(`/activity${qs ? `?${qs}` : ""}`);
      },
    },
    dashboard: { summary: () => api.get("/dashboard") },
    assistant: {
      initialThread: (conversationId) => api.get(`/assistant/thread${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`),
      conversations: () => api.get("/assistant/conversations"),
      newConversation: () => api.post("/assistant/conversations"),
      async respond(input, options = {}) {
        const stop = input.documentIds.length ? startProgress(options.onProgress) : () => undefined;
        try {
          return await api.post("/assistant/messages", { conversationId: input.conversationId, text: input.text, documentIds: input.documentIds });
        } finally {
          stop();
        }
      },
      resolveChoice: (input) => api.post("/assistant/choices", input),
      revise: async (blockId, interpretation) => (await api.post<{ interpretation: never }>(`/assistant/interpretations/${blockId}/revise`, { interpretation })).interpretation,
      confirm: (blockId, interpretation) => api.post(`/assistant/interpretations/${blockId}/confirm`, { interpretation }),
      cancel: async (blockId) => {
        await api.post(`/assistant/interpretations/${blockId}/cancel`);
      },
      undo: (recordId, conversationId) => api.post("/assistant/undo", { recordId, conversationId }),
    },
  };
}
