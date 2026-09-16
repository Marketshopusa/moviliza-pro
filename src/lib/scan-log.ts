import { shouldShowBuildMark } from "@/lib/build-id";

export function scanLog(stage: string, extra?: Record<string, unknown>): void {
  if (!shouldShowBuildMark()) return;
  if (extra) {
    console.info(`[scan] ${stage}`, extra);
    return;
  }
  console.info(`[scan] ${stage}`);
}
