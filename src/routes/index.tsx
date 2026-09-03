import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "MovilizaPro · Control de movimientos de vehículos" },
      {
        name: "description",
        content:
          "Registro móvil de movimientos de vehículos entre Base X y terminales, con foto, hora oficial y conteo automático por turno.",
      },
      { property: "og:title", content: "MovilizaPro · Control de movimientos" },
      {
        property: "og:description",
        content: "Registra cada movimiento con foto, placa, ruta y conductor. Sin papel, sin duplicados.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const navigate = useNavigate();
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/app" });
      else navigate({ to: "/auth" });
    });
  }, [navigate]);
  return (
    <div className="min-h-screen grid place-items-center bg-background">
      <p className="font-mono text-sm text-muted-foreground tracking-widest">CARGANDO…</p>
    </div>
  );
}
