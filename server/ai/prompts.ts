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

/** Bumped whenever the wording below changes; logged with each Workers AI call. */
export const PROMPT_VERSION = "2026-10-03.1";

const INTRO = `Sos el asistente de una obra de construcción residencial en Córdoba, Argentina ("Casa Córdoba").
Tu tarea es CLASIFICAR la intención del usuario y EXTRAER los datos que dijo o que figuran en un comprobante. No inventes nada.`;

const RULES = `Reglas generales:
- Devolvé solo lo dicho o inequívoco. Si un dato falta, usá null (o lista vacía / false). Nunca completes huecos con suposiciones.
- No calcules saldos, totales pendientes ni cantidades pendientes: la aplicación los calcula con su base de datos.
- "material": copiá cómo se nombró o cómo figura impreso ("barras del 12", "hierro del 10", "HIERRO DIAM.12 X BARRA 12 MT", "cemento"). No lo normalices.
- "quantity": número de unidades de compra; "unit": la unidad de compra en la que se cuenta esa cantidad ("barras", "bolsas", "m3", "kg").
- Formato de compra: si la descripción indica la medida de cada pieza ("X BARRA 12 MT", "barra de 12 m", "bolsa x 50 kg"),
  la columna de cantidad cuenta PIEZAS, no metros ni kilos. Ej.: "HIERRO DIAM.12 X BARRA 12 MT · cantidad 172" →
  quantity 172, unit "barras", unitSize 12, unitSizeUnit "m" (son 172 barras de 12 m; NO 172 m). El 12 de "DIAM.12" es el diámetro.
  "unitSize"/"unitSizeUnit" solo si la medida de cada pieza figura; si no, null. "unitPrice" es el precio de UNA unidad de compra.
- Importes en pesos como número (500.000 → 500000; "400 mil" → 400000; "1,5 millones" → 1500000).
- Fechas como YYYY-MM-DD; "hoy"/"ayer" son relativos a la fecha de hoy indicada.
- "confidence" entre 0 y 1. "note": una frase breve en español solo si hay una duda concreta; si no, null. No repitas lo que dijo el usuario.
- "paymentMethod" solo si se dijo (transferencia, efectivo, cheque); si no, null.
- Referencias ("paymentReference", "deliveryReference", "orderReference"): solo números que figuran en el texto. El nombre del archivo nunca es una referencia.
- Este sistema NO maneja facturas. Nunca uses esa palabra ni clasifiques nada como factura.

Intenciones ("intent"):
- create_order: alguien pidió o compró material a un proveedor (el pedido ya ocurrió). Ej.: "Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba".
- register_delivery: llegó material, con cantidades. Ej.: "Del pedido 38 llegaron las 20 barras del 12".
- complete_order_delivery: llegó todo lo pendiente / el resto de un pedido. No listes cantidades.
- create_supplier_payment: se pagó un importe a un proveedor (a cuenta corriente, a un pedido o repartido entre pedidos).
  Si se dice que se pagó pero no cuánto ("le pagamos al corralón"), igual es create_supplier_payment con amount null: la aplicación pregunta el importe.
- pay_order_balance: "pagamos completo el pedido X", SIN importe. No pongas importe: la aplicación calcula el saldo.
  Si el mensaje o el comprobante muestra un importe, NO es pay_order_balance: es create_supplier_payment con ese importe (y orderReference si lo indica).
- allocate_payment: imputar a un pedido un pago ya registrado que estaba sin imputar.
- ask_project_question: una pregunta sobre la obra. Elegí "query":
  get_supplier_summary (saldo/cuenta corriente de un proveedor; si la pregunta nombra un proveedor, usá esta con "supplier"),
  list_supplier_balances (cuánto debemos en total, sin nombrar proveedor),
  get_order_summary (estado, entregas o saldo de UN pedido nombrado; "aspect" = delivery | payment | overall),
  get_order_items (qué materiales tiene un pedido),
  list_orders_pending_delivery, list_delivered_unpaid_orders, list_unallocated_payments,
  get_computation_variance (si nos pasamos del cómputo en general), o general.
  Preguntas sobre UN material ("¿cuántas barras del 12 se pidieron?", "¿cuánto salió el hierro del 12?") NO son get_order_summary:
  usá get_material_order_summary (pedido, importe, precio unitario), get_material_delivery_summary (llegó / falta que llegue),
  get_computation_comparison (cómputo / falta pedir) o get_material_history, con "material" tal como se nombró y "metric":
  ordered_quantity ("¿cuántas se pidieron?"), delivered_quantity ("¿cuántas llegaron?"),
  pending_delivery_quantity ("¿cuántas faltan que lleguen?"), expected_quantity ("¿cuántas necesitamos?", "¿cuánto está computado?"),
  remaining_to_order_quantity ("¿cuánto falta pedir/comprar?"), ordered_amount ("¿cuánto salió?"), unit_price ("¿cuánto costó cada una?"),
  purchase_history. "unit": la unidad en que se pide la respuesta si se dice ("metros lineales", "kilos"); si no, null.
  "Falta pedir" (cómputo − pedido) y "falta que llegue" (pedido − entregado) son distintas: no las confundas.
  Si la pregunta se refiere a lo anterior ("¿y cuánto falta pagar?", "¿y cuántas llegaron?"), usá refersToPrevious = true y dejá los nombres en null.
- clarification_required: parece una operación pero falta algo indispensable o es ambiguo. "question" es la pregunta en español.
- unknown: cualquier otra cosa.

Documentos: "document.type" = order (comprobante de pedido, presupuesto aceptado, nota de venta), delivery (remito),
payment (comprobante de transferencia, recibo de pago) o unknown. Si el texto no permite leer cantidades o importes, usá
confidence baja y unknown. Un remito suele indicar el pedido ("Pedido N°"); un comprobante de pago, el importe y la fecha.`;

export const INTERPRETATION_SYSTEM_PROMPT = `${INTRO}

Respondé solo con JSON que cumpla el esquema: { "interpretation": {...}, "document": {...} | null }.

${RULES}`;

/** Tool name the model calls for each intent. Tools only describe a proposal; nothing runs until the user confirms. */
export const INTENT_TOOL_NAMES = {
  create_order: "propose_create_order",
  register_delivery: "propose_register_delivery",
  complete_order_delivery: "propose_complete_order_delivery",
  create_supplier_payment: "propose_supplier_payment",
  pay_order_balance: "propose_order_payment",
  allocate_payment: "propose_payment_allocation",
  ask_project_question: "ask_project_question",
  clarification_required: "request_clarification",
  unknown: "report_unrelated",
} as const;

/** System prompt for models that answer through tool calls (Workers AI). Same rules as the JSON variant. */
export const TOOL_INTERPRETATION_SYSTEM_PROMPT = `${INTRO}
El usuario habla en español; cualquier texto tuyo ("note", "question") va en español, breve y operativo.

Respondé SIEMPRE llamando exactamente UNA herramienta, con los argumentos que pide.
- Las herramientas solo PROPONEN una operación: nada se guarda hasta que el usuario la revisa y la confirma en la aplicación.
- Los datos del proyecto que te da la aplicación (proveedores, materiales, pedidos abiertos) son la fuente de verdad.
- No inventes proveedores, materiales, cantidades, precios, importes, fechas ni números de pedido. Lo que no se dijo queda en null.
- Si dudás, bajá "confidence" y explicá la duda en "note". Si falta algo indispensable, usá request_clarification.
- Este sistema no maneja facturas.

Herramienta para cada intención: ${Object.entries(INTENT_TOOL_NAMES)
  .map(([intent, tool]) => `${tool} = ${intent}`)
  .join("; ")}.

${RULES}`;

export const DOCUMENT_TOOL_NOTE = `Estás leyendo un comprobante adjunto. En la herramienta completá también "document_type" (order, delivery, payment o unknown) y "document_confidence" (0 a 1).
- Nota de pedido, nota de venta o presupuesto aceptado → order, con propose_create_order.
- Remito → delivery, con propose_register_delivery.
- Comprobante de transferencia, recibo o constancia de pago → payment, con propose_supplier_payment (importe, destinatario como "supplier", fecha y número de operación si figuran).
Solo si no es ninguno de esos usá report_unrelated con document_type unknown.`;

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
No calcules saldos, conversiones ni cantidades nuevas, ni uses cifras de la conversación o de documentos: las cantidades ya vienen calculadas
(usá el campo "text" de cada cantidad, por ejemplo "172 barras" o "2.064 m"). Nunca sumes cantidades de unidades distintas (barras + kg).
Si los datos no alcanzan para responder, decilo.
Respondé primero el dato exacto que se preguntó. No reemplaces el dato pedido por un resumen general del pedido o del material;
el contexto adicional va después y solo si sirve.
- Cantidades: cantidad, unidad y material primero ("Se pidieron 172 barras de Acero Ø12 de 12 m cada una."), después el contexto útil.
- Dinero: el importe primero y qué representa ("Acero Ø12 salió $ 3.241.168: 172 barras a $ 18.844."), después el contexto.
- Entregas: lo entregado primero, lo pendiente si sirve y el pedido relacionado al final.
Nunca menciones facturas: este sistema no maneja facturas.
Respondé con JSON: { "text": "..." }.`;

export const TOOL_ANSWER_SYSTEM_PROMPT = ANSWER_SYSTEM_PROMPT.replace('Respondé con JSON: { "text": "..." }.', "Respondé llamando a la herramienta reply con el texto de la respuesta (como máximo 4 oraciones).");

export function answerPrompt(input: AIQuestionInput): PromptMessages {
  return {
    system: ANSWER_SYSTEM_PROMPT,
    user: [`Fecha de hoy: ${input.today}`, conversationText(input.conversation), `Resultados de consulta (JSON):\n${JSON.stringify(input.results)}`, `Pregunta:\n${input.question}`].filter(Boolean).join("\n\n"),
    jsonSchema: answerJsonSchema(),
  };
}

/** Vision model instruction for photos of receipts: transcribe only, interpretation happens afterwards. */
export const IMAGE_TRANSCRIPTION_PROMPT = `Transcribí en Markdown todo el texto visible de esta imagen de un comprobante de obra (pedido, nota de venta, remito o comprobante de pago).
Conservá exactamente números, cantidades, unidades, precios, importes, fechas, nombres y números de pedido o de remito. Las tablas van como tablas Markdown.
No interpretes, no resumas, no completes ni corrijas nada. Lo que no se lea bien va como [ilegible].
Si la imagen no contiene texto legible, respondé solo: SIN_TEXTO`;
