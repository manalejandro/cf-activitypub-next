interface ModerationResult {
  action: "dismiss" | "warn" | "delete" | "suspend";
  reason: string;
  confidence: "low" | "medium" | "high";
}

export async function evaluateReport(
  env: { AI: Ai; DB: D1Database },
  report: {
    category: string;
    comment: string;
    statusContent: string;
    targetUsername: string;
    reporterUsername: string;
    invalidStatuses: boolean;
    mismatchedOwnership: boolean;
  }
): Promise<ModerationResult | null> {
  if (!env.AI) return null;

  const categoryLabels: Record<string, string> = {
    spam: "spam / contenido no deseado / publicidad engañosa",
    violation: "violación de normas (acoso, incitación al odio, contenido ilegal, violencia)",
    other: "otro motivo",
  };

  const systemPrompt =
    "Eres un moderador de una red social federada. Debes evaluar si el reporte es auténtico y determinar la acción apropiada.\n\n" +
    "Responde ÚNICAMENTE con un objeto JSON, sin texto adicional:\n" +
    '{"action": "dismiss|warn|delete|suspend", "reason": "explicación breve y específica en español", "confidence": "low|medium|high"}\n\n' +
    "Acciones:\n" +
    "- dismiss: el reporte es falso, sin mérito, el contenido es aceptable, o el reporte parece fraudulento (venganza, sabotaje). No tomar acción.\n" +
    "- warn: infracción menor o dudosa. Emitir advertencia.\n" +
    "- delete: contenido inapropiado (spam leve, insultos, etc.) pero la cuenta no es reincidente. Eliminar solo el post.\n" +
    "- suspend: contenido grave (spam masivo, acoso, ilegal, odio, bots, suplantación). Suspender la cuenta.\n\n" +
    "Sé estricto con spam y acoso. Si hay duda razonable, prefiere warn sobre suspend.\n" +
    "Si el reporte parece falso o malicioso (el contenido no coincide con la categoría, o el denunciante parece estar abusando del sistema), usa dismiss.";

  const userPrompt = `## Reporte
- Categoría: ${categoryLabels[report.category] ?? report.category}
- Comentario del denunciante: ${report.comment || "(sin comentario)"}
- Contenido reportado: "${report.statusContent || "(sin contenido textual)"}"
- Usuario reportado: @${report.targetUsername}
- Denunciante: @${report.reporterUsername}
- IDs de estado inválidos: ${report.invalidStatuses ? "Sí" : "No"}
- Estados que no pertenecen al usuario reportado: ${report.mismatchedOwnership ? "Sí" : "No"}

Evalúa la autenticidad de este reporte y determina la acción apropiada. Si el reporte parece falso o abusivo, indica dismiss.`;

  try {
    const result = await env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 256,
        temperature: 0.1,
      } as Parameters<Ai["run"]>[1],
    ) as { response: string };

    const text = result.response?.trim();
    if (!text) return null;

    const parsed = JSON.parse(text) as ModerationResult;
    if (!["dismiss", "warn", "delete", "suspend"].includes(parsed.action)) return null;

    return parsed;
  } catch {
    return null;
  }
}
