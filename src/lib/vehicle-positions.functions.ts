import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type VehiclePosition = {
  id: string;
  plate: string;
  plate_state: string | null;
  vehicle_model: string | null;
  photo_path: string | null;
  latitude: number;
  longitude: number;
  created_by: string | null;
  created_at: string;
};

/**
 * Guarda la posición exacta (GPS) donde quedó estacionado un vehículo en Base X.
 * La registran los cleaners al tomar la foto de ubicación.
 */
export const saveVehiclePosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        plate: z.string().min(1).max(12),
        plate_state: z.string().max(4).nullish(),
        vehicle_model: z.string().max(120).nullish(),
        photo_path: z.string().max(300).nullish(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<VehiclePosition> => {
    const { data: row, error } = await context.supabase
      .from("vehicle_positions")
      .insert({
        plate: data.plate.toUpperCase(),
        plate_state: data.plate_state?.toUpperCase() ?? null,
        vehicle_model: data.vehicle_model ?? null,
        photo_path: data.photo_path ?? null,
        latitude: data.latitude,
        longitude: data.longitude,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row as VehiclePosition;
  });

/**
 * Devuelve la última posición registrada de un vehículo por placa.
 * La usan los drivers para ubicar el carro en Base X antes de iniciar la ruta.
 */
export const getVehiclePosition = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ plate: z.string().min(1).max(12) }).parse(data))
  .handler(async ({ data, context }): Promise<VehiclePosition | null> => {
    const { data: row, error } = await context.supabase
      .from("vehicle_positions")
      .select("*")
      .eq("plate", data.plate.toUpperCase())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (row as VehiclePosition | null) ?? null;
  });
