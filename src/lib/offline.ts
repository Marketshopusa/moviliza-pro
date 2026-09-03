import { supabase } from "@/integrations/supabase/client";

export type SiteCode = "X" | "A" | "B" | "C";

export type PendingMovement = {
  localId: string;
  driver_id: string;
  shift_id: string | null;
  plate_state: string;
  plate: string;
  vehicle_model: string | null;
  origin: SiteCode;
  destination: SiteCode;
  occurred_at: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  photoDataUrl: string | null;
};

const KEY = "movpro.pending.v1";

export function readPending(): PendingMovement[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as PendingMovement[];
  } catch {
    return [];
  }
}

function writePending(items: PendingMovement[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event("movpro:pending"));
}

export function queueMovement(item: PendingMovement) {
  writePending([...readPending(), item]);
}

export async function uploadPhoto(driverId: string, file: Blob): Promise<string> {
  const path = `${driverId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from("vehicle-photos").upload(path, file, {
    contentType: file.type || "image/jpeg",
    upsert: false,
  });
  if (error) throw error;
  return path;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  const head = parts[0] ?? "";
  const mime = head.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
  const bin = atob(parts[1] ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function syncPending(): Promise<number> {
  const items = readPending();
  if (items.length === 0 || !navigator.onLine) return 0;
  const remaining: PendingMovement[] = [];
  let synced = 0;
  for (const item of items) {
    try {
      const photoPath = item.photoDataUrl
        ? await uploadPhoto(item.driver_id, dataUrlToBlob(item.photoDataUrl))
        : null;
      const { error } = await supabase.from("movements").insert({
        driver_id: item.driver_id,
        shift_id: item.shift_id,
        plate_state: item.plate_state,
        plate: item.plate,
        vehicle_model: item.vehicle_model,
        origin: item.origin,
        destination: item.destination,
        occurred_at: item.occurred_at,
        latitude: item.latitude,
        longitude: item.longitude,
        notes: item.notes,
        photo_path: photoPath,
        status: "sincronizado",
      });
      if (error) throw error;
      synced++;
    } catch {
      remaining.push(item);
    }
  }
  writePending(remaining);
  return synced;
}
