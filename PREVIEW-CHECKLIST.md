# Prueba real en teléfono (Preview `2ef4d38`)

Marca visible (esquina, Preview): **`2ef4d38c04ce`**. Si ves otra SHA, detente.

## Checklist

- [ ] A. Login abre **Drivers** (no DAW `/app`)
- [ ] B. OFFLINE rojo + **Iniciar turno** (sin PTT/rutas/OCR)
- [ ] C. Tras iniciar: **EN LÍNEA** + **Cerrar turno**
- [ ] D. PTT y Control de rutas **solo** con turno activo
- [ ] E. Sin scroll horizontal (gira el teléfono / 390px)
- [ ] F. Foto sin A/B/C o sin placa → rechazo, no “éxito”
- [ ] G. Foto A/B/C + etiqueta → Estado / placa / modelo rellenados
- [ ] H. **Descartar** / X limpia y vuelve a capturar
- [ ] I. Iniciar viaje (`en_ruta`)
- [ ] J. **Cancelar viaje** (confirmación) → no reaparece, se puede cerrar turno
- [ ] K. Cerrar turno → OFFLINE, **sigue autenticado**
- [ ] L. Nuevo turno **sin** FL XNX283 / Volvo u otro viaje viejo

## Si XNX283 sigue en pantalla

No borrar a ciegas. En Supabase SQL (solo SELECT):

```sql
select m.id, m.status, m.shift_id, m.created_at, m.driver_id, m.plate, m.vehicle_model, m.photo_path, m.photos
from movements m
where m.plate ilike '%XNX283%'
   or m.vehicle_model ilike '%XC40%'
order by m.created_at desc
limit 20;
```

Llevar: `id`, `status`, `shift_id`, `created_at`, `driver_id`, foto. Luego cancelar/eliminar **por id** si es prueba inequívoca.
