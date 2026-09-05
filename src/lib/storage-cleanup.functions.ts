import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface CleanupResult {
  success: boolean;
  dryRun: boolean;
  foundCount: number;
  purgedCount: number;
  cutoffDate: string;
  message: string;
  error?: string;
}

/**
 * Función de servidor para ejecutar la política de retención de fotos de 30 días.
 * Localiza fotografías de movimientos con más de X días de antigüedad y las elimina
 * del bucket 'vehicle-photos' de Supabase Storage para liberar espacio.
 * Preserva intactos todos los registros de movimientos (fechas, choferes, placas y notas).
 */
export const executeStorageCleanup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        daysOld: z.number().int().min(7).max(365).default(30),
        dryRun: z.boolean().default(false),
      })
      .parse(data),
  )
  .handler(async ({ context, data }): Promise<CleanupResult> => {
    const supabase = context.supabase;
    const { daysOld, dryRun } = data;

    // 1. Verificar que el usuario tenga rol de supervisor o administrador
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return {
        success: false,
        dryRun,
        foundCount: 0,
        purgedCount: 0,
        cutoffDate: new Date().toISOString(),
        message: "No autorizado para ejecutar la purga de almacenamiento.",
      };
    }

    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    const role = roleRow?.role;
    if (role !== "supervisor" && role !== "administrador") {
      return {
        success: false,
        dryRun,
        foundCount: 0,
        purgedCount: 0,
        cutoffDate: new Date().toISOString(),
        message: "Acceso denegado: solo supervisores o administradores pueden purgar fotos.",
      };
    }

    // 2. Calcular fecha límite (ej. hace 30 días)
    const cutoff = new Date(Date.now() - daysOld * 86_400_000);
    const cutoffISO = cutoff.toISOString();

    try {
      // 3. Obtener movimientos anteriores a la fecha límite que tengan fotos registradas
      const { data: oldMovements, error: movErr } = await supabase
        .from("movements")
        .select("id, photos, photo_path")
        .lt("occurred_at", cutoffISO)
        .or("photos.neq.{},photo_path.not.is.null")
        .limit(500);

      if (movErr) {
        return {
          success: false,
          dryRun,
          foundCount: 0,
          purgedCount: 0,
          cutoffDate: cutoffISO,
          message: `Error al consultar movimientos antiguos: ${movErr.message}`,
        };
      }

      // Recopilar rutas de fotos a eliminar
      const pathsToDelete = new Set<string>();
      const movementIdsToUpdate: string[] = [];

      for (const m of oldMovements ?? []) {
        let hasFiles = false;
        if (m.photos && Array.isArray(m.photos)) {
          for (const p of m.photos) {
            if (typeof p === "string" && p.trim()) {
              pathsToDelete.add(p.trim());
              hasFiles = true;
            }
          }
        }
        if (m.photo_path && typeof m.photo_path === "string" && m.photo_path.trim()) {
          pathsToDelete.add(m.photo_path.trim());
          hasFiles = true;
        }
        if (hasFiles) {
          movementIdsToUpdate.push(m.id);
        }
      }

      const pathsList = Array.from(pathsToDelete);
      const foundCount = pathsList.length;

      if (foundCount === 0) {
        return {
          success: true,
          dryRun,
          foundCount: 0,
          purgedCount: 0,
          cutoffDate: cutoffISO,
          message: `No se encontraron fotografías con más de ${daysOld} días de antigüedad. El almacenamiento está optimizado.`,
        };
      }

      // Si es simulación (dryRun), reportar sin borrar
      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          foundCount,
          purgedCount: 0,
          cutoffDate: cutoffISO,
          message: `Simulación: Se identificaron ${foundCount} fotos en ${movementIdsToUpdate.length} movimientos de más de ${daysOld} días para purgar.`,
        };
      }

      // 4. Eliminar del bucket en lotes de 50
      let purgedCount = 0;
      const CHUNK_SIZE = 50;
      for (let i = 0; i < pathsList.length; i += CHUNK_SIZE) {
        const chunk = pathsList.slice(i, i + CHUNK_SIZE);
        const { error: delErr } = await supabase.storage.from("vehicle-photos").remove(chunk);
        if (!delErr) {
          purgedCount += chunk.length;
        }
      }

      // 5. Actualizar los movimientos para desvincular las fotos purgadas
      if (movementIdsToUpdate.length > 0) {
        await supabase
          .from("movements")
          .update({
            photos: [],
            photo_path: null,
          })
          .in("id", movementIdsToUpdate);
      }

      return {
        success: true,
        dryRun: false,
        foundCount,
        purgedCount,
        cutoffDate: cutoffISO,
        message: `Purga exitosa: Se eliminaron permanentemente ${purgedCount} fotos de más de ${daysOld} días, liberando almacenamiento en Supabase.`,
      };
    } catch (err) {
      return {
        success: false,
        dryRun,
        foundCount: 0,
        purgedCount: 0,
        cutoffDate: cutoffISO,
        message: "Ocurrió una falla inesperada durante la purga de almacenamiento.",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
