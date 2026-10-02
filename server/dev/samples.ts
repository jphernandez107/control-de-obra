import { mkdirSync, writeFileSync } from "node:fs";
import { simplePdf } from "./pdf";

// Regenerates the sample documents in /samples (used to try document
// interpretation against the demo data: `npm run samples`).

const docs: Record<string, string[]> = {
  "remito_hierros_cordoba_pedido_38.pdf": ["REMITO N° 0012-4601", "Hierros Córdoba", "Pedido 38", "20 barras Acero Ø12", "25 barras Acero Ø10", "Recibió: Marcelo Ríos"],
  "nota_pedido_corralon_0041.pdf": ["NOTA DE PEDIDO N° 0041", "Corralón San Martín", "30 bolsas Cemento portland 50 kg $12.400", "4 m3 Arena gruesa $45.000"],
  "transferencia_hierros_pedido_381.pdf": ["Comprobante de transferencia", "Destinatario: Hierros Córdoba", "Importe: $350.000", "Concepto: pago pedido 381"],
  "transferencia_sanitarios.pdf": ["Comprobante de transferencia", "Destinatario: Sanitarios del Centro", "Importe: $612.300", "Concepto: materiales sanitarios"],
};

mkdirSync("samples", { recursive: true });
for (const [name, lines] of Object.entries(docs)) {
  writeFileSync(`samples/${name}`, simplePdf([{ text: lines[0]!, size: 15, bold: true }, ...lines.slice(1).map((text) => ({ text }))]));
}
writeFileSync(
  "samples/computo_ejemplo.csv",
  "Material;Unidad;Cantidad;Etapa;Desperdicio\nAcero Ø12;barras;110;Estructura;\nhierro del 10;barras;85;Estructura;\nCodo PVC 110 mm 90°;u;30;Sanitarios;\nMembrana asfáltica;m2;140;Cubierta;10%\n",
);
console.log("Documentos de ejemplo generados en samples/");
