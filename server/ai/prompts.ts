import type { AIConversationContext, AIDocumentInput, AIInterpretationInput, AIProjectContext, AIQuestionInput } from "./provider";
import { answerJsonSchema, interpretationJsonSchema } from "./schemas";

// Provider-agnostic prompts. A model adapter (e.g. Workers AI) sends
// `system` + `user` as chat messages and asks for JSON matching `jsonSchema`,
// then passes the raw JSON to `parseInterpretationResult` / `parseAnswerResult`.
// Keeping prompts here means switching models never touches domain code.

export interface PromptMessages {
  system: string;
  user: string;
  /** JSON Schema the response must follow (JSON mode / structured output). */
  jsonSchema: Record<string, unknown>;
}

export const INTERPRETATION_SYSTEM_PROMPT = `Sos el asistente de una obra de construcción residencial en Córdoba, Argentina ("Casa Córdoba").
Tu tarea es CLASIFICAR la intención del usuario y EXTRAER los datos que dijo o que figuran en un comprobante. No inventes nada.

Respondé solo con JSON que cumpla el esquema: { "interpretation": {...}, "document": {...} | null }.

Reglas generales:
- Devolvé solo lo dicho o inequívoco. Si un dato falta, usá null (o lista vacía / false). Nunca completes huecos con suposiciones.
- No calcules saldos, totales pendientes ni cantidades pendientes: la aplicación los calcula con su base de datos.
- "material": copiá cómo se nombró ("barras del 12", "hierro del 10", "acero 12 mm", "cemento"). No lo normalices.
- "quantity": número; "unit": la palabra de unidad tal como aparece ("barras", "bolsas", "m3", "kg").
- Importes en pesos como número (500.000 → 500000; "400 mil" → 400000; "1,5 millones" → 1500000).
- Fechas como YYYY-MM-DD; "hoy"/"ayer" son relativos a la fecha de hoy indicada.
- "confidence" entre 0 y 1. "note": una frase breve en español solo si algo es dudoso.
- Este sistema NO maneja facturas. Nunca uses esa palabra ni clasifiques nada como factura.

Intenciones ("intent"):
- create_order: alguien pidió o compró material a un proveedor (el pedido ya ocurrió). Ej.: "Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba".
- register_delivery: llegó material, con cantidades. Ej.: "Del pedido 38 llegaron las 20 barras del 12".
- complete_order_delivery: llegó todo lo pendiente / el resto de un pedido. No listes cantidades.
- create_supplier_payment: se pagó un importe a un proveedor (a cuenta corriente, a un pedido o repartido entre pedidos).
- pay_order_balance: "pagamos completo el pedido X". No pongas importe: la aplicación calcula el saldo.
- allocate_payment: imputar a un pedido un pago ya registrado que estaba sin imputar.
- ask_project_question: una pregunta sobre la obra. Elegí "query":
  get_supplier_summary (saldo/cuenta corriente de un proveedor), list_supplier_balances (cuánto debemos en total),
  get_order_summary (estado, entregas o saldo de un pedido; "aspect" = delivery | payment | overall),
  list_orders_pending_delivery, list_delivered_unpaid_orders, get_material_summary (cuánto llevamos pedido de un material),
  get_computation_variance (si nos pasamos del cómputo), list_unallocated_payments, o general.
  Si la pregunta se refiere a lo anterior ("¿y cuánto falta pagar?"), usá refersToPrevious = true y dejá los nombres en null.
- clarification_required: parece una operación pero falta algo indispensable o es ambiguo. "question" es la pregunta en español.
- unknown: cualquier otra cosa.

Documentos: "document.type" = order (comprobante de pedido, presupuesto aceptado, nota de venta), delivery (remito),
payment (comprobante de transferencia, recibo de pago) o unknown. Si el texto no permite leer cantidades o importes, usá
confidence baja y unknown. Un remito suele indicar el pedido ("Pedido N°"); un comprobante de pago, el importe y la fecha.`;

function projectText(c: AIProjectContext): string {
  return [
    `Fecha de hoy: ${c.today}`,
    `Proveedores conocidos: ${c.suppliers.join("; ") || "ninguno"}`,
    `Materiales del catálogo: ${c.materials.map((m) => `${m.name} (${m.unit}${m.aliases.length ? `; también: ${m.aliases.slice(0, 4).join(", ")}` : ""})`).join("; ") || "ninguno"}`,
    `Pedidos abiertos: ${c.openOrders.map((o) => `pedido ${o.reference} de ${o.supplier}: ${o.items}`).join(" | ") || "ninguno"}`,
  ].join("\n");
}

function conversationText(c: AIConversationContext): string {
  const lines: string[] = [];
  if (c.recent.length) lines.push("Conversación reciente:", ...c.recent.map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.text}`));
  const focus = [
    c.focus.order ? `pedido ${c.focus.order.reference} de ${c.focus.order.supplier}` : "",
    c.focus.supplier ? `proveedor ${c.focus.supplier}` : "",
    c.focus.material ? `material ${c.focus.material}` : "",
  ].filter(Boolean);
  if (focus.length) lines.push(`Tema de lo último que se habló: ${focus.join(", ")}.`);
  return lines.join("\n");
}

export function interpretationPrompt(input: AIInterpretationInput): PromptMessages {
  return {
    system: INTERPRETATION_SYSTEM_PROMPT,
    user: [projectText(input.project), conversationText(input.conversation), `Mensaje del usuario:\n${input.text}`].filter(Boolean).join("\n\n"),
    jsonSchema: interpretationJsonSchema(),
  };
}

export function documentPrompt(input: AIDocumentInput): PromptMessages {
  return {
    system: INTERPRETATION_SYSTEM_PROMPT,
    user: [
      projectText(input.project),
      conversationText(input.conversation),
      `Documento adjunto: ${input.document.fileName} (${input.document.mimeType})`,
      input.userText ? `El usuario escribió junto al documento: ${input.userText}` : "",
      `Contenido del documento (${input.content.format}):\n${input.content.text.slice(0, 20_000)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    jsonSchema: interpretationJsonSchema(),
  };
}

export const ANSWER_SYSTEM_PROMPT = `Sos el asistente de una obra de construcción en Córdoba, Argentina. Respondé en español rioplatense, breve y claro.
Usá ÚNICAMENTE las cifras de los resultados de consulta que te da la aplicación (importes en centavos: dividí por 100 y mostrálos como $ 1.234.567).
No calcules saldos nuevos ni uses cifras de la conversación. Si los datos no alcanzan para responder, decilo.
Nunca menciones facturas: este sistema no maneja facturas.
Respondé con JSON: { "text": "..." }.`;

export function answerPrompt(input: AIQuestionInput): PromptMessages {
  return {
    system: ANSWER_SYSTEM_PROMPT,
    user: [`Fecha de hoy: ${input.today}`, conversationText(input.conversation), `Resultados de consulta (JSON):\n${JSON.stringify(input.results)}`, `Pregunta:\n${input.question}`].filter(Boolean).join("\n\n"),
    jsonSchema: answerJsonSchema(),
  };
}
