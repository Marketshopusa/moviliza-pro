# MOVILIZA PRO

Hola. Quiero explicarte preliminarmente el proyecto que deseamos desarrollar. Luego te entregaré un documento técnico completo y una fotografía de la hoja que actualmente utilizamos para llevar el control manual.

Trabajamos movilizando vehículos de alquiler entre una base, que llamamos “X”, y tres terminales identificadas como A, B y C. Actualmente, cada conductor debe escribir manualmente en una hoja la información de cada vehículo movilizado: hora, estado de la placa, número de placa, marca o modelo, lugar de origen, destino, iniciales del conductor y número de movimiento.

Por ejemplo:

FL-DM25CV – C → X

Esto significa que el vehículo con placa de Florida DM25CV está siendo trasladado desde la terminal C hacia la Base X.

Queremos convertir este procedimiento en una aplicación móvil para los conductores, acompañada de un panel web para los supervisores. La aplicación debe permitir registrar cada movimiento, tomar una fotografía del vehículo, escribir o escanear la placa, seleccionar el origen y el destino, identificar automáticamente al conductor y guardar la hora y la ubicación.

También necesitamos llevar el conteo automático de los vehículos movilizados durante cada turno y entregar reportes por bloques horarios. El sistema debe mostrar cuántos movimientos realizó cada conductor, cuántos vehículos salieron de la base, cuántos regresaron y cuántos fueron trasladados hacia o desde cada terminal.

Para evitar errores y desarrollar correctamente cada función, queremos dividir la construcción en bloques. No se debe comenzar todo al mismo tiempo. Cada fase debe quedar terminada, probada y aprobada antes de comenzar la siguiente.

FASE 1: REGISTRO Y CONTROL DE MOVIMIENTOS

Esta debe ser la primera parte del proyecto y la base de todo el sistema.

Debe incluir:

Registro e inicio de sesión de conductores y supervisores.

Creación y administración de turnos.

Registro de cada movimiento.

Estado y número de placa.

Marca o modelo del vehículo.

Selección del origen: Base X, terminal A, B o C.

Selección del destino: Base X, terminal A, B o C.

Fotografía obligatoria o configurable del vehículo.

Identificación automática del conductor.

Hora oficial del movimiento.

Número correlativo para cada movimiento.

Historial personal de movimientos.

Conteo automático por conductor, terminal, ruta y turno.

Reportes y cierres por bloques horarios.

Panel web para que el supervisor pueda revisar todos los movimientos.

Exportación de reportes.

Prevención de movimientos duplicados.

Funcionamiento sin conexión, guardando temporalmente los movimientos para sincronizarlos cuando regrese el internet.

Esta fase debe probarse durante uno o varios turnos reales. No se debe continuar hasta comprobar que las fotografías se guardan correctamente, que no existen movimientos duplicados y que los totales coinciden con los vehículos realmente movilizados.

FASE 2: GPS, MAPA Y CONTROL OPERATIVO

Después de aprobar completamente la primera fase, se desarrollará el sistema avanzado de ubicación.

Debe incluir:

Activación del GPS cuando el conductor inicia su turno.

Desactivación automática cuando finaliza el turno.

Mapa para supervisores con la ubicación de los conductores activos.

Identificación de quién está en la Base X y quién está en las terminales A, B o C.

Registro de la última ubicación y de la hora de actualización.

Geocercas para reconocer aproximadamente cada terminal y la base.

Sugerencia automática del origen según la ubicación.

Historial de ubicación limitado al horario laboral autorizado.

Funcionamiento con poca señal y sincronización posterior.

Permisos y controles de privacidad según el cargo del usuario.

La aplicación debe indicar claramente cuándo una ubicación es reciente y cuándo corresponde a una última posición registrada. No queremos que una ubicación antigua aparezca como si estuviera actualizada en tiempo real.

FASE 3: HORARIOS Y COMUNICACIÓN INTERNA

Cuando el registro de movimientos y el GPS estén funcionando correctamente, se desarrollarán los grupos internos de comunicación.

Inicialmente necesitamos tres canales:

Operación: para informar asignaciones, movimientos, terminales, incidencias y vehículos.

Horarios: para publicar los días y horas de trabajo de cada conductor.

Reportes de movimientos: para enviar los cierres y totales de cada bloque horario.

Los canales deben permitir mensajes de texto, fotografías, archivos, audios, avisos importantes, menciones y confirmación de lectura.

Cuando se registre un movimiento, el sistema podrá publicar automáticamente una tarjeta informativa en el canal de Operación. Sin embargo, esta tarjeta debe estar conectada con el registro original y no crear un segundo movimiento ni duplicar el conteo.

FASE 4: COMUNICACIÓN DE VOZ TIPO ZELLO

Esta será la última fase porque entendemos que requiere una infraestructura más especializada.

Debe permitir:

Mantener presionado un botón para hablar.

Soltar el botón para enviar o terminar la transmisión.

Escuchar inmediatamente el mensaje de voz.

Identificar quién está hablando.

Separar las comunicaciones por grupos o canales.

Mostrar la hora y duración de cada audio.

Guardar el historial según las reglas de conservación establecidas.

Configurar mensajes prioritarios o de emergencia.

Administrar quién puede hablar, escuchar o crear canales.

Necesitamos que nos indiques si recomiendas comenzar con mensajes de voz tipo “pulsar para grabar y enviar” o si puedes desarrollar desde el principio una comunicación verdaderamente en vivo y de baja latencia. Estas dos alternativas deben cotizarse por separado.

FORMA DE TRABAJO REQUERIDA

Antes de programar cada fase, necesitamos recibir un diseño o prototipo de las pantallas para aprobar el funcionamiento.

Cada fase debe seguir este proceso:

Definición detallada de requisitos.

Diseño de pantallas y flujo.

Revisión y aprobación.

Desarrollo.

Pruebas internas.

Prueba con usuarios durante un turno real.

Corrección de errores.

Aprobación final.

Inicio de la siguiente fase.

También necesitamos que la cotización esté dividida por fases y que se indiquen por separado:

Costo de desarrollo de cada fase.

Tiempo estimado de construcción.

Costos mensuales de servidores.

Costos de almacenamiento de fotografías y audios.

Costos de mapas y GPS.

Costos de comunicación de voz.

Mantenimiento y soporte.

Propiedad y entrega del código fuente.

Acceso administrativo a las cuentas y bases de datos.

Garantía para corregir errores después de la entrega.

El objetivo es construir un sistema organizado, estable y fácil de utilizar. No queremos desarrollar todas las funciones simultáneamente. Primero debemos conseguir que el registro y conteo de movimientos funcione correctamente; después agregaremos el GPS, luego los canales internos y finalmente la comunicación de voz tipo Zello.

Te entregaré el documento técnico completo para que puedas revisar todos los requisitos y preparar una propuesta dividida por fases.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://moviliza-pro.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/0277441c-52a5-46b5-aebd-65c11611ba20).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
